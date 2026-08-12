// lib/handlers/automatizacion.js — Panel de Control Centralizado v53
// Queries SOLO tablas confirmadas en el backup de la DB real.
import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { listarProductosConStockMinimo } from '../repos/productos.js';
import {
  upsertDispositivoPush,
  desactivarDispositivoPush,
  obtenerPrefsAuto,
  upsertPrefAuto,
  listarCiclosProximos,
  contarCiclosActivos,
  listarFacturasPendientesCierre,
  listarCobrosRecientes,
  contarBloqueosActivos,
  listarRutasHoy,
  listarEntregasPorRutas,
  listarLotesPorVencer,
  listarOrdenesCompraPendientes,
  listarStockPorProductos,
  listarClientesConScore,
  detectarAnomaliasAuditoriaRpc,
} from '../repos/automatizacion.js';

const sb = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]);

// Columnas reales de notif_prefs_auto (037, 053, 070, 243) — whitelist para
// el endpoint push-prefs, que recibe el nombre de columna como dato de body.
const TIPOS_PREF_VALIDOS = [
  'piloto_sugerencia',
  'cierre_cliente_bloqueado',
  'cierre_error_cola',
  'stock_quiebre',
  'stock_orden_auto',
  'stock_sin_proveedor',
  'score_caida_critica',
  'auditoria_anomalia',
];

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  // GET vapid-key (sin auth, público)
  if (req.method === 'GET' && req.query.accion === 'vapid-key') {
    return res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
  }

  const perfil = await verificarToken(req, sb);
  if (!perfil || !['dueno', 'admin'].includes(perfil.rol))
    return res.status(401).json({ error: 'No autorizado' });

  const eid = perfil.empresa_id;
  const accion = req.query.accion;

  // ── GET: estado de los 6 motores ─────────────────────────────────────────
  if (req.method === 'GET' && !accion) {
    const [piloto, cierre, rutas, stock, score, auditoria] = await Promise.allSettled([
      getEstadoPiloto(eid),
      getEstadoCierre(eid),
      getEstadoRutas(eid),
      getEstadoStock(eid),
      getEstadoScore(eid),
      getEstadoAuditoria(eid),
    ]);

    return res.json({
      piloto:    piloto.status    === 'fulfilled' ? piloto.value    : { error: piloto.reason?.message },
      cierre:    cierre.status    === 'fulfilled' ? cierre.value    : { error: cierre.reason?.message },
      rutas:     rutas.status     === 'fulfilled' ? rutas.value     : { error: rutas.reason?.message },
      stock:     stock.status     === 'fulfilled' ? stock.value     : { error: stock.reason?.message },
      score:     score.status     === 'fulfilled' ? score.value     : { error: score.reason?.message },
      auditoria: auditoria.status === 'fulfilled' ? auditoria.value : { error: auditoria.reason?.message },
      generado_en: new Date().toISOString(),
    });
  }

  // ── POST: ejecutar motor manualmente ─────────────────────────────────────
  if (req.method === 'POST' && accion === 'ejecutar') {
    const { motor } = req.body || {};
    if (!motor) return res.status(400).json({ error: 'motor requerido' });

    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    // AUTOMATIZACION-001: antes se reenviaba Authorization: Bearer CRON_SECRET,
    // haciéndose pasar por el cron interno. Cada handler downstream (piloto,
    // cierre, stock-auto, auditoria, score) trata esa identidad como "correr
    // para TODAS las empresas activas de la plataforma" — así que un click de
    // cualquier dueño/admin de cualquier tenant disparaba el motor (y sus
    // notificaciones push/WhatsApp) para todos los demás tenants. Se reenvía
    // en cambio el propio token del usuario (ya validado como dueno/admin más
    // arriba), que cae en el branch "!esInterno" que cada handler ya tiene
    // para scopear la corrida a perfil.empresa_id.
    const hdr = { 'Content-Type': 'application/json', Authorization: req.headers.authorization };
    const endpoints = {
      piloto:    { url: `${base}/api/index?_mod=piloto&accion=generar`,           method: 'POST' },
      cierre:    { url: `${base}/api/index?_mod=cierre&accion=procesar`,          method: 'POST' },
      stock:     { url: `${base}/api/index?_mod=stock-auto&accion=analizar`,      method: 'POST' },
      score:     { url: `${base}/api/index?_mod=score&accion=recalcular-todos`,   method: 'POST' },
      auditoria: { url: `${base}/api/index?_mod=auditoria&accion=analizar`,       method: 'POST' },
    };
    const ep = endpoints[motor];
    if (!ep) return res.status(400).json({ error: `Motor inválido: ${motor}` });

    try {
      const r = await fetch(ep.url, { method: ep.method, headers: hdr });
      const d = await r.json().catch(() => ({}));
      // AUTOMATIZACION-002: antes no se chequeaba r.ok, así que un 401/403/500
      // del motor downstream (p. ej. score.js, que no reconocía el header viejo)
      // volvía igual como {ok:true} y el frontend mostraba "Motor ejecutado"
      // aunque en realidad no había hecho nada.
      if (!r.ok) return res.status(r.status).json({ error: d.error || 'No se pudo ejecutar el motor.' });
      return res.json({ ok: true, motor, resultado: d });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── POST: suscripción push ────────────────────────────────────────────────
  if (req.method === 'POST' && accion === 'push-suscribir') {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ error: 'subscription inválida' });

    // FIX (auditoría alertas v320): esto es una suscripción Web Push (VAPID)
    // del navegador — va en la columna 'endpoint', que es la que lee
    // _auto-push.js para mandar las 6 alertas del panel (select('endpoint,
    // p256dh, auth')). Antes se guardaba en 'token_push', que es la columna
    // que usa el flujo de FCM/app móvil (_push.js / notif.js) — el envío
    // por Web Push nunca encontraba estos dispositivos y quedaba mudo.
    // Hay índice único sobre endpoint (053_fix_sincronizacion_v54.sql).
    await upsertDispositivoPush({
      usuario_id:       perfil.id,
      empresa_id:       eid,
      endpoint:         endpoint,
      p256dh:           keys.p256dh,
      auth:             keys.auth,
      tipo_dispositivo: req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'desktop',
      activo:           true,
      updated_at:       new Date(),
    });

    return res.json({ ok: true });
  }

  if (req.method === 'DELETE' && accion === 'push-cancelar') {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
    await desactivarDispositivoPush(endpoint, perfil.id);
    return res.json({ ok: true });
  }

  // ── GET/POST: preferencias push ───────────────────────────────────────────
  if (accion === 'push-prefs') {
    if (req.method === 'GET') {
      const data = await obtenerPrefsAuto(eid);
      return res.json({ prefs: data || {} });
    }
    if (req.method === 'POST') {
      const { tipo, valor } = req.body || {};
      if (!tipo) return res.status(400).json({ error: 'tipo requerido' });
      // FIX (auditoría seguridad v323): 'tipo' llegaba del body y se usaba
      // directo como nombre de columna ([tipo]: valor). Sin whitelist, un
      // dueño/admin de CUALQUIER empresa podía mandar tipo:"empresa_id" y
      // pisar el empresa_id de su propia fila hacia el de otro tenant —
      // este handler usa SUPABASE_SERVICE_ROLE_KEY, así que RLS no frenaba
      // nada. Se valida contra las 8 columnas reales de notif_prefs_auto.
      if (!TIPOS_PREF_VALIDOS.includes(tipo))
        return res.status(400).json({ error: 'tipo inválido' });
      await upsertPrefAuto(eid, tipo, valor);
      return res.json({ ok: true });
    }
  }

  return res.status(404).json({ error: 'Acción no encontrada' });
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR 1: Piloto Automático — ciclos de compra y sugerencias pendientes
// ─────────────────────────────────────────────────────────────────────────────
async function getEstadoPiloto(eid) {
  const en7d = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const [proximos, ciclosActivos] = await Promise.all([
    listarCiclosProximos(eid, en7d),
    contarCiclosActivos(eid),
  ]);

  const confianzaPromedio = proximos.length
    ? Math.round(proximos.reduce((s, c) => s + (c.confianza || 0), 0) / proximos.length * 100)
    : null;

  return {
    sugeridos_pendientes: proximos.length,
    ciclos_activos:       ciclosActivos,
    confianza_promedio:   confianzaPromedio,
    recientes: proximos.slice(0, 3).map(c => ({
      id:                  c.id,
      confianza_sugerencia: c.confianza || 0,
      proximo_pedido:      c.proximo_pedido,
      clientes:            { razon_social: c.clientes?.razon_social || '—' },
      productos:           { nombre: c.productos?.nombre || '—' },
    })),
    ultima_ejecucion: proximos[0] ? new Date().toISOString() : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR 2: Cierre Financiero — facturas, cobros y clientes bloqueados
// ─────────────────────────────────────────────────────────────────────────────
async function getEstadoCierre(eid) {
  const hace7d = new Date(Date.now() - 7 * 86400000).toISOString();

  const [facturas, cobros, bloqueosActivos] = await Promise.all([
    listarFacturasPendientesCierre(eid),
    listarCobrosRecientes(eid, hace7d),
    contarBloqueosActivos(eid),
  ]);

  const pendientes = facturas.filter(f => f.estado === 'pendiente').length;
  const errores    = facturas.filter(f => f.estado === 'error_afip').length;
  const monto      = facturas.reduce((s, f) => s + Number(f.total || 0), 0);

  return {
    pendientes,
    errores,
    completados_hoy: 0,
    bloqueados:       bloqueosActivos,
    monto_pendiente:  monto,
    recientes: cobros.slice(0, 3).map(c => ({
      tipo:       'cobro_reciente',
      updated_at: c.fecha || c.created_at,
      monto:      c.monto,
      cliente:    c.clientes?.razon_social || '—',
    })),
    ultima_ejecucion: cobros[0]?.fecha || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR 3: Rutas Dinámicas — rutas de hoy, GPS y completitud
// ─────────────────────────────────────────────────────────────────────────────
async function getEstadoRutas(eid) {
  const hoy = new Date().toISOString().split('T')[0];

  const rutas = await listarRutasHoy(eid, hoy);

  if (!rutas?.length) {
    return { rutas_hoy: 0, rutas_activas: 0, choferes_con_gps: 0,
             pct_completitud: 0, entregadas: 0, total_paradas: 0, lista: [] };
  }

  const rutaIds = rutas.map(r => r.id);
  const entregas = await listarEntregasPorRutas(rutaIds);

  const todasEntregas  = entregas || [];
  const totalParadas   = todasEntregas.length;
  const numEntregadas  = todasEntregas.filter(e => e.estado === 'entregado').length; // [Etapa 4] antes decía 'entregada' — el valor real que usa el resto del sistema (rutas.js, rutas-live.js) es 'entregado', por lo que pct_completitud siempre daba 0%
  const hace15min      = Date.now() - 15 * 60 * 1000;
  const conGps         = rutas.filter(r => r.chofer_lat && r.chofer_actualizado
    && new Date(r.chofer_actualizado).getTime() > hace15min).length;

  const lista = rutas.map(r => {
    const mis = todasEntregas.filter(e => e.ruta_id === r.id);
    const entOk = mis.filter(e => e.estado === 'entregado').length;
    return {
      id:          r.id,
      chofer:      r.usuarios?.nombre || 'Chofer',
      paradas:     mis.length,
      entregadas:  entOk,
      gps_ok:      !!(r.chofer_lat && r.chofer_actualizado
                      && new Date(r.chofer_actualizado).getTime() > hace15min),
    };
  });

  return {
    rutas_hoy:      rutas.length,
    rutas_activas:  rutas.filter(r => r.estado === 'en_curso').length,
    choferes_con_gps: conGps,
    pct_completitud: totalParadas > 0 ? Math.round(numEntregadas / totalParadas * 100) : 0,
    entregadas:     numEntregadas,
    total_paradas:  totalParadas,
    lista,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR 4: Stock Autónomo — bajo mínimo, vencimientos, órdenes
// ─────────────────────────────────────────────────────────────────────────────
async function getEstadoStock(eid) {
  const en30d = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  const [productos, lotesData, ordenesData] = await Promise.all([
    listarProductosConStockMinimo(eid),
    listarLotesPorVencer(eid, en30d),
    listarOrdenesCompraPendientes(eid),
  ]);

  const lotes      = lotesData || [];
  const ordenes     = ordenesData || [];
  let   bajoStock  = [];

  if (productos.length > 0) {
    // stock no tiene empresa_id — se filtra por producto_id (los productos ya están filtrados por empresa)
    const stocks = await listarStockPorProductos(productos.map(p => p.id));

    const mapa = {};
    for (const s of (stocks || [])) mapa[s.producto_id] = (mapa[s.producto_id] || 0) + Number(s.cantidad);
    // UI-005: mismo criterio que el dashboard (lib/repos/admin.js): si el producto
    // no tiene stock_minimo propio configurado, se usa un umbral por defecto de 5
    // en vez de no evaluarlo. Sin este fallback, todo producto con stock_minimo=0/null
    // nunca flagueaba como bajo stock (cantidad < 0 siempre es falso).
    const umbralDefault = 5;
    bajoStock = productos.filter(p => {
      const umbral = p.stock_minimo > 0 ? Number(p.stock_minimo) : umbralDefault;
      return (mapa[p.id] || 0) < umbral;
    });
  }

  const alertas = [
    ...bajoStock.slice(0, 3).map(p => ({
      tipo: 'quiebre', dias_restantes: null, productos: { nombre: p.nombre, unidad: p.unidad },
    })),
    ...lotes.slice(0, 3).map(l => ({
      tipo: 'vencimiento',
      dias_restantes: Math.ceil((new Date(l.fecha_vencimiento) - new Date()) / 86400000),
      productos: l.productos,
    })),
  ].slice(0, 5);

  return {
    alertas_activas:      alertas.length,
    productos_bajo_stock: bajoStock.length,
    lotes_por_vencer:     lotes.length,
    ordenes_auto:         ordenes.length,
    alertas,
    ordenes: ordenes.map(o => ({
      id:     o.id,
      numero: o.numero || `ORD-${o.id.substring(0, 6).toUpperCase()}`,
      estado: o.estado,
      total:  o.total,
    })),
    ultima_ejecucion: ordenes[0]?.created_at || lotes[0]?.fecha_vencimiento || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR 5: Score de Clientes — semáforo de salud
// ─────────────────────────────────────────────────────────────────────────────
async function getEstadoScore(eid) {
  const clientes = await listarClientesConScore(eid);

  const todos      = clientes || [];
  const conScore   = todos.filter(c => c.score_actual != null);
  const sinScore   = todos.length - conScore.length;
  // FIX (auditoría alertas v320): calcular_score_cliente() sólo escribe
  // 'premium' | 'bueno' | 'normal' | 'riesgo' | 'bloqueado' en
  // clientes.score_categoria (ver 092_fix_bugs_criticos.sql y la función
  // viva en la DB). Antes acá se comparaba contra 'critico'/'en_riesgo'/
  // 'saludable'/'excelente', valores que la función NUNCA produce — el
  // panel siempre mostraba 0 alertas de score sin importar los datos
  // reales. Se mapean los valores reales a los mismos 3 buckets que ya
  // consume el frontend (críticos/en riesgo/sanos) para no tener que
  // tocar automatizacion.js del lado del cliente.
  const criticos   = conScore.filter(c => c.score_categoria === 'bloqueado').length;
  const enRiesgo   = conScore.filter(c => c.score_categoria === 'riesgo').length;
  const saludables = conScore.filter(c => ['normal', 'bueno', 'premium'].includes(c.score_categoria)).length;
  const promedio   = conScore.length
    ? Math.round(conScore.reduce((s, c) => s + Number(c.score_actual || 0), 0) / conScore.length)
    : null;

  return {
    total_clientes:    todos.length,
    con_score:         conScore.length,
    sin_score:         sinScore,
    categorias:        { critico: criticos, en_riesgo: enRiesgo, saludable: saludables },
    alertas_activas:   criticos + enRiesgo,
    score_promedio:    promedio,
    peores: conScore.sort((a, b) => (a.score_actual || 0) - (b.score_actual || 0))
      .slice(0, 3).map(c => ({ id: c.id, razon_social: c.razon_social, score: c.score_actual, categoria: c.score_categoria })),
    ultima_actualizacion: conScore[0]?.score_actualizado || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR 6: Auditoría Predictiva — descuentos repetidos, ajustes sin OC, etc.
// ─────────────────────────────────────────────────────────────────────────────
async function getEstadoAuditoria(eid) {
  const { data, error } = await detectarAnomaliasAuditoriaRpc(eid, 7);
  if (error) throw new Error(error.message);

  const anomalias = data || [];
  const altas     = anomalias.filter(a => a.severidad === 'alta').length;
  const ultimoEvento = anomalias.length
    ? anomalias.reduce((max, a) => (a.ultimo_evento > max ? a.ultimo_evento : max), anomalias[0].ultimo_evento)
    : null;

  return {
    alertas_activas: anomalias.length,
    severidad_alta:  altas,
    por_tipo: anomalias.reduce((acc, a) => {
      acc[a.tipo_anomalia] = (acc[a.tipo_anomalia] || 0) + 1;
      return acc;
    }, {}),
    recientes: anomalias.slice(0, 3).map(a => ({
      tipo_anomalia:    a.tipo_anomalia,
      severidad:        a.severidad,
      usuario_nombre:   a.usuario_nombre,
      entidad_nombre:   a.entidad_nombre,
      cantidad_eventos: a.cantidad_eventos,
      ultimo_evento:    a.ultimo_evento,
    })),
    ultima_ejecucion: ultimoEvento,
  };
}
