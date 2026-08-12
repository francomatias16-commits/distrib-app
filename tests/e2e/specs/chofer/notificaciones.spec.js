// Historial de notificaciones del portal chofer (`notif_log`) — cuarta
// página del bloque (ver PLAN_E2E_COBERTURA_TOTAL.md sección 29). Más
// simple que `cliente/notificaciones.html`: sin filtro por tipo, sin
// resolución de un id intermedio (RLS filtra directo por
// `usuario_id = auth.uid()`, ver comentario del propio HTML). Mismo
// mecanismo de paginación que el portal cliente — `.range()` viaja como
// header `Range`, no query param.
//
// TODAVÍA NO corrido contra Chromium real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearTabla, mockearRestGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionChofer } from '../../helpers/auth-helper.js';
import { ChoferNotificacionesPage } from '../../page-objects/chofer/notificaciones.page.js';

function notif(i, overrides = {}) {
  return {
    id: `n-${i}`,
    tipo: 'ruta_asignada',
    canal: 'push',
    created_at: '2026-08-01T10:00:00Z',
    entregada: true,
    motivo: null,
    ...overrides,
  };
}

const PAGINA_1 = Array.from({ length: 20 }, (_, i) => notif(i, { id: `n-${i}` }));
const PAGINA_2 = [notif(20, { id: 'n-20' })];

/** Lee el offset inicial de `?offset=N` — la versión vendorizada de
 *  supabase-js manda `.range()` como query params (`offset`/`limit`),
 *  no como header `Range` (eso era de una versión vieja del SDK). Leer
 *  el header acá siempre daba `undefined` → offset 0 → la página 2
 *  nunca se distinguía de la 1, y el mock repetía PAGINA_1 en el "Ver
 *  más". Bug del helper de test, no de la app. */
function offsetDeRequest(request) {
  const url = new URL(request.url());
  return parseInt(url.searchParams.get('offset'), 10) || 0;
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function prepararRed(page, { paginada = false, notificaciones = [notif(1)], onSelect, sesion = true } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  if (sesion) await sembrarSesionChofer(page);
  await vendorizarSupabase(page);
  mockearRestGenerico(page);

  if (paginada) {
    mockearTabla(page, 'notif_log', {
      onSelect: ({ request }) => (offsetDeRequest(request) === 0 ? PAGINA_1 : PAGINA_2),
    });
  } else {
    mockearTabla(page, 'notif_log', { onSelect: onSelect || (() => notificaciones) });
  }

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola) };
}

test.describe('chofer/notificaciones.html', () => {

  test('sin sesión: redirige a /chofer/login', async ({ page }) => {
    await prepararRed(page, { sesion: false });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.page.goto(`${staticServer.baseURL}/frontend/chofer/notificaciones.html`);

    await expect(page).toHaveURL(/\/chofer\/login/, { timeout: 10_000 });
  });

  test('sin notificaciones: muestra el estado vacío', async ({ page }) => {
    const { erroresConsola } = await prepararRed(page, { notificaciones: [] });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('Todavía no tenés notificaciones');
    expect(erroresConsola()).toEqual([]);
  });

  test('lista una notificación de ruta asignada con su label y canal', async ({ page }) => {
    await prepararRed(page, { notificaciones: [notif(1, { canal: 'whatsapp' })] });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.cardsNotif()).toHaveCount(1);
    await expect(notifPage.listaNotif).toContainText('Ruta asignada');
    await expect(notifPage.listaNotif).toContainText('WhatsApp');
  });

  test('tipo no mapeado en TIPO_CONFIG: cae al fallback (🔔 + el tipo crudo)', async ({ page }) => {
    await prepararRed(page, { notificaciones: [notif(1, { tipo: 'promo_nueva' })] });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('promo_nueva');
  });

  test('notificación no entregada: muestra el motivo del fallo', async ({ page }) => {
    await prepararRed(page, {
      notificaciones: [notif(1, { entregada: false, motivo: 'Token push inválido' })],
    });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('No se pudo entregar — Token push inválido');
  });

  test('entregada true con motivo: NO muestra el motivo (solo aplica al caso de fallo)', async ({ page }) => {
    await prepararRed(page, {
      notificaciones: [notif(1, { entregada: true, motivo: 'esto no debería verse' })],
    });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).not.toContainText('esto no debería verse');
  });

  test('paginación: "Ver más" aparece con una página llena y agrega sin resetear', async ({ page }) => {
    await prepararRed(page, { paginada: true });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.cardsNotif()).toHaveCount(20);
    await expect(notifPage.btnCargarMas).toBeVisible();

    await notifPage.cargarMas();

    await expect(notifPage.cardsNotif()).toHaveCount(21);
    // La página 2 solo trae 1 fila (< PAGE) → no hay más para cargar.
    await expect(notifPage.btnCargarMas).toBeHidden();
  });

  test('error al cargar: muestra el mensaje sin romper la página', async ({ page }) => {
    await prepararRed(page, { onSelect: () => ({ __status: 500, message: 'error interno' }) });
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('No se pudo cargar el historial');
  });

  test('botón "Volver": navega hacia atrás en el historial del browser', async ({ page }) => {
    await prepararRed(page, { notificaciones: [] });
    // Cualquier página previa sirve para tener a dónde volver — no hace
    // falta que sea /chofer (evita mockear de más /api/chofer/remitos acá).
    await page.goto(`${staticServer.baseURL}/`);
    const notifPage = new ChoferNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();
    await notifPage.btnBack.click();

    await expect(page).toHaveURL(`${staticServer.baseURL}/`, { timeout: 10_000 });
  });
});
