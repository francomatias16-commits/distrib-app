// Hallazgo que corrige un supuesto del plan original (sección 4 de
// PLAN_E2E_COBERTURA_TOTAL.md hablaba de "mockear por _mod" como si todo
// pasara por `/api/*`): la mayoría de las páginas admin NO llaman a
// `/api/<modulo>` para su CRUD principal, llaman directo a PostgREST vía
// `window.supabaseClient.from('tabla').select/insert/update/delete(...)`
// (ver frontend/admin/js/pedidos.js — la lista/alta/baja de pedidos es
// `sb.from('pedidos')`, no fetch a `/api/pedidos`; ese endpoint solo
// existe para acciones puntuales como el borrado). `/api/*` sigue
// existiendo y `mock-network.js::mockApi` lo sigue cubriendo — son dos
// capas de red distintas y casi todas las páginas usan AMBAS.
//
// Esto importa para el presupuesto del plan: agregar `data-testid` era
// el prerrequisito identificado; mockear PostgREST por tabla es el
// prerrequisito que faltaba nombrar para que Tier 1 cubra de verdad el
// flujo "completar formulario → submit → verificar resultado" en las
// páginas que hoy pesan más (P0), no solo el wiring de `/api/*`.

const HEADER_SINGLE = 'application/vnd.pgrst.object+json';

export { HEADER_SINGLE };

/**
 * Mockea TODAS las requests PostgREST (`/rest/v1/<tabla>`) contra una
 * tabla puntual, para los 4 verbos que arma el SDK de supabase-js:
 * GET (select), POST (insert), PATCH (update), DELETE (delete).
 *
 * `handlers` es opcional por verbo — el verbo no cubierto devuelve `[]`
 * (GET) o `{}` (el resto) por defecto, así un spec puede mockear solo lo
 * que le importa sin tener que pensar en los demás.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} tabla
 * @param {{
 *   onSelect?: (call: {request: import('@playwright/test').Request, url: URL}) => any,
 *   onInsert?: (call: {request: import('@playwright/test').Request, body: any}) => any,
 *   onUpdate?: (call: {request: import('@playwright/test').Request, body: any, url: URL}) => any,
 *   onDelete?: (call: {request: import('@playwright/test').Request, url: URL}) => any,
 * }} handlers
 */
