// api/proveedores/index.js
// GET    /api/proveedores            → lista (filtro ?activo=true|false|'')
// GET    /api/proveedores?id=uuid    → detalle
// POST   /api/proveedores            → crear
// PATCH  /api/proveedores            → editar (body.id requerido)
// DELETE /api/proveedores?id=uuid    → dar de baja (soft-delete: activo=false)

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit } from '../rate-limit.js';
import { enviarEmailRecepcionProveedor } from '../email.js';
import { handleCCProveedores } from './cc_proveedores.js';
import { handlePortalAdmin, handlePortalPublico } from './portal_proveedor.js';
import { errorSeguro } from '../error-response.js';
import { obtenerProductosPorIds } from '../repos/productos.js';
import { puede } from '../permisos-service.js';
import { obtenerEmpresaContacto, insertarNotifLog } from '../repos/pedidos.js';
import * as ProveedoresRepo from '../repos/proveedores.js';
import * as ComprasRepo from '../repos/compras.js';
import { AuditRepo } from '../repos/index.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export default async function handler(req, res) {
  // ── Rate limiting ──────────────────────────────────────────────────
  if (await limiter(req, res)) return;

  // ── Sub-router: compras ───────────────────────────────────────────
  const _svc = req.query._svc;
    if (_svc === 'compras')        return handleCompras(req, res);
  if (_svc === 'cc-proveedores') return handleCCProveedores(req, res);
  if (_svc === 'comparador-precios') return handleComparadorPrecios(req, res);

  // Portal público del proveedor (#10 — Vidriera Inversa): SIN auth de
  // usuario, va antes del bloque de auth porque el proveedor no tiene
  // sesión de Supabase. Se autoriza por token firmado (ver portal_proveedor.js).
  if (_svc === 'portal') return handlePortalPublico(req, res);

    // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await ProveedoresRepo.obtenerPerfilProveedores(user.id);

  if (!perfil || !puede(perfil, 'leer', 'proveedores'))
    return res.status(403).json({ error: 'Sin permisos' });

  // Portal de proveedores — administración (generar/revocar links). Requiere
  // sesión admin, por eso se despacha acá y no arriba junto al público.
  if (_svc === 'portal-admin') return handlePortalAdmin(req, res, perfil);

  const empresa_id = perfil.empresa_id;
  const esEscritor = puede(perfil, 'escribir', 'proveedores');

  // ── GET ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, activo, busqueda, page = '1', limit = '200' } = req.query;

    if (id) {
      const { data, error } = await ProveedoresRepo.obtenerProveedorPorId(id, empresa_id);

      if (error || !data) return res.status(404).json({ error: 'Proveedor no encontrado' });
      return res.json(data);
    }

    // Antes: .limit(500) fijo, sin búsqueda server-side ni paginación —
    // el frontend (proveedores.js) traía hasta 500 proveedores y filtraba
    // por texto en el navegador con Array.filter(). Con más de 500
    // proveedores activos, buscar dejaba resultados afuera silenciosamente.
    // Mismo tratamiento que busqueda.js: escapar caracteres reservados de
    // PostgREST ( , ( ) * ) antes de interpolar en .or(), y paginar con
    // .range() + count:'exact' en vez de un tope fijo.
    const offsetPag = (parseInt(page) - 1) * parseInt(limit);
    const busq = (busqueda || '').trim();
    const escaparFiltroPostgrest = (valor) => valor.replace(/[,()*]/g, (c) => '\\' + c);
    const busquedaLike = busq ? `%${escaparFiltroPostgrest(busq)}%` : null;

    const { data, error, count } = await ProveedoresRepo.listarProveedoresFiltrados(empresa_id, {
      activo, busquedaLike, offset: offsetPag, limit: parseInt(limit),
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ proveedores: data || [], total: count || 0 });
  }

  // ── Escritura: solo roles con permiso ─────────────────────────────
  if (!esEscritor) return res.status(403).json({ error: 'Sin permisos de escritura' });

  // ── POST: crear ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { razon_social, nombre_fantasia, cuit, condicion_iva,
            contacto, telefono, email, dias_pago,
            domicilio, localidad, notas } = req.body;

    if (!razon_social?.trim()) return res.status(400).json({ error: 'Razón social requerida' });

    const { data, error } = await ProveedoresRepo.crearProveedor({
      empresa_id,
      razon_social: razon_social.trim(),
      nombre_fantasia: nombre_fantasia?.trim() || null,
      cuit: cuit?.trim() || null,
      condicion_iva: condicion_iva || 'responsable_inscripto',
      contacto: contacto?.trim() || null,
      telefono: telefono?.trim() || null,
      email: email?.trim() || null,
      dias_pago: parseInt(dias_pago) || 0,
      domicilio: domicilio?.trim() || null,
      localidad: localidad?.trim() || null,
      notas: notas?.trim() || null,
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, user.id, 'proveedores', 'INSERT', data.id, null, data);
    return res.status(201).json(data);
  }

  // ── PATCH: editar ─────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, ...cambios } = req.body;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    // Sanitizar campos editables
    const permitidos = ['razon_social','nombre_fantasia','cuit','condicion_iva',
                        'contacto','telefono','email','dias_pago','domicilio',
                        'localidad','notas','activo'];
    const update = {};
    for (const k of permitidos) {
      if (k in cambios) update[k] = cambios[k];
    }
    update.updated_at = new Date().toISOString();

    const antes = await ProveedoresRepo.obtenerProveedorAntes(id, empresa_id);

    const { data, error } = await ProveedoresRepo.actualizarProveedorCampos(id, empresa_id, update);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, user.id, 'proveedores', 'UPDATE', id, antes, data);
    return res.json(data);
  }

  // ── DELETE: soft-delete ───────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const { error } = await ProveedoresRepo.desactivarProveedor(id, empresa_id);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(empresa_id, user.id, 'proveedores', 'UPDATE', id, null, { activo: false });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ── Auditoría directa (service-role no tiene auth.uid() en RPCs) ──────────
