// Sirve el repo tal cual está en disco, para que las páginas reales
// (frontend/proveedor/portal.html, frontend/chofer/remito.html, etc.) y
// nuestros fixtures de test convivan bajo el mismo origen sin tocar nada
// del código de producción.
//
// Por qué un server propio y no `npx serve`: necesitamos rutas explícitas
// (`/frontend/...`, `/shared/...`, `/tests/e2e/fixtures/...`) sirviendo
// siempre desde la raíz del repo, sin sorpresas de working directory.
//
// Replica el rewrite de vercel.json para /shared/*.js|css → /frontend/shared/*
// — las páginas de producción (portal.html, remito.html, carrito.html, etc.)
// referencian ese asset como "/shared/offline-core.js", confiando en que
// Vercel lo reescriba. Sin este rewrite acá, cualquier test que cargue una
// página real (no un harness a medida) 404ea silenciosamente ese script:
// OfflineCore nunca se define, y el fallo aparece muchos pasos después con
// un mensaje que no menciona la causa (ver proveedor.spec.js).
//
// Replica también el header Service-Worker-Allowed que vercel.json manda
// para los 4 sw-*.js (ver mapa SW_ALLOWED_SCOPE abajo). Sin este header,
// `navigator.serviceWorker.register(scope: '/')` se registra igual en
// producción (Vercel sí lo manda) pero falla acá con
// "The path of the provided scope is not under the max scope allowed" —
// el error de registro depende de dónde VIVE el script, no de dónde lo
// serví: sw-admin.js vive en /frontend/admin/ pero pide scope '/', y sin
// el header el browser topea el scope máximo permitido en /frontend/admin/.
//
// Replica además las rutas "limpias" de página (`/admin/login` ->
// `/frontend/admin/login.html`, etc.) que vercel.json declara una por una
// (~90 entradas). Varias páginas de producción son stubs de redirect que
// navegan a esas rutas limpias en tiempo real — `cta-cte.html`,
// `liquidacion.html`, `lotes.html` y `presupuestos.html` son solo
// `location.replace('/admin/<algo>')`; `login.html` y `suspendida.html`
// redirigen igual tras resolver sesión — así que sin este rewrite, CUALQUIER
// test que deje avanzar la navegación después de cargar esas 6 páginas
// pega un 404 real contra este server (aunque en Vercel resuelve bien).
// En vez de copiar las ~90 entradas 1:1 (se desincroniza fácil), resolvemos
// genéricamente: `/<portal>/<slug>` sin extensión -> si existe
// `/frontend/<portal>/<slug>.html` en disco, servimos ese archivo. Cubre
// todas las entradas 1:1 de vercel.json donde el slug coincide con el
// nombre de archivo (que es la gran mayoría — las pocas excepciones reales,
// como `/admin` y `/admin/dashboard-v3` -> dashboard.html, están en
// PORTAL_ROOT_ALIASES).
const SW_ALLOWED_SCOPE = {
  '/frontend/admin/sw-admin.js': '/',
  '/frontend/chofer/sw-chofer.js': '/chofer',
  '/frontend/cliente/sw-cliente.js': '/cliente',
  '/frontend/proveedor/sw-proveedor.js': '/proveedor',
};

// Excepciones donde el slug de la URL limpia NO coincide 1:1 con el
// nombre del .html (copiado de vercel.json, sección de rewrites).
const PORTAL_ROOT_ALIASES = {
  '/admin': '/frontend/admin/dashboard.html',
  '/admin/dashboard-v3': '/frontend/admin/dashboard.html',
  '/cliente': '/frontend/cliente/inicio.html',
  '/chofer': '/frontend/chofer/index.html',
};

// Mismo problema pero para rutas limpias SIN prefijo de portal
// (`/setup`, `/suspendida.html` login.js las usa igual que las de arriba —
// ver suspendida.html/login.html, que redirigen a `/setup` fuera de
// `/admin/...`). `/demo` y `/demo-chofer` en vercel.json son en sí mismos
// otro rewrite encadenado (a `/admin/login?demo=1` / `/chofer/login?demo=1`),
// así que apuntan directo al .html final para no tener que resolver dos
// saltos acá.
const ROOT_ALIASES = {
  '/': '/frontend/landing/index.html',
  '/setup': '/frontend/admin/setup.html',
  '/suspendida': '/frontend/admin/suspendida.html',
  '/demo': '/frontend/admin/login.html',
  '/demo-chofer': '/frontend/chofer/login.html',
};

// URL limpia raíz sin extensión ni prefijo de portal: '/registro',
// '/completar-registro', etc.
const CLEAN_ROOT_URL = /^\/([a-z0-9-]+)$/i;

