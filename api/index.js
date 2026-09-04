// api/index.js — Dispatcher único (1 Serverless Function para todo el proyecto)
//
// Vercel Hobby permite máximo 12 Serverless Functions. Este proyecto tenía 17
// handlers en api/*/index.js. Para resolverlo sin perder funcionalidad, se
// consolidaron todos los handlers en lib/handlers/ y este archivo los
// despacha según el query param ?_mod=<módulo>, que vercel.json agrega en
// cada rewrite.
//
// IMPORTANTE: dentro de los handlers, req.url ya NO refleja la ruta original
// (ej: /api/auth/login), sino algo como /api/index?_mod=auth&_ruta=login.
// El sub-ruteo dentro de cada handler se hace exclusivamente vía req.query
// (_mod, _ruta, _svc, accion, recurso, tipo, etc.), nunca vía req.url.
//
// FIX v861 (504 en /api/admin/kpis y /api/admin/stock/bajo): antes este
// archivo importaba los 40 handlers de forma ESTÁTICA (import ... from) al
// tope del archivo. Node tenía que inicializar los 40 —incluyendo módulos
// pesados como AFIP/ARCA, WhatsApp, el wizard de migración y el asistente
// RAG— en CADA cold start del lambda, aunque la request fuera solo para
// kpis. Eso, sumado al límite de memoria/tiempo del plan Hobby, producía
// cold starts tan lentos que terminaban en 504 antes de llegar a ejecutar
// ninguna query (las queries a la base tardan milisegundos — no es un
// problema de Supabase).
//
// Ahora HANDLERS pasó a ser LOADERS: cada entrada es una función
// `() => import('../lib/handlers/archivo.js')` que solo se ejecuta cuando
// llega una request para ESE módulo puntual. El resultado se cachea en
// memoria del lambda (moduleCache) para que las invocaciones "warm" —el
// mismo lambda atendiendo otra request después de la primera— no vuelvan a
// pagar el costo de import().

import '../lib/ws-polyfill.js'; // FIX v339: debe ir primero (ver comentario en el archivo)

import * as Sentry from '@sentry/node'; // Fase 4.1 (plan de acción) — error tracking
import { bloquearSiSoloLectura } from '../lib/solo-lectura.js'; // 456 — corta mutaciones del usuario demo (Marina Torres) antes del handler

// ── Sentry (Fase 4.1, plan de acción) ────────────────────────────────────
// Se activa solo si SENTRY_DSN está seteada (Vercel → env vars del proyecto).
// Sin la variable, Sentry.init() no corre y el resto del dispatcher sigue
// funcionando igual que antes — no rompe entornos locales ni previews sin
// configurar. El DSN de Sentry no es secreto (está pensado para viajar en
// código cliente), pero igual lo dejamos por env var y no hardcodeado para
// poder tener DSNs distintos por entorno (prod vs preview) sin tocar código.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    tracesSampleRate: 0, // Fase 4.1 es solo error tracking, no performance tracing
  });
}

// ── Body parsing manual ──────────────────────────────────────────────────
// Se desactiva el bodyParser automático de Vercel (config.api.bodyParser)
// para poder quedarnos con los bytes crudos del body (`req.rawBody`).
// Motivo: el webhook de WhatsApp (Etapa 3, notif.js) necesita validar la
// firma `X-Hub-Signature-256` que manda Meta, y esa validación es un HMAC
// sobre el body exacto tal como llegó — si dejamos que Vercel lo parsee a
// JSON primero, perdemos esos bytes y la firma nunca va a matchear.
// Para no romper los ~25 handlers que ya esperan `req.body` como objeto
// parseado, acá mismo leemos el stream y lo parseamos nosotros, dejando
// `req.body` idéntico a como quedaba antes en todos los casos normales.
export const config = {
  api: { bodyParser: false },
};

