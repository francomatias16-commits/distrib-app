// lib/handlers/admin.js
// Handler para /api/admin/* — Dashboard del administrador
//
// Rutas absorbidas desde vercel.json → _mod=admin:
//   GET /api/admin/kpis?periodo=7d              → KPIs consolidados
//   GET /api/admin/pedidos?limit=10&orden=X     → pedidos recientes
//   GET /api/admin/stock/bajo?limit=10          → items con stock bajo
//   GET /api/admin/reportes/ventas-diarias?periodo=7d → serie temporal
//   GET /api/admin/alertas?sin_leer=true        → alertas del sistema
//   GET /api/admin/dashboard-ejecutivo?periodo=30d → resumen ventas+cobranza+rentabilidad+stock (Etapa 5)
//   GET /api/admin/comparativa-mensual          → serie diaria mes actual vs. mes anterior (Etapa 5)
//   GET /api/admin/resumen-arranque              → las 3 preguntas del arranque del día:
//                                                   stock disponible real, hoja de ruta de hoy,
//                                                   alertas críticas (stock crítico + deuda vencida)
//   GET /api/admin/estado-financiero?agrupacion=mes → ingresos por canal + egresos por categoría +
//                                                   serie de resultado + patrimonio neto (migración 564)
//
// Todos los endpoints son de solo lectura y requieren rol admin/dueno/vendedor/contador.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { getUserSeguro } from '../auth-helpers.js';
import { rateLimit }    from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { existeProductoParaEmpresa } from '../repos/productos.js';
import { puede } from '../permisos-service.js';
import { cacheado } from '../cache.js';
import * as AdminRepo from '../repos/admin.js';
import * as ObservabilidadRepo from '../repos/observabilidad.js';
// TIPOS_EVENTO_SIN_LISTENER se importa dinámicamente dentro de
// handleSaludEventos (no acá arriba): un import estático de
// eventos-dispatcher.js arrastra lib/eventos-listeners/pedido_creado.js →
// lib/handlers/pedidos.js → lib/handlers/_push.js, que llama
// rateLimitPorClave() en el scope del módulo (no dentro de una función) —
// eso rompe cualquier test que mockee lib/rate-limit.js sin anticipar esa
// cadena (ver tests/handlers/admin-permisos.test.js). El import perezoso
// evita meter esa cadena en el grafo estático de admin.js.

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const limiter     = rateLimit({ max: 120, windowMs: 60_000 });

// ─── Utilidades ──────────────────────────────────────────────────────────────

function periodoAFechas(periodo = '7d') {
  const ahora = new Date();
  const dias   = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 }[periodo] ?? 7;
  const desde  = new Date(ahora);
  desde.setDate(desde.getDate() - dias);
  return {
    desde: desde.toISOString(),
    hasta: ahora.toISOString(),
    dias,
  };
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

// FIX (2026-07-12, incidente dashboard colgado) — actualizado v862, y ahora
// migrado a getUserSeguro (2026-08-29, incidente "Supabase API Gateway:
// Degraded Performance"): admin.js era el ÚLTIMO handler del proyecto que
// seguía con su propio Promise.race de 8s puntual sobre
// supabase.auth.getUser() en vez de usar el helper compartido de
// lib/auth-helpers.js (los otros ~20 handlers — pos.js, score.js,
// cc_proveedores.js, etc. — ya lo usaban). Esto explica por qué el incidente
// del 27-29/8 pegó más fuerte acá: /api/admin/kpis, /api/pos/cajas-admin y
// /api/score son las tres rutas que aparecieron en el 503 en cascada, pero
// solo admin.js estaba pagando el viaje de red completo a Supabase Auth en
// cada request — las otras dos ya se beneficiaban de:
//
//   1) Verificación LOCAL del JWT (JWKS del proyecto) — sin red — para
//      tokens firmados con la signing key asimétrica actual (ver
//      verificarJWTLocal en auth-helpers.js).
//   2) Caché en memoria de 45s (AUTH_CACHE_TTL_MS) para el fallback remoto,
//      cuando la verificación local no aplica (tokens legacy HS256).
//   3) Timeout de 3s en vez de 8s cuando sí hace falta ir a la red.
//
// getUserSeguro() tira una excepción marcada `esTimeoutAuth` en vez de
// devolver `{ timedOut: true }` — el catch-all de api/index.js la traduce a
// la misma respuesta 503 { codigo: 'TIMEOUT_AUTH' } que este handler armaba
// a mano antes, así que el contrato con el frontend (api-client.js, que
// reintenta ante ese código) no cambia.
async function autenticar(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return { error: 'No autorizado', status: 401 };

  const { data: { user }, error: authErr } = await getUserSeguro(supabase, token);
  if (authErr || !user) return { error: 'Token inválido', status: 401 };

  const perfil = await AdminRepo.obtenerPerfilAdmin(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'admin_dashboard'))
    return { error: 'Sin permisos para el panel admin', status: 403 };

  return { user, perfil, empresa_id: perfil.empresa_id };
}

// ─── Dispatcher principal ─────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Método no permitido' });
  // BUG v863 (causa real del 504 en /api/admin/*, no cold start ni Supabase
  // colgado): faltaba el `await` acá. `limiter` es un middleware ASYNC (ver
  // rate-limit.js) — sin await, `limiter(req, res)` devuelve una Promise
  // pendiente, y `if (unaPromesa)` es SIEMPRE verdadero en JS (un objeto es
  // truthy sin importar en qué se resuelva). Resultado: esta línea cortaba
  // con `return` en el 100% de los requests a /api/admin/*, ANTES de llegar
  // a autenticar() o a cualquier _svc — sin mandar respuesta nunca. El
  // cliente quedaba esperando hasta que Vercel mataba la función a los 60s.
  // Todos los demás handlers del proyecto (clientes.js, stock.js, pos.js,
  // etc.) sí tienen el `await` — este era el único caso suelto.
  if (await limiter(req, res))  return;

  const auth = await autenticar(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error, ...(auth.codigo ? { codigo: auth.codigo } : {}) });

  const { empresa_id } = auth;
  const _svc = req.query._svc;

  if (_svc === 'kpis')          return handleKPIs(req, res, empresa_id);
  if (_svc === 'pedidos')       return handlePedidos(req, res, empresa_id);
  if (_svc === 'stock-bajo')    return handleStockBajo(req, res, empresa_id);
  if (_svc === 'ventas-diarias') return handleVentasDiarias(req, res, empresa_id);
  if (_svc === 'alertas')       return handleAlertas(req, res, empresa_id);
  if (_svc === 'onboarding')    return handleOnboarding(req, res, empresa_id);
  if (_svc === 'dashboard-ejecutivo') return handleDashboardEjecutivo(req, res, empresa_id);
  if (_svc === 'comparativa-mensual') return handleComparativaMensual(req, res, empresa_id);
  if (_svc === 'resumen-arranque')    return handleResumenArranque(req, res, empresa_id);
  if (_svc === 'salud-eventos')       return handleSaludEventos(req, res, empresa_id);
  if (_svc === 'metricas-negocio')    return handleMetricasNegocio(req, res, empresa_id);
  if (_svc === 'estado-financiero')   return handleEstadoFinanciero(req, res, empresa_id);

  return res.status(404).json({ error: `Sub-ruta admin desconocida: ${_svc ?? '(sin _svc)'}` });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/kpis?periodo=7d
