// api/stock-auto/index.js — REQ-4: Stock Vivo con Reposición Autónoma
import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { notifAuto } from './_auto-push.js';
import { enviarEmail } from '../email.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { obtenerCostosPorIds } from '../repos/productos.js';
import {
  listarEmpresasActivas,
  analizarStockAutonomoRpc,
  listarAlertasStockActivas,
  resolverAlertaStock,
  buscarOrdenRecienteProveedor,
  insertarOrdenCompraAuto,
  insertarItemsOrdenCompra,
  upsertAlertasStock,
  obtenerOrdenParaEnviar,
  listarItemsOrdenCompra,
  marcarOrdenEnviada,
  marcarAlertasResueltasPorOrden,
} from '../repos/stock-auto.js';

// `sb` sigue vivo solo para `verificarToken(req, sb)` — identidad, mismo
// criterio que `automatizacion.js`/`cc_proveedores.js`. `notifAuto` ya no
// lo necesita: usa el singleton `db` internamente (ver lib/repos/notif.js).
const sb = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]);

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  // CRON-001 (auditoría 2026-07-26): se sacó la confianza en `x-vercel-cron`
  // (spoofeable por cualquiera en un request normal) — solo se acepta el
  // `CRON_SECRET` real.
  const esInterno = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  if (!esInterno) {
    const perfil = await verificarToken(req, sb);
    if (!perfil) return res.status(401).json({ error: 'No autorizado' });
    req._perfil = perfil;
  }

  const accion = req.query.accion || req.body?.accion;

  // ── Analizar stock y generar órdenes automáticas ──────────────────────────
  if (accion === 'analizar') {
    let empresas;
    if (esInterno) {
      empresas = await listarEmpresasActivas();
    } else {
      empresas = [{ id: req._perfil.empresa_id }];
    }

    const resultados = [];
    for (const emp of empresas) {
      resultados.push({
        empresa_id: emp.id,
        ordenes_generadas: await analizarYGenerarOrdenes(emp.id)
      });
    }
    return res.json({ ok: true, resultados });
  }

  // ── Aprobar y enviar orden al proveedor ────────────────────────────────────
  if (req.method === 'POST' && accion === 'aprobar') {
    if (!['dueno', 'admin'].includes(req._perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    const { orden_id } = req.body;
    if (!orden_id) return res.status(400).json({ error: 'orden_id requerido' });
    await aprobarYEnviarOrden(orden_id, req._perfil.empresa_id);
    return res.json({ ok: true });
  }

  // ── Vista previa del análisis (sin crear órdenes) ─────────────────────────
  if (req.method === 'GET' && accion === 'vista-previa') {
    const { data, error } = await analizarStockAutonomoRpc(req._perfil.empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ analisis: data });
  }

  // ── Listar alertas de stock activas ───────────────────────────────────────
  if (req.method === 'GET' && accion === 'alertas') {
    let data;
    try {
      data = await listarAlertasStockActivas(req._perfil.empresa_id);
    } catch (error) {
      return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    }
    return res.json({ alertas: data });
  }

  // ── Resolver alerta manualmente ───────────────────────────────────────────
  if (req.method === 'POST' && accion === 'resolver-alerta') {
    const { alerta_id } = req.body;
    await resolverAlertaStock(alerta_id, req._perfil.empresa_id);
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: 'Acción no encontrada' });
}