async function leerRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// LOADERS — mapa mod → () => import('../lib/handlers/archivo.js')
// Clave y archivo viven en la misma línea (a diferencia del HANDLERS
// original, que separaba el import arriba de la referencia acá abajo).
// Mismas 40 claves que el HANDLERS anterior, verificado byte a byte.
const LOADERS = {
  auth:                    () => import('../lib/handlers/auth.js'),
  admin:                   () => import('../lib/handlers/admin.js'),
  asistente:               () => import('../lib/handlers/asistente.js'), // Asistente de ayuda interno (RAG, ver docs/ayuda)
  auditoria:               () => import('../lib/handlers/auditoria.js'),
  automatizacion:          () => import('../lib/handlers/automatizacion.js'),
  bcra:                    () => import('../lib/handlers/bcra.js'), // Integración APIs públicas BCRA (cheques/situación)
  busqueda:                () => import('../lib/handlers/busqueda.js'),
  cierre:                  () => import('../lib/handlers/cierre.js'),
  ciclos:                  () => import('../lib/handlers/ciclos.js'),
  clientes:                () => import('../lib/handlers/clientes.js'),
  empresa:                 () => import('../lib/handlers/empresa.js'),
  etiquetas:               () => import('../lib/handlers/etiquetas.js'), // 543 — config del generador de etiquetas de precio/código de barras
  facturas:                () => import('../lib/handlers/facturas.js'),
  importar:                () => import('../lib/handlers/importar.js'),
  'auto-imagenes':         () => import('../lib/handlers/auto-imagenes.js'), // Auto-carga de fotos de productos (barcode → banco de fotos → ícono fallback en frontend)
  notif:                   () => import('../lib/handlers/notif.js'),
  pagos:                   () => import('../lib/handlers/pagos.js'),
  pedidos:                 () => import('../lib/handlers/pedidos.js'),
  piloto:                  () => import('../lib/handlers/piloto.js'),
  pos:                     () => import('../lib/handlers/pos.js'),
  'pos-scanner':           () => import('../lib/handlers/pos-scanner.js'), // v612 — vincular celular como lector remoto
  proveedores:             () => import('../lib/handlers/proveedores.js'),
  'rutas-live':            () => import('../lib/handlers/rutas-live.js'),
  score:                   () => import('../lib/handlers/score.js'),
  'stock-auto':            () => import('../lib/handlers/stock-auto.js'),
  stock:                   () => import('../lib/handlers/stock.js'),
  setup:                   () => import('../lib/handlers/setup.js'),
  migracion:               () => import('../lib/handlers/migracion.js'), // Wizard de migración de clientes/productos
  registro:                () => import('../lib/handlers/registro.js'), // §2.1 Registro público SaaS
  'registro-social':       () => import('../lib/handlers/registro-social.js'), // Registro público SaaS vía Google/Microsoft/Facebook
  usuarios:                () => import('../lib/handlers/usuarios.js'), // Etapa 14 (auditoría UX) — alta/gestión de usuarios internos
  'chofer-invitacion':     () => import('../lib/handlers/chofer_invitacion.js'), // Repartos — invitación de choferes por link/WhatsApp
  saas:                    () => import('../lib/handlers/saas.js'), // §3 Panel superadmin SaaS
  'saas-alertas':          () => import('../lib/handlers/saas-alertas.js'), // Aviso por email al dueño de la plataforma cuando se registra un tenant nuevo (trigger 548)
  'export-contable':       () => import('../lib/handlers/export-contable.js'), // Etapa 6 — export contable (Tango/Bejerman/Contabilium)
  'reglas-precio':         () => import('../lib/handlers/reglas-precio.js'), // Etapa 2: CRUD de reglas_precio (243)
  'gastos-generales':      () => import('../lib/handlers/gastos-generales.js'), // CRUD de gastos_generales (479) — Ganancia Neta
  'reglas-automatizacion': () => import('../lib/handlers/reglas-automatizacion.js'), // Fase 6 (plan ERP de sincronización)
  'conciliacion-bancaria': () => import('../lib/handlers/conciliacion-bancaria.js'), // Etapa 3 — conciliación bancaria (248)
  retencion:               () => import('../lib/handlers/retencion.js'), // Etapa 2 del plan de robustez/escalabilidad — archivado+purga de notif_log/eventos_negocio/audit_log
  fidelizacion:            () => import('../lib/handlers/fidelizacion.js'), // Etapa 13 (auditoría UX) H1 — canje de recompensas desde el portal cliente
  maestros:                () => import('../lib/handlers/maestros.js'), // ABM de zonas, depósitos, listas de precio y categorías
  'banco-codigos':         () => import('../lib/handlers/banco-codigos.js'), // 440 — banco de códigos de barras compartido entre empresas
  'captura-competencia':   () => import('../lib/handlers/captura-competencia.js'), // 551/552 — Fase 1 (PLAN_CAPTURA_COMPETENCIA.md): captura y comparación de factura de competencia en el mostrador
  'prospectos-competencia': () => import('../lib/handlers/prospectos-competencia.js'), // 557 — Fase 3 (PLAN_CAPTURA_COMPETENCIA.md, Capa 1): prospección geográfica sobre rutas existentes
  'clientes-fuga':          () => import('../lib/handlers/clientes-fuga.js'), // v1060+ — Fase 3 (PLAN_CLIENTES_EN_FUGA.md): pantalla de clientes en fuga
};

// Cache de módulos ya cargados en ESTE lambda (sobrevive entre invocaciones
// "warm" del mismo contenedor, se pierde en cold start — que es exactamente
// lo que queremos: pagar el import() una sola vez por contenedor, no una
// vez por request).
const moduleCache = new Map();

async function cargarHandler(mod) {
  if (moduleCache.has(mod)) return moduleCache.get(mod);

  const loader = LOADERS[mod];
  if (!loader) return null;

  const imported = await loader();
  const fn = imported.default;
  moduleCache.set(mod, fn);
  return fn;
}

// Umbral de alerta de duración (Etapa 6, plan de robustez): 45s sobre un
// límite de función de 60s (Hobby/Pro). La idea es ver en los logs los
// candidatos a 504 ANTES de que efectivamente truncen, no solo contar los
// 504 que ya pasaron. 45s = 75% del límite, deja margen para reaccionar.
const UMBRAL_ALERTA_DURACION_MS = 45_000;

