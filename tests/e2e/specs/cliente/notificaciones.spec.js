// Historial de notificaciones del portal cliente (`notif_log`): filtro
// por tipo (server-side, resetea offset), paginación "Ver más" (PAGE=20,
// via header `Range`, no query param), y el caso "no se pudo entregar"
// (entregada:false + motivo). TODAVÍA NO corrido contra Chromium real —
// mismo estado que el resto del bloque.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearTabla, mockearRestGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionCliente } from '../../helpers/auth-helper.js';
import { ClienteNotificacionesPage } from '../../page-objects/cliente/notificaciones.page.js';

const CLIENTE_ID = 'e2e-cliente-001';
const USUARIO = { cliente_id: CLIENTE_ID };

function notif(i, overrides = {}) {
  return {
    id: `n-${i}`,
    tipo: 'pedido_entregado',
    canal: 'whatsapp',
    created_at: '2026-08-01T10:00:00Z',
    entregada: true,
    motivo: null,
    ...overrides,
  };
}

/** Página 1 con exactamente PAGE (20) filas → dispara "hubo más". */
const PAGINA_1 = Array.from({ length: 20 }, (_, i) => notif(i, { id: `n-${i}`, canal: 'whatsapp' }));
const PAGINA_2 = [notif(20, { id: 'n-20', tipo: 'puntos_ganados', canal: 'push' })];

/** Lee el offset inicial de `?offset=N` — ver nota equivalente en
 *  chofer/notificaciones.spec.js: la versión vendorizada del SDK manda
 *  `.range()` como query params, no como header `Range`. */
function offsetDeRequest(request) {
  const url = new URL(request.url());
  return parseInt(url.searchParams.get('offset'), 10) || 0;
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function prepararRed(page, { paginada = false, notificaciones = [notif(1)], onSelectFiltro } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearTabla(page, 'usuarios', { onSelect: () => USUARIO });

  if (paginada) {
    mockearTabla(page, 'notif_log', {
      onSelect: ({ request }) => (offsetDeRequest(request) === 0 ? PAGINA_1 : PAGINA_2),
    });
  } else {
    mockearTabla(page, 'notif_log', { onSelect: onSelectFiltro || (() => notificaciones) });
  }

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola) };
}

test.describe('cliente/notificaciones.html', () => {

  test('sin notificaciones: muestra el estado vacío', async ({ page }) => {
    await sembrarSesionCliente(page);
    const { erroresConsola } = await prepararRed(page, { notificaciones: [] });
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('Todavía no tenés notificaciones');
    expect(erroresConsola()).toEqual([]);
  });

  test('lista notificaciones con su label y canal', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { notificaciones: [notif(1, { tipo: 'deuda_vencida', canal: 'email' })] });
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.cardsNotif()).toHaveCount(1);
    await expect(notifPage.listaNotif).toContainText('Aviso de deuda vencida');
    await expect(notifPage.listaNotif).toContainText('Email');
  });

  test('notificación no entregada: muestra el motivo del fallo', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, {
      notificaciones: [notif(1, { entregada: false, motivo: 'Número no tiene WhatsApp' })],
    });
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('No se pudo entregar — Número no tiene WhatsApp');
  });

  test('filtrar por tipo: repite la carga con el filtro aplicado', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { notificaciones: [notif(1, { tipo: 'puntos_ganados' })] });
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();
    await notifPage.filtrarPor('puntos_ganados');

    await expect(notifPage.chipFiltro('puntos_ganados')).toHaveClass(/activo/);
    await expect(notifPage.listaNotif).toContainText('Puntos ganados');
  });

  test('paginación: "Ver más" aparece con una página llena y agrega sin resetear', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { paginada: true });
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.cardsNotif()).toHaveCount(20);
    await expect(notifPage.btnCargarMas).toBeVisible();

    await notifPage.cargarMas();

    await expect(notifPage.cardsNotif()).toHaveCount(21);
    // La página 2 solo trae 1 fila (< PAGE) → no hay más para cargar.
    await expect(notifPage.btnCargarMas).toBeHidden();
  });

  test('error al cargar: muestra el mensaje sin romper la página', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { onSelectFiltro: () => ({ __status: 500, message: 'error interno' }) });
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.listaNotif).toContainText('No se pudo cargar el historial');
  });

  test('botón de activar notificaciones push: visible por default', async ({ page }) => {
    // Ver nota equivalente en cliente/cuenta.spec.js: Chromium bajo
    // Playwright arranca en 'denied', no 'default', porque no hay UI de
    // prompt en un contexto automatizado.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    });
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const notifPage = new ClienteNotificacionesPage(page, staticServer.baseURL);
    await notifPage.goto();

    await expect(notifPage.btnActivarPush).toBeVisible();
  });
});