// Migrado a AuditRepo (lib/repos/audit.js), Fase 7 — antes tenía su propio
// insert local a `audit_log`, duplicado carácter por carácter con el de
// maestros.js.



// ══════════════════════════════════════════════════════════════════════════
// ── Compras / Órdenes de Compra (absorto desde api/compras/index.js) ────
// ══════════════════════════════════════════════════════════════════════════

async function handleCompras(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await ComprasRepo.obtenerPerfilCompras(user.id);

  if (!perfil || !puede(perfil, 'leer', 'compras'))
    return res.status(403).json({ error: 'Sin permisos' });

  const empresa_id = perfil.empresa_id;
  const esEscritor = puede(perfil, 'escribir', 'compras');

  // ── GET ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, proveedor_id, estado, desde, hasta,
            page = '1', limit = '50', accion, sin_facturar, excluir_factura_id } = req.query;

    // ── Historial de recepciones (GET) ────────────────────────────
    if (accion === 'historial-recepciones') {
      const offset = (parseInt(page) - 1) * parseInt(limit);
      const { data, error, count } = await ComprasRepo.listarHistorialRecepciones(empresa_id, {
        orden_id: id, offset, limit: parseInt(limit),
      });
      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      return res.json({ recepciones: data || [], total: count || 0 });
    }

    if (id) {
      const { data, error } = await ComprasRepo.obtenerOrdenCompraDetalle(id, empresa_id);

      if (error || !data) return res.status(404).json({ error: 'Orden no encontrada' });
      return res.json(data);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // ── sin_facturar=1: para el selector "OC vinculada" al cargar una
    // factura de proveedor nueva. Sin esto, una OC que ya tiene una factura
    // (pendiente, parcial o pagada) sigue apareciendo como opción y se puede
    // terminar facturando dos veces la misma compra. Si se está editando una
    // factura existente, excluir_factura_id evita que la OC ya vinculada a
    // ESA factura se oculte a sí misma.
    let excluirIds;
    if (sin_facturar === '1') {
      const { data: facturadas, error: errFact } = await ComprasRepo.listarFacturasProveedorOrdenIds(empresa_id, excluir_factura_id);
      if (errFact) return errorSeguro(res, errFact, 500, 'No se pudo completar la operación.');

      const idsFacturados = [...new Set((facturadas || []).map(f => f.orden_id))];
      if (idsFacturados.length) excluirIds = idsFacturados;
    }

    const { data, error, count } = await ComprasRepo.listarOrdenesCompraFiltradas(empresa_id, {
      proveedor_id, estado, desde, hasta, offset, limit: parseInt(limit), excluirIds,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ordenes: data || [], total: count || 0 });
  }

  // ── Escritura ─────────────────────────────────────────────────────
  if (!esEscritor) return res.status(403).json({ error: 'Sin permisos de escritura' });

  if (req.method === 'POST') {
    // ── Recepcionar ───────────────────────────────────────────────
    if (req.query.accion === 'recepcionar') {
      const { orden_id, items, recepcion_id, deposito_id } = req.body;

      if (!orden_id || !Array.isArray(items) || !items.length)
        return res.status(400).json({ error: 'orden_id e items requeridos' });

      // ── Detalle real de lo recepcionado (para que el historial muestre
      // qué productos/cantidades se recibieron, no solo fecha+usuario) ──
      const idsProductos = items.map(it => it.producto_id).filter(Boolean);
      const productosDet = await obtenerProductosPorIds(idsProductos);
      const nombrePorId = Object.fromEntries((productosDet || []).map(p => [p.id, p]));
      const itemsDetalle = items.map(it => ({
        producto_id:       it.producto_id,
        nombre:            nombrePorId[it.producto_id]?.nombre || null,
        codigo:            nombrePorId[it.producto_id]?.codigo || null,
        cantidad_recibida: it.cantidad_recibida,
        precio_costo:      it.precio_costo ?? null,
      }));

      // ── Guard anti doble-submit: si en los últimos 8s se confirmó una
      // recepción para esta misma OC con exactamente el mismo detalle de
      // items, es casi con certeza un doble clic/reintento de red, no una
      // segunda entrega parcial real (las entregas reales llevan cantidades
      // distintas). Se rechaza antes de tocar stock.
      const haceOchoSeg = new Date(Date.now() - 8000).toISOString();
      const reciente = await ComprasRepo.buscarRecepcionRecienteDuplicada(empresa_id, orden_id, haceOchoSeg);

      if (reciente?.length && JSON.stringify(reciente[0].items_conciliados) === JSON.stringify(itemsDetalle)) {
        return res.status(409).json({ error: 'Esta recepción ya fue confirmada hace unos segundos (doble envío detectado).' });
      }

      const { data, error } = await ComprasRepo.recepcionarOrdenCompraRpc({
        p_empresa_id:  empresa_id,
        p_orden_id:    orden_id,
        p_items:       items,
        p_usuario_id:  user.id,
        p_deposito_id: deposito_id || null,
      });

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

      // Registrar siempre en recepciones_mercaderia para que quede en el historial.
      // Si vino del flujo OCR ya existe un borrador → confirmarlo.
      // Si es flujo manual (sin escaneo) → crear el registro directamente como confirmada.
      // En ambos casos se guarda itemsDetalle (lo realmente confirmado por el
      // usuario), no solo lo sugerido por OCR, para que el historial sea fiel.
      const ahora = new Date().toISOString();
      if (recepcion_id) {
        await ComprasRepo.confirmarRecepcionExistente(recepcion_id, empresa_id, {
          estado:             'confirmada',
          confirmada_at:      ahora,
          usuario_id:         user.id,
          items_conciliados:  itemsDetalle,
        });
      } else {
        await ComprasRepo.crearRecepcionConfirmada({
          empresa_id,
          orden_id:           orden_id,
          estado:             'confirmada',
          confirmada_at:      ahora,
          usuario_id:         user.id,
          datos_ocr:          null,
          items_conciliados:  itemsDetalle,
        });
      }

      return res.json(data);
    }

    // ── Subir foto de remito ──────────────────────────────────────
    if (req.query.accion === 'upload-remito') {
      const { imagen_base64, mime_type, recepcion_id } = req.body;

      if (!imagen_base64 || !mime_type || !recepcion_id)
        return res.status(400).json({ error: 'imagen_base64, mime_type y recepcion_id requeridos' });

      // Validar que la recepción pertenece a la empresa
      const recep = await ComprasRepo.obtenerRecepcionIdValida(recepcion_id, empresa_id);

      if (!recep) return res.status(404).json({ error: 'Recepción no encontrada' });

      const ext    = mime_type === 'application/pdf' ? 'pdf' : mime_type.split('/')[1] || 'jpg';
      const path   = `${empresa_id}/${recepcion_id}.${ext}`;
      const buffer = Buffer.from(imagen_base64, 'base64');

      const { error: uploadErr } = await ComprasRepo.subirRemitoStorage(path, buffer, mime_type);

      if (uploadErr)
        return errorSeguro(res, uploadErr, 500, 'Error al subir imagen.');

      const publicUrl = ComprasRepo.obtenerUrlPublicaRemito(path);

      await ComprasRepo.actualizarFotoRecepcion(recepcion_id, publicUrl);

      return res.json({ ok: true, foto_url: publicUrl });
    }

    // ── Descartar recepción (Fix hallazgo 4: 'descartada' existía en el
    // CHECK constraint y en el frontend (badge en compras.js) pero ningún
    // código la seteaba nunca — el usuario no tenía forma de rechazar un
    // remito escaneado por OCR que no correspondía) ─────────────────────
    if (req.query.accion === 'descartar-recepcion') {
      const { recepcion_id, motivo } = req.body;
      if (!recepcion_id) return res.status(400).json({ error: 'recepcion_id requerido' });

      const recep = await ComprasRepo.obtenerRecepcionParaDescartar(recepcion_id, empresa_id);

      if (!recep) return res.status(404).json({ error: 'Recepción no encontrada' });
      if (recep.estado !== 'borrador')
        return res.status(400).json({ error: `Solo se puede descartar una recepción en borrador (estado actual: ${recep.estado})` });

      const { data, error } = await ComprasRepo.descartarRecepcion(recepcion_id, empresa_id, {
        estado: 'descartada', notas: motivo?.trim() || null, usuario_id: user.id,
      });

      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      return res.json({ ok: true, recepcion: data });
    }

    // ── Historial de recepciones ──────────────────────────────────
    if (req.query.accion === 'historial-recepciones') {
      const { orden_id, limit: lim = '20', page: pg = '1' } = req.query;
      const offset = (parseInt(pg) - 1) * parseInt(lim);

      const { data, error, count } = await ComprasRepo.listarHistorialRecepcionesConOcr(empresa_id, {
        orden_id, offset, limit: parseInt(lim),
      });
      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      return res.json({ recepciones: data || [], total: count || 0 });
    }

    // ── Notificar proveedor por recepción (8.4) ───────────────────
    if (req.query.accion === 'notificar-proveedor') {
      const { recepcion_id } = req.body;

      if (!recepcion_id)
        return res.status(400).json({ error: 'recepcion_id requerido' });

      // Cargar recepción completa
      const { data: recepcion, error: errRecep } = await ComprasRepo.obtenerRecepcionParaNotificar(recepcion_id, empresa_id);

      if (errRecep || !recepcion)
        return res.status(404).json({ error: 'Recepción no encontrada' });

      // Cargar OC y proveedor
      const orden = await ComprasRepo.obtenerOrdenConProveedorParaNotificar(recepcion.orden_id, empresa_id);

      const proveedor = orden?.proveedores;
      if (!proveedor?.email)
        return res.status(422).json({ error: 'El proveedor no tiene email registrado' });

      // Cargar datos de la empresa (reusa lib/repos/pedidos.js — mismo select exacto)
      const empData = await obtenerEmpresaContacto(empresa_id);

      const items        = recepcion.items_conciliados || [];
      const discrepancias = recepcion.discrepancias    || [];

      const resultado = await enviarEmailRecepcionProveedor(
        proveedor,
        orden,
        recepcion,
        items,
        discrepancias,
        empData,
      );

      // FIX (Hallazgo 2, auditoría notificaciones — "reenvío manual de
      // emails"): antes este insert mandaba un campo `resend_id`, que no
      // existe como columna en notif_log (la columna real se llama
      // `message_id` — ver 005_notif_log.sql). Como el resultado del
      // insert nunca se revisaba (no había `.catch`/chequeo de `error`),
      // Postgres rechazaba el insert por la columna inexistente y fallaba
      // en silencio: en producción, tipo='recepcion_proveedor' tenía CERO
      // filas en notif_log a pesar de que el módulo se usaba activamente.
      // Además, el `return res.status(502)` de más abajo cortaba el flujo
      // ANTES de loguear cuando el envío fallaba — mismo patrón de "solo
      // registro lo que sale bien" corregido en handleEstadoCuenta. Ahora
      // se loguea siempre (éxito y falla), con la columna correcta, y
      // recién después se decide la respuesta HTTP.
      const { error: errNotifLog } = await insertarNotifLog({
        empresa_id,
        tipo:       'recepcion_proveedor',
        canal:      'email',
        email:      proveedor.email,
        message_id: resultado.id || null,
        entregada:  !!resultado.ok,
        motivo:     resultado.ok ? null : (resultado.razon || 'error_desconocido'),
        payload: {
          recepcion_id,
          orden_id:      recepcion.orden_id,
          proveedor_id:  proveedor.id,
          discrepancias: discrepancias.length,
          enviado_por:   user.id,
        },
      });
      if (errNotifLog) console.error('[PROVEEDORES] Error guardando notif_log de recepción:', errNotifLog.message);

      if (!resultado.ok)
        return res.status(502).json({ error: 'Error al enviar email', detalle: resultado });

      return res.json({ ok: true, resend_id: resultado.id, email: proveedor.email });
    }

    // ── Crear OC ──────────────────────────────────────────────────
    const { proveedor_id, fecha_esperada, notas, items } = req.body;

    if (!proveedor_id) return res.status(400).json({ error: 'proveedor_id requerido' });
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'items requeridos' });

    // Validar que el proveedor pertenece a la empresa
    const prov = await ProveedoresRepo.obtenerProveedorIdValido(empresa_id, proveedor_id);

    if (!prov) return res.status(400).json({ error: 'Proveedor no encontrado' });

    const { data, error } = await ComprasRepo.crearOrdenCompraRpc({
      p_empresa_id:    empresa_id,
      p_proveedor_id:  proveedor_id,
      p_fecha_esperada: fecha_esperada || null,
      p_notas:         notas || null,
      p_created_by:    user.id,
      p_items:         items,
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(201).json(data);
  }

  // ── PATCH: cambiar estado ─────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, estado } = req.body;
    if (!id || !estado) return res.status(400).json({ error: 'id y estado requeridos' });

    const estadosValidos = ['borrador','enviada','confirmada','cancelada'];
    if (!estadosValidos.includes(estado))
      return res.status(400).json({ error: 'Estado inválido' });

    const { data, error } = await ComprasRepo.actualizarEstadoOrdenCompra(id, empresa_id, {
      estado, updated_at: new Date().toISOString(),
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json(data);
  }

  // ── DELETE: eliminar (borrado físico, solo si nunca salió al proveedor) ──
  // Una OC en 'enviada'/'confirmada'/'recibida_parcial'/'recibida' ya tiene
  // efectos hacia afuera (el proveedor la vio, o ya impactó stock/factura);
  // para esas se usa PATCH estado='cancelada', no un borrado. Solo
  // 'borrador' y 'pendiente_aprobacion' son puramente internas.
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const orden = await ComprasRepo.obtenerOrdenCompraParaEliminar(id, empresa_id);
    if (!orden) return res.status(404).json({ error: 'Orden de compra no encontrada' });

    if (!['borrador', 'pendiente_aprobacion'].includes(orden.estado)) {
      return res.status(400).json({
        error: 'Solo se pueden eliminar órdenes en borrador o pendientes de aprobación. Esta ya fue enviada al proveedor: cancelala en su lugar.',
      });
    }

    if (await ComprasRepo.ordenTieneFacturaVinculada(id)) {
      return res.status(400).json({ error: 'Esta orden ya tiene una factura de proveedor vinculada y no se puede eliminar.' });
    }

    const { error } = await ComprasRepo.eliminarOrdenCompra(id, empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, user.id, 'ordenes_compra', 'DELETE', id,
      { numero: orden.numero, estado: orden.estado }, null,
    );

    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ══════════════════════════════════════════════════════════════════════
// Comparador de precios entre proveedores (Etapa 2, ítem 3/3 — Comercial y precios)
// GET ?_svc=comparador-precios                      → ranking de oportunidades de ahorro
// GET ?_svc=comparador-precios&producto_id=uuid      → detalle por proveedor de un producto
// Ambas leen de migración 244_etapa2_comparador_precios_proveedores.sql
// (ranking_ahorro_proveedores / comparar_precios_proveedores), que solo
// considera OCs con estado='recibida' (precio confirmado, no especulativo).
async function handleComparadorPrecios(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Método no permitido' });

  // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await ComprasRepo.obtenerPerfilCompras(user.id);

  if (!perfil || !puede(perfil, 'leer', 'comparador_precios'))
    return res.status(403).json({ error: 'Sin permisos' });

  const empresa_id = perfil.empresa_id;
  const { producto_id, meses, limit } = req.query;

  const mesesNum = Math.min(Math.max(parseInt(meses, 10) || 12, 1), 36);

  // ── Detalle por producto ────────────────────────────────────────────
  if (producto_id) {
    const { data, error } = await ComprasRepo.compararPreciosProveedoresRpc({
      p_empresa_id:  empresa_id,
      p_producto_id: producto_id,
      p_meses:       mesesNum,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ detalle: data || [] });
  }

  // ── Ranking de oportunidades de ahorro ──────────────────────────────
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const { data, error } = await ComprasRepo.rankingAhorroProveedoresRpc({
    p_empresa_id: empresa_id,
    p_meses:      mesesNum,
    p_limit:      limitNum,
  });
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ ranking: data || [] });
}
