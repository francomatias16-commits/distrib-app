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
  'export-contable':       () => import('../lib/handlers/export-contable.js'), // Etapa 6 — export contable (Tango/Bejerman/Contabilium)
  'reglas-precio':         () => import('../lib/handlers/reglas-precio.js'), // Etapa 2: CRUD de reglas_precio (243)
  'gastos-generales':      () => import('../lib/handlers/gastos-generales.js'), // CRUD de gastos_generales (479) — Ganancia Neta
  'reglas-automatizacion': () => import('../lib/handlers/reglas-automatizacion.js'), // Fase 6 (plan ERP de sincronización)
  'conciliacion-bancaria': () => import('../lib/handlers/conciliacion-bancaria.js'), // Etapa 3 — conciliación bancaria (248)
  fidelizacion:            () => import('../lib/handlers/fidelizacion.js'), // Etapa 13 (auditoría UX) H1 — canje de recompensas desde el portal cliente
  maestros:                () => import('../lib/handlers/maestros.js'), // ABM de zonas, depósitos, listas de precio y categorías
  'banco-codigos':         () => import('../lib/handlers/banco-codigos.js'), // 440 — banco de códigos de barras compartido entre empresas
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

export default async function handler(req, res) {
  const mod = req.query._mod;

  const fn = await cargarHandler(mod);

  if (!fn) {
    // Sin CORS wildcard — applyCorsHeaders ya aplicó el origen correcto arriba
    return res.status(404).json({ error: `Módulo de API desconocido: ${mod ?? '(sin especificar)'}` });
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
      return res.status(400).json({ error: 'Body inválido: se esperaba JSON' });
    }

    // 456 — Usuario demo (solo_lectura=true, ver migración 456): corta acá
    // cualquier mutación ANTES de llegar al handler, sin tener que tocar
    // los ~35 handlers uno por uno. bloquearSiSoloLectura ya responde el
    // 403 por su cuenta cuando corresponde.
    if (await bloquearSiSoloLectura(req, res)) return;
  }

  try {
    return await fn(req, res);
  } catch (err) {
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
  }
}
