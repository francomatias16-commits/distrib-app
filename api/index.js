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

import '../lib/ws-polyfill.js'; // FIX v339: debe ir primero (ver comentario en el archivo)

import * as Sentry from '@sentry/node'; // Fase 4.1 (plan de acción) — error tracking

import auth           from '../lib/handlers/auth.js';
import admin          from '../lib/handlers/admin.js';
import auditoria      from '../lib/handlers/auditoria.js';
import automatizacion from '../lib/handlers/automatizacion.js';
import reglasAutomatizacion from '../lib/handlers/reglas-automatizacion.js'; // Fase 6 (plan ERP de sincronización)
import bcra           from '../lib/handlers/bcra.js';       // Integración APIs públicas BCRA (cheques/situación)
import busqueda       from '../lib/handlers/busqueda.js';
import cierre         from '../lib/handlers/cierre.js';
import ciclos         from '../lib/handlers/ciclos.js';
import clientes       from '../lib/handlers/clientes.js';
import empresa        from '../lib/handlers/empresa.js';
import facturas       from '../lib/handlers/facturas.js';
import importar       from '../lib/handlers/importar.js';
import autoImagenes   from '../lib/handlers/auto-imagenes.js'; // Auto-carga de fotos de productos (barcode → banco de fotos → ícono fallback en frontend)
import notif          from '../lib/handlers/notif.js';
import pagos          from '../lib/handlers/pagos.js';
import pedidos        from '../lib/handlers/pedidos.js';
import piloto         from '../lib/handlers/piloto.js';
import pos            from '../lib/handlers/pos.js';
import posScanner     from '../lib/handlers/pos-scanner.js'; // v612 — vincular celular como lector remoto
import proveedores    from '../lib/handlers/proveedores.js';
import rutasLive      from '../lib/handlers/rutas-live.js';
import score          from '../lib/handlers/score.js';
import stockAuto      from '../lib/handlers/stock-auto.js';
import stock          from '../lib/handlers/stock.js';
import setup          from '../lib/handlers/setup.js';
import migracion      from '../lib/handlers/migracion.js'; // Wizard de migración de clientes/productos
import registro       from '../lib/handlers/registro.js';  // §2.1 Registro público SaaS
import registroSocial from '../lib/handlers/registro-social.js'; // Registro público SaaS vía Google/Microsoft/Facebook
import usuarios       from '../lib/handlers/usuarios.js';  // Etapa 14 (auditoría UX) — alta/gestión de usuarios internos
import choferInvitacion from '../lib/handlers/chofer_invitacion.js'; // Repartos — invitación de choferes por link/WhatsApp
import saas           from '../lib/handlers/saas.js';      // §3 Panel superadmin SaaS
import asistente      from '../lib/handlers/asistente.js'; // Asistente de ayuda interno (RAG, ver docs/ayuda)
import exportContable from '../lib/handlers/export-contable.js'; // Etapa 6 — export contable (Tango/Bejerman/Contabilium)
import reglasPrecio   from '../lib/handlers/reglas-precio.js'; // Etapa 2: CRUD de reglas_precio (243)
import conciliacionBancaria from '../lib/handlers/conciliacion-bancaria.js'; // Etapa 3: conciliación bancaria (248)
import fidelizacion   from '../lib/handlers/fidelizacion.js'; // Etapa 13 (auditoría UX) H1 — canje de recompensas desde el portal cliente
import maestros       from '../lib/handlers/maestros.js';  // ABM de zonas, depósitos, listas de precio y categorías
import bancoCodigos   from '../lib/handlers/banco-codigos.js'; // 440 — banco de códigos de barras compartido entre empresas

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

const HANDLERS = {
  auth,
  admin,
  asistente,
  auditoria,
  automatizacion,
  bcra,
  busqueda,
  cierre,
  ciclos,
  clientes,
  empresa,
  facturas,
  importar,
  'auto-imagenes': autoImagenes,
  notif,
  pagos,
  pedidos,
  piloto,
  pos,
  'pos-scanner': posScanner, // v612 — vincular celular como lector remoto
  proveedores,
  'rutas-live': rutasLive,
  score,
  'stock-auto': stockAuto,
  stock,
  setup,
  migracion,
  registro,  // POST /api/registro — registro público de nuevas empresas
  'registro-social': registroSocial, // POST /api/registro-social — completa el registro para altas por Google/Microsoft/Facebook
  usuarios,  // /api/usuarios — alta/gestión de usuarios internos
  'chofer-invitacion': choferInvitacion, // /api/chofer-invitacion — admin (invitar/listar/revocar) + público (ver/activar)
  saas,      // /api/saas/* — panel superadmin SaaS
  'export-contable': exportContable, // Etapa 6 — export contable
  'reglas-precio': reglasPrecio,
  'reglas-automatizacion': reglasAutomatizacion, // Fase 6 (plan ERP de sincronización)
  'conciliacion-bancaria': conciliacionBancaria, // Etapa 3 — conciliación bancaria (248)
  fidelizacion, // Etapa 13 (auditoría UX) H1 — catálogo de recompensas canjeable desde el portal cliente
  maestros, // ABM de zonas, depósitos, listas de precio y categorías
  'banco-codigos': bancoCodigos, // 440 — banco de códigos de barras compartido entre empresas
};

export default async function handler(req, res) {
  const mod = req.query._mod;
  const fn  = HANDLERS[mod];

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
