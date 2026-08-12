/**
 * sw-admin.js — Service Worker PWA Portal Admin v4
 * distrib-v143 | Sin Firebase — VAPID nativo + Offline POS
 *
 * Estrategias:
 *   Cache-First            → Shell admin (HTML, CSS, JS, íconos)
 *   Stale-While-Revalidate → Dashboard KPIs, pedidos, stock
 *   Network-First          → Facturación, pagos, acciones críticas
 *   Network-First + IDB    → POS ventas (offline → encola en IDB via pos-offline.js)
 *   Push nativo VAPID      → Notificaciones de nuevos pedidos y alertas
 */

'use strict';

const SW_VERSION   = 'admin-v149';
const CACHE_STATIC = `${SW_VERSION}-static`;
const CACHE_DATA   = `${SW_VERSION}-data`;

const PRECACHE_URLS = [
  '/admin/dashboard',
  '/admin/pedidos',
  '/admin/clientes',
  '/admin/stock',
  '/admin/compras',
  '/admin/pos',
  '/frontend/admin/css/nav.css',
  '/frontend/admin/css/base-layout.css',
  '/frontend/admin/css/dashboard.css',
  '/frontend/admin/css/pedidos.css',
  '/frontend/admin/css/clientes.css',
  '/frontend/admin/css/stock.css',
  '/frontend/admin/css/finanzas.css',
  '/frontend/admin/css/automatizacion.css',
  '/frontend/admin/css/compras.css',
  '/frontend/admin/css/pos.css',
  '/shared/tokens.css',
  '/shared/skeletons.css',
];

const SWR_PATTERNS = [
  /\/api\/admin\/kpis/,
  /\/api\/pedidos(\?|$)/,
  /\/api\/clientes(\?|$)/,
  /\/api\/stock(\?|$)/,
  /\/api\/lotes(\?|$)/,
  /\/api\/reportes/,
  /\/api\/empresa/,
  /\/api\/automatizacion/,
  /\/api\/notif\/log/,
  /\/api\/pos\/productos/,       // catálogo POS — se sirve desde caché si está disponible
  /\/api\/pos\/cajas/,           // lista de cajas — cambia poco
  /\/api\/pos\/favoritos/,       // favoritos de la grilla
];

const NETWORK_ONLY_PATTERNS = [
  /\/api\/auth/,
  /\/api\/facturas/,
  /\/api\/pagos/,
  /\/api\/importar/,
  /\/api\/pedidos\/confirmar/,
  /\/api\/compras/,
  // Nota: /api/pos (POST de venta) NO está acá — el manejo offline
  // lo hace pos-offline.js interceptando el fetch antes de que llegue al SW
];

// ── Instalación ───────────────────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then((c) => c.addAll(PRECACHE_URLS))
      .catch((err) => console.warn('[SW-admin] Precache parcial:', err))
      .then(() => self.skipWaiting())
  );
});