export function mockearTabla(page, tabla, handlers = {}) {
  const llamadas = { select: 0, insert: 0, update: 0, delete: 0 };

  page.route(`**/rest/v1/${tabla}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const esSingle = (request.headers()['accept'] || '').includes(HEADER_SINGLE);
    let resultado;

    switch (request.method()) {
      case 'GET':
        llamadas.select += 1;
        resultado = handlers.onSelect ? handlers.onSelect({ request, url }) : (esSingle ? {} : []);
        break;
      case 'POST':
        llamadas.insert += 1;
        resultado = handlers.onInsert
          ? handlers.onInsert({ request, body: safeJson(request.postData()), url })
          : {};
        break;
      case 'PATCH':
        llamadas.update += 1;
        resultado = handlers.onUpdate
          ? handlers.onUpdate({ request, body: safeJson(request.postData()), url })
          : {};
        break;
      case 'DELETE':
        llamadas.delete += 1;
        resultado = handlers.onDelete ? handlers.onDelete({ request, url }) : {};
        break;
      default:
        resultado = {};
    }

    await route.fulfill({
      status: resultado?.__status ?? 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(stripStatus(resultado)),
    });
  });

  return llamadas;
}

/**
 * Atajo para el caso más común en páginas P1/P2/P3 (mayormente lectura):
 * varias tablas, cada una devuelve siempre el mismo fixture sin importar
 * los filtros. Para páginas P0 con validación de payload en el POST/PATCH,
 * usar `mockearTabla` directo por tabla.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, any[] | Record<string, any>>} fixturesPorTabla
 */
export function mockearTablasSoloLectura(page, fixturesPorTabla) {
  for (const [tabla, fixture] of Object.entries(fixturesPorTabla)) {
    mockearTabla(page, tabla, {
      onSelect: ({ request }) => {
        const esSingle = (request.headers()['accept'] || '').includes(HEADER_SINGLE);
        if (esSingle) return Array.isArray(fixture) ? (fixture[0] ?? {}) : fixture;
        return Array.isArray(fixture) ? fixture : [fixture];
      },
    });
  }
}

/**
 * Mockea una función Postgres expuesta vía RPC (`sb.rpc('fn_x', params)`
 * → `POST /rest/v1/rpc/fn_x`). Tercer patrón de red distinto de
 * `/api/*` y `/rest/v1/<tabla>` — varias páginas P0 lo usan para listados
 * con filtros/paginación resueltos en el servidor (ej. `pedidos.html`
 * llama a `fn_pedidos_lista` en vez de `.from('pedidos').select()` — ver
 * nota al principio de este archivo, esto es lo mismo un nivel más).
 *
 * `redEstado` (opcional, Etapa 6 offline — v685): mismo contrato que
 * `mockApi` de `mock-network.js` — un objeto `{ offline: boolean }`
 * compartido con el test. Cuando `redEstado.offline` es `true`, la
 * request se aborta (`internetdisconnected`) ANTES de llamar a
 * `handler`, igual que el corte real de red que ve `stock-offline.js`/
 * `cobros-offline.js` en el dispositivo (los dos únicos módulos offline
 * que llaman `sb.rpc(...)` en vez de `fetch('/api/...')`, así que
 * necesitaban esta variante para las mismas pruebas de "modo avión a
 * mitad de operación" que ya tenía `mockApi` para pos/chofer/cliente/
 * proveedor). También soporta `delayMs` en el valor devuelto por
 * `handler` (para el escenario "cierre de pestaña a mitad del sync"),
 * mismo campo que ya usa `mockApi`. Sin `redEstado`, se comporta
 * exactamente igual que antes (todos los callers previos siguen
 * andando sin tocarlos).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} nombreFn
 * @param {(call: {params: any, request: import('@playwright/test').Request}) => any} handler
 * @param {{ offline: boolean }} [redEstado]
 */
export function mockearRpc(page, nombreFn, handler, redEstado) {
  let llamadas = 0;
  page.route(`**/rest/v1/rpc/${nombreFn}**`, async (route) => {
    if (redEstado?.offline) {
      await route.abort('internetdisconnected');
      return;
    }
    llamadas += 1;
    const request = route.request();
    const params = safeJson(request.postData());
    const resultado = handler({ params, request });
    if (resultado?.delayMs) {
      await new Promise((r) => setTimeout(r, resultado.delayMs));
    }
    await route.fulfill({
      status: resultado?.__status ?? 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(stripStatus(stripDelay(resultado))),
    });
  });
  return () => llamadas;
}

/**
 * Catch-all para `/rest/v1/*` — pensado para el smoke test universal
 * (Fase 0.5) y como red de seguridad en cualquier spec: sin esto, una
 * tabla que la página consulta y que el spec no anticipó termina pegándole
 * a Supabase real (con nuestro JWT falso, eso es un 401 real, no un
 * "no mockeado" silencioso — ensucia la señal del smoke test). Devuelve
 * `[]`/`{}` según pida `.single()`, nunca error. Registrar ANTES que los
 * mocks específicos del spec (Playwright prioriza el último `page.route`
 * registrado que matchea, así que los específicos pisan a este).
 *
 * @param {import('@playwright/test').Page} page
 */
export function mockearRestGenerico(page) {
  return page.route('**/rest/v1/**', (route) => {
    const esSingle = (route.request().headers()['accept'] || '').includes(HEADER_SINGLE);
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(esSingle ? {} : []),
    });
  });
}

/**
 * Mismo catch-all pero para `/api/*` (dispatcher propio, no PostgREST).
 *
 * OJO: a diferencia de `/rest/v1/*`, acá no hay un contrato uniforme —
 * cada endpoint de `/api/<algo>` decide su propia forma de respuesta.
 * Encontramos en la práctica que la mayoría de los GET son listados que
 * el frontend consume como array directo sin envoltorio (ver
 * `cajas.html::cargar()` → `[cajas, depositos] = await Promise.all([
 * apiGet('/api/pos/cajas-admin'), ...])` y luego `cajas.map(...)`; o
 * `reglas-precio.js::cargarReglas()` → `reglasData = data || []` seguido
 * de `filas.filter(...)`). Devolver `{ ok: true }` para un GET rompe esos
 * dos casos con un runtime error (`.map`/`.filter` is not a function),
 * no con un fallo de aserción — ensucia la señal igual que el catch-all
 * de `/rest/v1/*` sin mockear. Por eso: GET → `[]` (array vacío, como
 * corresponde a un listado sin resultados), POST/PATCH/PUT/DELETE →
 * `{ ok: true }` (mutación genérica sin body esperado por defecto).
 *
 * Si un spec necesita una forma distinta para un endpoint puntual
 * (ej. un GET que devuelve `{ items: [...] }` en vez de array plano),
 * hay que registrar un `page.route` específico para ese endpoint ANTES
 * de llamar a este catch-all — Playwright prioriza el último route
 * registrado que matchea.
 *
 * @param {import('@playwright/test').Page} page
 */
