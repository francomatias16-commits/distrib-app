// lib/handlers/pedidos/devoluciones.js
// Lógica compartida de alta de devolución (usada por el chofer y por el
// admin) y gestión admin de devoluciones. Extraído de
// lib/handlers/pedidos.js (25/08/2026).

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import { errorSeguro } from '../../error-response.js';
import { puede } from '../../permisos-service.js';
import {
  actualizarEstadoDevolucion,
  actualizarNotasDevolucion,
  ajustarStockRpc,
  anularNotasDebitoDeDevolucion,
  calcularScoreClienteRpc,
  contarDevolucionesPorEstado,
  crearDevolucionValidadaRpc,
  crearNotaCreditoRpc,
  crearNotaDebitoProveedor,
  eliminarDevolucion,
  listarDevolucionesFiltradas,
  listarItemsDevolucionConProducto,
  listarItemsDevolucionParaReponer,
  listarNotasDebitoDeDevolucion,
  marcarItemDevolucionError,
  marcarItemDevolucionRepuesto,
  obtenerClienteCondicionIva,
  obtenerDepositoPorId,
  obtenerDepositoPrincipal,
  obtenerDevolucionDetalle,
  obtenerDevolucionParaEliminar,
  obtenerFacturaRecienteDePedido,
  obtenerPerfilParaDevolucionesAdmin,
} from '../../repos/pedidos.js';
import { obtenerProveedorDefaultPorProductos } from '../../repos/productos.js';
import {
  applyCorsHeaders,
  applySecurityHeaders,
} from '../../security-headers.js';
import {
  firmarCampoUrl,
  firmarCampoUrlEnLista,
} from '../../utils/storage-urls.js';
import { notifAuto } from '../_auto-push.js';
import { validarImagenReal } from './_helpers.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export async function crearDevolucionCore({ empresa_id, chofer_id: creado_por_id, body }) {
  const MOTIVOS_VALIDOS = ['producto_defectuoso', 'error_pedido', 'cliente_arrepentido', 'vencido', 'otro'];
  const { pedido_id, motivo, notas, foto_url, offline_local_id } = body;
  const items = Array.isArray(body.items) ? body.items : [];

  if (!motivo || !MOTIVOS_VALIDOS.includes(motivo))
    return { ok: false, status: 400, error: 'Motivo inválido' };
  if (!items.length)
    return { ok: false, status: 400, error: 'La devolución necesita al menos un ítem' };

  // Migración 570 (Etapa 7, Bloque 1): toda la validación de "cantidad
  // disponible para devolver" + la resolución server-side del precio
  // (pedido vinculado, si lo hay, o precio_base) + el insert de cabecera
  // e ítems ahora vive en una única transacción de Postgres
  // (`rpc_crear_devolucion_validada`), serializada por cliente con un
  // advisory lock.
  //
  // Antes esto se hacía acá en JS con 2 SELECTs sueltos (comprado histórico
  // y ya-reservado) y recién después el INSERT, sin lock — dos altas
  // simultáneas del mismo cliente+producto (chofer + admin, o admin +
  // asistente de WhatsApp) podían leer el mismo "disponible" y las dos
  // pasar la validación, superando entre las dos lo realmente comprado.
  // Mismo eje de riesgo que el incidente real de v805 (~$9,86M), pero de
  // concurrencia en vez de validación faltante. La RPC cierra esa ventana;
  // ver migración `570_rpc_crear_devolucion_validada_fix_race_condition`.
  //
  // De paso, un fallo insertando los ítems ahora revierte toda la
  // transacción solo — ya no hace falta la "compensación" manual de la
  // cabecera que existía antes (y que podía fallar también).
  const { data: rpcResult, error: rpcError } = await crearDevolucionValidadaRpc({
    p_empresa_id: empresa_id,
    p_cliente_id: body.cliente_id || null,
    p_pedido_id: pedido_id || null,
    p_chofer_id: creado_por_id,
    p_motivo: motivo,
    p_notas: notas || null,
    p_foto_url: foto_url || null,
    p_offline_local_id: offline_local_id || null,
    p_items: items.map(it => ({ producto_id: it.producto_id, cantidad: it.cantidad })),
  });

  if (rpcError) return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  if (!rpcResult?.ok) return { ok: false, status: 400, error: rpcResult?.error || 'No se pudo completar la operación.' };

  if (rpcResult.offline_replay) {
    return {
      ok: true,
      payload: {
        ok: true,
        devolucion: rpcResult.devolucion,
        notas_debito: [],
        items_sin_proveedor_default: [],
        offline_replay: true,
      },
    };
  }

  const devolucion = rpcResult.devolucion;

  // Si es producto defectuoso: nota de débito automática al proveedor,
  //    agrupada por producto.proveedor_id_default
  let notasDebitoCreadas = [];
  // Migración 193: antes este array no existía y los ítems sin
  // proveedor_id_default se descartaban en silencio (ver
  // v_productos_sin_proveedor_default para el gap de datos subyacente).
  let itemsSinProveedorDefault = [];
  if (motivo === 'producto_defectuoso') {
    // Migración 570: el precio_unitario ya no viaja en `items` (el body
    // original) — se resuelve server-side dentro de la RPC. Se traen los
    // ítems reales insertados (mismo helper que usa la NC más abajo).
    const itemsInsertados = await listarItemsDevolucionConProducto(devolucion.id);
    const productoIds = [...new Set(itemsInsertados.map(it => it.producto_id))];
    const productos = await obtenerProveedorDefaultPorProductos(productoIds);

    const proveedorPorProducto = new Map((productos || []).map(p => [p.id, p.proveedor_id_default]));
    const nombrePorProducto = new Map((productos || []).map(p => [p.id, p.nombre]));
    const montoPorProveedor = new Map();

    for (const it of itemsInsertados) {
      const proveedor_id = proveedorPorProducto.get(it.producto_id);
      if (!proveedor_id) {
        // Sin proveedor por defecto -> queda para manejo manual, pero ahora
        // se reporta explícitamente en vez de descartarse en silencio.
        itemsSinProveedorDefault.push({
          producto_id: it.producto_id,
          nombre: nombrePorProducto.get(it.producto_id) || null,
          cantidad: it.cantidad,
        });
        continue;
      }
      const monto = (+it.cantidad || 0) * (+it.precio_unitario || 0);
      montoPorProveedor.set(proveedor_id, (montoPorProveedor.get(proveedor_id) || 0) + monto);
    }

    for (const [proveedor_id, monto] of montoPorProveedor.entries()) {
      const nd = await crearNotaDebitoProveedor({
        empresa_id, proveedor_id, devolucion_id: devolucion.id,
        motivo: `Producto defectuoso — devolución de cliente (ref. ${devolucion.id.slice(0, 8)})`,
        monto, estado: 'pendiente',
      });
      if (nd) notasDebitoCreadas.push(nd);
    }
  }

  // 4. Recalcular score del cliente ahora (best-effort, no bloquea la respuesta)
  //
  // FIX (post-migración 570): `cliente_id` no estaba declarado en este
  // scope — la desestructuración de `body` en la cabecera de la función
  // nunca lo incluyó (venía de una validación previa en JS que la
  // migración 570 movió a la RPC). Referenciarlo acá tiraba
  // `ReferenceError: cliente_id is not defined` de forma síncrona en
  // TODA devolución creada con éxito, sin try/catch que lo contuviera:
  // el alta ya había quedado grabada en la DB (la RPC ya hizo commit),
  // pero la request completa reventaba antes de notificar al admin y de
  // devolver el payload de éxito al cliente/chofer.
  calcularScoreClienteRpc({
    p_cliente_id: body.cliente_id, p_empresa_id: empresa_id, p_motivo: 'devolucion_registrada',
  }).then(() => {}).catch(err => console.error(`[PEDIDOS] Error recalculando score cliente ${body.cliente_id} tras devolución:`, err.message));

  // 5. Notificar al admin
  await notifAuto(empresa_id, {
    tipo: 'cierre_error_cola',
    titulo: 'Devolución registrada',
    cuerpo: `Devolución pendiente de revisión (motivo: ${motivo}).`,
    link: '/admin/devoluciones',
  });

  // Migración 193: si hubo producto_defectuoso con ítems sin proveedor
  // por defecto, avisar aparte -- antes esto no generaba ninguna señal.
  if (itemsSinProveedorDefault.length) {
    await notifAuto(empresa_id, {
      tipo: 'cierre_error_cola',
      titulo: '⚠ Nota de débito no generada',
      cuerpo: `${itemsSinProveedorDefault.length} ítem(s) de la devolución no generaron nota de débito automática por falta de proveedor por defecto en el producto. Revisar en /admin/productos.`,
      link: '/admin/devoluciones',
    });
  }

  return {
    ok: true,
    payload: {
      ok: true,
      devolucion,
      notas_debito: notasDebitoCreadas,
      items_sin_proveedor_default: itemsSinProveedorDefault,
    },
  };
}