// Nombres de query param usados en distintos handlers para sub-rutear
// dentro de un mismo módulo (ver comentario de cabecera del archivo).
// Se listan en orden de prioridad; el primero que aparezca en la request
// se usa como "sub-ruta" en el log de duración.
const PARAMS_SUB_RUTA = ['_ruta', '_svc', 'accion', 'recurso', 'tipo'];

function obtenerSubRuta(req) {
  for (const p of PARAMS_SUB_RUTA) {
    if (req.query[p]) return req.query[p];
  }
  return null;
}

// [PERF] Etapa 6 (plan de robustez/escalabilidad) — instrumentación mínima
// de duración por request. Objetivo: acumular tráfico real para poder medir
// p95/p99 por módulo/sub-ruta y detectar qué endpoints se acercan al límite
// de 60s de Vercel, algo que hoy no se podía calcular (sin esto, no había
// ningún dato de duración en los logs — ver Runtime Logs de Vercel, que solo
// tienen texto de errores/console.log puntuales, nada de timing).
// Formato de línea pensado para ser grepeable: query="[PERF]" en
// get_runtime_logs, o group_by no aplica acá porque duration_ms es
// continuo — hay que traer líneas crudas y calcular percentiles aparte.
function logDuracion(req, res, mod, inicioMs) {
  const duration_ms = Date.now() - inicioMs;
  const subRuta = obtenerSubRuta(req);
  const linea = `[PERF] mod=${mod ?? '(none)'} ruta=${subRuta ?? '-'} method=${req.method} status=${res.statusCode} duration_ms=${duration_ms}`;

  if (duration_ms >= UMBRAL_ALERTA_DURACION_MS) {
    // console.warn en vez de console.log a propósito: separa esto de las
    // ~5000 líneas de ruido de [PERF] normal cuando alguien filtre por
    // level=warning en get_runtime_logs.
    console.warn(`${linea} ⚠️ cerca del límite de 60s (umbral ${UMBRAL_ALERTA_DURACION_MS}ms)`);
  } else {
    console.log(linea);
  }
}

export default async function handler(req, res) {
  const inicioMs = Date.now();
  const mod = req.query._mod;

  try {
    const fn = await cargarHandler(mod);

    if (!fn) {
      // Sin CORS wildcard — applyCorsHeaders ya aplicó el origen correcto arriba
      res.status(404).json({ error: `Módulo de API desconocido: ${mod ?? '(sin especificar)'}` });
      return;
    }

    // Body manual: con bodyParser desactivado (ver arriba), a nadie le llega
    // req.body salvo que lo armemos acá. Métodos sin body (GET/HEAD) se
    // saltean directamente. req.rawBody queda disponible para quien necesite
    // los bytes exactos (hoy: la validación de firma del webhook de WhatsApp).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const raw = await leerRawBody(req);
        req.rawBody = raw; // Buffer — notif.js lo usa tal cual para el HMAC
        req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch (err) {
        res.status(400).json({ error: 'Body inválido: se esperaba JSON' });
        return;
      }

      // 456 — Usuario demo (solo_lectura=true, ver migración 456): corta acá
      // cualquier mutación ANTES de llegar al handler, sin tener que tocar
      // los ~35 handlers uno por uno. bloquearSiSoloLectura ya responde el
      // 403 por su cuenta cuando corresponde.
      if (await bloquearSiSoloLectura(req, res)) return;
    }

    return await fn(req, res);
  } catch (err) {
    // FIX — ver lib/auth-helpers.js (verificarToken): un timeout real del
    // servicio de Auth de Supabase ahora llega hasta acá como excepción
    // (antes se confundía con "token inválido" y respondía 401, disparando
    // un logout falso en el frontend). Se responde 503 — mismo criterio y
    // mismo mensaje que ya usa admin.js para este caso — en vez de caer en
    // el 500 genérico de abajo.
    if (err?.esTimeoutAuth) {
      if (!res.headersSent) {
        res.status(503).json({ error: err.message, codigo: 'TIMEOUT_AUTH' });
      }
      logDuracion(req, res, mod, inicioMs);
      return;
    }

    // BUG-03 (auditoría v194, P0): antes se mandaba err?.message directo al
    // cliente en el 500. Eso puede filtrar detalles internos (nombres de
    // tabla, fragmentos de query SQL, stack de librerías) a cualquiera que
    // provoque un error. Ahora el detalle completo solo queda en los logs
    // del servidor, correlacionado con un ID que sí es seguro exponer.
    const correlationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    console.error(`[DISPATCHER] Error en módulo "${mod}" (correlation_id=${correlationId}):`, err?.stack || err?.message || err);

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { modulo: mod, correlation_id: correlationId },
      });
    }

    if (!res.headersSent) {
      res.status(500).json({ error: 'Error interno del servidor', correlation_id: correlationId });
    }
  } finally {
    // finally corre siempre: éxito, 404, 400 de body inválido, bloqueo por
    // solo-lectura, o el catch de arriba. Un solo punto de log, sin
    // duplicar la línea [PERF] en cada return posible.
    logDuracion(req, res, mod, inicioMs);
  }
}
