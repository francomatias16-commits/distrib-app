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

const SW_VERSION   = 'admin-mtcen4q1';
const CACHE_STATIC = `${SW_VERSION}-static`;
const CACHE_DATA   = `${SW_VERSION}-data`;

// OFFLINE-06 (objetivo "que ninguna pantalla quede en blanco NI siquiera\n// en la primera visita sin conexión"): antes acá solo había 6 páginas y un
// puñado de CSS a mano. Se generó esta lista con un script (scripts que
// recorre frontend/admin/*.html y extrae cada <script src>/<link href>
// local — ver comentario en el instalador más abajo) para cubrir las 57
// páginas del admin + sus 209 assets propios (JS/CSS). Con esto, cualquier
// pantalla — se haya visitado antes o no — tiene su shell (HTML+CSS+JS)
// disponible offline desde la primera instalación del Service Worker.
//
// Van SIN el query string "?v=..." de cache-busting (ver bump-asset-
// versions.js) a propósito: ese valor cambia en cada deploy y mantenerlo
// sincronizado acá a mano volvería a repetir el mismo problema que ya se
// resolvió para el SW_VERSION. En cambio, cacheFirst() de abajo matchea
// con { ignoreSearch: true } — no importa qué versión pida el HTML del
// deploy actual, encuentra la entrada igual. Esto NO aplica a los
// endpoints de datos (/api/*): esos siguen exigiendo match exacto, donde
// el query string sí es parte real de la identidad del request (filtros,
// paginado, etc.) y no algo a ignorar.
// OFFLINE-06 (objetivo "que ninguna pantalla quede en blanco NI siquiera
// en la primera visita sin conexión"): antes acá solo había 6 páginas y un
// puñado de CSS a mano. Esta lista se generó recorriendo frontend/admin/*.html
// y extrayendo cada <script src>/<link href> local, para cubrir las 57
// páginas del admin + sus assets propios (JS/CSS). Con esto, cualquier
// pantalla — se haya visitado antes o no — tiene su shell (HTML+CSS+JS)
// disponible offline desde la primera instalación del Service Worker.
//
// Separadas en dos listas porque van a cachés distintos:
//   PRECACHE_PAGES  → CACHE_DATA   (se vacía en logout, ver CLEAR_ON_LOGOUT
//                      más abajo — coherente con que la navegación de
//                      páginas ya usa CACHE_DATA en el resto de este SW)
//   PRECACHE_ASSETS → CACHE_STATIC (shell JS/CSS sin datos de usuario,
//                      persiste entre logins, igual que el resto del shell)
//
// Van SIN el query string "?v=..." de cache-busting (ver bump-asset-
// versions.js) a propósito: ese valor cambia en cada deploy y mantenerlo
// sincronizado acá a mano volvería a repetir el mismo problema que ya se
// resolvió para el SW_VERSION. cacheFirst()/networkFirst() de abajo
// matchean con { ignoreSearch: true } para los assets/páginas — no importa
// qué versión pida el HTML del deploy actual, encuentran la entrada igual.
// Esto NO aplica a los endpoints de datos (/api/*): esos siguen exigiendo
// match exacto, donde el query string sí es parte real de la identidad del
// request (filtros, paginado, etc.) y no algo a ignorar.
const PRECACHE_PAGES = [
  '/admin/anomalias',
  '/admin/auditoria',
  '/admin/automatizacion',
  '/admin/avisos',
  '/admin/cajas',
  '/admin/cc-proveedores',
  '/admin/cheques',
  '/admin/clientes',
  '/admin/cobranzas',
  '/admin/comparador-precios',
  '/admin/compras',
  '/admin/conciliacion-bancaria',
  '/admin/cta-cte',
  '/admin/dashboard',
  '/admin/devoluciones',
  '/admin/empresa-config',
  '/admin/etiquetas-config',
  '/admin/export-contable',
  '/admin/facturacion',
  '/admin/facturacion-config',
  '/admin/fidelizacion',
  '/admin/gastos-generales',
  '/admin/liquidacion',
  '/admin/login',
  '/admin/lotes',
  '/admin/mercadopago-config',
  '/admin/migracion',
  '/admin/notas',
  '/admin/notif-log',
  '/admin/observabilidad',
  '/admin/pedidos',
  '/admin/pos',
  '/admin/presupuestos',
  '/admin/productos',
  '/admin/proveedores',
  '/admin/puntos',
  '/admin/reglas-precio',
  '/admin/rentabilidad-producto-vendedor',
  '/admin/rentabilidad-zona',
  '/admin/reportes-financieros',
  '/admin/reportes-stock',
  '/admin/reportes-ventas',
  '/admin/restablecer-password',
  '/admin/riesgo-cheques',
  '/admin/rutas',
  '/admin/saas-billing',
  '/admin/setup',
  '/admin/setup-wizard',
  '/admin/sin-permiso',
  '/admin/soporte',
  '/admin/stock',
  '/admin/superadmin',
  '/admin/suspendida',
  '/admin/usuarios',
  '/admin/vencimientos',
  '/admin/whatsapp-conversaciones',
  '/admin/whatsapp-onboarding',
];