//
// Respuesta:
// {
//   ventas_total:    number,   ventas_delta:    number (% vs período anterior),
//   pedidos_total:   number,   pedidos_delta:   number,
//   clientes_activos:number,   clientes_delta:  number,
//   stock_critico:   number    (items bajo mínimo)
// }
// ══════════════════════════════════════════════════════════════════════════

// Etapa 3 (plan de robustez/escalabilidad) — piloto de caché.
// Subido de 30s a 60s (loadtest 2026-08-31 contra fluxoapp.com.ar): con
// 30 conexiones concurrentes el p99 de este endpoint llegó a 4785ms —
// el más lento de los 9 endpoints auditados por lejos, muy cerca del
// umbral interno de 5000ms de scripts/load-test.js — porque el caché es
// en memoria POR INSTANCIA de lambda (ver lib/cache.js): una ráfaga
// concurrente hace que Vercel levante varias instancias en paralelo,
// cada una con su caché vacío, así que gran parte de esas 30 conexiones
// termina recalculando las 4 RPCs (kpis + canal + compras + gastos) al
// mismo tiempo, compitiendo por conexiones a Postgres. Duplicar el TTL
// no soluciona el problema de fondo (el caché sigue sin compartirse
// entre instancias — para eso hace falta algo como Redis/Upstash, ya
// evaluado en el plan de robustez) pero reduce a la mitad la ventana en
// la que una ráfaga fría puede repetir el trabajo, sin perder frescura
// real: un cambio (venta/pedido nuevo) sigue reflejándose dentro de 1
// minuto, que sigue siendo aceptable para un dashboard, no para un
// timer en tiempo real.
const KPIS_CACHE_TTL_MS = 60_000;

async function calcularKpisDashboard(empresa_id, periodo) {
  const { desde, hasta, dias } = periodoAFechas(periodo);

  const desdeAnterior = new Date(desde);
  desdeAnterior.setDate(desdeAnterior.getDate() - dias);

  const params = {
    p_empresa_id:     empresa_id,
    p_desde:          desde,
    p_hasta:          hasta,
    p_desde_anterior: desdeAnterior.toISOString(),
  };

  // Intentar _v3 (agrega AFIP, riesgo de cheques y catálogo). Si no existe
  // en la BD todavía (migración no corrida), fallback a _v2, y de ahí a _v1.
  let kpis, error;
  ({ data: kpis, error } = await AdminRepo.obtenerKpisDashboardV3Rpc(params));

  if (error) {
    const v2 = await AdminRepo.obtenerKpisDashboardV2Rpc(params);
    if (v2.error) {
      const fallback = await AdminRepo.obtenerKpisDashboardV1Rpc(params);
      if (fallback.error) throw fallback.error; // handleKPIs decide cómo responder — acá no se cachea nada
      kpis = fallback.data;
    } else {
      kpis = v2.data;
    }
  }

  const delta = (actual, anterior) =>
    anterior === 0 ? null : Math.round(((actual - anterior) / anterior) * 100);

  // Desglose por canal y compras a proveedores (migración 478) — misma
  // ventana [desde, hasta] que el resto de la tarjeta. No bloquean la
  // respuesta si fallan (empresa sin migración corrida todavía): se
  // degradan a null y el frontend oculta esas secciones sin romper el
  // resto de "Hoy en tu negocio".
  const [canalRes, comprasRes, gastosRes] = await Promise.all([
    AdminRepo.obtenerVentasPorCanalRpc({ p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta }),
    AdminRepo.obtenerResumenComprasProveedorRpc({ p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta }),
    AdminRepo.obtenerResumenGastosGeneralesRpc({ p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta }),
  ]);

  return {
    ventas_total:     Math.round((kpis.ventas_actual    || 0) * 100) / 100,
    ventas_delta:     delta(kpis.ventas_actual    || 0, kpis.ventas_anterior    || 0),
    ventas_por_canal: canalRes.error ? null : (canalRes.data || []),
    pedidos_total:    kpis.pedidos_actual   || 0,
    pedidos_delta:    delta(kpis.pedidos_actual   || 0, kpis.pedidos_anterior   || 0),
    clientes_activos: kpis.clientes_activos || 0,
    clientes_delta:   delta(kpis.clientes_activos || 0, kpis.clientes_activos_anterior || 0),
    stock_critico:    kpis.stock_critico_count || 0,
    // ── Nuevos, para las tarjetas KPI del rediseño Fireart (undefined si
    // la migración 230 todavía no corrió — el frontend lo maneja) ──────
    facturas_emitidas_periodo: kpis.facturas_emitidas_periodo,
    facturas_total_periodo:    kpis.facturas_total_periodo,
    facturas_error_afip:       kpis.facturas_error_afip,
    cheques_riesgo_clientes:   kpis.cheques_riesgo_clientes,
    cheques_riesgo_monto:      kpis.cheques_riesgo_monto,
    productos_catalogo_count:  kpis.productos_catalogo_count,
    compras_proveedor: comprasRes.error ? null : (comprasRes.data || null),
    gastos_generales:  gastosRes.error ? null : (gastosRes.data || null),
    periodo,
    desde,
    hasta,
  };
}