// Ya estaba scopeada por empresa_id (accion=analizar la llama una vez por
// empresa, tanto para el cron como para el trigger manual de un dueño/admin)
// — se exporta tal cual, mismo criterio que procesarColaFinancieraEmpresa en
// cierre.js, para que la tool de chat del asistente la reuse directo en vez
// de pegarle un fetch HTTP interno reenviando el Bearer del usuario.
export async function analizarYGenerarOrdenes(empresa_id) {
  const { data: analisis } = await analizarStockAutonomoRpc(empresa_id);
  const criticos = (analisis || []).filter(a => a.necesita_reponer && a.cantidad_sugerida > 0);
  if (!criticos.length) return 0;

  // Agrupar por proveedor
  const porProveedor = {};
  for (const item of criticos) {
    const k = item.proveedor_id || 'sin_proveedor';
    if (!porProveedor[k]) porProveedor[k] = [];
    porProveedor[k].push(item);
  }

  let generadas = 0;
  for (const [proveedor_id, items] of Object.entries(porProveedor)) {
    if (proveedor_id === 'sin_proveedor') {
      // Antes: se descartaban en silencio (sin OC posible porque no hay a
      // quién enviarla, ni alerta, ni aviso a nadie). Un producto podía
      // llegar a quiebre total y el sistema nunca lo mostraba en ningún
      // lado. Ahora: se deja constancia en alertas_stock (sin orden_compra_id,
      // porque no existe orden) y se avisa a los admins para que asignen
      // un proveedor por defecto al producto.
      await alertarSinProveedor(empresa_id, items);
      continue;
    }

    // Idempotencia: verificar si ya hay una orden reciente para este proveedor
    const exist = await buscarOrdenRecienteProveedor(
      empresa_id, proveedor_id, new Date(Date.now() - 7 * 86400000).toISOString()
    );
    if (exist) continue;

    // Un solo fetch para todos los productos del proveedor (evita N+1).
    // Antes: una query .single() por cada item en Promise.all → N round-trips.
    // Ahora: un .in('id', ids) y un Map en memoria.
    const ids = items.map(i => i.producto_id);
    const productosData = await obtenerCostosPorIds(ids);
    const porId = new Map((productosData || []).map(p => [p.id, p]));

    const lineas = items.map(item => {
      const prod     = porId.get(item.producto_id);
      const cantidad = Math.ceil(item.cantidad_sugerida);
      const precio   = prod?.costo || 0;
      return {
        producto_id:     item.producto_id,
        descripcion:     prod?.nombre || item.nombre,
        cantidad,
        precio_unitario: precio,
        subtotal:        cantidad * precio
      };
    });

    const subtotal = lineas.reduce((s, l) => s + l.subtotal, 0);
    const numero   = `AUTO-${Date.now().toString(36).toUpperCase()}`;

    const { data: orden, error: errOC } = await insertarOrdenCompraAuto({
      empresa_id,
      proveedor_id,
      numero,
      estado:         'pendiente_aprobacion',
      fecha_pedido:   new Date().toISOString().split('T')[0],
      fecha_esperada: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
      subtotal,
      total: subtotal,
      auto_generada: true,
      velocidad_venta_snapshot: { items }
    });

    if (errOC || !orden) {
      console.error('[STOCK-AUTO] Error creando orden:', errOC?.message);
      continue;
    }

    await insertarItemsOrdenCompra(
      lineas.map(l => ({ ...l, orden_id: orden.id }))  // FIX: usar orden_id (tiene FK real)
    );

    const filasAlertas = items.map(item => ({
      empresa_id,
      producto_id:    item.producto_id,
      tipo:           item.dias_restantes < 3 ? 'quiebre' : 'critico',
      dias_restantes: item.dias_restantes,
      orden_compra_id: orden.id,   // columna de alertas_stock (apunta a ordenes_compra.id correctamente)
      resuelta: false
    }));
    await upsertAlertasStock(filasAlertas);

    // Push a admins
    notifAuto(empresa_id, {
      tipo:   'stock_orden_auto',
      titulo: 'Orden auto-generada',
      cuerpo: `${items.length} producto${items.length > 1 ? 's' : ''} necesitan reposición — Orden ${numero} esperando aprobación`,
      link:   '/admin/stock',
    }).catch(() => {});
    if (items.some(i => i.dias_restantes < 3)) {
      notifAuto(empresa_id, {
        tipo:   'stock_quiebre',
        titulo: 'Quiebre de stock',
        cuerpo: `${items.filter(i => i.dias_restantes < 3).length} producto${items.filter(i => i.dias_restantes < 3).length > 1 ? 's' : ''} con menos de 3 días de stock`,
        link:   '/admin/stock',
      }).catch(() => {});
    }

    generadas++;
  }

  return generadas;
}