const PRECACHE_ASSETS = [
  '/frontend/admin/css/anomalias-gentelella.css',
  '/frontend/admin/css/auditoria-gentelella.css',
  '/frontend/admin/css/automatizacion-gentelella.css',
  '/frontend/admin/css/automatizacion.css',
  '/frontend/admin/css/base-layout.css',
  '/frontend/admin/css/cajas-gentelella.css',
  '/frontend/admin/css/cc-proveedores-gentelella.css',
  '/frontend/admin/css/cheques-gentelella.css',
  '/frontend/admin/css/clientes-ciclos.css',
  '/frontend/admin/css/clientes-gentelella.css',
  '/frontend/admin/css/clientes.css',
  '/frontend/admin/css/cobranzas-gentelella.css',
  '/frontend/admin/css/combos.css',
  '/frontend/admin/css/comparador-precios-gentelella.css',
  '/frontend/admin/css/compras-gentelella.css',
  '/frontend/admin/css/compras.css',
  '/frontend/admin/css/conciliacion-bancaria-gentelella.css',
  '/frontend/admin/css/devoluciones-gentelella.css',
  '/frontend/admin/css/empresa-config-gentelella.css',
  '/frontend/admin/css/etiquetas-preview.css',
  '/frontend/admin/css/export-contable-gentelella.css',
  '/frontend/admin/css/facturacion-config-gentelella.css',
  '/frontend/admin/css/facturacion-gentelella.css',
  '/frontend/admin/css/facturacion.css',
  '/frontend/admin/css/fidelizacion-gentelella.css',
  '/frontend/admin/css/finanzas.css',
  '/frontend/admin/css/gastos-generales-gentelella.css',
  '/frontend/admin/css/login.css',
  '/frontend/admin/css/mercadopago-config-gentelella.css',
  '/frontend/admin/css/migracion-gentelella.css',
  '/frontend/admin/css/migracion.css',
  '/frontend/admin/css/nav.css',
  '/frontend/admin/css/notas-gentelella.css',
  '/frontend/admin/css/notif-log-gentelella.css',
  '/frontend/admin/css/observabilidad-gentelella.css',
  '/frontend/admin/css/pedido-modal-fullscreen.css',
  '/frontend/admin/css/pedidos-gentelella.css',
  '/frontend/admin/css/pedidos.css',
  '/frontend/admin/css/pos-gentelella.css',
  '/frontend/admin/css/pos-terminal-pro.css',
  '/frontend/admin/css/pos.css',
  '/frontend/admin/css/producto-picker.css',
  '/frontend/admin/css/productos-gentelella.css',
  '/frontend/admin/css/productos-modal-fix.css',
  '/frontend/admin/css/productos.css',
  '/frontend/admin/css/proveedores-gentelella.css',
  '/frontend/admin/css/puntos-gentelella.css',
  '/frontend/admin/css/reglas-precio-gentelella.css',
  '/frontend/admin/css/rentabilidad-producto-vendedor-gentelella.css',
  '/frontend/admin/css/rentabilidad-zona-gentelella.css',
  '/frontend/admin/css/reportes-financieros-gentelella.css',
  '/frontend/admin/css/reportes-stock-gentelella.css',
  '/frontend/admin/css/reportes-ventas-gentelella.css',
  '/frontend/admin/css/reportes.css',
  '/frontend/admin/css/riesgo-cheques-gentelella.css',
  '/frontend/admin/css/rutas-command-center.css',
  '/frontend/admin/css/rutas-compact.css',
  '/frontend/admin/css/rutas-gentelella.css',
  '/frontend/admin/css/rutas-integrated.css',
  '/frontend/admin/css/rutas-professional.css',
  '/frontend/admin/css/rutas-resumen-identity.css',
  '/frontend/admin/css/rutas-resumen.css',
  '/frontend/admin/css/rutas-surface-v2.css',
  '/frontend/admin/css/rutas.css',
  '/frontend/admin/css/saas-billing-gentelella.css',
  '/frontend/admin/css/soporte-gentelella.css',
  '/frontend/admin/css/stock-gentelella.css',
  '/frontend/admin/css/stock-overview.css',
  '/frontend/admin/css/stock.css',
  '/frontend/admin/css/tema-claro-shipp.css',
  '/frontend/admin/css/usuarios-gentelella.css',
  '/frontend/admin/css/vencimientos-gentelella.css',
  '/frontend/admin/css/whatsapp-conversaciones-gentelella.css',
  '/frontend/admin/css/whatsapp-onboarding-gentelella.css',
  '/frontend/admin/img/icon-192.png',
  '/frontend/admin/js/anomalias.js',
  '/frontend/admin/js/api-client.js',
  '/frontend/admin/js/auditoria.js',
  '/frontend/admin/js/auth-ready.js',
  '/frontend/admin/js/auth.js',
  '/frontend/admin/js/automatizacion.js',
  '/frontend/admin/js/avisos.js',
  '/frontend/admin/js/busqueda-global.js',
  '/frontend/admin/js/cc-proveedores.js',
  '/frontend/admin/js/cheques.js',
  '/frontend/admin/js/clientes-ciclos.js',
  '/frontend/admin/js/clientes/index.js',
  '/frontend/admin/js/cobranzas.js',
  '/frontend/admin/js/cobros-offline.js',
  '/frontend/admin/js/combos-tab.js',
  '/frontend/admin/js/comparador-precios.js',
  '/frontend/admin/js/compras.js',
  '/frontend/admin/js/conciliacion-bancaria.js',
  '/frontend/admin/js/cta-cte.js',
  '/frontend/admin/js/devoluciones.js',
  '/frontend/admin/js/etiquetas-preview.js',
  '/frontend/admin/js/etiquetas-print.js',
  '/frontend/admin/js/etiquetas.js',
  '/frontend/admin/js/export-contable.js',
  '/frontend/admin/js/export-utils.js',
  '/frontend/admin/js/facturacion.js',
  '/frontend/admin/js/fidelizacion.js',
  '/frontend/admin/js/gastos-generales.js',
  '/frontend/admin/js/liquidacion.js',
  '/frontend/admin/js/lotes.js',
  '/frontend/admin/js/migracion-badge.js',
  '/frontend/admin/js/migracion-maestra.js',
  '/frontend/admin/js/migracion/checklist-historial.js',
  '/frontend/admin/js/migracion/columnas-sin-mapear-reintentos.js',
  '/frontend/admin/js/migracion/confirmacion-lote.js',
  '/frontend/admin/js/migracion/encabezados-mapeo.js',
  '/frontend/admin/js/migracion/nucleo-navegacion-api.js',
  '/frontend/admin/js/migracion/parseo-archivo-base.js',
  '/frontend/admin/js/migracion/parseo-formatos-estructurados.js',
  '/frontend/admin/js/migracion/plantillas-mapeo.js',
  '/frontend/admin/js/migracion/revision-filas.js',
  '/frontend/admin/js/migracion/utils-superadmin-init.js',
  '/frontend/admin/js/nav-data.js',
  '/frontend/admin/js/nav-mobile.js',
  '/frontend/admin/js/nav.js',
  '/frontend/admin/js/notas-credito.js',
  '/frontend/admin/js/notas-internas.js',
  '/frontend/admin/js/notas.js',
  '/frontend/admin/js/notif-log.js',
  '/frontend/admin/js/observabilidad.js',
  '/frontend/admin/js/pedidos.js',
  '/frontend/admin/js/pos-offline.js',
  '/frontend/admin/js/pos-printer.js',
  '/frontend/admin/js/pos-scanner-remoto.js',
  '/frontend/admin/js/pos-scanner.js',
  '/frontend/admin/js/pos-terminal.js',
  '/frontend/admin/js/pos/admin-ventas-stock.js',
  '/frontend/admin/js/pos/atajos-teclado.js',
  '/frontend/admin/js/pos/busqueda-favoritos.js',
  '/frontend/admin/js/pos/carrito.js',
  '/frontend/admin/js/pos/cliente-cobro.js',
  '/frontend/admin/js/pos/cliente-rapido-alertas.js',
  '/frontend/admin/js/pos/devoluciones-promos.js',
  '/frontend/admin/js/pos/hardware-config.js',
  '/frontend/admin/js/pos/nucleo.js',
  '/frontend/admin/js/pos/offline-hooks.js',
  '/frontend/admin/js/pos/ticket-facturacion.js',
  '/frontend/admin/js/pos/turnos-caja.js',
  '/frontend/admin/js/presupuestos.js',
  '/frontend/admin/js/producto-picker.js',
  '/frontend/admin/js/productos-scanner-remoto.js',
  '/frontend/admin/js/productos/auto-imagenes.js',
  '/frontend/admin/js/productos/carga-datos.js',
  '/frontend/admin/js/productos/categorias-abm.js',
  '/frontend/admin/js/productos/filtros-menu.js',
  '/frontend/admin/js/productos/guardar-eliminar-producto.js',
  '/frontend/admin/js/productos/init-vistas.js',
  '/frontend/admin/js/productos/modal-producto.js',
  '/frontend/admin/js/productos/nucleo-estado.js',
  '/frontend/admin/js/productos/orden-busqueda-nav.js',
  '/frontend/admin/js/productos/receta-bom.js',
  '/frontend/admin/js/productos/render-tabla.js',
  '/frontend/admin/js/productos/seleccion-etiquetas.js',
  '/frontend/admin/js/proveedores.js',
  '/frontend/admin/js/puntos.js',
  '/frontend/admin/js/reglas-precio.js',
  '/frontend/admin/js/remito.js',
  '/frontend/admin/js/rentabilidad-producto-vendedor.js',
  '/frontend/admin/js/rentabilidad-zona.js',
  '/frontend/admin/js/reportes-financieros.js',
  '/frontend/admin/js/reportes-stock.js',
  '/frontend/admin/js/reportes-ventas.js',
  '/frontend/admin/js/riesgo-cheques.js',
  '/frontend/admin/js/rutas-resumen.js',
  '/frontend/admin/js/rutas.js',
  '/frontend/admin/js/soporte-faqs-data.js',
  '/frontend/admin/js/stock-offline.js',
  '/frontend/admin/js/stock-scanner-remoto.js',
  '/frontend/admin/js/stock.js',
  '/frontend/admin/js/ui-utils.js',
  '/frontend/admin/js/usuarios.js',
  '/frontend/admin/js/whatsapp-conversaciones.js',
  '/frontend/admin/js/whatsapp-onboarding.js',
  '/frontend/admin/js/zonas.js',
  '/frontend/admin/manifest.json',
  '/frontend/env-config.js',
  '/frontend/js/push-init.js',
  '/frontend/shared/camera-scanner.js',
  '/frontend/shared/chat-widget.css',
  '/frontend/shared/chat-widget.js',
  '/frontend/shared/componentes-admin.css',
  '/frontend/shared/componentes-admin.js',
  '/frontend/shared/echarts-gentelella-theme.js',
  '/frontend/shared/echarts-wrapper.js',
  '/frontend/shared/filtro-tabs.css',
  '/frontend/shared/filtro-tabs.js',
  '/frontend/shared/gentelella-fkpi.css',
  '/frontend/shared/gentelella-nav.css',
  '/frontend/shared/gentelella-tokens.css',
  '/frontend/shared/realtime.js',
  '/frontend/shared/tabla-agrupada.css',
  '/frontend/shared/tabla-agrupada.js',
  '/frontend/shared/topbar-widgets.js',
  '/frontend/shared/vincular-celular.js',
  '/shared/adminlte-components.css',
  '/shared/microinteracciones.css',
  '/shared/offline-core.js',
  '/shared/pagination.css',
  '/shared/reskin-patch-v2-shadcn.css',
  '/shared/reskin-patch.css',
  '/shared/responsive-mobile.css',
  '/shared/responsive-mobile.js',
  '/shared/skeletons.css',
  '/shared/tokens.css',
];

