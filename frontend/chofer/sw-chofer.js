/**
 * sw-chofer.js — Service Worker PWA App Chofer v1
 * distrib-v162 | Offline-first para ruta del día y remitos
 *
 * Por qué offline acá importa más que en el admin: el chofer está en la calle,
 * a menudo con señal mala o nula, y necesita poder abrir su ruta de hoy y
 * cargar una entrega/devolución aunque no haya datos en ese momento.
 *
 * Estrategias:
 *   Cache-First            → Shell de la app (HTML, CSS compartido, manifest, íconos)
 *   Network-First + cache  → Ruta del día y remitos (último dato bueno si no hay red)
 *   Network-Only           → Confirmaciones de entrega/devolución (no tiene sentido
 *                             servir un POST desde caché; si falla, el usuario reintenta)
 */

'use strict';

const SW_VERSION   = 'chofer-v163';
const CACHE_STATIC = `${SW_VERSION}-static`;
const CACHE_DATA   = `${SW_VERSION}-data`;
let SESSION_SCOPE  = 'anonymous';

const PRECACHE_URLS = [
  '/chofer',
  '/chofer/login',
  '/chofer/remito',
  '/chofer/gps-tracker.js',
  '/shared/tokens.css',
];

// GET que conviene servir desde caché si no hay red (último estado conocido)
const NETWORK_FIRST_PATTERNS = [
  /\/api\/chofer\/remitos(\?|$)/,
  /\/api\/chofer\/clientes(\?|$)/,
  /\/api\/chofer\/productos(\?|$)/,
];

// Nunca cachear — son acciones que modifican datos
const NETWORK_ONLY_PATTERNS = [
  /\/api\/chofer\/devolucion/,
  /\/api\/chofer\/entrega-foto/,
  /\/api\/chofer\/.*\/entregar/,
  /\/api\/rutas-live/,   // posición GPS del chofer — nunca servir/cachear desde acá
  /\/api\/auth/,
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then((c) => c.addAll(PRECACHE_URLS))
      .catch((err) => console.warn('[SW-chofer] Precache parcial:', err))
      .then(() => self.skipWaiting())
  );
});

// El service worker no puede leer localStorage ni el JWT por sí solo. La pestaña
// comunica el scope después del login/detalle del remito; mientras no lo haga,
// las respuestas de datos no se mezclan con una sesión identificada.
self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type !== 'CHOFER_SESSION_SCOPE' && data.type !== 'CHOFER_SESSION_LOGOUT') return;

  if (data.type === 'CHOFER_SESSION_LOGOUT') {
    SESSION_SCOPE = 'anonymous';
    e.waitUntil(caches.delete(CACHE_DATA));
    return;
  }

  const empresa = String(data.empresa_id || '').trim();
  const usuario = String(data.usuario_id || '').trim();
  const nextScope = empresa && usuario ? `${empresa}:${usuario}` : 'anonymous';
  if (nextScope !== SESSION_SCOPE) {
    SESSION_SCOPE = nextScope;
    // No conservar datos de la sesión anterior cuando se cambia de usuario.
    e.waitUntil(caches.delete(CACHE_DATA));
  }
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_STATIC && k !== CACHE_DATA)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Background Sync (Plan offline, Etapa 1) ──────────────────────────────
// Relevo best-effort: el SW no tiene la sesión del chofer, así que en vez
// de sincronizar acá, avisa a cualquier pestaña abierta para que sea ella
// (chofer-offline.js / OfflineCore) la que dispare el sync real.
self.addEventListener('sync', (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'BACKGROUND_SYNC', tag: e.tag }));
    })
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (!['http:', 'https:'].includes(url.protocol)) return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('manifest.json')) return; // ver nota en sw-admin.js

  if (req.method !== 'GET') {
    // POSTs de entrega/devolución: siempre red. Si falla, que el chofer lo vea
    // y reintente — encolar offline acá queda como mejora futura (IDB), no
    // conviene fingir éxito en una confirmación de entrega.
    return;
  }

  if (NETWORK_ONLY_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(fetch(req));
    return;
  }

  if (NETWORK_FIRST_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(networkFirst(req));
    return;
  }

  if (
    url.pathname.startsWith('/chofer') ||
    url.pathname.startsWith('/frontend/chofer/') ||
    url.pathname.startsWith('/shared/')
  ) {
    e.respondWith(cacheFirst(req));
    return;
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const c = await caches.open(CACHE_STATIC);
      c.put(req, resp.clone());
    }
    return resp;
  } catch {
    return cached || new Response('Sin conexión', { status: 503 });
  }
}

function scopedCacheRequest(req) {
  const url = new URL(req.url);
  url.searchParams.set('__chofer_session_scope', SESSION_SCOPE);
  return new Request(url.toString(), { method: 'GET' });
}

async function networkFirst(req) {
  const cacheReq = scopedCacheRequest(req);
  try {
    const resp = await fetch(req);
    if (resp.ok && SESSION_SCOPE !== 'anonymous') {
      const cache = await caches.open(CACHE_DATA);
      cache.put(cacheReq, resp.clone());
    }
    return resp;
  } catch {
    const cached = SESSION_SCOPE === 'anonymous' ? null : await caches.match(cacheReq);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Sin conexión', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