export function mockearApiGenerico(page) {
  return page.route('**/api/**', (route) => {
    const esGet = route.request().method() === 'GET';
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(esGet ? [] : { ok: true }),
    });
  });
}

/**
 * Catch-all para `**\/auth/v1/**` (GoTrue). Sin esto, cualquier llamada real
 * de auth del SDK (la más común: `sb.auth.signOut()` en los botones
 * "Cerrar sesión") le pega a la red real — bloqueada en el sandbox de CI —
 * y el `await` nunca resuelve, así que el código que depende de que
 * `signOut()` termine (ej. redirigir después) nunca corre. No es un mock
 * "inteligente": alcanza con devolver 204/200 para lo que se necesita acá
 * (logout). Si algún spec necesita login real contra `/auth/v1/token`,
 * que registre su propio `page.route` específico ANTES de llamar a este
 * catch-all (mismo criterio que mockearRestGenerico/mockearApiGenerico).
 *
 * @param {import('@playwright/test').Page} page
 */
export function mockearAuthGenerico(page) {
  return page.route('**/auth/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/logout')) {
      route.fulfill({ status: 204, body: '' });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({}),
    });
  });
}

/**
 * Hallazgo (bloque portal cliente, `cuenta.html`) — `sb.from('pedidos')
 * .select('id', { count: 'exact', head: true })` (conteo de "Pedidos
 * realizados") arma una request HEAD, no GET, y supabase-js lee el total
 * del header `Content-Range` de la respuesta, no del body (que en un HEAD
 * ni siquiera viaja). `mockearTabla` no distingue HEAD de los 4 verbos que
 * sí maneja — cae al `default` y responde `{}` sin ese header, así que
 * cualquier `count:'exact', head:true` mockeado solo con `mockearTabla`
 * resuelve `count: null` siempre, sin importar qué devuelva `onSelect`
 * (la página lo tapa con `?? 0`, así que no rompe nada — pero tampoco
 * refleja ningún valor puesto a propósito por el test).
 *
 * Este helper cubre ESE caso puntual: intercepta el HEAD y responde el
 * header `Content-Range: * /<count>` que espera el SDK. Para cualquier
 * otro verbo hace `route.fallback()` — dejá que lo resuelva el
 * `mockearTabla`/`mockearRestGenerico` ya registrado para la misma tabla
 * (llamar a este helper DESPUÉS de esos, no antes, mismo criterio de
 * orden que el resto del archivo).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} tabla
 * @param {number} count
 */
export function mockearConteoTabla(page, tabla, count) {
  return page.route(`**/rest/v1/${tabla}**`, async (route) => {
    if (route.request().method() !== 'HEAD') { await route.fallback(); return; }
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      // BUG REAL del mock (no de la app): `content-range` es el único header
      // de donde supabase-js saca `count` (ver processResponse() en el vendor
      // — `c=e.headers.get('content-range')`), pero en una respuesta
      // cross-origin el navegador oculta cualquier header que no esté en la
      // lista "simple" salvo que el response declare
      // `Access-Control-Expose-Headers`. Sin esto, `route.request()` en el
      // log de Playwright SÍ muestra `content-range` (esa vista no está
      // sujeta a CORS), pero el `fetch()` real que corre dentro de la página
      // no puede leerlo — `count` sale `null` y cualquier UI que lo consuma
      // (ej. "Pedidos realizados" en cuenta.html) cae al fallback en 0.
      headers: {
        'content-range': `*/${count}`,
        'access-control-expose-headers': 'content-range',
      },
      body: '',
    });
  });
}

function safeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function stripStatus(resultado) {
  if (resultado && typeof resultado === 'object' && '__status' in resultado) {
    const { __status, ...resto } = resultado;
    return resto;
  }
  return resultado;
}

// v685 — mismo criterio que stripStatus: delayMs es una instrucción para
// el mock (cuánto esperar antes de responder), no un campo del payload
// real que el RPC devolvería — si no se saca acá, un handler que
// devuelve `{ ok: true, delayMs: 2000 }` filtraría `delayMs` dentro de
// `data` y stock-offline.js/cobros-offline.js lo verían como si el
// servidor lo hubiera mandado.
function stripDelay(resultado) {
  if (resultado && typeof resultado === 'object' && 'delayMs' in resultado) {
    const { delayMs, ...resto } = resultado;
    return resto;
  }
  return resultado;
}