// FIX v150 — bug "hay que hacer Ctrl+Shift+R para ver el dato nuevo":
// Todo lo que vivía acá quedaba en Stale-While-Revalidate: el SW devolvía
// la respuesta VIEJA cacheada al toque y recién en paralelo pedía la nueva
// (que queda guardada para la PRÓXIMA vez, no para esta). Como después de
// cada alta/baja/edición la UI dispara un GET de refresco inmediato, ese
// refresco mostraba el dato viejo hasta el siguiente reload — exactamente
// el mismo bug que ya se había detectado y corregido en sw-cliente.js
// (ver comentario FIX F4-02 más abajo en NETWORK_ONLY_PATTERNS de ese SW).
// Se deja el array vacío (no se borra la estrategia SWR por si en el futuro
// se agrega ahí un endpoint realmente de "bajo riesgo" que no se edite
// nunca desde un modal/formulario del propio admin).
const SWR_PATTERNS = [];

const NETWORK_ONLY_PATTERNS = [
  /\/api\/auth/,
  /\/api\/facturas/,
  /\/api\/pagos/,
  /\/api\/importar/,
  /\/api\/pedidos\/confirmar/,
  /\/api\/compras/,
  // Nota: /api/pos (POST de venta) NO está acá — el manejo offline
  // lo hace pos-offline.js interceptando el fetch antes de que llegue al SW

  // ── Movidos acá desde SWR_PATTERNS (FIX v150, auditoría stale-cache) ──
  // Estos SÍ tienen que ser network-only puro (sin fallback a caché): son
  // datos sensibles a mostrar desactualizados (config de empresa, reglas
  // de automatización, catálogo/caja del POS) donde un dato viejo puede
  // llevar a una acción incorrecta, no solo a verse raro.
  /\/api\/reportes/,
  /\/api\/empresa/,              // config de empresa
  /\/api\/automatizacion/,       // reglas de automatización
  /\/api\/notif\/log/,
  /\/api\/pos\/productos/,       // catálogo POS
  /\/api\/pos\/cajas/,           // apertura/cierre de caja
  /\/api\/pos\/favoritos/,       // ← el bug reportado: favoritos del POS
];

