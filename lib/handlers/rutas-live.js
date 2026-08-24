// api/rutas-live/index.js — REQ-3: Inteligencia de Ruta Dinámica con Re-Optimización en Vivo
import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { notifAuto } from './_auto-push.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import * as RutasRepo from '../repos/rutas.js';
import { obtenerConfigConError, actualizarConfig } from '../repos/empresas.js';
import { geocodificarDireccion } from '../geocoding.js';
import { actualizarCliente } from '../repos/clientes.js';

const sb = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]);
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ── Geocodificación automática (reusa lib/geocoding.js, mismo patrón que
// lib/handlers/clientes.js accion=geocodificar) ────────────────────────────
//
// Nominatim exige 1 request/segundo — nunca se dispara en paralelo. Por eso:
//  - En "agregar-urgente" se geocodifica UNA sola dirección (la del pedido
//    que se está agregando), no hay lote que pacear.
//  - En "reoptimizar" puede haber varias entregas sin coords a la vez; se
//    geocodifican en serie con una pausa entre cada una, y se acota la
//    cantidad por llamada para no alargar de más la respuesta del endpoint
//    (el resto queda para la próxima reoptimización o para el botón
//    "Geocodificar direcciones pendientes" del panel de Clientes).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSA_NOMINATIM_MS = 1100;
const MAX_GEOCODIFICACIONES_POR_REOPTIMIZAR = 5;

/** Geocodifica y persiste lat/lng de un cliente si le faltan y tiene domicilio. Best-effort. */
async function geocodificarClienteSiFalta(cliente, empresa_id) {
  if (!cliente || (cliente.lat && cliente.lng) || !cliente.domicilio) return false;
  try {
    const resultado = await geocodificarDireccion({
      domicilio: cliente.domicilio,
      localidad: cliente.localidad,
    });
    if (!resultado) return false;
    await actualizarCliente(empresa_id, cliente.id, { lat: resultado.lat, lng: resultado.lng });
    // Reflejar en el objeto en memoria para que el llamador (reoptimizar,
    // que arma destinos justo después) ya use las coords recién obtenidas
    // sin tener que releer de la base.
    cliente.lat = resultado.lat;
    cliente.lng = resultado.lng;
    return true;
  } catch (e) {
    console.error('[rutas-live] error geocodificando cliente', cliente.id, ':', e?.message || e);
    return false;
  }
}

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const accion = req.query.accion;

  // El cron de reporte semanal (Innovación #5) no trae JWT de usuario — se
  // identifica igual que el resto de los crons del proyecto (ver auditoria.js).
  // CRON-001 (auditoría 2026-07-26): se sacó la confianza en `x-vercel-cron`
  // (spoofeable por cualquiera en un request normal) — solo se acepta el
  // `CRON_SECRET` real.
  const esInterno = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  if (accion === 'reporte-semanal' && esInterno) {
    return reporteSemanalCron(req, res);
  }

  const perfil = await verificarToken(req, sb);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });


  // ── GET: rentabilidad por zona/ruta (Innovación #5) ────────────────────────
  // Lee v_rentabilidad_zona_ruta (069), que NO tiene security_invoker ni RLS
  // propio (mismo patrón que v_cc_proveedor / v_cobranza_priorizada) — el
  // filtro por empresa_id se hace acá, nunca delegado al cliente.
  if (req.method === 'GET' && accion === 'rentabilidad-zona') {
    if (!['dueno', 'admin', 'contador'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    // Filtros opcionales de rango de fecha (reporte semanal/mensual, no solo
    // "todo el historial")
    const { data, error } = await RutasRepo.listarRentabilidadZonaRuta(perfil.empresa_id, {
      desde: req.query.desde, hasta: req.query.hasta, zona_id: req.query.zona_id,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ rentabilidad: data || [] });
  }

  // ── GET: costo por km configurado (Innovación #5) ──────────────────────
  // empresas.config.costo_km es la fuente de verdad que ya usa la vista
  // v_rentabilidad_zona_ruta (069). Esto solo expone lectura/escritura.
  if (req.method === 'GET' && accion === 'costo-km') {
    if (!['dueno', 'admin', 'contador'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    const { data: empresa, error } = await obtenerConfigConError(perfil.empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    const costoKm = Number(empresa?.config?.costo_km);
    return res.json({ costo_km: Number.isFinite(costoKm) ? costoKm : 0 });
  }

  // ── POST: guardar costo por km (Innovación #5) ──────────────────────────
  // Lee-mergea-escribe el jsonb config para no pisar otras claves
  // (config.facturacion, etc. — mismo patrón que facturas.js accion=config).
  if (req.method === 'POST' && accion === 'costo-km') {
    if (!['dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    const costoKm = Number(req.body?.costo_km);
    if (!Number.isFinite(costoKm) || costoKm < 0)
      return res.status(400).json({ error: 'costo_km debe ser un número mayor o igual a 0' });

    const { data: empresaActual, error: errLeer } = await obtenerConfigConError(perfil.empresa_id);
    if (errLeer) return errorSeguro(res, errLeer, 500, 'No se pudo completar la operación.');

    const nuevoConfig = { ...(empresaActual?.config || {}), costo_km: costoKm };

    try {
      await actualizarConfig(perfil.empresa_id, nuevoConfig);
    } catch (errGuardar) {
      return errorSeguro(res, errGuardar, 500, 'No se pudo completar la operación.');
    }

    return res.json({ ok: true, costo_km: costoKm });
  }

  // ── GET: rentabilidad por producto (Etapa 2, ítem 2) ────────────────────
  // Lee v_rentabilidad_producto (246), mismo patrón que v_rentabilidad_zona_ruta:
  // SIN security_invoker ni RLS propio, el filtro por empresa_id se hace acá.
  if (req.method === 'GET' && accion === 'rentabilidad-producto') {
    if (!['dueno', 'admin', 'contador'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    const { data, error } = await RutasRepo.listarRentabilidadProducto(perfil.empresa_id, {
      desde: req.query.desde, hasta: req.query.hasta,
      producto_id: req.query.producto_id, categoria_id: req.query.categoria_id,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ rentabilidad: data || [] });
  }

  // ── GET: rentabilidad por vendedor (Etapa 2, ítem 2) ─────────────────────
  // Lee v_rentabilidad_vendedor (246). Mismo patrón de seguridad.
  if (req.method === 'GET' && accion === 'rentabilidad-vendedor') {
    if (!['dueno', 'admin', 'contador'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    const { data, error } = await RutasRepo.listarRentabilidadVendedor(perfil.empresa_id, {
      desde: req.query.desde, hasta: req.query.hasta, vendedor_id: req.query.vendedor_id,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ rentabilidad: data || [] });
  }

  // ── Actualizar posición GPS del chofer ────────────────────────────────────
  if (req.method === 'POST' && accion === 'posicion') {
    const { ruta_id, lat, lng } = req.body;
    if (perfil.rol !== 'chofer') return res.status(403).json({ error: 'Solo choferes' });
    if (!ruta_id || lat == null || lng == null)
      return res.status(400).json({ error: 'ruta_id, lat, lng requeridos' });

    const { data: rutaActualizada, error } = await RutasRepo.actualizarPosicionChofer(
      ruta_id, perfil.id, { lat, lng },
    );

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // Etapa 1 (Logística) — "tracking en vivo del chofer + notificación al
    // cliente" (tu pedido está a ~15 min). No bloquea la respuesta al chofer
    // si algo falla: es un aviso best-effort, nunca debe frenar el ping GPS.
    if (rutaActualizada) {
      avisarProximidadSiCorresponde(ruta_id, rutaActualizada.empresa_id)
        .catch(e => console.error('[rutas-live] error en avisarProximidadSiCorresponde:', e?.message || e));
    }

    return res.json({ ok: true });
  }

  // ── Re-optimizar orden de entregas pendientes ─────────────────────────────
  if (req.method === 'POST' && accion === 'reoptimizar') {
    const { ruta_id } = req.body;
    if (!ruta_id) return res.status(400).json({ error: 'ruta_id requerido' });

    // Validar que la ruta pertenece a la empresa del usuario (y, si es
    // chofer, que es el chofer asignado) ANTES de leer o escribir nada.
    const rutaCheck = await RutasRepo.obtenerRutaParaReoptimizar(ruta_id);

    if (!rutaCheck || rutaCheck.empresa_id !== perfil.empresa_id)
      return res.status(404).json({ error: 'Ruta no encontrada' });

    const esInterno = ['dueno', 'admin', 'vendedor'].includes(perfil.rol);
    const esChoferDeRuta = perfil.rol === 'chofer' && rutaCheck.chofer_id === perfil.id;
    if (!esInterno && !esChoferDeRuta)
      return res.status(403).json({ error: 'Sin permiso' });

    const entregas = await RutasRepo.listarEntregasParaReoptimizar(ruta_id);

    if (!entregas?.length) return res.json({ ok: true, reordenadas: 0 });

    // Fallback: si alguna entrega todavía no tiene coords (cliente cargado
    // antes de este cambio, o geocodificación de "agregar-urgente" que
    // falló), geocodificar con Nominatim antes de armar destinos — evita
    // gastar una consulta paga a Google con el string de dirección crudo y
    // el caso "duración 999999 → al final de la ruta" cuando Google no
    // matchea bien. Acotado y en serie (Nominatim: 1 req/seg); lo que no
    // llega a esta tanda queda para la próxima reoptimización.
    let intentosGeocodificacion = 0;
    for (const e of entregas) {
      if (intentosGeocodificacion >= MAX_GEOCODIFICACIONES_POR_REOPTIMIZAR) break;
      const cliente = e.pedidos?.clientes;
      if (!cliente || (cliente.lat && cliente.lng) || !cliente.domicilio) continue;
      if (intentosGeocodificacion > 0) await sleep(PAUSA_NOMINATIM_MS);
      intentosGeocodificacion++;
      await geocodificarClienteSiFalta(cliente, perfil.empresa_id);
    }

    const ruta = rutaCheck;

    const origen = {
      lat: ruta?.chofer_lat || entregas[0].pedidos?.clientes?.lat,
      lng: ruta?.chofer_lng || entregas[0].pedidos?.clientes?.lng
    };

    const destinos = entregas.map(e => {
      const c = e.pedidos?.clientes;
      return (c?.lat && c?.lng)
        ? `${c.lat},${c.lng}`
        : encodeURIComponent(`${c?.domicilio || ''} ${c?.localidad || ''} Argentina`);
    });

    let ordenOptimo = entregas.map((_, i) => i);

    // Intentar optimizar con Google Maps Distance Matrix (si hay API key y coords)
    if (GMAPS_KEY && origen.lat) {
      try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
          + `?origins=${origen.lat},${origen.lng}`
          + `&destinations=${destinos.join('|')}`
          + `&mode=driving&language=es&key=${GMAPS_KEY}`;
        const gmData = await (await fetch(url)).json();
        if (gmData.status === 'OK') {
          const dur = gmData.rows[0].elements.map((el, i) => ({
            idx: i,
            duracion: el.status === 'OK' ? el.duration.value : 999999
          }));
          dur.sort((a, b) => a.duracion - b.duracion);
          ordenOptimo = dur.map(d => d.idx);
        }
      } catch (e) {
        // Fallback a orden actual si Google Maps falla
      }
    }

    const updates = ordenOptimo.map((idx, pos) => ({ id: entregas[idx].id, orden: pos + 1 }));
    for (const u of updates) {
      await RutasRepo.actualizarOrdenEntrega(u.id, u.orden);
    }

    return res.json({ ok: true, reordenadas: updates.length, nuevo_orden: updates });
  }

  // ── Agregar entrega urgente a ruta en curso ────────────────────────────────
  if (req.method === 'POST' && accion === 'agregar-urgente') {
    const { ruta_id, pedido_id } = req.body;
    if (!['dueno', 'admin', 'vendedor'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    if (!ruta_id || !pedido_id)
      return res.status(400).json({ error: 'ruta_id y pedido_id requeridos' });

    const rutaCheck = await RutasRepo.obtenerRutaIdEmpresa(ruta_id);
    if (!rutaCheck || rutaCheck.empresa_id !== perfil.empresa_id)
      return res.status(404).json({ error: 'Ruta no encontrada' });

    const pedidoCheck = await RutasRepo.obtenerPedidoIdEmpresa(pedido_id);
    if (!pedidoCheck || pedidoCheck.empresa_id !== perfil.empresa_id)
      return res.status(404).json({ error: 'Pedido no encontrado' });

    // FIX (auditoría etapa 6 — Hallazgo 2): este endpoint no validaba si el
    // pedido ya estaba asignado a otra ruta activa (mismo gap que en la UI
    // de armado de rutas, corregido aparte). Ahora se corta acá antes de
    // insertar una segunda entrega para el mismo pedido.
    const entregaExistente = await RutasRepo.obtenerEntregaActivaParaValidarDuplicado(pedido_id);
    if (entregaExistente)
      return res.status(409).json({ error: 'El pedido ya está asignado a otra ruta activa', ruta_id: entregaExistente.ruta_id });

    // Geocodificar automáticamente el cliente del pedido si todavía no tiene
    // lat/lng — así la reoptimización que sigue (y el mapa de seguimiento)
    // ya cachean coords reales en vez de mandarle a Google el string de
    // dirección crudo. Best-effort: si Nominatim falla o no encuentra la
    // dirección, se sigue con el flujo normal (el fallback de siempre).
    try {
      const pedidoConCliente = await RutasRepo.obtenerClienteDePedidoParaGeocodificar(pedido_id);
      await geocodificarClienteSiFalta(pedidoConCliente?.clientes, perfil.empresa_id);
    } catch (e) {
      console.error('[rutas-live] error en geocodificación al agregar entrega urgente:', e?.message || e);
    }

    const maxOrden = await RutasRepo.obtenerMaxOrdenEntrega(ruta_id);

    const { data: entrega, error } = await RutasRepo.crearEntregaUrgente({
      ruta_id, pedido_id, orden: (maxOrden?.orden || 0) + 1, estado: 'pendiente',
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // Re-optimizar en background
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    fetch(`${base}/api/rutas-live?accion=reoptimizar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization
      },
      body: JSON.stringify({ ruta_id })
    }).catch(() => {});

    return res.json({ ok: true, entrega });
  }

  // ── Generar reporte de eficiencia al cerrar ruta ───────────────────────────
  if (req.method === 'POST' && accion === 'cerrar-reporte') {
    const { ruta_id } = req.body;
    if (!ruta_id) return res.status(400).json({ error: 'ruta_id requerido' });

    const ruta = await RutasRepo.obtenerRutaParaCerrarReporte(ruta_id);

    if (!ruta || ruta.empresa_id !== perfil.empresa_id)
      return res.status(404).json({ error: 'Ruta no encontrada' });

    const esInterno = ['dueno', 'admin', 'vendedor'].includes(perfil.rol);
    const esChoferDeRuta = perfil.rol === 'chofer' && ruta.chofer_id === perfil.id;
    if (!esInterno && !esChoferDeRuta)
      return res.status(403).json({ error: 'Sin permiso' });

    const entregas = await RutasRepo.listarEntregasParaReporte(ruta_id);

    const total      = entregas?.length || 0;
    const entregadas = entregas?.filter(e => e.estado === 'entregado').length || 0;

    await RutasRepo.upsertReporteRuta({
      ruta_id,
      empresa_id:       ruta.empresa_id,
      chofer_id:        ruta.chofer_id,
      total_paradas:    total,
      entregadas,
      no_entregadas:    total - entregadas,
      km_estimados:     entregas?.reduce((s, e) => s + (e.distancia_km || 0), 0) || 0,
      tiempo_total_min: entregas?.reduce((s, e) => s + (e.duracion_minutos || 0), 0) || 0,
      pct_completitud:  total > 0 ? (entregadas / total * 100) : 0
    });

    return res.json({ ok: true });
  }

  // ── GET: estado de ruta en vivo (para admin) ──────────────────────────────
  if (req.method === 'GET' && accion === 'estado') {
    const { ruta_id } = req.query;
    if (!ruta_id) return res.status(400).json({ error: 'ruta_id requerido' });

    const { data: ruta, error } = await RutasRepo.obtenerRutaEstadoLive(ruta_id, perfil.empresa_id);

    if (error) return res.status(404).json({ error: 'Ruta no encontrada' });
    return res.json({ ruta });
  }

  // ── GET: seguimiento en vivo para el CLIENTE ──────────────────────────────
  // Accesible con JWT de cliente. Solo devuelve datos del pedido propio.
  // Activa cuando entregas.estado = 'en_camino' O pedidos.estado = 'despachado'.
  if (req.method === 'GET' && accion === 'seguimiento') {
    const { pedido_id } = req.query;
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

    if (!['cliente', 'dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    // 1. Verificar que el pedido existe
    const { data: pedido, error: errPedido } = await RutasRepo.obtenerPedidoParaSeguimiento(pedido_id);

    if (errPedido || !pedido)
      return res.status(404).json({ error: 'Pedido no encontrado' });

    // 2. Validar ownership. Clientes: scope estricto (nunca datos de otro
    //    cliente). Dueno/admin: scope a su propia empresa (evita que un
    //    admin de otra empresa consulte el tracking de un pedido ajeno).
    if (perfil.rol === 'cliente') {
      const usuario = await RutasRepo.obtenerClienteIdDeUsuario(perfil.id);
      const clienteId = usuario?.clientes?.id;
      if (!clienteId || pedido.cliente_id !== clienteId)
        return res.status(403).json({ error: 'Pedido no pertenece a este cliente' });
    } else if (['dueno', 'admin'].includes(perfil.rol)) {
      if (pedido.empresa_id !== perfil.empresa_id)
        return res.status(403).json({ error: 'Pedido no pertenece a esta empresa' });
    } else {
      return res.status(403).json({ error: 'Sin permiso' });
    }

    // 3. Buscar la entrega activa asociada al pedido
    const entrega = await RutasRepo.obtenerEntregaActivaParaSeguimiento(pedido_id);

    const estaEnRuta = pedido.estado === 'despachado' || entrega?.estado === 'en_camino';
    if (!entrega || !estaEnRuta) {
      return res.json({
        disponible: false,
        estado_pedido: pedido.estado,
        mensaje: 'El pedido aún no está en camino'
      });
    }

    // 4. Obtener posición actual del chofer
    const ruta = await RutasRepo.obtenerPosicionChoferDeRuta(entrega.ruta_id);

    if (!ruta?.chofer_lat || !ruta?.chofer_lng) {
      return res.json({
        disponible: true,
        estado_pedido: pedido.estado,
        estado_entrega: entrega.estado,
        ubicacion: null,
        eta_minutos: null,
        mensaje: 'Ubicación del chofer no disponible aún'
      });
    }

    // 5. Calcular ETA simple: paradas pendientes antes que esta × tiempo promedio
    const entregasPrevias = await RutasRepo.contarEntregasPreviasEnRuta(entrega.ruta_id, entrega.orden);

    const MINUTOS_POR_PARADA = 12;
    const paradasRestantes   = (entregasPrevias?.length || 0) + 1;
    const eta_minutos        = paradasRestantes * MINUTOS_POR_PARADA;

    return res.json({
      disponible:        true,
      estado_pedido:     pedido.estado,
      estado_entrega:    entrega.estado,
      ubicacion: {
        lat:         parseFloat(ruta.chofer_lat),
        lng:         parseFloat(ruta.chofer_lng),
        actualizado: ruta.chofer_actualizado
      },
      eta_minutos,
      paradas_restantes: paradasRestantes
    });
  }

  return res.status(404).json({ error: 'Acción no encontrada' });
}

// ── Etapa 1 (Logística) — aviso automático "tu pedido está a ~15 min" ─────
// Se llama en cada ping de GPS (accion=posicion). Mira solo la PRÓXIMA
// entrega pendiente de la ruta (la de menor "orden"), calcula un ETA simple
// (mismo criterio que accion=seguimiento: paradas restantes × minutos
// promedio por parada) y, si cruza el umbral y todavía no se avisó para esa
// entrega puntual, dispara el WhatsApp al cliente vía /api/notif y marca
// aviso_proximidad_enviado para no repetirlo en el próximo ping.
const UMBRAL_AVISO_MINUTOS = 15;
const MINUTOS_POR_PARADA_AVISO = 12;

async function avisarProximidadSiCorresponde(rutaId, empresaId) {
  const pendientes = await RutasRepo.listarEntregasPendientesOrdenadas(rutaId);

  if (!pendientes?.length) return;

  const proxima = pendientes[0];
  if (proxima.aviso_proximidad_enviado) return; // ya se avisó para esta entrega

  const etaMinutos = pendientes.length * MINUTOS_POR_PARADA_AVISO; // mismo criterio que accion=seguimiento
  if (etaMinutos > UMBRAL_AVISO_MINUTOS) return;

  if (!process.env.INTERNAL_API_KEY) {
    console.warn('[rutas-live] INTERNAL_API_KEY no configurada — no se puede avisar proximidad al cliente');
    return;
  }

  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  const resp = await fetch(`${base}/api/notif/notif-entrega`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY },
    body: JSON.stringify({
      tipo: 'proximidad',
      pedido_id: proxima.pedido_id,
      empresa_id: empresaId,
      eta_minutos: etaMinutos,
    }),
  }).catch(() => null);

  // Marcar como avisada solo si el envío no fue un error de red/servidor —
  // si el proveedor de WhatsApp rechaza el template (ver notif.js), igual
  // se marca para no reintentar en bucle cada 25s; queda en notif_log el
  // detalle del error para revisar manualmente.
  if (resp) {
    await RutasRepo.marcarAvisoProximidadEnviado(proxima.id);
  }
}

// ── Cron semanal: Mapa de Rentabilidad por Zona/Ruta (Innovación #5) ──────
// Corre los lunes, mira la semana cerrada (lunes a domingo anterior), y
// avisa al dueño/admin de cada empresa con un resumen + la zona de peor
// margen neto por km (la que más vale la pena revisar primero).
async function reporteSemanalCron(req, res) {
  const empresas = await RutasRepo.listarEmpresasActivasParaCron();

  const hoy = new Date();
  const hasta = new Date(hoy); hasta.setDate(hoy.getDate() - 1);            // domingo
  const desde = new Date(hasta); desde.setDate(hasta.getDate() - 6);        // lunes anterior
  const fmtFecha = d => d.toISOString().slice(0, 10);

  const resultados = [];

  for (const { id: empresa_id } of (empresas || [])) {
    const { data: filas, error } = await RutasRepo.listarRentabilidadZonaRuta(empresa_id, {
      desde: fmtFecha(desde), hasta: fmtFecha(hasta),
    });

    if (error) {
      console.error('[RENTABILIDAD] Error al leer v_rentabilidad_zona_ruta:', error.message);
      resultados.push({ empresa_id, ok: false, error: error.message });
      continue;
    }

    if (!filas?.length) {
      resultados.push({ empresa_id, ok: true, sin_datos: true });
      continue;
    }

    // Agregar por zona (la vista viene una fila por ruta/fecha)
    const porZona = new Map();
    for (const f of filas) {
      const key = f.zona_id || 'sin_zona';
      const acc = porZona.get(key) || {
        zona_nombre: f.zona_nombre || 'Sin zona asignada',
        margen_neto: 0, km: 0, entregas: 0,
      };
      acc.margen_neto += +f.margen_neto_estimado || 0;
      acc.km          += +f.km_recorridos || 0;
      acc.entregas     += +f.entregas_completadas || 0;
      porZona.set(key, acc);
    }

    const zonas = [...porZona.values()].map(z => ({
      ...z,
      margen_neto_por_km: z.km > 0 ? Math.round((z.margen_neto / z.km) * 100) / 100 : null,
    }));

    zonas.sort((a, b) => (a.margen_neto_por_km ?? Infinity) - (b.margen_neto_por_km ?? Infinity));
    const peorZona = zonas[0];

    const margenTotalSemana = zonas.reduce((s, z) => s + z.margen_neto, 0);
    const fmtPeso = n => '$' + Math.round(n || 0).toLocaleString('es-AR');

    let cuerpo = `Margen neto estimado de la semana: ${fmtPeso(margenTotalSemana)} en ${zonas.length} zona${zonas.length === 1 ? '' : 's'}.`;
    if (peorZona && peorZona.margen_neto_por_km !== null) {
      cuerpo += ` Peor rendimiento: "${peorZona.zona_nombre}" (${fmtPeso(peorZona.margen_neto_por_km)}/km).`;
    }

    await notifAuto(empresa_id, {
      tipo: 'rentabilidad_zona_semanal',
      titulo: 'Reporte semanal de rentabilidad por zona',
      cuerpo,
      link: '/admin/rentabilidad-zona',
    }).catch(() => {});

    resultados.push({ empresa_id, ok: true, zonas: zonas.length, margen_total: margenTotalSemana });
  }

  return res.json({ ok: true, desde: fmtFecha(desde), hasta: fmtFecha(hasta), resultados });
}