async function alertarSinProveedor(empresa_id, items) {
  // upsert por producto: mismo criterio de idempotencia que las alertas
  // 'critico'/'quiebre' (onConflict producto_id,tipo,resuelta + ignoreDuplicates)
  // para no reabrir/duplicar la alerta si ya está pendiente sin resolver.
  const filasAlertas = items.map(item => ({
    empresa_id,
    producto_id:    item.producto_id,
    tipo:           'sin_proveedor',
    dias_restantes: item.dias_restantes,
    orden_compra_id: null,
    resuelta: false
  }));
  await upsertAlertasStock(filasAlertas);

  const enQuiebre = items.filter(i => i.dias_restantes < 3).length;
  notifAuto(empresa_id, {
    tipo:   'stock_sin_proveedor',
    titulo: '⚠ Reposición sin proveedor asignado',
    cuerpo: `${items.length} producto${items.length > 1 ? 's' : ''} necesita${items.length > 1 ? 'n' : ''} reponerse pero no tienen proveedor por defecto — no se pudo generar la orden` +
            (enQuiebre ? ` (${enQuiebre} ya en quiebre)` : ''),
    link:   '/admin/stock',
  }).catch(() => {});
}

async function aprobarYEnviarOrden(orden_id, empresa_id) {
  const orden = await obtenerOrdenParaEnviar(orden_id, empresa_id);

  if (!orden) throw new Error('Orden no encontrada');
  if (orden.estado === 'enviada') return; // idempotencia: ya enviada, no reenviar email duplicado

  // FIX: usar orden_id (columna con FK real). orden_compra_id era una columna huérfana.
  const items = await listarItemsOrdenCompra(orden_id);
  orden.ordenes_compra_items = items || [];

  await marcarOrdenEnviada(orden_id);

  // Marcar alertas como resueltas (alertas_stock.orden_compra_id referencia ordenes_compra.id — correcto)
  await marcarAlertasResueltasPorOrden(orden_id);

  if (!orden.proveedor?.email) return;

  const rowsHtml = (orden.ordenes_compra_items || []).map(i => `
    <tr>
      <td>${i.productos?.nombre || i.descripcion}</td>
      <td align="center">${i.cantidad}</td>
      <td align="right">$${Number(i.precio_unitario).toLocaleString('es-AR')}</td>
      <td align="right">$${Number(i.subtotal).toLocaleString('es-AR')}</td>
    </tr>`).join('');

  await enviarEmail({
    to: orden.proveedor.email,
    subject: `Orden de Compra ${orden.numero} — ${orden.empresa.nombre}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <h2 style="color:#185FA5">Orden de Compra Nº ${orden.numero}</h2>
      <p><b>De:</b> ${orden.empresa.nombre} &nbsp;|&nbsp; <b>Para:</b> ${orden.proveedor.razon_social}</p>
      <p><b>Fecha:</b> ${orden.fecha_pedido} &nbsp;|&nbsp; <b>Entrega esperada:</b> ${orden.fecha_esperada}</p>
      <table width="100%" cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse">
        <thead style="background:#f0f4f8">
          <tr><th>Producto</th><th>Cantidad</th><th>Precio Unit.</th><th>Subtotal</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr>
            <td colspan="3"><b>TOTAL</b></td>
            <td align="right"><b>$${Number(orden.total).toLocaleString('es-AR')}</b></td>
          </tr>
        </tfoot>
      </table>
      <p style="color:#666;font-size:12px">Confirmá recepción respondiendo este email.</p>
    </div>`
  });
}
