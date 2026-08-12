/**
 * sw-proveedor.js — Service Worker PWA Portal Proveedor v2
 * Plan offline — Etapa 2 (lectura) + Etapa 3, cierre (escritura offline vía
 * outbox, ver frontend/proveedor/proveedor-offline.js)
 *
 * Diferencia clave con sw-cliente.js / sw-admin.js: este portal no tiene
 * login persistente — el acceso es por link con token en la URL
 * (`?t=...`, ver frontend/proveedor/portal.js). Por eso acá TODO el dato
 * de API va Network-First (nunca Stale-While-Revalidate): es información
 * financiera (facturas, pedidos, saldo) y conviene mostrar "último dato
 * bueno" solo cuando de verdad no hay red, no servir caché de entrada.
 * Tampoco se ofrece "Instalar app": sin sesión propia, un ícono instalado
 * no tiene una URL de arranque útil sin el token del link original.
 *
 * Estrategias:
 *   Cache-First    → Shell estático (CSS, JS, íconos)
 *   Network-First  → HTML del portal y datos de la API (con token en la URL)
 *   Network-Only   → Confirmar entrega / subir factura (mutaciones) — el
 *                    fetch directo simplemente falla sin red, que es la
 *                    señal que ProveedorOffline usa para encolar
 *
 * v2 — se suma el listener 'sync' (Background Sync, best-effort): cuando el
 * SO despierta este SW con conectividad, no tiene la sesión/token del
 * proveedor — así que en vez de sincronizar él mismo, avisa a cualquier
 * pestaña abierta (mismo relevo que sw-chofer.js/sw-admin.js) para que sea
 * la página, que sí tiene el token en memoria, la que dispare el sync real.
 */

'use strict';

const SW_VERSION   = 'proveedor-v2';
const CACHE_STATIC = `${SW_VERSION}-static`;
const CACHE_DATA   = `${SW_VERSION}-data`;

// Nota: no se precachea '/proveedor/portal' porque su contenido depende
// del token en el query string (?t=...), que varía por proveedor/link.
// El shell estático sí es común a todos.
const PRECACHE_URLS = [
  '/frontend/proveedor/portal.css',
  '/frontend/proveedor/portal.js',
  '/frontend/proveedor/proveedor-offline.js',
  '/shared/offline-core.js',
  '/shared/tokens.css',
  '/shared/skeletons.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then((c) => c.addAll(PRECACHE_URLS))
      .catch((err) => console.warn('[SW-proveedor] Precache parcial:', err))
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

  // Mutaciones (confirmar-entrega, subir-factura) → siempre a la red. Si no
  // hay conexión el fetch rechaza solo (network error) — esa es justo la
  // señal que ProveedorOffline usa para encolar en vez de mostrar error.
  if (req.method !== 'GET') return;

  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('manifest.json')) return;

  // JS/CSS propios → Network-First, igual que el resto de los portales
  if (
    (url.pathname.startsWith('/frontend/proveedor/') || url.pathname.startsWith('/shared/'))
    && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
  ) {
    e.respondWith(networkFirst(req, CACHE_STATIC));
    return;
  }

  if (
    url.pathname.startsWith('/frontend/proveedor/') ||
    url.pathname.startsWith('/shared/')
  ) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // GET de datos (/api/proveedores?_svc=portal&t=...) → Network-First.
  // El caché queda atado a la URL exacta (incluye el token), así que un
  // proveedor solo ve su propio último dato cacheado, nunca el de otro.
  if (url.pathname.startsWith('/api/proveedores')) {
    e.respondWith(networkFirst(req, CACHE_DATA));
    return;
  }

  // Navegación del portal (/proveedor/portal?t=...) → Network-First,
  // sin ignoreSearch: el token es parte de la identidad del request y no
  // conviene devolver el HTML de otro proveedor cacheado por error.
  if (url.pathname.startsWith('/proveedor')) {
    e.respondWith(networkFirst(req, CACHE_STATIC));
    return;
  }
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
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
