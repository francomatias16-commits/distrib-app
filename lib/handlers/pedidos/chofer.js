// lib/handlers/pedidos/chofer.js
// Portal del chofer (PWA de entrega): /api/chofer/*. Extraído de
// lib/handlers/pedidos.js (25/08/2026).

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import * as AuditRepo from '../../repos/audit.js';
import { errorSeguro } from '../../error-response.js';
import { puede } from '../../permisos-service.js';
import {
  actualizarCantidadItemPedido,
  buscarEntregaPorOfflineLocalId,
  listarClientesConPedidosActivos,
  listarEntregasPorRutas,
  listarPedidosParaRemitos,
  listarRutasDelDia,
  marcarEntregaCompletada,
  marcarEntregaNoRealizada,
  marcarPedidoDespachado,
  marcarPedidoEntregado,
  obtenerEntregaActivaDelPedido,
  obtenerPedidoParaDespacho,
  obtenerPedidoParaEntrega,
  obtenerPerfilChofer,
  obtenerRemitoDetalle,
  obtenerUltimaEntregaDelPedido,
  registrarCobroCompletoRpc,
  revertirPedidoAConfirmado,
} from '../../repos/pedidos.js';
import { buscarProductosParaRemito } from '../../repos/productos.js';
import {
  applyCorsHeaders,
  applySecurityHeaders,
} from '../../security-headers.js';
import { sincronizarEstadoRuta, hoyArgentina, validarImagenReal } from './_helpers.js';
import { crearDevolucionCore } from './devoluciones.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

async function pedidoEsDeEsteChofer(pedido_id, chofer_id) {
  const data = await obtenerEntregaActivaDelPedido(pedido_id);
  return !!data && data.rutas?.chofer_id === chofer_id;
}

