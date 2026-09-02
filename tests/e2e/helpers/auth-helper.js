// Fase 0 del plan E2E (PLAN_E2E_COBERTURA_TOTAL.md, sección 7) — el
// bloqueante real para testear CLICKS de verdad sobre las páginas admin
// (no solo los 4 harness offline) es que las 54 páginas de /admin exigen
// una sesión de Supabase Auth real antes de renderizar nada (ver
// frontend/admin/js/auth.js: `sb.auth.getSession()` redirige a /login si
// no hay sesión). Este helper resuelve eso sin pegarle a Supabase real:
//
// 1. Antes de que la página cargue (`page.addInitScript`), sembramos en
//    localStorage el mismo objeto que persiste el SDK de supabase-js v2
//    bajo su `storageKey` (`sb-admin-auth` / `sb-chofer-auth` /
//    `sb-cliente-auth` según el portal — ver auth.js de cada uno).
//    `sb.auth.getSession()` lo lee de ahí sin red mientras no esté vencido
//    (por eso `expires_at` se manda bien al futuro).
// 2. auth.js igual hace 2 queries PostgREST reales después de resolver la
//    sesión (`usuarios` y `empresas`, con `.single()`) — las mockeamos acá
//    con `page.route`, no con `mockApi` (que matchea `/api/*`, no
//    `/rest/v1/*`; son dos capas de red distintas en este proyecto, ver
//    nota en supabase-rest-mock.js).
//
// No usar esto para proveedor.spec.js — el portal proveedor es público
// (token en la URL, sin Supabase Auth), ver proveedor.spec.js.

import { HEADER_SINGLE } from './supabase-rest-mock.js';

const STORAGE_KEY_POR_PORTAL = {
  admin: 'sb-admin-auth',
  chofer: 'sb-chofer-auth',
  cliente: 'sb-cliente-auth',
};

let contadorUsuarioFake = 0;

