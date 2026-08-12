/**
 * sw-cliente.js — Service Worker PWA Portal Cliente v1
 * Plan offline — Etapa 2 | Solo lectura cacheable, sin cola de escritura
 *
 * Alcance real de este SW (ver PLAN_OFFLINE_ETAPA0_MAPA_OPERACIONES.md):
 * cubre el shell (HTML/CSS/JS) y los endpoints de API de solo lectura.
 * NO cubre las pantallas que leen directo de Supabase con
 * `supabase.createClient(...)` (inicio.html, notificaciones.html) —
 * esas llamadas van a `*.supabase.co`, son cross-origin, y un Service
 * Worker no puede interceptarlas para cachearlas sin un proxy propio.
 * Con este SW esas dos pantallas dejan de quedar en blanco offline
 * (el shell carga desde caché), pero sus datos en pantalla van a fallar
 * igual sin red hasta que se las migre a leer vía /api/ (fuera de
 * alcance de esta etapa).
 *
 * Estrategias:
 *   Cache-First            → Shell (HTML de páginas, CSS, JS, íconos)
 *   Stale-While-Revalidate → Catálogo (categorías/productos) y recompensas
 *   Network-First          → Páginas HTML (último dato bueno si no hay red)
 *   Network-Only           → Auth, pagos, pedidos (precio/stock en tiempo
 *                             real), tracking de ruta en vivo
 */

'use strict';

const SW_VERSION   = 'cliente-v2';
const CACHE_STATIC = `${SW_VERSION}-static`;
const CACHE_DATA   = `${SW_VERSION}-data`;

const PRECACHE_URLS = [
  '/cliente/inicio',
  '/cliente/login',
  '/cliente/catalogo',
  '/cliente/carrito',
  '/cliente/pedidos',
  '/cliente/cuenta',
  '/cliente/notificaciones',
  '/shared/tokens.css',
  '/shared/skeletons.css',
  '/shared/reskin-patch.css',
  '/shared/reskin-patch-v2-shadcn.css',
  '/shared/tienda-nav.css',
];

// GET de catálogo/recompensas — bajo riesgo, se sirve del último dato
// conocido mientras se revalida en segundo plano
const SWR_PATTERNS = [
  /\/api\/cliente\/categorias(\?|$)/,
  /\/api\/fidelizacion(\?|$)/,
];

// Nunca cachear: precio/stock en tiempo real, dinero, auth, o tracking en vivo
const NETWORK_ONLY_PATTERNS = [
  /\/api\/auth/,
  /\/api\/pagos/,
  /\/api\/pedidos/,             // incluye ver-sugerido (precio recalculado) y confirmar (mutación)
  /\/api\/rutas-live/,          // seguimiento del pedido en camino
  /\/api\/cliente\/productos(\?|$)/, // FIX F4-02 (SW): desde que este endpoint resuelve
                                      // precio real por cliente (especial/regla/lista), ya
                                      // no es catálogo genérico "bajo riesgo" — es dinero.
                                      // Antes vivía en SWR y servía precio viejo cacheado
                                      // (de antes de loguearse o de antes del fix) mientras
                                      // revalidaba atrás, sin que se notara hasta el próximo
                                      // load. Movido a network-only.
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then((c) => c.addAll(PRECACHE_URLS))
      .catch((err) => console.warn('[SW-cliente] Precache parcial:', err))
      .then(() => self.skipWaiting())
  );
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (!['http:', 'https:'].includes(url.protocol)) return;

  // Mutaciones → siempre a la red (ninguna categoría 2 todavía, ver Etapa 3)
  if (req.method !== 'GET') return;

  // Cross-origin (ej: supabase.co) → no interceptar, ver nota de alcance arriba
  if (url.origin !== self.location.origin) return;

  // manifest.json → nunca cachear acá (mismo motivo que sw-admin.js: evita
  // seguir un redirect cross-origin de Vercel dentro del SW)
  if (url.pathname.endsWith('manifest.json')) return;

  if (NETWORK_ONLY_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(fetch(req));
    return;
  }

  if (SWR_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // JS/CSS propios → Network-First (mismo motivo que sw-admin.js: que un
  // deploy nuevo no quede pegado al primer archivo cacheado)
  if (
    (url.pathname.startsWith('/frontend/cliente/') || url.pathname.startsWith('/shared/'))
    && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
  ) {
    e.respondWith(networkFirst(req, CACHE_STATIC));
    return;
  }

  // Resto de assets estáticos → Cache-First
  if (
    url.pathname.startsWith('/frontend/cliente/') ||
    url.pathname.startsWith('/shared/')
  ) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // Páginas HTML del portal cliente → Network-First
  if (url.pathname.startsWith('/cliente')) {
    e.respondWith(networkFirst(req, CACHE_STATIC, true));
    return;
  }
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ─── Background Sync (Plan offline, Etapa 1) ──────────────────────────────
// Relevo best-effort: el SW no tiene la sesión del usuario, así que en vez
// de sincronizar acá, avisa a cualquier pestaña abierta para que sea ella
// (cliente-offline.js / OfflineCore) la que dispare el sync real.
self.addEventListener('sync', (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'BACKGROUND_SYNC', tag: e.tag }));
    })
  );
});

// ─── Estrategias ────────────────────────────────────────────────────────

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

async function staleWhileRevalidate(req) {
  const cache        = await caches.open(CACHE_DATA);
  const cached       = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; })
    .catch(() => null);
  return cached || fetchPromise;
}

// ignoreSearch: para navegaciones HTML (el shell es el mismo con o sin
// query string en la URL)
async function networkFirst(req, cacheName = CACHE_DATA, ignoreSearch = false) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    const cached = await caches.match(req, { ignoreSearch });
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Sin conexión', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