// OFFLINE-04 (auditoría Etapa 5) — el FIX v150 de arriba resolvió bien el
// bug de stale-cache ("hay que hacer Ctrl+Shift+R para ver el dato nuevo")
// pero como efecto colateral no documentado dejó estas 5 rutas —las
// pantallas MÁS usadas del admin— sin ningún fallback offline: NETWORK_ONLY
// hace `fetch(req)` a secas, así que sin señal la request explota y la
// grilla muestra error en vez del último dato conocido, revirtiendo el
// objetivo de la Etapa 2 del plan offline ("que ninguna pantalla quede en
// blanco sin Internet"). Network-First (misma estrategia que ya usan JS/CSS
// y las páginas HTML del admin más abajo) resuelve ambos bugs a la vez: con
// conexión SIEMPRE espera la respuesta real de la red antes de devolver algo
// (no hay stale-cache posible, a diferencia de Stale-While-Revalidate que sí
// devolvía la vieja al toque) y solo cae al último dato cacheado cuando el
// fetch realmente falla por falta de señal.
const NETWORK_FIRST_DATA_PATTERNS = [
  /\/api\/admin\/kpis/,          // dashboard
  /\/api\/pedidos(\?|$)/,        // grilla de pedidos
  /\/api\/clientes(\?|$)/,       // alta/edición de cliente
  /\/api\/stock(\?|$)/,          // ajustes/entradas/salidas de stock
  /\/api\/lotes(\?|$)/,          // alta/edición/baja de lotes
];