export async function handleChofer(req, res) {
  // SEC-11: antes fijaba wildcard '*' acá, pisando la allowlist central de
  // orígenes con una política más abierta para este handler mutante en
  // particular. Bearer token reduce la explotación automática por navegador,
  // pero seguía siendo una superficie cross-origin innecesariamente abierta.
  applySecurityHeaders(res);
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Auth ──────────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilChofer(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'pedidos_chofer'))
    return res.status(403).json({ error: 'Acceso restringido al portal del chofer' });

  const empresa_id = perfil.empresa_id;
  const chofer_id  = perfil.id;
  const esAdmin    = ['dueno', 'admin'].includes(perfil.rol);

  // ── Router interno por _ruta param (inyectado desde vercel.json path) ─
  // La ruta original llega como req.query._ruta:
  //   /api/chofer/remitos              → _ruta = "remitos"
  //   /api/chofer/remitos/:id/entregar → _ruta = "entregar" + req.query.id
  //   /api/chofer/clientes             → _ruta = "clientes"
  //   /api/chofer/productos            → _ruta = "productos"
  const ruta = req.query._ruta || 'remitos';

  // ════════════════════════════════════
  // GET /api/chofer/remitos
  // ════════════════════════════════════
  if (ruta === 'remitos' && req.method === 'GET') {
    const hoy   = req.query.fecha || hoyArgentina();
    const { id } = req.query;

    // Detalle de un remito específico
    if (id) {
      const { data, error } = await obtenerRemitoDetalle(empresa_id, id);

      if (error) return res.status(404).json({ error: 'Remito no encontrado' });

      // CHOFER-001: un chofer (no admin) solo puede ver el detalle de un
      // remito si tiene una entrega activa asignada en su propia ruta.
      if (!esAdmin && !(await pedidoEsDeEsteChofer(id, chofer_id)))
        return res.status(404).json({ error: 'Remito no encontrado' });

      // ruta_id de la entrega asociada — lo necesita el front del chofer
      // para mandar el GPS (accion=posicion) mientras reparte este pedido.
      // Se trae también el cobro (si hubo) para mostrarlo una vez entregado.
      const entregaDeEstePedido = await obtenerUltimaEntregaDelPedido(id);

      return res.json({
        ...data,
        numero_pedido: data.id.slice(0, 8).toUpperCase(),
        notas: data.notas_cliente,
        ruta_id: entregaDeEstePedido?.ruta_id || null,
        monto_cobrado: entregaDeEstePedido?.monto_cobrado ?? null,
        medio_cobro: entregaDeEstePedido?.medio_cobro ?? null,
      });
    }

    // FIX: la asignación real pedido↔chofer NO vive en pedidos.chofer_id
    // (ese campo no lo escribe ningún flujo de la app — confirmado, está
    // siempre en NULL salvo carga manual). El vínculo real es
    // rutas.chofer_id + entregas.pedido_id (ver frontend/admin/js/rutas.js,
    // confirmarRuta(): crea la ruta con chofer_id y las entregas con
    // pedido_id, pero nunca actualiza pedidos.chofer_id).
    const { data: rutasHoy, error: errRutas } = await listarRutasDelDia(empresa_id, hoy, esAdmin ? null : chofer_id);
    if (errRutas) return errorSeguro(res, errRutas, 500, 'No se pudo completar la operación.');

    const rutaIds = (rutasHoy || []).map(r => r.id);
    if (rutaIds.length === 0) return res.json({ remitos: [], fecha: hoy });

    const { data: entregasHoy, error: errEntregas } = await listarEntregasPorRutas(rutaIds);
    if (errEntregas) return errorSeguro(res, errEntregas, 500, 'No se pudo completar la operación.');

    const pedidoIds = [...new Set((entregasHoy || []).map(e => e.pedido_id))];
    if (pedidoIds.length === 0) return res.json({ remitos: [], fecha: hoy });

    // Mapa pedido_id → ruta_id (lo usa el front del chofer para mandar GPS)
    const rutaIdPorPedido = new Map((entregasHoy || []).map(e => [e.pedido_id, e.ruta_id]));

    const { data, error } = await listarPedidosParaRemitos(empresa_id, pedidoIds);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    const remitos = (data || []).map(r => ({
      ...r,
      numero_pedido: r.id.slice(0, 8).toUpperCase(),
      ruta_id: rutaIdPorPedido.get(r.id) || null,
    }));
    return res.json({ remitos, fecha: hoy, ruta_id: rutaIds[0] || null });
  }

  // ════════════════════════════════════
  // POST /api/chofer/remitos
  // Registrar nuevo remito manual
  // ════════════════════════════════════
  if (ruta === 'remitos' && req.method === 'POST') {
    const { pedido_id, notas_chofer, items_entregados } = req.body || {};
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

    const pedido = await obtenerPedidoParaDespacho(empresa_id, pedido_id);

    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!['confirmado', 'preparando'].includes(pedido.estado))
      return res.status(400).json({ error: `Estado inválido para despacho: ${pedido.estado}` });

    // Marcar pedido como despachado y asignar chofer
    const { error: errPatch } = await marcarPedidoDespachado(pedido_id, { notas_chofer });

    if (errPatch) return errorSeguro(res, errPatch, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, chofer_id, 'pedidos', 'UPDATE', pedido_id,
      { estado: pedido.estado }, { estado: 'despachado', notas_chofer: notas_chofer || null }
    );

    // Si vienen items parciales, registrarlos
    if (Array.isArray(items_entregados) && items_entregados.length > 0) {
      const updates = items_entregados.map(({ item_id, cantidad_entregada }) =>
        actualizarCantidadItemPedido(item_id, cantidad_entregada, { pedido_id })
      );
      const resultados = await Promise.allSettled(updates);
      const fallosItems = resultados
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'No se pudo actualizar un ítem');
      if (fallosItems.length) {
        return res.status(207).json({
          ok: false,
          parcial: true,
          pedido_id,
          estado: 'despachado',
          fallos: fallosItems,
          error: 'El despacho se registró, pero algunos ítems no pudieron actualizarse.',
        });
      }
    }

    return res.status(201).json({ ok: true, pedido_id, estado: 'despachado' });
  }

  // ════════════════════════════════════
  // PATCH /api/chofer/remitos → entregar
  // ════════════════════════════════════
  if (ruta === 'entregar' && req.method === 'PATCH') {
    const { id, firma_url, foto_url, notas_entrega, items_entregados, receptor, cobro, offline_local_id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });

    // Punto 6 (auditoría financiera 2026, "puntos críticos" fase A): resolver
    // y autorizar el pedido (empresa + pertenencia al chofer, CHOFER-001)
    // ANTES del fast-path de idempotencia — antes se validaba recién
    // después, así que un offline_local_id ajeno (ej. de otro chofer de la
    // misma empresa) podía disparar una respuesta de éxito sobre un pedido
    // que no le pertenece, sin pasar nunca por el chequeo CHOFER-001. Esto
    // NO valida el estado del pedido todavía (eso sigue yendo después del
    // fast-path, ver comentario abajo) — solo que el pedido existe en esta
    // empresa y que este chofer puede operarlo.
    const pedido = await obtenerPedidoParaEntrega(empresa_id, id);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!esAdmin && !(await pedidoEsDeEsteChofer(id, chofer_id)))
      return res.status(404).json({ error: 'Pedido no encontrado' });

    // Plan offline — Etapa 3: fast path de idempotencia. Si este
    // offline_local_id ya generó una fila en `entregas` (reintento del
    // outbox tras reconectar, o doble tap del chofer mientras la primera
    // request seguía en vuelo), devolver éxito sin reprocesar — clave para
    // no duplicar el cobro asociado (ver registrarCobroCompletoRpc abajo).
    // Va ANTES del chequeo de estado 'despachado' a propósito: en un
    // reintento el pedido ya va a estar 'entregado', y ese chequeo de
    // estado rechazaría el reintento como si fuera un error real. También
    // se exige que la entrega encontrada sea la de ESTE pedido_id (no solo
    // el mismo offline_local_id+empresa) — evita devolver "entregado" para
    // un id de pedido que no corresponde a esa entrega.
    if (offline_local_id) {
      const yaExiste = await buscarEntregaPorOfflineLocalId(empresa_id, offline_local_id);
      if (yaExiste && yaExiste.pedido_id === id) {
        return res.json({ ok: true, pedido_id: id, estado: 'entregado', offline_replay: true });
      }
    }

    if (pedido.estado !== 'despachado')
      return res.status(400).json({ error: 'El pedido no está despachado' });

    // ── Cobro contra entrega (auditoría UX v2 — brecha funcional real) ────
    // Opcional: el chofer puede registrar que cobró efectivo/transferencia/
    // cheque al momento de entregar. Se resuelve ANTES de marcar la entrega
    // como completada: si el cobro fue completado (monto ingresado) pero
    // falla, se corta acá y la entrega queda sin confirmar, para que el
    // chofer pueda corregir el monto/medio y reintentar sin perder la firma
    // ya subida (firma_url/foto_url ya están en Storage, no se pierden).
    let cobro_id = null;
    const montoCobro = cobro?.monto != null ? Number(cobro.monto) : null;
    if (cobro && (!Number.isFinite(montoCobro) || montoCobro <= 0)) {
      return res.status(400).json({ error: 'El monto del cobro debe ser un número positivo y válido.' });
    }
    const MEDIOS_COBRO_CHOFER = new Set(['efectivo', 'transferencia', 'cheque', 'otro']);
    if (cobro && !MEDIOS_COBRO_CHOFER.has(cobro.medio)) {
      return res.status(400).json({ error: 'Medio de cobro inválido.' });
    }
    if (montoCobro != null && montoCobro > 0) {
      if (!pedido.cliente_id)
        return res.status(400).json({ error: 'El pedido no tiene cliente asociado, no se puede registrar el cobro' });
      if (!cobro?.medio)
        return res.status(400).json({ error: 'Seleccioná el medio de pago del cobro' });

      const { data: rpcData, error: rpcError } = await registrarCobroCompletoRpc({
        p_empresa_id: empresa_id,
        p_cliente_id: pedido.cliente_id,
        p_usuario_id: chofer_id,
        p_monto:      montoCobro,
        p_medio:      cobro.medio,
        p_referencia: pedido.numero_pedido ? `Remito #${pedido.numero_pedido}` : null,
        p_notas:      cobro.notas || 'Cobro registrado por el chofer al confirmar la entrega',
        // Plan offline — Etapa 3: mismo offline_local_id que la entrega,
        // sufijado, para que un reintento del cobro (aunque el resto del
        // handler no haya llegado a guardar entregas.offline_local_id)
        // también sea idempotente — ver migración 442.
        p_offline_local_id: offline_local_id ? `${offline_local_id}-cobro` : null,
      });
      if (rpcError) return errorSeguro(res, rpcError, 500, 'No se pudo registrar el cobro.');
      if (rpcData && rpcData.ok === false)
        return res.status(400).json({ error: rpcData.error || 'No se pudo registrar el cobro' });

      cobro_id = rpcData.cobro_id;
    }

    const { error: errUpd } = await marcarPedidoEntregado(id, { notas_entrega });

    if (errUpd) return errorSeguro(res, errUpd, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, chofer_id, 'pedidos', 'UPDATE', id,
      { estado: pedido.estado }, { estado: 'entregado', notas_entrega: notas_entrega || null, cobro_id }
    );

    // Sincronizar entregas.estado para que el historial admin refleje la entrega.
    // FIX (auditoría etapa 6): antes este update no filtraba por estado, así
    // que si el pedido tenía más de una fila histórica en `entregas` (por
    // ejemplo, una entrega fallida anterior ya reprogramada), esto también
    // la marcaba como 'entregado' por error. Ahora solo toca la entrega
    // activa (pendiente/en_camino).
    const { data: entregaActualizada, error: entregaUpdateError } = await marcarEntregaCompletada(id, {
      estado:             'entregado',
      fecha_confirmacion: new Date().toISOString(),
      notas_entrega:      notas_entrega || null,
      firma_url:          firma_url     || null,
      foto_url:           foto_url      || null,
      receptor:           receptor      || null,
      monto_cobrado:      montoCobro    || null,
      medio_cobro:        montoCobro ? (cobro?.medio || null) : null,
      cobro_id:           cobro_id,
      offline_local_id:   offline_local_id || null,
    });

    if (entregaUpdateError || !entregaActualizada?.length) {
      return res.status(207).json({
        ok: false,
        parcial: true,
        pedido_id: id,
        estado: 'entregado',
        fallos: [{ paso: 'actualizar_entrega', error: entregaUpdateError?.message || 'No se encontró una entrega activa para actualizar.' }],
        error: 'El pedido se marcó entregado, pero no se pudo sincronizar la entrega activa.',
      });
    }

    // FIX (Matías): mantener rutas.estado sincronizado con las entregas reales
    // (ver sincronizarEstadoRuta más arriba). Best-effort: si falla, no debe
    // bloquear la confirmación de la entrega ya guardada.
    const ruta_id_entrega = entregaActualizada?.[0]?.ruta_id;
    if (ruta_id_entrega) {
      sincronizarEstadoRuta(ruta_id_entrega).catch(e =>
        console.error('[entregar] Error sincronizando rutas.estado:', e?.message || e));
    }

    if (Array.isArray(items_entregados) && items_entregados.length > 0) {
      const updates = items_entregados.map(({ item_id, cantidad_entregada }) =>
        actualizarCantidadItemPedido(item_id, cantidad_entregada, { pedido_id: id })
      );
      const resultados = await Promise.allSettled(updates);
      const fallosItems = resultados
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'No se pudo actualizar un ítem');
      if (fallosItems.length) {
        return res.status(207).json({
          ok: false,
          parcial: true,
          pedido_id: id,
          estado: 'entregado',
          fallos: fallosItems,
          error: 'La entrega se registró, pero algunos ítems no pudieron actualizarse.',
        });
      }
    }

    return res.json({ ok: true, pedido_id: id, estado: 'entregado' });
  }

  // ════════════════════════════════════
  // PATCH /api/chofer/remitos → no-entregar
  // ════════════════════════════════════
  //
  // FIX (auditoría etapa 6 — Hallazgo 1): el flujo de "no se pudo entregar"
  // estaba documentado (docs/ayuda/rutas-y-entregas.md), tenía columna en
  // la BD (pedidos.motivo_no_entrega desde la migración 006), template de
  // WhatsApp (notif.js: pedido_no_entregado) y el admin ya mostraba
  // entregas.estado='no_entregado' en rutas.js — pero no existía ningún
  // botón ni endpoint alcanzable por el chofer para generarlo. La única
  // función relacionada (manejarNoEntregado en notif.js) no tenía ningún
  // caller en todo el repo y, además, marcaba el pedido como 'cancelado'
  // en vez de dejarlo disponible para reprogramar como dice la
  // documentación. Ese bug se corrige aparte, en notif.js.
  if (ruta === 'no-entregar' && req.method === 'PATCH') {
    const MOTIVOS_NO_ENTREGA = ['nadie_en_casa', 'rechazo', 'direccion_incorrecta', 'otro'];
    // Mismo diccionario que usa notif.js para armar el mensaje de WhatsApp.
    const MOTIVOS_LABEL = {
      nadie_en_casa:        'nadie en casa al momento de la entrega',
      rechazo:              'el cliente rechazó la mercadería',
      direccion_incorrecta: 'la dirección no fue encontrada',
      otro:                 'inconveniente en la entrega',
    };

    const { id, motivo, notas, foto_url, offline_local_id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    if (!motivo || !MOTIVOS_NO_ENTREGA.includes(motivo))
      return res.status(400).json({ error: 'Motivo inválido' });

    // Punto 6: mismo criterio que en "entregar" — resolver y autorizar el
    // pedido (empresa + CHOFER-001) antes del fast-path de idempotencia.
    const pedido = await obtenerPedidoParaEntrega(empresa_id, id);
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!esAdmin && !(await pedidoEsDeEsteChofer(id, chofer_id)))
      return res.status(404).json({ error: 'Pedido no encontrado' });

    // Plan offline — Etapa 3: mismo fast path de idempotencia que en
    // "entregar" — ver el comentario de ahí. También exige que la entrega
    // encontrada sea la de este pedido_id.
    if (offline_local_id) {
      const yaExiste = await buscarEntregaPorOfflineLocalId(empresa_id, offline_local_id);
      if (yaExiste && yaExiste.pedido_id === id) {
        return res.json({ ok: true, pedido_id: id, estado: 'confirmado', offline_replay: true });
      }
    }

    if (pedido.estado !== 'despachado')
      return res.status(400).json({ error: 'El pedido no está despachado' });

    // 1. Marcar la entrega activa (acotado a pendiente/en_camino — nunca un
    //    update ciego por pedido_id, mismo criterio que el fix de arriba).
    const { data: entregaNoRealizada, error: errEnt } = await marcarEntregaNoRealizada(id, {
      estado:              'no_entregado',
      fecha_confirmacion:  new Date().toISOString(),
      notas_entrega:       notas || null,
      foto_url:            foto_url || null,
      motivo_no_entrega:   motivo,
      offline_local_id:    offline_local_id || null,
    });

    if (errEnt) return errorSeguro(res, errEnt, 500, 'No se pudo completar la operación.');

    // FIX (Matías): mismo sync de rutas.estado que en el handler "entregar" —
    // un "no entregado" también es un estado terminal para la entrega y debe
    // poder cerrar la ruta si es la última pendiente.
    const ruta_id_no_entrega = entregaNoRealizada?.[0]?.ruta_id;
    if (ruta_id_no_entrega) {
      sincronizarEstadoRuta(ruta_id_no_entrega).catch(e =>
        console.error('[no-entregar] Error sincronizando rutas.estado:', e?.message || e));
    }

    // 2. El pedido vuelve a 'confirmado' — queda disponible para una
    //    próxima ruta, tal como está documentado ("el pedido queda
    //    disponible para reprogramar en una próxima ruta").
    const { error: errPed } = await revertirPedidoAConfirmado(id, {
      notas_internas: `[No entregado] ${MOTIVOS_LABEL[motivo]}${notas ? ' — ' + notas : ''}`,
    });

    if (errPed) return errorSeguro(res, errPed, 500, 'No se pudo completar la operación.');

    await AuditRepo.registrarAuditoriaSilenciosa(
      empresa_id, chofer_id, 'pedidos', 'UPDATE', id,
      { estado: pedido.estado }, { estado: 'confirmado', motivo_no_entrega: motivo }
    );

    // 3. Notificar al cliente por WhatsApp (best-effort, no bloquea la
    //    respuesta al chofer si el envío falla).
    if (process.env.INTERNAL_API_KEY) {
      const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      fetch(`${base}/api/notif/notif-entrega`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY },
        body:    JSON.stringify({ evento: 'entrega_no_realizada', pedido_id: id, motivo, empresa_id }),
      }).catch(e => console.error('[no-entregar] Error notificando al cliente:', e?.message || e));
    }

    return res.json({ ok: true, pedido_id: id, estado: 'confirmado' });
  }

  // ════════════════════════════════════
  // GET /api/chofer/clientes
  // Clientes de la ruta del día
  // ════════════════════════════════════
  if (ruta === 'clientes' && req.method === 'GET') {
    const hoy = hoyArgentina();

    let pedidoIdsPropios = null;
    // CHOFER-001: antes esto devolvía TODOS los clientes con pedidos activos
    // hoy en la empresa (domicilio, teléfono, coordenadas) a cualquier
    // chofer, sin importar si el pedido estaba en su ruta o en la de otro.
    if (!esAdmin) {
      const { data: rutasHoyChofer } = await listarRutasDelDia(empresa_id, hoy, chofer_id);
      const rutaIdsChofer = (rutasHoyChofer || []).map(r => r.id);
      if (rutaIdsChofer.length === 0) return res.json({ clientes: [] });

      const { data: entregasChofer } = await listarEntregasPorRutas(rutaIdsChofer);
      pedidoIdsPropios = [...new Set((entregasChofer || []).map(e => e.pedido_id))];
      if (pedidoIdsPropios.length === 0) return res.json({ clientes: [] });
    }

    // Obtener clientes que tienen pedidos activos hoy
    const { data, error } = await listarClientesConPedidosActivos(empresa_id, hoy, pedidoIdsPropios);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // Deduplicar clientes
    const seen = new Set();
    const clientes = (data || [])
      .map(p => p.clientes)
      .filter(c => c && !seen.has(c.id) && seen.add(c.id));

    return res.json({ clientes });
  }

  // ════════════════════════════════════
  // GET /api/chofer/productos
  // Catálogo simplificado para remitos manuales
  // ════════════════════════════════════
  if (ruta === 'productos' && req.method === 'GET') {
    const { q: busqueda } = req.query;

    let data;
    try {
      data = await buscarProductosParaRemito(empresa_id, { busqueda });
    } catch (error) {
      return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    }
    return res.json({ productos: data || [] });
  }

  // ════════════════════════════════════
  // POST /api/chofer/entrega-foto
  // Etapa 1 (Logística): "firma digital / foto de conformidad en la
  // entrega". Sube al bucket 'remitos' (ya existía desde la Etapa 8.3 pero
  // nunca se había conectado ningún endpoint). Sirve tanto para la firma
  // (dataURL exportado de un <canvas>) como para la foto de conformidad
  // (misma validación que devolucion-foto). Devuelve la url pública para
  // pasarla luego como firma_url/foto_url en PATCH /api/chofer/remitos/:id/entregar,
  // que ya acepta ambos campos desde hace tiempo.
  // ════════════════════════════════════
  if (ruta === 'entrega-foto' && req.method === 'POST') {
    const { imagen_base64, tipo: tipoImagen } = req.body || {};
    if (!imagen_base64 || typeof imagen_base64 !== 'string')
      return res.status(400).json({ error: 'imagen_base64 requerida' });
    if (!['firma', 'foto'].includes(tipoImagen))
      return res.status(400).json({ error: 'tipo debe ser "firma" o "foto"' });

    const match = imagen_base64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de imagen inválido' });

    const mime = `image/${match[1].toLowerCase()}`;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
      return res.status(400).json({ error: 'Solo se permiten imágenes JPEG, PNG o WebP' });
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    const buffer = Buffer.from(match[2], 'base64');
    if (!validarImagenReal(buffer, mime))
      return res.status(400).json({ error: 'El contenido no coincide con el tipo de imagen declarado' });

    const MAX_BYTES = 8 * 1024 * 1024; // 8MB, mismo límite que devolucion-foto
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'La imagen no puede superar 8MB' });

    const path = `${empresa_id}/${chofer_id}/${tipoImagen}-${Date.now()}.${ext}`;

    const { error: errUpload } = await supabase.storage
      .from('remitos')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'remitos' privado. Se devuelve el path — el cliente lo
    // reenvía tal cual en PATCH /entregar como firma_url/foto_url, y recién
    // se firma al leer (ver lib/utils/storage-urls.js). El cliente no
    // renderiza esto directo, solo lo reenvía.
    return res.status(201).json({ ok: true, url: path, tipo: tipoImagen });
  }

  // ════════════════════════════════════
  // POST /api/chofer/devolucion-foto
  // Sube la foto de una devolución al bucket 'devoluciones' usando el
  // service role (el bucket solo permite INSERT vía service_role, el chofer
  // no puede subir directo con su JWT). Recibe base64, devuelve foto_url
  // pública para pasarle luego a POST /api/chofer/devolucion.
  // ════════════════════════════════════
  if (ruta === 'devolucion-foto' && req.method === 'POST') {
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

    const MAX_BYTES = 8 * 1024 * 1024; // 8MB, mismo límite que valida el front
    if (buffer.length > MAX_BYTES)
      return res.status(400).json({ error: 'La imagen no puede superar 8MB' });

    const path = `${empresa_id}/${chofer_id}/${Date.now()}.${ext}`;

    const { error: errUpload } = await supabase.storage
      .from('devoluciones')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (errUpload) return errorSeguro(res, errUpload, 500, 'No se pudo completar la operación.');

    // SEC-05: bucket 'devoluciones' privado. Se devuelve el path — el
    // chofer lo reenvía tal cual en POST /devolucion, sin renderizarlo.
    return res.status(201).json({ ok: true, foto_url: path });
  }

  // ════════════════════════════════════
  // POST /api/chofer/devolucion
  // Registra una devolución con foto + items. Si motivo='producto_defectuoso',
  // genera automáticamente notas_debito_proveedor agrupadas por proveedor
  // (Innovación #2).
  // ════════════════════════════════════
  if (ruta === 'devolucion' && req.method === 'POST') {
    // CHOFER-001: si la devolución viene atada a un pedido_id, un chofer
    // (no admin) solo puede registrarla contra un pedido de su propia ruta
    // — evita notas de débito a proveedor y recalculos de score disparados
    // sobre clientes/pedidos ajenos.
    const pedidoIdBody = req.body?.pedido_id;
    if (!esAdmin && pedidoIdBody && !(await pedidoEsDeEsteChofer(pedidoIdBody, chofer_id)))
      return res.status(404).json({ error: 'Pedido no encontrado' });

    const resultado = await crearDevolucionCore({ empresa_id, chofer_id, body: req.body || {} });
    if (!resultado.ok) return res.status(resultado.status || 400).json({ error: resultado.error });
    return res.status(201).json(resultado.payload);
  }

  return res.status(405).json({ error: 'Método o ruta no soportado en /api/chofer' });
}