// ─── Admin: gestión de devoluciones (Innovación #2) ────────────────────────
//
// GET   ?accion=listar    → lista de devoluciones (filtros: estado, motivo, q, page, limit)
// GET   ?accion=kpis      → conteos globales por estado (pendientes/aprobadas/rechazadas)
// GET   ?id=uuid           → detalle con items + notas de débito asociadas
// PATCH ?accion=revisar    → { id, estado: 'aprobada'|'rechazada' }
export async function handleDevolucionesAdmin(req, res) {
  // SEC-11: mismo fix que handleChofer — wildcard reemplazado por la
  // allowlist central (ver comentario ahí).
  applySecurityHeaders(res);
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaDevolucionesAdmin(user.id);
  if (!perfil || !puede(perfil, 'leer', 'devoluciones'))
    return res.status(403).json({ error: 'Sin permisos para consultar devoluciones' });

  const empresa_id = perfil.empresa_id;
  const { id, accion } = req.query;

  // ── Subir foto (para adjuntar a un alta manual) ──────────────────────
  // Mismo bucket 'devoluciones' que usa el chofer; el admin tampoco puede
  // subir directo con su JWT (el bucket solo permite INSERT vía service_role).
  if (req.method === 'POST' && accion === 'foto') {
    const { foto_base64 } = req.body || {};
    if (!foto_base64 || typeof foto_base64 !== 'string')
      return res.status(400).json({ error: 'foto_base64 requerida' });

    const match = foto_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de imagen inválido' });

    const mime = `image/${match[1].toLowerCase()}`;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ error: 'Solo se permiten imágenes JPEG, PNG o WebP' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    const buffer = Buffer.from(match[2], 'base64');
    if (!validarImagenReal(buffer, mime))
      return res.status(400).json({ error: 'El contenido no coincide con el tipo de imagen declarado' });

    const MAX_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'La imagen no puede superar 8MB' });

    const path = `${empresa_id}/admin-${user.id}/${Date.now()}.${ext}`;
    const { error: errUpload } = await supabase.storage
      .from('devoluciones')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'devoluciones' privado. Se devuelve el path — el alta
    // manual no muestra preview antes de guardar, solo lo reenvía en el
    // POST de creación (ver ndSubirFotoSiCorresponde en el frontend).
    return res.status(201).json({ ok: true, foto_url: path });
  }

  // ── Crear (alta manual desde el admin, sin pasar por la app del chofer) ──
  if (req.method === 'POST' && !accion) {
    if (!puede(perfil, 'crear', 'devoluciones')) return res.status(403).json({ error: 'Sin permiso para crear devoluciones' });
    const resultado = await crearDevolucionCore({ empresa_id, chofer_id: user.id, body: req.body || {} });
    if (!resultado.ok) return res.status(resultado.status || 400).json({ error: resultado.error });
    return res.status(201).json(resultado.payload);
  }

  // ── Editar notas (en cualquier momento, no solo al revisar) ─────────────
  if (req.method === 'PATCH' && accion === 'notas') {
    if (!puede(perfil, 'editar', 'devoluciones')) return res.status(403).json({ error: 'Sin permiso para editar devoluciones' });
    const { id: devId, notas } = req.body || {};
    if (!devId) return res.status(400).json({ error: 'id requerido' });
    const { data, error } = await actualizarNotasDevolucion(empresa_id, devId, notas);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true, devolucion: data });
  }

  // ── Eliminar (solo devoluciones pendientes — una vez revisada queda
  //    como registro histórico, no se borra) ───────────────────────────
  if (req.method === 'DELETE' && id) {
    if (!puede(perfil, 'eliminar', 'devoluciones')) return res.status(403).json({ error: 'Sin permiso para eliminar devoluciones' });
    const existente = await obtenerDevolucionParaEliminar(empresa_id, id);
    if (!existente) return res.status(404).json({ error: 'Devolución no encontrada' });
    if (existente.estado !== 'pendiente')
      return res.status(400).json({ error: 'Solo se pueden eliminar devoluciones pendientes de revisión' });

    // Las notas de débito automáticas que se hayan generado al crearla
    // (motivo producto_defectuoso) quedan huérfanas si no se anulan.
    await anularNotasDebitoDeDevolucion(id);

    // devolucion_items se borra en cascada (ON DELETE CASCADE, ver 006_logistica.sql)
    const { error } = await eliminarDevolucion(empresa_id, id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true });
  }

  // ── Detalle ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && id) {
    const { data: devolucion, error } = await obtenerDevolucionDetalle(empresa_id, id);

    if (error) return res.status(404).json({ error: 'Devolución no encontrada' });

    const notasDebito = await listarNotasDebitoDeDevolucion(id);
    const devolucionConUrl = await firmarCampoUrl(supabase, 'devoluciones', devolucion, 'foto_url');

    return res.json({ ...devolucionConUrl, notas_debito: notasDebito || [] });
  }

  // ── KPIs (conteos globales por estado, independientes del filtro/página) ──
  if (req.method === 'GET' && accion === 'kpis') {
    const [pendientes, aprobadas, rechazadas] = await Promise.all([
      contarDevolucionesPorEstado(empresa_id, 'pendiente'),
      contarDevolucionesPorEstado(empresa_id, 'aprobada'),
      contarDevolucionesPorEstado(empresa_id, 'rechazada'),
    ]);
    return res.json({ pendientes, aprobadas, rechazadas });
  }

  // ── Listar ────────────────────────────────────────────────────────────
  // FIX (continuación AUDITORIA_FILTROS_v280 §5): antes traía hasta 200
  // devoluciones sin filtro de búsqueda/motivo server-side (solo `estado`
  // estaba soportado en el backend, pero el frontend ni lo mandaba —
  // filtraba las 3 columnas con Array.filter() en el navegador sobre el
  // recorte fijo, sin debounce en el buscador). Volumen actual: 0 filas
  // en jgiquzjwoedmzwqgzubr (confirmado), pero se corrige por consistencia
  // con el resto de los módulos ya migrados.
  if (req.method === 'GET') {
    const { estado, motivo, q: busqueda, fecha_desde, fecha_hasta, pedido_id } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 50));
    const desde = (page - 1) * limit;
    const hasta = desde + limit - 1;

    const { data, error, count } = await listarDevolucionesFiltradas({
      empresa_id, estado, motivo, busqueda, fecha_desde, fecha_hasta, desde, hasta, pedido_id,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    const devoluciones = await firmarCampoUrlEnLista(supabase, 'devoluciones', data || [], 'foto_url');
    return res.json({ devoluciones, total: count ?? 0, page, limit });
  }

  // ── Revisar (aprobar / rechazar) ─────────────────────────────────────
  //
  // FIX (auditoría etapa 9 — módulos): la página decía explícitamente
  // "decidí si repone stock o genera nota de crédito" pero ninguna de las
  // dos cosas existía en el código — aprobar una devolución solo cambiaba
  // el estado y (si el motivo era producto_defectuoso) dejaba la nota de
  // débito al proveedor como estaba. El cliente que devolvía mercadería no
  // recibía nunca stock repuesto ni crédito; había que hacerlo a mano y sin
  // ningún vínculo con la devolución de origen. Ahora el admin puede tildar
  // una o ambas opciones al aprobar.
  if (req.method === 'PATCH' && accion === 'revisar') {
    if (!puede(perfil, 'revisar', 'devoluciones'))
      return res.status(403).json({ error: 'Sin permiso para revisar devoluciones' });

    const { id: devId, estado, reponer_stock, generar_nc, deposito_id, items_reponer } = req.body || {};
    if (!devId || !['aprobada', 'rechazada'].includes(estado))
      return res.status(400).json({ error: 'id y estado (aprobada|rechazada) requeridos' });

    const { data: devolucion, error } = await actualizarEstadoDevolucion(empresa_id, devId, estado);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // FIX v804: data=null significa que el UPDATE no matcheó ninguna fila
    // porque la devolución ya no estaba en 'pendiente' (ya fue revisada antes
    // — típico de un reintento del front tras un error transitorio). Cortar
    // acá evita reponer stock y generar la nota de crédito por segunda vez.
    if (!devolucion) {
      const { data: actual } = await obtenerDevolucionDetalle(empresa_id, devId);
      const actualConUrl = await firmarCampoUrl(supabase, 'devoluciones', actual, 'foto_url');
      return res.status(409).json({
        error: actual
          ? `Esta devolución ya fue revisada (estado actual: ${actual.estado}). No se volvió a procesar.`
          : 'Devolución no encontrada.',
        devolucion: actualConUrl || null,
      });
    }

    // Si se rechaza, anular las notas de débito vinculadas (el producto
    // no resultó defectuoso según revisión admin -> no corresponde el débito)
    if (estado === 'rechazada') {
      await anularNotasDebitoDeDevolucion(devId);
    }

    const resultado = { ok: true, devolucion, stock_repuesto: [], stock_errores: [], nota_credito: null };

    // ── Reponer stock (solo si se aprueba y el admin lo pidió) ──────────
    if (estado === 'aprobada' && reponer_stock) {
      // Reposición parcial: si el admin destildó algún ítem en el panel,
      // items_reponer trae solo los ids de devolucion_items a reponer.
      const items = await listarItemsDevolucionParaReponer(devId, items_reponer);

      // Depósito elegido por el admin en el panel; si no mandó ninguno,
      // cae al principal (comportamiento previo, retrocompatible).
      const deposito = deposito_id
        ? await obtenerDepositoPorId(empresa_id, deposito_id)
        : await obtenerDepositoPrincipal(empresa_id);

      if (!deposito) {
        resultado.stock_errores.push('No se encontró el depósito destino — no se pudo reponer el stock.');
      } else {
        for (const it of (items || [])) {
          const { data: rpcResult, error: rpcError } = await ajustarStockRpc({
            p_producto_id: it.producto_id,
            p_deposito_id: deposito.id,
            p_delta: it.cantidad,
            p_tipo: 'ingreso',
            p_motivo: `Reposición por devolución aprobada (ref. ${devId.slice(0, 8)})`,
            p_notas: null,
            p_usuario_id: user.id,
          });
          if (rpcError || !rpcResult?.ok) {
            const mensaje = rpcError?.message || rpcResult?.error || 'error desconocido';
            await marcarItemDevolucionError(it.id, mensaje);
            resultado.stock_errores.push(`Producto ${it.producto_id}: ${mensaje}`);
          } else {
            const { error: marcaError } = await marcarItemDevolucionRepuesto(it.id, deposito.id);
            if (marcaError) {
              resultado.stock_errores.push(`Producto ${it.producto_id}: el stock se repuso, pero no se pudo marcar el ítem como procesado (${marcaError.message})`);
            } else {
              resultado.stock_repuesto.push({ producto_id: it.producto_id, cantidad: it.cantidad });
            }
          }
        }
      }
    }

    // ── Generar nota de crédito pendiente (solo si se aprueba y el admin
    //    lo pidió) — queda en estado 'pendiente', igual que una NC manual;
    //    la emisión real contra ARCA se hace desde el panel de Notas de
    //    Crédito, como con cualquier otra NC.
    if (estado === 'aprobada' && generar_nc && devolucion?.cliente_id) {
      const items = await listarItemsDevolucionConProducto(devId);

      const itemsNC = (items || [])
        .filter(it => it.cantidad > 0)
        .map(it => ({
          descripcion: it.productos?.nombre || 'Producto devuelto',
          cantidad: it.cantidad,
          precio_unitario: it.precio_unitario || 0,
        }))
        .filter(it => it.precio_unitario > 0);

      if (!itemsNC.length) {
        resultado.stock_errores.push('La devolución no tiene ítems con precio > 0 — no se generó la NC.');
      } else {
        const cliente = await obtenerClienteCondicionIva(devolucion.cliente_id);
        const tipoNC = cliente?.condicion_iva === 'responsable_inscripto' ? 'A' : 'B';

        // factura asociada: la más reciente del mismo pedido, si existe
        let factura_id = null;
        if (devolucion.pedido_id) {
          const fact = await obtenerFacturaRecienteDePedido(devolucion.pedido_id);
          factura_id = fact?.id || null;
        }

        const { data: nc, error: errNC } = await crearNotaCreditoRpc({
          p_empresa_id: empresa_id,
          p_cliente_id: devolucion.cliente_id,
          p_tipo:       tipoNC,
          p_motivo:     `Devolución aprobada (ref. ${devId.slice(0, 8)}) — ${devolucion.motivo}`,
          p_items:      itemsNC,
          p_factura_id: factura_id,
          p_created_by: user.id,
        });

        if (errNC || nc?.ok === false) {
          resultado.stock_errores.push(`No se pudo generar la NC: ${errNC?.message || nc?.error}`);
        } else {
          resultado.nota_credito = nc;
        }
      }
    }

    // Recalcular score: el cambio de estado afecta el cálculo (rechazadas
    // se excluyen del componente de devoluciones)
    //
    // FIX v803: el objeto que devuelve calcularScoreClienteRpc() (un
    // PostgrestFilterBuilder de supabase-js) es "thenable" — implementa
    // .then() pero NO .catch()/.finally() como métodos propios. Encadenar
    // `.catch()` directo sobre él (sin pasar antes por `.then()`, que sí
    // devuelve una Promise nativa) tira "TypeError: ...catch is not a
    // function" — reventaba con 500 CUALQUIER aprobación/rechazo de
    // devolución (correlation_id 9a1c8bf1, ver logs de Vercel). Acá,
    // a diferencia del alta manual (línea ~2728, fire-and-forget con
    // `.then().catch()`), esto ya se espera con `await` — alcanza con
    // try/catch normal, que sí funciona sobre un thenable.
    if (devolucion?.cliente_id) {
      try {
        await calcularScoreClienteRpc({
          p_cliente_id: devolucion.cliente_id, p_empresa_id: empresa_id,
          p_motivo: `devolucion_${estado}`,
        });
      } catch { /* best-effort: no debe bloquear la revisión de la devolución */ }
    }

    return res.json(resultado);
  }

  return res.status(405).json({ error: 'Método o acción no soportada' });
}