async function handleKPIs(req, res, empresa_id) {
  const periodo = req.query.periodo || '7d';
  try {
    // Piloto Etapa 3 (robustez/escalabilidad): caché en memoria 60s, clave
    // por empresa+período — ver lib/cache.js para el alcance real (por
    // instancia de lambda, no distribuido).
    const datos = await cacheado(
      `kpis-dashboard:${empresa_id}:${periodo}`,
      KPIS_CACHE_TTL_MS,
      () => calcularKpisDashboard(empresa_id, periodo),
    );
    return res.json(datos);
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/pedidos?limit=10&orden=fecha_desc
//
// Respuesta:
// { pedidos: [{ id, numero_pedido, cliente_nombre, estado, total, created_at }] }
// ══════════════════════════════════════════════════════════════════════════

async function handlePedidos(req, res, empresa_id) {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

  const { data, error } = await AdminRepo.listarPedidosRecientes(empresa_id, limit);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  const pedidos = (data || []).map(p => ({
    id:             p.id,
    numero_pedido:  p.id.slice(0, 8).toUpperCase(),
    estado:         p.estado,
    total:          p.total,
    created_at:     p.created_at,
    cliente_nombre: p.clientes?.nombre_fantasia || p.clientes?.razon_social || '—',
  }));

  return res.json({ pedidos });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/stock/bajo?limit=10
//
// Respuesta:
// { items: [{ producto_id, nombre, cantidad_disponible, stock_minimo }] }
// ══════════════════════════════════════════════════════════════════════════

// FIX (perf, load test 2026-08-29): agrupado y filtro de umbral movidos a
// SQL (obtener_stock_bajo, ver 462_perf_stock_agregado_en_sql.sql). Antes
// esto traía TODAS las filas de stock×productos de la empresa a JS
// (obtenerStockConProductos) — bajo 30 conexiones concurrentes ese
// endpoint caía a 8.1 req/s con p99 de 9.5s. El handler ahora solo pasa
// el resultado; no toca el contrato de respuesta (`{ items: [...] }`).
async function handleStockBajo(req, res, empresa_id) {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

  const { data, error } = await AdminRepo.obtenerStockBajo(empresa_id, limit);
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  return res.json({ items: data || [] });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/resumen-arranque
//
// REQ-DASHBOARD-ARRANQUE — responde las 3 preguntas jerárquicas que el
// administrador se hace al arrancar el día (ver docs/Flujo_de_Trabajo_y_
// Diseno_Distribucion.pdf, punto 1):
//   1. ¿Qué tengo para vender de verdad?  → stock disponible real (no físico)
//   2. ¿Qué hay que repartir hoy?         → hoja de ruta del día
//   3. ¿Hay algo prendido fuego?          → stock crítico + deuda vencida
//
// Reutiliza el mismo patrón de join depósitos→stock→productos que
// handleStockBajo (cantidad_disponible se recalcula en JS como
// cantidad - cantidad_reservada, sin confiar en la columna sincronizada por
// trigger, por consistencia con el resto del dashboard).
//
// Respuesta:
// {
//   stock:   { unidades_disponibles, valorizado_disponible, productos_con_stock, stock_critico_count },
//   rutas:   { total_rutas, pendientes, en_camino, completadas, total_paradas, fecha },
//   alertas: { stock_critico_count, clientes_deuda_vencida_count, monto_deuda_vencida }
// }
// ══════════════════════════════════════════════════════════════════════════

async function handleResumenArranque(req, res, empresa_id) {
  // Mismo fix de timezone que /api/chofer/remitos (pedidos.js): calcular
  // "hoy" en hora Argentina, no en UTC del server, para no perder rutas de
  // la noche (21:00-23:59 ART cae en el día siguiente en UTC).
  const hoyArgentina = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const hoy = req.query.fecha || hoyArgentina();

  try {
    // Piloto Etapa 3 (robustez/escalabilidad): mismo criterio que
    // /api/admin/kpis — este handler dispara 4 llamadas en paralelo
    // (stock + rutas + bloqueos + score crítico) en cada request. 60s TTL,
    // clave por empresa+fecha.
    const datos = await cacheado(
      `resumen-arranque:${empresa_id}:${hoy}`,
      KPIS_CACHE_TTL_MS,
      () => calcularResumenArranque(empresa_id, hoy),
    );
    return res.json(datos);
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

async function calcularResumenArranque(empresa_id, hoy) {
  // FIX (perf, load test 2026-08-29): el stock ahora se agrega y filtra en
  // SQL (obtener_stock_resumen_arranque, ver 462_perf_stock_agregado_en_sql.sql)
  // en vez de traer depositos → todo el stock de la empresa → agrupar en JS.
  // Esto además saca la dependencia secuencial que había (depositos primero,
  // stock después): ahora es una llamada más de la misma tanda paralela.
  const [stockRes, rutasRes, bloqueosRes, scoreCriticoRes] = await Promise.allSettled([
    AdminRepo.obtenerStockResumenArranque(empresa_id),
    AdminRepo.obtenerRutasDelDia(empresa_id, hoy),
    AdminRepo.obtenerBloqueosDeudaVencida(empresa_id),
    // FIX (dashboard estados críticos): mismo criterio de score_categoria
    // que ya usa el Motor 5 de automatizacion.js (getEstadoScore) — evita
    // repetir el bug de comparar contra valores 'critico'/'en_riesgo' que
    // calcular_score_cliente() nunca escribe.
    AdminRepo.contarClientesScoreCritico(empresa_id),
  ]);

  // ── 1. Stock disponible real ────────────────────────────────────────────
  let stockOut = { unidades_disponibles: 0, valorizado_disponible: 0, productos_con_stock: 0, stock_critico_count: 0 };
  if (stockRes.status === 'fulfilled' && !stockRes.value?.error) {
    stockOut = stockRes.value.data || stockOut;
  } else {
    console.error('[Dashboard] resumen-arranque stock:', stockRes.reason || stockRes.value?.error);
  }

  // ── 2. Hoja de ruta de hoy ───────────────────────────────────────────────
  let rutasOut = { total_rutas: 0, pendientes: 0, en_camino: 0, completadas: 0, total_paradas: 0, fecha: hoy };
  if (rutasRes.status === 'fulfilled') {
    const rutas = rutasRes.value || [];
    const rutaIds = rutas.map(r => r.id);
    let totalParadas = 0;
    if (rutaIds.length > 0) {
      totalParadas = (await AdminRepo.contarEntregasPorRutas(rutaIds)) || 0;
    }
    rutasOut = {
      total_rutas:   rutas.length,
      pendientes:    rutas.filter(r => r.estado === 'pendiente').length,
      en_camino:     rutas.filter(r => r.estado === 'en_camino').length,
      completadas:   rutas.filter(r => r.estado === 'completada').length,
      total_paradas: totalParadas,
      fecha:         hoy,
    };
  } else {
    console.error('[Dashboard] resumen-arranque rutas:', rutasRes.reason);
  }

  // ── 3. Alertas críticas (stock crítico + deuda vencida) ────────────────
  let clientesDeudaCount = 0, montoDeuda = 0;
  if (bloqueosRes.status === 'fulfilled') {
    const bloqueos = bloqueosRes.value || [];
    clientesDeudaCount = bloqueos.length;
    montoDeuda = bloqueos.reduce((acc, b) => acc + (+b.deuda_monto || 0), 0);
  } else {
    console.error('[Dashboard] resumen-arranque bloqueos:', bloqueosRes.reason);
  }

  // ── 4. Clientes en estado crítico de score (riesgo/bloqueado) ──────────
  let clientesScoreCriticoCount = 0;
  if (scoreCriticoRes.status === 'fulfilled') {
    clientesScoreCriticoCount = scoreCriticoRes.value.count ?? (scoreCriticoRes.value.data || []).length;
  } else {
    console.error('[Dashboard] resumen-arranque score crítico:', scoreCriticoRes.reason);
  }

  return {
    stock:   stockOut,
    rutas:   rutasOut,
    alertas: {
      stock_critico_count:            stockOut.stock_critico_count,
      clientes_deuda_vencida_count:   clientesDeudaCount,
      monto_deuda_vencida:            Math.round(montoDeuda * 100) / 100,
      clientes_score_critico_count:   clientesScoreCriticoCount,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/reportes/ventas-diarias?periodo=7d
//
// Respuesta:
// { series: [{ fecha: "2025-06-01", total: 12500 }, ...] }
// ══════════════════════════════════════════════════════════════════════════

async function handleVentasDiarias(req, res, empresa_id) {
  const { desde, hasta, dias } = periodoAFechas(req.query.periodo);

  const [{ data: pedidosData, error: errPedidos }, { data: posData, error: errPos }] = await Promise.all([
    AdminRepo.obtenerVentasPedidosPeriodo(empresa_id, desde, hasta),
    // Canal mostrador (POS). 'anulada' se excluye — no es venta real.
    // No hay riesgo de doble conteo: ventas_pos y pedidos son tablas
    // disjuntas (un pedido de pedidos.js nunca genera fila en ventas_pos
    // y viceversa).
    AdminRepo.obtenerVentasPosPeriodo(empresa_id, desde, hasta),
  ]);

  if (errPedidos) return errorSeguro(res, errPedidos, 500, 'No se pudo completar la operación.');
  if (errPos) return errorSeguro(res, errPos, 500, 'No se pudo completar la operación.');

  // Agrupar por día
  const porDia = new Map();

  // Inicializar todos los días del rango con 0
  for (let i = 0; i <= dias; i++) {
    const d = new Date(desde);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    porDia.set(key, 0);
  }

  // Sumar totales por día (pedidos + ventas de mostrador, mismo bucket)
  for (const p of [...(pedidosData || []), ...(posData || [])]) {
    const key = p.created_at.slice(0, 10);
    porDia.set(key, (porDia.get(key) || 0) + (+p.total || 0));
  }

  const series = [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, total]) => ({ fecha, total: Math.round(total * 100) / 100 }));

  return res.json({ series, periodo: req.query.periodo || '7d' });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/alertas?sin_leer=true
//
// Devuelve alertas del sistema: stock bajo crítico, pedidos sin despachar,
// pagos vencidos, y notificaciones sin leer del log.
//
// Respuesta:
// { alertas: [{ id, tipo, titulo, cuerpo, created_at }], resumen_cheques_vencidos: { cantidad, monto_total } }
// ══════════════════════════════════════════════════════════════════════════

async function handleAlertas(req, res, empresa_id) {
  const soloSinLeer = req.query.sin_leer === 'true';
  // Límite total de la respuesta. La campanita del topbar pide 8 (igual que
  // siempre); la página /admin/avisos (Alertas automáticas) pide más para
  // mostrar un historial real en vez de sólo el resumen corto. Se cubre el
  // rango histórico de límite=5 por categoría con un tope prudente de 50
  // para no pegarle una consulta gigante a la base.
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 20, 1), 50);
  const limitePorCategoria = Math.min(limite, 10);
  const alertas = [];

  // 1. Notificaciones del log sin leer
  const notifs = await AdminRepo.obtenerNotificacionesRecientes(empresa_id, 20);

  for (const n of notifs || []) {
    if (soloSinLeer && n.leida) continue;
    alertas.push({
      id:         n.id,
      tipo:       n.tipo || 'info',
      titulo:     n.titulo || 'Notificación',
      cuerpo:     n.cuerpo || '',
      created_at: n.created_at,
      leido:      n.leida,
      // datos_json.link se completa al crear la notificación (ej. "va tu
      // pedido con puntos ganados" → link al pedido). Sin esto la campanita
      // mostraba el aviso pero no llevaba a ningún lado al hacer clic.
      link:       n.datos_json?.link || null,
    });
  }

  // 2. Pedidos confirmados hace más de 24h sin despachar
  const hace24h = new Date();
  hace24h.setHours(hace24h.getHours() - 24);

  const pedidosDemorados = await AdminRepo.obtenerPedidosDemorados(empresa_id, hace24h.toISOString(), limitePorCategoria);

  for (const p of pedidosDemorados || []) {
    alertas.push({
      id:         `pedido-demorado-${p.id}`,
      tipo:       'pedido_nuevo',
      titulo:     `Pedido sin despachar`,
      cuerpo:     'Lleva más de 24 horas en estado confirmado',
      created_at: p.created_at,
      leido:      false,
      // Deep-link directo al pedido en cuestión. pedidos.js ya soporta
      // ?id=<uuid> (lo usa el botón "Confirmar" del dashboard) para abrir el
      // modal de ese pedido puntual sin que el dueño tenga que buscarlo a
      // mano entre todos los pedidos confirmados.
      link:       `/admin/pedidos?id=${p.id}`,
    });
  }

  // 3. Punto 3 del machete de auditoría de migración: sesiones "completado"
  // que terminaron con filas en error nunca reintentadas. `marcarSesionError`
  // ya avisa cuando una sesión entera se cae (estado='error', vía
  // notificaciones_push), pero ese es el caso raro. El caso común es una
  // migración que "termina bien" pero deja N filas sin poder crearse (CUIT
  // duplicado, FK inválida, etc.) — sin esto, esas filas quedan invisibles
  // fuera del wizard de migración hasta que alguien entra a mirar a mano.
  const sesionesConError = await AdminRepo.obtenerSesionesMigracionConError(empresa_id, limitePorCategoria);

  for (const s of sesionesConError || []) {
    alertas.push({
      id:         `migracion-pendiente-${s.id}`,
      tipo:       'migracion_pendiente',
      titulo:     `Migración con filas pendientes de resolver`,
      cuerpo:     `${s.filas_con_error} fila(s) de "${s.entidad}" (${s.nombre_archivo_original || 'sin nombre'}) no se pudieron importar. Reintentalas o corregilas en el módulo de Migración.`,
      created_at: s.created_at,
      leido:      false,
      // Deep-link a la sesión puntual (mismo query param ?sesion_id= que ya
      // arma migracion-badge.js) — migracion.js ahora lo lee al cargar y
      // destaca esa fila del historial en vez de dejar la lista genérica.
      link:       `/admin/migracion?sesion_id=${s.id}`,
    });
  }

  // 4. Cheques en cartera vencidos que todavía no fueron gestionados
  // (depositados, rechazados o devueltos). Mismo criterio que
  // riesgo-cheques.js: estado='en_cartera' y vencimiento < hoy.
  //
  // OJO: se filtra/ordena por `fecha_vto`, no por `vencimiento`. `fecha_vto`
  // es la columna real (NOT NULL, con índice) que usa el wizard de
  // migración masiva (migracion_confirmar_cheques_lote, migración 174) y el
  // cron de notificaciones — ese INSERT nunca completa `vencimiento`.
  // `vencimiento` es un alias que solo mantiene sincronizado a mano
  // cheques.js (la UI manual), sin trigger de la base (a diferencia de
  // facturas, que sí tiene uno desde la migración 094). Filtrar por
  // `vencimiento` dejaba afuera los cheques cargados por migración en
  // cuanto vencieran (ver CHANGELOG_v262).
  const hoyISO = new Date().toISOString().slice(0, 10);

  const chequesVencidos = await AdminRepo.obtenerChequesVencidos(empresa_id, hoyISO, limitePorCategoria);

  for (const c of chequesVencidos || []) {
    const cliente = c.clientes?.nombre_fantasia || c.clientes?.razon_social || 'Cliente';
    const vto = c.vencimiento || c.fecha_vto;
    alertas.push({
      id:         `cheque-vencido-${c.id}`,
      tipo:       'cheque_vencido',
      titulo:     `Cheque vencido sin gestionar`,
      cuerpo:     `${cliente} — Nº ${c.numero || '—'} por $${(+c.monto || 0).toLocaleString('es-AR')}, venció el ${vto}.`,
      created_at: vto,
      leido:      false,
      // Filtra directo a "solo vencidos" (cheques.js lee ?filtro=vencidos) y
      // precarga el buscador con el cliente puntual (mismo patrón que usa
      // riesgo-cheques.js con ?buscar=), en vez de tirar al dueño a la lista
      // completa sin filtrar a que lo busque a mano.
      link:       `/admin/cheques?filtro=vencidos&buscar=${encodeURIComponent(cliente)}`,
    });
  }

  // Resumen agregado (no limitado a 5) para la tarjeta proactiva del dashboard:
  // cuántos cheques vencidos hay en total y por cuánta plata, más allá de los
  // que se listan arriba en el panel de notificaciones.
  const resumenCheques = await AdminRepo.obtenerResumenChequesVencidos(empresa_id, hoyISO);

  const resumenChequesVencidos = {
    cantidad:    (resumenCheques || []).length,
    monto_total: (resumenCheques || []).reduce((acc, c) => acc + (+c.monto || 0), 0),
  };

  // 5. Clientes en estado crítico de score (riesgo/bloqueado) — mismo
  // criterio real que usa el Motor 5 de automatizacion.js y la tarjeta de
  // "algo prendido fuego" de resumen-arranque. Antes esto no aparecía acá
  // (además del bug de fondo en calcular_score_cliente que impedía que la
  // categoría se guardara — ver migración 318).
  const clientesCriticos = await AdminRepo.obtenerClientesScoreCritico(empresa_id, limitePorCategoria);

  for (const c of clientesCriticos || []) {
    const nombre = c.nombre_fantasia || c.razon_social || 'Cliente';
    alertas.push({
      id:         `score-critico-${c.id}`,
      tipo:       'score_critico',
      titulo:     c.score_categoria === 'bloqueado' ? 'Cliente bloqueado por score' : 'Cliente en riesgo (score)',
      cuerpo:     `${nombre} — score ${c.score_actual != null ? Math.round(c.score_actual) : '—'}/100.`,
      created_at: c.score_actualizado || new Date().toISOString(),
      leido:      false,
      link:       `/admin/clientes?id=${c.id}`,
    });
  }

  // 6. Facturas de proveedor con diferencias sin resolver contra la OC
  // (conciliar_oc_factura las marca en `discrepancias`; tiene_diferencias es
  // la columna generada de la migración 414). Mismo criterio que usan el
  // badge ⚠ Dif. y la tarjeta KPI de Cta. Cte. Proveedores — no se listan acá
  // las anuladas, ya no requieren acción.
  const facturasConDiferencias = await AdminRepo.obtenerFacturasProveedorConDiferencias(empresa_id, limitePorCategoria);

  for (const f of facturasConDiferencias || []) {
    const nomProv = f.proveedores?.nombre_fantasia || f.proveedores?.razon_social || 'Proveedor';
    const cant = Array.isArray(f.discrepancias) ? f.discrepancias.length : 0;
    alertas.push({
      id:         `factura-diferencia-${f.id}`,
      tipo:       'factura_diferencia',
      titulo:     `Factura con diferencias vs. OC`,
      cuerpo:     `${nomProv} — Nº ${f.numero_factura || '—'}, ${cant} ítem(s) fuera de lo pedido.`,
      created_at: f.created_at,
      leido:      false,
      link:       `/admin/cc-proveedores?factura=${f.id}`,
    });
  }

  // 7. Turnos de caja cerrados con diferencia de arqueo (efectivo esperado
  // vs. declarado al cerrar). Antes esto solo quedaba en turnos_caja.diferencia,
  // visible únicamente si el dueño entraba a mano a Cajas → Historial de
  // cierres — nada lo traía al panel de alertas ni disparaba aviso. Mismo
  // umbral de $1 que ya usa el filtro "Solo con diferencia" de ese historial
  // y el color de alerta del propio POS (TOLERANCIA_REDONDEO_PAGO), para no
  // marcar como alerta un redondeo de centavos.
  // usuarios!usuario_id: turnos_caja tiene DOS FKs a usuarios (usuario_id y
  // cerrado_forzado_por) — sin el hint, PostgREST tira ambigüedad (mismo
  // bug que rompía el Reporte Z, ver fix en pos.js).
  //
  // A diferencia del resto de las alertas de esta lista, una diferencia de
  // caja cerrada es un hecho histórico permanente: no existe un estado
  // "conciliado" o "gestionado" que la haga desaparecer sola (como sí pasa
  // con un cheque que cambia de estado o una factura que concilia). Sin
  // acotarla, los mismos turnos viejos quedan pegados en el panel para
  // siempre. Se agregan dos límites, igual que el resto del panel:
  // - Ventana de 30 días (mismo criterio que la ventana de 24h de pedidos,
  //   sólo más ancha porque una diferencia de caja no es tan urgente).
  // - Exclusión de los turnos ya marcados como resueltos, reusando la misma
  //   tabla `anomalias_revisadas` (migración 079) que usa auditoria.js, con
  //   tipo_anomalia='diferencia_caja' y entidad_id=turno.id. El botón
  //   "Marcar como resuelto" vive en el modal de detalle de cajas.html.
  const hace30dias = new Date();
  hace30dias.setDate(hace30dias.getDate() - 30);

  const turnosRevisados = await AdminRepo.obtenerAnomaliasRevisadas(empresa_id, 'diferencia_caja');

  const idsRevisados = new Set((turnosRevisados || []).map((r) => r.entidad_id));

  const turnosConDiferencia = await AdminRepo.obtenerTurnosConDiferencia(
    empresa_id, hace30dias.toISOString(), limitePorCategoria + idsRevisados.size
  );

  let mostrados = 0;
  for (const t of turnosConDiferencia || []) {
    if (mostrados >= limitePorCategoria) break;
    if (idsRevisados.has(t.id)) continue;
    mostrados++;
    const negativa = t.diferencia < 0;
    alertas.push({
      id:         `turno-diferencia-${t.id}`,
      tipo:       'diferencia_caja',
      titulo:     negativa ? 'Faltante de caja al cerrar' : 'Sobrante de caja al cerrar',
      cuerpo:     `${t.cajas_pos?.nombre || 'Caja'} — ${t.usuarios?.nombre || 'vendedor'}: diferencia de $${Math.abs(t.diferencia).toLocaleString('es-AR')}.`,
      created_at: t.cerrado_at,
      leido:      false,
      link:       `/admin/cajas?turno_dif=${t.id}`,
    });
  }

  // 8. Entregas confirmadas con un cobro registrado menor al total del
  // pedido (cobro parcial sin ajuste posterior). Antes esto solo se veía
  // entrando a Repartos → Historial, o al detalle puntual de la entrega —
  // no aparecía en ningún lado proactivo como sí pasa con diferencia_caja
  // o factura_diferencia. Mismo criterio de "hecho histórico permanente"
  // que la diferencia de caja (sección 7): se resuelve a mano vía
  // anomalias_revisadas (tipo_anomalia='entrega_cobro_parcial'), no hay un
  // estado de la entrega que la haga desaparecer sola. Deep-link a
  // rutas.html con el ruta_id/fecha para abrir el detalle sin que el
  // dueño tenga que buscarlo (ver rutas.js, sección de deep-link al final
  // del DOMContentLoaded).
  const entregasRevisadas = await AdminRepo.obtenerAnomaliasRevisadas(empresa_id, 'entrega_cobro_parcial');

  const idsEntregasRevisadas = new Set((entregasRevisadas || []).map((r) => r.entidad_id));

  const entregasConCobroParcial = await AdminRepo.obtenerEntregasConCobroParcial(
    empresa_id, hace30dias.toISOString(), 30
  );

  let mostradosEntrega = 0;
  for (const e of entregasConCobroParcial || []) {
    if (mostradosEntrega >= limitePorCategoria) break;
    if (idsEntregasRevisadas.has(e.id)) continue;

    const total      = Number(e.pedidos?.total || 0);
    const cobrado    = Number(e.monto_cobrado || 0);
    const diferencia = total - cobrado;
    if (diferencia <= 1) continue; // mismo umbral de $1 que el resto del panel

    mostradosEntrega++;
    const nombreCliente = e.pedidos?.clientes?.nombre_fantasia || e.pedidos?.clientes?.razon_social || 'Cliente';
    alertas.push({
      id:         `entrega-cobro-parcial-${e.id}`,
      tipo:       'entrega_cobro_parcial',
      titulo:     'Entrega con cobro parcial',
      cuerpo:     `${nombreCliente} — cobró $${cobrado.toLocaleString('es-AR')} de $${total.toLocaleString('es-AR')} (faltan $${diferencia.toLocaleString('es-AR')}).`,
      created_at: e.fecha_confirmacion,
      leido:      false,
      link:       `/admin/rutas?entrega_dif=${e.id}&ruta_id=${e.ruta_id || ''}&fecha=${e.rutas?.fecha || ''}`,
    });
  }

  // 9. Eventos de sincronización (eventos_negocio, Fase 1-3 del plan ERP)
  // que quedaron en estado 'error' hace más de MINUTOS_ERROR_PROLONGADO sin
  // que el cron de reproceso los resolviera (handleEventosReprocesarCron,
  // lib/handlers/notif.js, corre 1 vez por día). A diferencia del resto de
  // las categorías, esto no es un hecho de negocio (un cheque, una
  // entrega) sino una falla técnica del propio bus de eventos — Fase 8 del
  // plan ERP (observabilidad continua). No tiene "marcar como revisado":
  // se resuelve solo cuando el evento pasa a 'procesado' (reproceso
  // exitoso), igual criterio que cheque_vencido/factura_diferencia.
  const umbralErrorProlongado = new Date();
  umbralErrorProlongado.setMinutes(umbralErrorProlongado.getMinutes() - MINUTOS_ERROR_PROLONGADO);

  const eventosEnError = await ObservabilidadRepo.obtenerEventosEnErrorProlongado(
    empresa_id, umbralErrorProlongado.toISOString(), limitePorCategoria
  );

  for (const ev of (eventosEnError.data || [])) {
    const umbralLegible = MINUTOS_ERROR_PROLONGADO % 60 === 0
      ? `${MINUTOS_ERROR_PROLONGADO / 60} h`
      : `${MINUTOS_ERROR_PROLONGADO} min`;
    alertas.push({
      id:         `evento-error-${ev.id}`,
      tipo:       'evento_error_prolongado',
      titulo:     'Evento de sincronización con error',
      cuerpo:     `"${ev.tipo_evento}" (origen: ${ev.origen || 'desconocido'}) sigue en error desde hace más de ${umbralLegible}.`,
      created_at: ev.procesado_en,
      leido:      false,
      link:       `/admin/observabilidad`,
    });
  }

  // Ordenar por fecha descendente
  alertas.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return res.json({ alertas: alertas.slice(0, limite), resumen_cheques_vencidos: resumenChequesVencidos });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/onboarding
//
// Checklist de activación del propio tenant (ítem 1 del plan comercial:
// onboarding guiado post-trial). Mismo criterio de "activada" que ya usa
// saas_panel_admin (migración 186) para el panel superadmin, pero acá
// filtrado por la empresa del usuario logueado — no expone otras empresas.
//
// Respuesta:
// { tiene_productos, tiene_pedidos, tiene_ventas_pos, activada, dias_desde_alta }
// ══════════════════════════════════════════════════════════════════════════

async function handleOnboarding(req, res, empresa_id) {
  const [tieneProductos, { data: ped }, { data: pos }, { data: empresa }] = await Promise.all([
    existeProductoParaEmpresa(empresa_id),
    AdminRepo.obtenerPedidosExistentes(empresa_id),
    AdminRepo.obtenerVentasPosExistentes(empresa_id),
    AdminRepo.obtenerEmpresaFechaAlta(empresa_id),
  ]);

  const tiene_productos   = tieneProductos;
  const tiene_pedidos     = (ped    || []).length > 0;
  const tiene_ventas_pos  = (pos    || []).length > 0;
  const activada          = tiene_productos && (tiene_pedidos || tiene_ventas_pos);

  const dias_desde_alta = empresa?.created_at
    ? Math.floor((Date.now() - new Date(empresa.created_at).getTime()) / 86_400_000)
    : null;

  return res.json({
    tiene_productos,
    tiene_pedidos,
    tiene_ventas_pos,
    activada,
    dias_desde_alta,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/dashboard-ejecutivo?periodo=30d
//
// Etapa 5 — resumen consolidado (ventas + cobranza + stock + rentabilidad)
// para la sección "Panel ejecutivo" del Panel principal. Reusa
// obtener_kpis_dashboard_v3 (ya existente) para ventas/pedidos/clientes y
// suma obtener_dashboard_ejecutivo_resumen (migración 243) para cobranza,
// rentabilidad y el detalle de stock crítico.
//
// Respuesta: { ventas: {...}, cobranza: {...}, rentabilidad: {...}, stock: {...} }
// ══════════════════════════════════════════════════════════════════════════

async function handleDashboardEjecutivo(req, res, empresa_id) {
  const periodo = req.query.periodo || '30d';
  try {
    // Piloto Etapa 3 (robustez/escalabilidad, mismo criterio que
    // /api/admin/kpis): este handler dispara 5 RPCs en paralelo en cada
    // request, sin caché. 60s TTL, clave por empresa+período.
    const datos = await cacheado(
      `dashboard-ejecutivo:${empresa_id}:${periodo}`,
      KPIS_CACHE_TTL_MS,
      () => calcularDashboardEjecutivo(empresa_id, periodo),
    );
    return res.json(datos);
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

async function calcularDashboardEjecutivo(empresa_id, periodo) {
  const { desde, hasta, dias } = periodoAFechas(periodo);
  const desdeAnterior = new Date(desde);
  desdeAnterior.setDate(desdeAnterior.getDate() - dias);

  const [kpisRes, resumenRes, canalRes, comprasRes, gastosRes] = await Promise.all([
    AdminRepo.obtenerKpisDashboardV3Rpc({
      p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta, p_desde_anterior: desdeAnterior.toISOString(),
    }),
    AdminRepo.obtenerDashboardEjecutivoResumenRpc({
      p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta,
    }),
    // Desglose por canal, compras a proveedores (migración 478) y gastos
    // generales (migración 479) — no bloquean la respuesta si fallan
    // (empresa sin migración corrida todavía, por ejemplo): se degradan a
    // null y el frontend oculta esas secciones en vez de romper el panel.
    AdminRepo.obtenerVentasPorCanalRpc({ p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta }),
    AdminRepo.obtenerResumenComprasProveedorRpc({ p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta }),
    AdminRepo.obtenerResumenGastosGeneralesRpc({ p_empresa_id: empresa_id, p_desde: desde, p_hasta: hasta }),
  ]);

  if (kpisRes.error)    throw kpisRes.error;
  if (resumenRes.error) throw resumenRes.error;

  const k = kpisRes.data || {};
  const r = resumenRes.data || {};

  const delta = (actual, anterior) =>
    anterior === 0 ? null : Math.round(((actual - anterior) / anterior) * 100);

  return {
    periodo,
    desde, hasta,
    ventas: {
      total:      Math.round((k.ventas_actual || 0) * 100) / 100,
      delta_pct:  delta(k.ventas_actual || 0, k.ventas_anterior || 0),
      pedidos:    k.pedidos_actual || 0,
      clientes_activos: k.clientes_activos || 0,
      por_canal:  canalRes.error ? null : (canalRes.data || []),
    },
    cobranza:     r.cobranza     || null,
    rentabilidad: r.rentabilidad || null,
    stock:        r.stock        || null,
    compras_proveedor: comprasRes.error ? null : (comprasRes.data || null),
    gastos_generales:  gastosRes.error ? null : (gastosRes.data || null),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/comparativa-mensual
//
// Etapa 5 — serie diaria del mes en curso vs. el mismo tramo del mes
// anterior (día 1 a día N, N = hoy). Ver justificación de por qué es
// mensual y no interanual en la migración 243.
// ══════════════════════════════════════════════════════════════════════════

async function handleComparativaMensual(req, res, empresa_id) {
  try {
    // Piloto Etapa 3 (robustez/escalabilidad, mismo criterio que
    // /api/admin/kpis): RPC pesada que no depende de query params. 60s
    // TTL, clave por empresa.
    const datos = await cacheado(
      `comparativa-mensual:${empresa_id}`,
      KPIS_CACHE_TTL_MS,
      async () => {
        const { data, error } = await AdminRepo.obtenerComparativaMensualRpc(empresa_id);
        if (error) throw error;
        return data;
      },
    );
    return res.json(datos);
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/salud-eventos?horas=24
//
// Fase 8 de PLAN_ERP_SINCRONIZACION_2026.md (observabilidad continua):
// panel de salud del despachador de eventos (Fase 3). Lee eventos_negocio
// directo (lib/repos/observabilidad.js) — no hay tabla ni motor de métricas
// nuevo, esto es agregación sobre lo que las fases 1-3 ya generan.
//
// Respuesta:
// { ventana_horas, resumen: { total, pendiente, procesado, error },
//   por_tipo: [{ tipo_evento, total, pendiente, procesado, error, tiempo_promedio_procesamiento_ms }],
//   en_error_prolongado: [{ id, tipo_evento, origen, creado_en, procesado_en }] }
// ══════════════════════════════════════════════════════════════════════════

// Umbral para considerar un evento en error "prolongado" — ver el mismo
// criterio en handleAlertas más abajo (categoría evento_error_prolongado) y
// en obtenerEventosEnErrorProlongado. 2 horas (no 30 min): además del cron
// diario de reproceso, cada pedido nuevo de la empresa dispara un reintento
// inmediato (despacharPendientes({ empresaId }) en crearPedidoParaCliente),
// así que el reintento real depende de la actividad del negocio, no de un
// reloj fijo. Con un umbral corto, una empresa con poca actividad (ej. de
// noche) mostraría "error prolongado" solo por falta de pedidos nuevos que
// disparen el reintento, no por una falla real — 2hs da margen a que ese
// reintento por actividad corra solo antes de avisar.
const MINUTOS_ERROR_PROLONGADO = 120;

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/estado-financiero?agrupacion=mes&desde=ISO&hasta=ISO
//
// Migración 560 — pantalla única de ingresos por canal + egresos por
// categoría + serie de resultado (día/mes/año) + patrimonio neto
// aproximado. Reemplaza el cálculo 100% client-side de
// reportes-financieros.js: toda la agregación corre en
// obtener_estado_financiero_integral (una sola RPC).
//
// `desde`/`hasta` son opcionales: si no vienen, se aplica un rango por
// defecto según `agrupacion` (rangoPorDefectoEstadoFinanciero) para que la
// vista sea útil sin que el usuario tenga que elegir fechas a mano.
//
// Respuesta: exactamente el JSON de la RPC (agrupacion, desde, hasta,
// serie, ingresos_por_canal, egresos_por_categoria,
// compras_proveedor_periodo, totales, patrimonio_neto).
// ══════════════════════════════════════════════════════════════════════════

const AGRUPACIONES_VALIDAS = new Set(['dia', 'mes', 'anio']);

/**
 * Rango por defecto cuando el usuario no eligió fechas: suficiente
 * historia para que la vista tenga contenido en cada granularidad sin
 * traer de más — 30 días en vista Día, 12 meses en vista Mes, 5 años en
 * vista Año (ver comentario espejo en frontend/admin/js/estado-financiero.js).
 */
function rangoPorDefectoEstadoFinanciero(agrupacion) {
  const hasta = new Date();
  const desde = new Date(hasta);
  if (agrupacion === 'dia')       desde.setDate(desde.getDate() - 30);
  else if (agrupacion === 'anio') desde.setFullYear(desde.getFullYear() - 5);
  else                            desde.setMonth(desde.getMonth() - 12); // 'mes' (default)
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}

async function handleEstadoFinanciero(req, res, empresa_id) {
  try {
    const agrupacionQuery = req.query.agrupacion;
    const agrupacion = AGRUPACIONES_VALIDAS.has(agrupacionQuery) ? agrupacionQuery : 'mes';

    let { desde, hasta } = req.query;
    if (!desde || !hasta) {
      const porDefecto = rangoPorDefectoEstadoFinanciero(agrupacion);
      desde = desde || porDefecto.desde;
      hasta = hasta || porDefecto.hasta;
    }

    const { data, error } = await AdminRepo.obtenerEstadoFinancieroIntegralRpc({
      p_empresa_id: empresa_id,
      p_desde:      desde,
      p_hasta:      hasta,
      p_agrupacion: agrupacion,
    });
    if (error) throw error;

    return res.json(data);
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo cargar el estado financiero.');
  }
}

async function handleSaludEventos(req, res, empresa_id) {
  const horas = Math.min(Math.max(parseInt(req.query.horas, 10) || 24, 1), 24 * 7);
  const desde = new Date();
  desde.setHours(desde.getHours() - horas);
  const desdeISO = desde.toISOString();

  const umbral = new Date();
  umbral.setMinutes(umbral.getMinutes() - MINUTOS_ERROR_PROLONGADO);

  const { TIPOS_EVENTO_SIN_LISTENER } = await import('../eventos-dispatcher.js');

  const [{ data: eventos, error }, { data: enErrorProlongado, error: errorProlongado }] = await Promise.all([
    ObservabilidadRepo.obtenerEventosParaResumen(empresa_id, desdeISO),
    ObservabilidadRepo.obtenerEventosEnErrorProlongado(empresa_id, umbral.toISOString(), 20),
  ]);

  if (error)            return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  if (errorProlongado)  return errorSeguro(res, errorProlongado, 500, 'No se pudo completar la operación.');

  const resumen = { total: 0, pendiente: 0, procesado: 0, error: 0, pendiente_sin_listener: 0 };
  const porTipoMap = new Map();

  for (const ev of (eventos || [])) {
    resumen.total++;
    resumen[ev.estado] = (resumen[ev.estado] || 0) + 1;
    if (ev.estado === 'pendiente' && TIPOS_EVENTO_SIN_LISTENER.includes(ev.tipo_evento)) {
      resumen.pendiente_sin_listener++;
    }

    if (!porTipoMap.has(ev.tipo_evento)) {
      porTipoMap.set(ev.tipo_evento, {
        tipo_evento: ev.tipo_evento,
        total: 0, pendiente: 0, procesado: 0, error: 0,
        _sumaMsProcesado: 0, _cantProcesado: 0,
      });
    }
    const t = porTipoMap.get(ev.tipo_evento);
    t.total++;
    t[ev.estado] = (t[ev.estado] || 0) + 1;

    if (ev.estado === 'procesado' && ev.procesado_en) {
      t._sumaMsProcesado += new Date(ev.procesado_en) - new Date(ev.creado_en);
      t._cantProcesado++;
    }
  }

  // sin_listener: tipos de evento que NUNCA van a salir de 'pendiente' por
  // diseño (ver TIPOS_EVENTO_SIN_LISTENER en eventos-dispatcher.js) — se
  // anota acá para que el panel no los muestre como si el despachador
  // estuviera fallando. No afecta el conteo de `pendiente`/`error`, solo
  // agrega el flag para que el frontend lo distinga visualmente.
  const por_tipo = [...porTipoMap.values()]
    .map(t => ({
      tipo_evento: t.tipo_evento,
      total: t.total,
      pendiente: t.pendiente,
      procesado: t.procesado,
      error: t.error,
      tiempo_promedio_procesamiento_ms: t._cantProcesado > 0
        ? Math.round(t._sumaMsProcesado / t._cantProcesado)
        : null,
      sin_listener: TIPOS_EVENTO_SIN_LISTENER.includes(t.tipo_evento),
    }))
    .sort((a, b) => b.total - a.total);

  return res.json({
    ventana_horas: horas,
    resumen,
    por_tipo,
    en_error_prolongado: (enErrorProlongado || []).map(ev => ({
      id: ev.id,
      tipo_evento: ev.tipo_evento,
      origen: ev.origen,
      creado_en: ev.creado_en,
      procesado_en: ev.procesado_en,
    })),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// GET /api/admin/metricas-negocio?horas=24
//
// Fase 8 — métricas de negocio derivadas de eventos_negocio (a diferencia
// de "salud-eventos", que mide el bus en sí): pedidos por hora y tiempo
// promedio pedido→facturación, matcheando pedido_creado/pedido_facturado
// por payload.pedido_id (ver los emisores en lib/handlers/pedidos.js y
// lib/facturas.js — ambos escriben ese campo desde la Fase 1/4).
//
// OJO: esto solo ve pedidos facturados a través del flujo que emite estos
// dos eventos (piloto de Fase 1 en adelante). Un pedido facturado antes de
// que se instrumentara el evento, o facturado como venta_pos_id en vez de
// pedido_id, no entra en el promedio — no es una métrica global de
// facturación, es específica del flujo instrumentado.
//
// Respuesta:
// { ventana_horas, pedidos_por_hora: [{ hora, cantidad }],
//   tiempo_promedio_pedido_facturacion: { muestras, promedio_minutos } }
// ══════════════════════════════════════════════════════════════════════════

async function handleMetricasNegocio(req, res, empresa_id) {
  const horas = Math.min(Math.max(parseInt(req.query.horas, 10) || 24, 1), 24 * 7);
  const desde = new Date();
  desde.setHours(desde.getHours() - horas);

  const { data: eventos, error } = await ObservabilidadRepo.obtenerEventosPedidoParaMetricas(empresa_id, desde.toISOString());
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  const pedidosPorHoraMap = new Map();
  const creadoEnPorPedido = new Map();
  let sumaMinutos = 0;
  let muestras = 0;

  for (const ev of (eventos || [])) {
    if (ev.tipo_evento === 'pedido_creado') {
      const horaISO = ev.creado_en.slice(0, 13) + ':00:00.000Z'; // bucket por hora UTC
      pedidosPorHoraMap.set(horaISO, (pedidosPorHoraMap.get(horaISO) || 0) + 1);
      if (ev.payload?.pedido_id) creadoEnPorPedido.set(ev.payload.pedido_id, ev.creado_en);
      continue;
    }
    if (ev.tipo_evento === 'pedido_facturado' && ev.payload?.pedido_id) {
      const creadoEn = creadoEnPorPedido.get(ev.payload.pedido_id);
      if (creadoEn) {
        sumaMinutos += (new Date(ev.creado_en) - new Date(creadoEn)) / 60_000;
        muestras++;
      }
    }
  }

  const pedidos_por_hora = [...pedidosPorHoraMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hora, cantidad]) => ({ hora, cantidad }));

  return res.json({
    ventana_horas: horas,
    pedidos_por_hora,
    tiempo_promedio_pedido_facturacion: {
      muestras,
      promedio_minutos: muestras > 0 ? Math.round((sumaMinutos / muestras) * 10) / 10 : null,
    },
  });
}