// ── Instalación ───────────────────────────────────────────────────────────
// FIX (precache resiliente): antes era cache.addAll(PRECACHE_URLS), que es
// atómico — si UN solo archivo de la lista da 404/error de red durante el
// install, addAll() rechaza COMPLETO y no se cachea nada de nada (el
// .catch() de abajo solo logueaba, pero para ese momento el daño ya estaba
// hecho: precache vacío). Con ~266 URLs el riesgo de que una sola falle
// (un archivo renombrado, un typo, una página nueva sin el asset todavía
// desplegado) ya no es despreciable. Ahora cada URL se cachea con su propio
// try/catch vía Promise.allSettled: si algunas fallan, el resto se cachea
// igual — degradación parcial en vez de precache total en cero.
function precachearLista(cacheName, urls) {
  return caches.open(cacheName).then((c) =>
    Promise.allSettled(urls.map((url) => c.add(url)))
  ).then((resultados) => {
    resultados.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn('[SW-admin] No se pudo precachear', urls[i], r.reason?.message || r.reason);
      }
    });
    return resultados;
  });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      precachearLista(CACHE_DATA, PRECACHE_PAGES),
      precachearLista(CACHE_STATIC, PRECACHE_ASSETS),
    ]).then(([resPaginas]) => {
      // FIX (bug reportado: dashboard offline mostrando el JSON crudo):
      // antes acá se llamaba a skipWaiting() sin importar si el precache de
      // las páginas había fallado parcialmente (ej: se cortó la señal justo
      // durante un deploy). Eso activaba esta versión nueva igual, y el
      // evento 'activate' de abajo borra todo caché que no sea el de la
      // versión actual — incluido el de la versión VIEJA, que sí tenía esa
      // página guardada. Resultado: se perdía la única copia funcional que
      // existía de esa pantalla, justo antes de que hiciera falta.
      //
      // Ahora, si falló el precache de alguna página, no promovemos esta
      // versión: la anterior se sigue sirviendo (con su caché intacto,
      // porque 'activate' nunca corre) hasta que un install futuro logre
      // precachear todo. Con el fallback HTML de networkFirstDocumento ya
      // no se rompería igual, pero así ni siquiera hace falta mostrar esa
      // pantalla de emergencia: se seguiría viendo el dashboard real.
      const fallaron = resPaginas.filter((r) => r.status === 'rejected').length;
      if (fallaron > 0) {
        console.warn(`[SW-admin] Precache incompleto: ${fallaron} página(s) no se pudieron guardar — no se activa esta versión todavía, sigue sirviendo la anterior.`);
        return;
      }
      return self.skipWaiting();
    })
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

  // FIX (bug reportado: dashboard offline mostrando el JSON crudo de
  // networkFirst): esto captura CUALQUIER carga de página completa —
  // click en un link, reload, escribir la URL a mano, abrir la PWA desde
  // el ícono — sin importar qué regla de path más abajo la hubiera
  // atendido. Va primero a propósito: así una página nueva que mañana se
  // agregue y todavía no esté en PRECACHE_PAGES, o cualquier otro caso no
  // contemplado en las reglas de abajo, sigue teniendo garantizado que si
  // no hay red y no hay caché, ve una pantalla de "sin conexión" real en
  // vez de texto plano de JSON.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(networkFirstDocumento(req, CACHE_DATA));
    return;
  }

  // Rutas críticas → solo red, sin fallback a caché
  if (NETWORK_ONLY_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(fetch(req));
    return;
  }

  // OFFLINE-04 — grillas de datos más usadas del admin: red primero siempre
  // (dato fresco, sin el bug de stale-cache de v150), y solo si de verdad no
  // hay señal, el último dato conocido en vez de pantalla en blanco/error.
  if (NETWORK_FIRST_DATA_PATTERNS.some((p) => p.test(url.pathname))) {
    e.respondWith(networkFirst(req, CACHE_DATA));
    return;
  }

  // OFFLINE-05 (objetivo "que ninguna pantalla quede en blanco"): hasta acá
  // solo 5 endpoints puntuales tenían red de contención offline — el resto
  // de las +30 pantallas del admin (compras, proveedores, cheques, cta_cte,
  // usuarios, gastos-generales, etc.) no pasaba por ningún handler de este
  // SW y cualquier GET a /api/* sin señal explotaba tal cual, dejando la
  // grilla vacía. Esta regla es el catch-all: cualquier otro GET a /api/*
  // que llegue hasta acá (o sea, que NO haya matcheado NETWORK_ONLY_PATTERNS
  // arriba — auth/facturas/pagos/importar/confirmar pedido/compras/reportes/
  // config de empresa/automatización/notif log/POS catálogo-cajas-favoritos)
  // se sirve igual con Network-First + último dato cacheado. Se ubica DESPUÉS
  // de NETWORK_ONLY_PATTERNS a propósito: esa lista sigue siendo la que
  // decide qué es demasiado sensible a servir desactualizado, no esta regla.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, CACHE_DATA));
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

  // Páginas HTML del admin → Network-First (mismo CACHE_DATA de siempre —
  // se sigue vaciando en logout, ver CLEAR_ON_LOGOUT más abajo). ignoreSearch
  // =true: un deep-link con query (ej. /admin/clientes?id=55) visitado
  // offline por primera vez cae igual sobre el shell precacheado de
  // /admin/clientes (sin query) en vez de romper por no matchear exacto.
  if (url.pathname.startsWith('/admin')) {
    e.respondWith(networkFirst(req, CACHE_DATA, true));
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
    return;
  }
  // FIX BUG-03: al hacer logout, auth.js manda este mensaje para que el SW
  // vacíe CACHE_DATA (respuestas de páginas /admin/* y API cacheadas por
  // networkFirst/staleWhileRevalidate, potencialmente con datos de la
  // empresa/usuario que cerró sesión). Caches son globales por origin —
  // sin esto, en un dispositivo compartido el próximo login (misma u otra
  // empresa) podía servir en modo offline una respuesta vieja cacheada de
  // la sesión anterior. Solo se vacía CACHE_DATA, no CACHE_STATIC (shell
  // JS/CSS, sin datos de usuario) — evita recachear todo el shell en el
  // siguiente login sin necesidad.
  if (e.data?.type === 'CLEAR_ON_LOGOUT') {
    e.waitUntil(
      caches.delete(CACHE_DATA).then(() => {
        e.ports?.[0]?.postMessage({ ok: true });
      })
    );
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

// FIX (ignoreSearch): los assets de PRECACHE_ASSETS se guardan SIN el query
// string "?v=..." de cache-busting, pero en runtime el HTML los pide CON
// ese query (bump-asset-versions.js lo agrega a todos los <link>/<script>
// del deploy actual). Sin ignoreSearch, caches.match(req) nunca encontraba
// la entrada precacheada — el query distinto la hacía invisible — así que
// la primera visita offline a una página nunca visitada antes igual
// rompía, aunque el archivo estuviera "cacheado". Ahora matchea ignorando
// el query, y al guardar una respuesta de red normaliza la key sacándole
// el query también, para que quede bajo el mismo nombre que usó el precache
// (si no, cada deploy nuevo acumularía una entrada más en vez de reusar/
// pisar la existente).
function sinQuery(req) {
  const url = new URL(req.url);
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

// FIX (bug reportado: pantallas del admin coladas para siempre en
// "Buscando y organizando..." con señal débil): fetch() nativo no tiene
// timeout por defecto. Cuando el dispositivo tiene señal pero apenas
// throughput (el caso real de campo, no "avión" con la red totalmente
// apagada), una petición puede tardar 60s+ en fallar sola — mientras tanto
// networkFirst() sigue esperando esa promesa y nunca llega al catch que
// haría el fallback a caché. Con AbortController cortamos nosotros mismos
// a los `ms` en vez de esperar a que el navegador se dé por vencido.
async function fetchConTimeout(req, ms = 10000) {
  const controller = new AbortController();
  const idTimeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(req, { signal: controller.signal });
  } finally {
    clearTimeout(idTimeout);
  }
}

async function cacheFirst(req, cacheName = CACHE_STATIC) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const resp = await fetch(req);
  if (resp.ok) {
    const c = await caches.open(cacheName);
    c.put(sinQuery(req), resp.clone());
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

async function networkFirst(req, cacheName = CACHE_DATA, ignoreSearch = false) {
  try {
    const resp = await fetchConTimeout(req);
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

// FIX (bug reportado: dashboard offline muestra el JSON crudo de
// networkFirst en vez de una pantalla): ese JSON de arriba está pensado
// para que lo parsee JS que llamó a fetch('/api/...') — nunca para que lo
// vea un browser porque cargó una página. Pero networkFirst() se usaba
// también como fallback final para la navegación de páginas HTML (ver
// regla "/admin" más abajo), así que cualquier página sin copia en caché
// y sin red terminaba mostrando ese texto plano en vez de una pantalla.
//
// Esta es la versión para navegación de documentos: mismo Network-First,
// pero si no hay red NI copia en caché, sirve una páginaHTML real de
// "sin conexión" en lugar del JSON.
const OFFLINE_HTML_FALLBACK = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sin conexión</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center;color:#2a3f54}
  .card{max-width:360px}
  h1{font-size:1.25rem;margin:0 0 8px}
  p{color:#666;font-size:.95rem;line-height:1.45;margin:0 0 20px}
  button{padding:10px 22px;border:0;border-radius:6px;background:#1abb9c;color:#fff;font-size:.95rem;cursor:pointer}
  button:active{opacity:.85}
</style>
</head>
<body>
  <div class="card">
    <h1>Sin conexión</h1>
    <p>Esta pantalla todavía no quedó guardada en el celular para uso sin conexión. Conectate a internet una vez para que quede disponible offline, o reintentá si ya volvió la señal.</p>
    <button onclick="location.reload()">Reintentar</button>
  </div>
</body>
</html>`;

function respuestaOfflineHTML() {
  return new Response(OFFLINE_HTML_FALLBACK, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function networkFirstDocumento(req, cacheName = CACHE_DATA) {
  try {
    const resp = await fetchConTimeout(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(sinQuery(req), resp.clone());
    }
    return resp;
  } catch {
    // ignoreSearch: true — un deep-link con query (ej. /admin/clientes?id=55)
    // visitado offline por primera vez cae igual sobre el shell precacheado
    // de /admin/clientes (sin query) en vez de romper por no matchear exacto.
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return respuestaOfflineHTML();
  }
}

async function invalidarCache(cacheName, pattern) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  keys
    .filter((r) => r.url.includes(pattern))
    .forEach((r) => cache.delete(r));
}