// Rewrites explícitos para los assets de la landing nueva (v917), copiados
// 1:1 de vercel.json: '/app.js', '/styles.css' y '/fonts/*.woff2' →
// frontend/landing/*. index.html de la landing los referencia como rutas
// absolutas cortas ("/app.js", "/styles.css", "/fonts/ESBuild-400.woff2"),
// confiando en que el rewrite exista — sin esto acá, cualquier test que
// cargue "/" y deje avanzar la carga real de la página (no solo el HTML)
// pega un 404 real contra este server para los tres, aunque en Vercel
// resuelve bien (falso negativo del smoke test, no bug real de la app).
const LANDING_ASSET_ALIASES = {
  '/app.js': '/frontend/landing/app.js',
  '/styles.css': '/frontend/landing/styles.css',
};
const LANDING_FONT_URL = /^\/fonts\/(.+\.woff2)$/;

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Mismo patrón que vercel.json: '/shared/(.*\.(js|css))' -> '/frontend/shared/$1'
const REWRITE_SHARED = /^\/shared\/(.+\.(?:js|css))$/;

// vercel.json tiene el MISMO rewrite repetido por portal — no solo para
// /shared/*: '/admin/(.*\.js)' -> '/frontend/admin/$1', y lo mismo para
// css/json en admin/cliente/chofer/proveedor (json solo importa para
// manifest.json, pero el patrón real en vercel.json no distingue, así
// que tampoco distinguimos acá). Sin esto, cualquier página que
// referencie un asset propio con ruta absoluta corta (confiando en el
// rewrite, como hacen login.html/invitacion.html/portal.html con
// "/cliente/pwa-init.js", "/chofer/manifest.json", etc.) 404ea en este
// server aunque en producción (Vercel) carga bien — falso negativo del
// smoke test, no bug real de la app. `.+` en el grupo de portal permite
// subrutas como "/chofer/sw/service-worker.js" (vercel.json también
// tiene un rewrite dedicado para esa, con el mismo destino final).
const REWRITE_PORTAL_ASSET = /^\/(admin|cliente|chofer|proveedor)\/(.+\.(?:js|css|json))$/;

// URL limpia de página sin extensión: '/admin/cobranzas', '/cliente/inicio', etc.
const CLEAN_PAGE_URL = /^\/(admin|cliente|chofer|proveedor)\/([a-z0-9-]+)$/i;

function resolverUrlPath(urlPath) {
  const mShared = urlPath.match(REWRITE_SHARED);
  if (mShared) return `/frontend/shared/${mShared[1]}`;

  const mPortal = urlPath.match(REWRITE_PORTAL_ASSET);
  if (mPortal) return `/frontend/${mPortal[1]}/${mPortal[2]}`;

  if (PORTAL_ROOT_ALIASES[urlPath]) return PORTAL_ROOT_ALIASES[urlPath];
  if (ROOT_ALIASES[urlPath]) return ROOT_ALIASES[urlPath];
  if (LANDING_ASSET_ALIASES[urlPath]) return LANDING_ASSET_ALIASES[urlPath];

  const mFont = urlPath.match(LANDING_FONT_URL);
  if (mFont) return `/frontend/landing/fonts/${mFont[1]}`;

  const mClean = urlPath.match(CLEAN_PAGE_URL);
  if (mClean) {
    const candidato = `/frontend/${mClean[1]}/${mClean[2]}.html`;
    if (existsSync(join(ROOT, candidato))) return candidato;
  }

  const mRoot = urlPath.match(CLEAN_ROOT_URL);
  if (mRoot) {
    const candidato = `/frontend/${mRoot[1]}.html`;
    if (existsSync(join(ROOT, candidato))) return candidato;
  }

  return urlPath;
}

export function startStaticServer(port = 0) {
  const server = http.createServer((req, res) => {
    const urlPath = resolverUrlPath(decodeURIComponent((req.url || '/').split('?')[0]));

    // Chromium pide `/favicon.ico` solo con navegar a CUALQUIER página,
    // sin importar si hay un <link rel="icon"> propio (que casi todas
    // las páginas de este repo sí tienen) — es un comportamiento propio
    // del navegador, no algo que la app controle. El repo no tiene un
    // favicon.ico en la raíz (confirmado: no existe en ningún lado),
    // así que sin esto cada test de smoke-universal.spec.js suma un 404
    // de consola espurio. El filtro `RUIDO_IGNORADO` de smoke-universal
    // intenta ignorar justamente esto por texto (`/favicon/i`), pero
    // Chromium loguea los 404 de red como
    // "Failed to load resource: the server responded with a status of
    // 404 (Not Found)" SIN la URL en el texto del mensaje de consola —
    // ese filtro nunca puede matchear. Cortamos el problema de raíz acá
    // (204, no hace falta servir un ícono real) en vez de depender de
    // parsear un mensaje que no trae la información necesaria.
    if (urlPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const filePath = normalize(join(ROOT, urlPath));

    // No servir nada fuera de la raíz del repo (path traversal).
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found: ' + urlPath);
      return;
    }
    const headers = { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' };
    const swScope = SW_ALLOWED_SCOPE[urlPath];
    if (swScope) headers['Service-Worker-Allowed'] = swScope;
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: assignedPort } = server.address();
      resolve({ server, port: assignedPort, baseURL: `http://127.0.0.1:${assignedPort}` });
    });
  });
}