function construirSesionFake({ userId, email }) {
  const ahora = Math.floor(Date.now() / 1000);
  return {
    access_token: 'e2e-fake-access-token',
    token_type: 'bearer',
    // Bien al futuro (~10 años) — ningún test de esta suite necesita
    // ejercitar el flujo de refresh de token, y así evitamos que
    // supabase-js dispare un POST a /auth/v1/token que también habría
    // que mockear sin aportar nada al escenario bajo test.
    expires_at: ahora + 10 * 365 * 24 * 3600,
    expires_in: 10 * 365 * 24 * 3600,
    refresh_token: 'e2e-fake-refresh-token',
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * Siembra una sesión de Supabase Auth válida en localStorage ANTES de la
 * primera navegación. Tiene que llamarse antes de `page.goto()`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'admin'|'chofer'|'cliente'} portal
 * @param {{ userId?: string, email?: string }} [opts]
 * @returns {{ userId: string, email: string }}
 */
export async function sembrarSesion(page, portal, opts = {}) {
  const storageKey = STORAGE_KEY_POR_PORTAL[portal];
  if (!storageKey) throw new Error(`Portal desconocido para auth-helper: "${portal}"`);

  contadorUsuarioFake += 1;
  const userId = opts.userId || `e2e-user-${portal}-${contadorUsuarioFake}`;
  const email = opts.email || `e2e-${portal}-${contadorUsuarioFake}@test.local`;
  const sesion = construirSesionFake({ userId, email });

  await page.addInitScript(
    ([key, value]) => { window.localStorage.setItem(key, value); },
    [storageKey, JSON.stringify(sesion)]
  );

  return { userId, email };
}

/**
 * Mockea las 2 queries PostgREST que hace `frontend/admin/js/auth.js`
 * después de resolver la sesión: `usuarios` (perfil, filtrado por
 * `id`+`activo=true`, `.single()`) y `empresas` (filtrado por
 * `id`, `.single()`). Sin esto, aunque la sesión esté sembrada, auth.js
 * redirige a login igual porque el perfil nunca resuelve (o intenta
 * pegarle a Supabase real y cuelga/falla la request).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ userId: string, rol?: 'dueno'|'admin'|string, empresaId?: string,
 *   nombre?: string, empresa?: Partial<Record<string,any>> }} datos
 */
export async function mockearPerfilAdmin(page, datos) {
  const empresaId = datos.empresaId || 'e2e-empresa-1';
  const perfil = {
    id: datos.userId,
    nombre: datos.nombre || 'Usuario E2E',
    email: datos.email || 'e2e@test.local',
    rol: datos.rol || 'admin',
    empresa_id: empresaId,
  };
  const empresa = {
    id: empresaId,
    nombre: 'Empresa E2E Test',
    logo_url: null,
    cuit: '20-11111111-1',
    activa: true,
    saas_suspendida: false,
    saas_plan: 'pro',
    saas_trial_fin: null,
    saas_precio_mes: 0,
    // config: null por default — específicos (ej. captura-competencia.spec.js,
    // que necesita captura_competencia_habilitada:true) lo pasan vía
    // opts.empresa. No afecta a specs preexistentes: ninguno lee este campo.
    config: null,
    ...(datos.empresa || {}),
  };

  // OJO: `usuarios` y `empresas` no son tablas de uso exclusivo de
  // auth.js — pedidos.js y clientes.js (al menos) hacen su propia query
  // de LISTADO contra `usuarios` (filtrando por `rol` in
  // vendedor/admin/dueno) para armar el combo de vendedores, sin
  // `.single()`. Si este route respondiera siempre con `perfil` a secas
  // (un objeto), esa segunda query recibiría un objeto donde
  // supabase-js espera un array, y cualquier `.forEach`/`.map` posterior
  // revienta con un runtime error silencioso (no un fallo de aserción)
  // que además puede tirar abajo TODO el `init()` de la página si no
  // está en un try/catch (ver pedidos.js::init, que hace
  // `await cargarFiltrosSecundarios()` sin atrapar el error). Por eso
  // discriminamos por el header `Accept` igual que `mockearTabla`: solo
  // el `.single()` de auth.js pide `HEADER_SINGLE` y recibe el objeto;
  // cualquier otra query a la misma tabla recibe un array (vacío por
  // default — si un spec puntual necesita contenido ahí, que registre
  // su propio `mockearTabla(page, 'usuarios', ...)` DESPUÉS de
  // `loguearComoAdmin`, que pisa a este por orden de registro).
  await page.route('**/rest/v1/usuarios**', (route) => {
    const esSingle = (route.request().headers()['accept'] || '').includes(HEADER_SINGLE);
    const body = esSingle ? perfil : [];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/rest/v1/empresas**', (route) => {
    const esSingle = (route.request().headers()['accept'] || '').includes(HEADER_SINGLE);
    const body = esSingle ? empresa : [];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  return { perfil, empresa };
}

/**
 * Atajo todo-en-uno para el caso común: loguear como dueño/admin de una
 * empresa de test. Llamar ANTES de `page.goto()`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ rol?: string, empresaId?: string }} [opts]
 */
export async function loguearComoAdmin(page, opts = {}) {
  const { userId, email } = await sembrarSesion(page, 'admin');
  const { perfil, empresa } = await mockearPerfilAdmin(page, { userId, email, ...opts });
  return { userId, email, perfil, empresa };
}

/**
 * Idem para portal chofer/cliente — esos dos NO pasan por auth.js
 * (tienen su propio bootstrap inline en cada .html), así que solo hace
 * falta la sesión sembrada; cada página resuelve su propio perfil con
 * queries que varían por página y se mockean en el spec puntual con
 * `mockApi`/`page.route` como corresponda.
 */
export async function sembrarSesionChofer(page, opts = {}) {
  return sembrarSesion(page, 'chofer', opts);
}
export async function sembrarSesionCliente(page, opts = {}) {
  return sembrarSesion(page, 'cliente', opts);
}

/**
 * Mockea el endpoint de login por password de GoTrue (`POST
 * {SUPABASE_URL}/auth/v1/token?grant_type=password`), que es lo que
 * dispara `sb.auth.signInWithPassword({ email, password })`. Distinto de
 * `sembrarSesion` (que ASUME que ya hay sesión, para testear páginas que
 * la requieren) — este helper es para cuando el spec quiere ejercitar el
 * FORMULARIO de login en sí: `cliente/login.html` (y previsiblemente
 * `chofer/login.html`, mismo flujo — ver comentario en ese spec cuando
 * se escriba).
 *
 * `handler` recibe el body ya parseado (`{ email, password }`) y decide
 * la respuesta — sin handler, responde éxito con una sesión fake para
 * ese email. Cualquier otro `grant_type` (ej. `refresh_token`) hace
 * `route.fallback()` sin mockear — no debería pasar por esta suite (los
 * `expires_at` que siembra `sembrarSesion` están ~10 años al futuro a
 * propósito), pero por las dudas no lo interceptamos.
 *
 * @param {import('@playwright/test').Page} page
 * @param {(call: { body: {email?: string, password?: string}, request: import('@playwright/test').Request }) => (
 *   { status?: number, json: any } | undefined
 * )} [handler]
 */
export function mockearLoginPassword(page, handler) {
  let llamadas = 0;
  page.route('**/auth/v1/token**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.searchParams.get('grant_type') !== 'password') { await route.fallback(); return; }

    llamadas += 1;
    const body = safeJsonAuth(request.postData());
    const resultado = handler ? handler({ body, request }) : { json: sesionFakeLogin(body?.email) };

    await route.fulfill({
      status: resultado?.status ?? 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(resultado?.json ?? {}),
    });
  });
  return () => llamadas;
}

function safeJsonAuth(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sesionFakeLogin(email) {
  const ahora = Math.floor(Date.now() / 1000);
  return {
    access_token: 'e2e-fake-access-token',
    token_type: 'bearer',
    expires_in: 10 * 365 * 24 * 3600,
    expires_at: ahora + 10 * 365 * 24 * 3600,
    refresh_token: 'e2e-fake-refresh-token',
    user: {
      id: 'e2e-user-login-1',
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}