// ── Activación ────────────────────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_STATIC && k !== CACHE_DATA)
            .map((k) => {
              console.log('[SW-admin] Eliminando caché obsoleto:', k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch interceptor ─────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (!['http:', 'https:'].includes(url.protocol)) return;

  // Mutaciones → siempre a la red
  if (req.method !== 'GET') return;

  // Requests a dominios externos (ej: vercel.com/sso-api) → no interceptar
  // Evita el error CORS cuando Vercel redirige manifest.json al SSO
  if (url.origin !== self.location.origin) return;

  // manifest.json → nunca cachear; dejar que el browser lo maneje directamente
  // (Vercel puede redirigirlo al SSO y el SW no puede seguir ese redirect cross-origin)
  if (url.pathname.endsWith('manifest.json')) return;

  // Rutas críticas → solo red
  if (NETWORK_ONLY_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(fetch(req));
    return;
  }

  // JS y CSS del admin → Network-First. Antes CSS era Cache-First y, al no
  // cambiar el nombre del cache entre deploys, quedaba pegado para siempre
  // al primer archivo cacheado (mismo problema que ya tuvimos con el JS:
  // había que forzar Ctrl+Shift+R para ver estilos nuevos).
  // Con Network-First el CSS nuevo se sirve apenas se publica el deploy,
  // y solo si no hay red se cae al último .css/.js cacheado (modo offline).
  if (
    (url.pathname.startsWith('/frontend/admin/') || url.pathname.startsWith('/shared/'))
    && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
  ) {
    e.respondWith(networkFirst(req, CACHE_STATIC));
    return;
  }

  // Resto de assets estáticos (íconos, imágenes) → Cache-First
  if (
    url.pathname.startsWith('/frontend/admin/') ||
    url.pathname.startsWith('/shared/')
  ) {
    e.respondWith(cacheFirst(req, CACHE_STATIC));
    return;
  }

  // API de datos → Stale-While-Revalidate
  if (SWR_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Páginas HTML del admin → Network-First
  if (url.pathname.startsWith('/admin')) {
    e.respondWith(networkFirst(req));
    return;
  }
});

// ── Push Notifications (VAPID nativo — sin Firebase) ─────────────────────
self.addEventListener('push', (e) => {
  if (!e.data) return;

  let payload;
  try { payload = e.data.json(); }
  catch { payload = { title: 'Admin Fluxo', body: e.data.text() }; }

  const {
    title   = 'Admin Fluxo',
    body    = '',
    icon,
    badge,
    data    = {},
    actions = [],
  } = payload;

  const tag = data.pedido_id
    ? `pedido-${data.pedido_id}`
    : data.tipo || 'admin-notif';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:               icon  || '/api/empresa/icon?size=192',
      badge:              badge || '/api/empresa/icon?size=badge',
      tag,
      data:               { link: data.link || '/admin/pedidos', ...data },
      requireInteraction: data.urgente === true,
      actions:            actions.length ? actions : [
        { action: 'ver',    title: 'Ver pedido' },
        { action: 'cerrar', title: 'Descartar'  },
      ],
    })
  );
});

// ── Click en notificación ─────────────────────────────────────────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  if (e.action === 'cerrar') return;

  const link = e.notification.data?.link || '/admin/pedidos';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if (c.url.includes('/admin') && 'focus' in c) {
          c.focus();
          c.postMessage({
            type:      'NOTIF_CLICK',
            link,
            pedido_id: e.notification.data?.pedido_id,
          });
          return;
        }
      }
      if (clients.openWindow) clients.openWindow(link);
    })
  );
});

// ── Mensajes desde el cliente ─────────────────────────────────────────────
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data?.type === 'INVALIDATE_CACHE') {
    const { pattern } = e.data;
    if (pattern) invalidarCache(CACHE_DATA, pattern);
  }
});

// ─── Background Sync (Plan offline, Etapa 1) ──────────────────────────────
// Relevo best-effort: el SW no tiene la sesión del usuario, así que en vez
// de sincronizar acá, avisa a cualquier pestaña abierta para que sea ella
// (pos-offline.js / stock-offline.js / OfflineCore) la que dispare el sync
// real (sync-pos-outbox o sync-stock-outbox según el tag).
self.addEventListener('sync', (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'BACKGROUND_SYNC', tag: e.tag }));
    })
  );
});

// ─── Estrategias ──────────────────────────────────────────────────────────

async function cacheFirst(req, cacheName = CACHE_STATIC) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const resp = await fetch(req);
  if (resp.ok) {
    const c = await caches.open(cacheName);
    c.put(req, resp.clone());
  }
  return resp;
}

async function staleWhileRevalidate(req) {
  const cache        = await caches.open(CACHE_DATA);
  const cached       = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((resp) => { if (resp.ok) cache.put(req, resp.clone()); return resp; })
    .catch(() => null);
  return cached || fetchPromise;
}

async function networkFirst(req, cacheName = CACHE_DATA) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Sin conexión', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function invalidarCache(cacheName, pattern) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  keys
    .filter((r) => r.url.includes(pattern))
    .forEach((r) => cache.delete(r));
}
