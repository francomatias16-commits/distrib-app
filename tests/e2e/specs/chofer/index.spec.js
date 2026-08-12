// Home del portal chofer — "ruta de hoy". Segunda página del bloque
// (ver PLAN_E2E_COBERTURA_TOTAL.md sección 29). Trae la ruta de
// `GET /api/chofer/remitos` (capa `/api/*`, no PostgREST directo) con
// `Authorization: Bearer <token>` armado a mano — se mockea con
// `mockApi`, no con `mockearTabla`.
//
// Hallazgo real: `gps-tracker.js` (script sin `defer`, cargado ANTES que
// el resto) pega su propio fetch a esa misma ruta apenas carga la
// página, aparte del que dispara `cargarRuta()` — cualquier spec que
// contara invocaciones de `/api/chofer/remitos` vería 2+ llamadas por
// carga, no 1; por eso ningún test de acá hace ese conteo (ver nota en
// el page object). Es 100% best-effort y no rompe nada si falla — no
// hace falta mockear geolocalización para que la página funcione.
//
// TODAVÍA NO corrido contra Chromium real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, mockApi, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico, mockearAuthGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionChofer } from '../../helpers/auth-helper.js';
import { ChoferIndexPage } from '../../page-objects/chofer/index.page.js';

const RUTA_ID = 'ruta-e2e-001';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

function remito(overrides = {}) {
  return {
    id: 'remito-1',
    numero_pedido: '1001',
    estado: 'confirmado',
    total: 15000,
    clientes: { nombre_fantasia: 'Kiosco Don José', domicilio: 'San Martín 450' },
    ...overrides,
  };
}

async function prepararRed(page, { remitos = [remito()], rutaId = RUTA_ID, onRemitos, sesion = true } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  if (sesion) await sembrarSesionChofer(page);
  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  mockearAuthGenerico(page);
  const contadores = mockApi(page, {
    '/api/chofer/remitos': onRemitos
      ? onRemitos
      : () => ({ json: { remitos, ruta_id: remitos.length ? rutaId : null } }),
  });

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), contadores };
}

test.describe('chofer/index.html (ruta de hoy)', () => {

  test('sin sesión: redirige a /chofer/login', async ({ page }) => {
    await prepararRed(page, { sesion: false });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    await expect(page).toHaveURL(/\/chofer\/login/, { timeout: 10_000 });
  });

  test('sin remitos asignados: estado vacío, resumen oculto', async ({ page }) => {
    const { erroresConsola } = await prepararRed(page, { remitos: [] });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    await expect(indexPage.emptyState).toContainText('No tenés remitos asignados para hoy');
    await expect(indexPage.resumenBar).toBeHidden();
    await expect(indexPage.btnRefrescar).toBeVisible();
    expect(erroresConsola()).toEqual([]);
  });

  test('con remitos: pinta las cards, el resumen y el chip de estado', async ({ page }) => {
    const remitos = [
      remito({ id: 'r1', numero_pedido: '1001', estado: 'confirmado' }),
      remito({ id: 'r2', numero_pedido: '1002', estado: 'despachado', clientes: { nombre_fantasia: 'Almacén Sur', domicilio: 'Belgrano 120' } }),
      remito({ id: 'r3', numero_pedido: '1003', estado: 'entregado', clientes: { razon_social: 'Distribuidora XYZ SRL' } }),
    ];
    await prepararRed(page, { remitos });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    await expect(indexPage.resumenBar).toBeVisible();
    await expect(indexPage.numTotal).toHaveText('3');
    await expect(indexPage.numEntregados).toHaveText('1');
    await expect(indexPage.numPendientes).toHaveText('2');

    await expect(indexPage.card('r1')).toContainText('Kiosco Don José');
    await expect(indexPage.card('r1')).toContainText('Por despachar');
    await expect(indexPage.card('r2')).toContainText('En camino');
    await expect(indexPage.card('r3')).toContainText('Distribuidora XYZ SRL'); // fallback a razón social sin nombre de fantasía
    await expect(indexPage.card('r3')).toContainText('Entregado');
  });

  test('cliente sin domicilio registrado: usa el texto de fallback', async ({ page }) => {
    await prepararRed(page, { remitos: [remito({ clientes: { nombre_fantasia: 'Kiosco Sin Domicilio' } })] });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    await expect(indexPage.card('remito-1')).toContainText('Sin domicilio registrado');
  });

  test('error al cargar la ruta: muestra el mensaje y el botón "Reintentar"', async ({ page }) => {
    await prepararRed(page, { onRemitos: () => ({ status: 500, json: { error: 'Error al cargar la ruta' } }) });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    await expect(indexPage.emptyState).toContainText('Error al cargar la ruta');
    await expect(indexPage.btnRefrescar).toHaveText('Reintentar');
  });

  test('tocar una card navega al detalle del remito', async ({ page }) => {
    await prepararRed(page, { remitos: [remito({ id: 'remito-nav' })] });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();
    await indexPage.abrirCard('remito-nav');

    await expect(page).toHaveURL(/\/chofer\/remito\?id=remito-nav/);
  });

  test('botón "Actualizar" vuelve a pedir la ruta', async ({ page }) => {
    let llamadas = 0;
    await prepararRed(page, { onRemitos: () => { llamadas += 1; return { json: { remitos: [remito()], ruta_id: RUTA_ID } }; } });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    const llamadasIniciales = llamadas;
    await indexPage.refrescar();

    await expect.poll(() => llamadas).toBeGreaterThan(llamadasIniciales);
  });

  test('cerrar sesión: confirma el diálogo nativo y redirige al login', async ({ page }) => {
    await prepararRed(page, { remitos: [] });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();
    await indexPage.salir();

    await expect(page).toHaveURL(/\/chofer\/login/, { timeout: 10_000 });
  });

  test('cancelar el diálogo de cerrar sesión: se queda en la página', async ({ page }) => {
    await prepararRed(page, { remitos: [] });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();
    await indexPage.cancelarSalir();

    await expect(page).toHaveURL(/\/chofer\/?$/);
    await expect(indexPage.emptyState).toBeVisible();
  });

  test('link "notificaciones" apunta al historial', async ({ page }) => {
    await prepararRed(page, { remitos: [] });
    const indexPage = new ChoferIndexPage(page, staticServer.baseURL);
    await indexPage.goto();

    await expect(indexPage.linkNotificaciones).toHaveAttribute('href', '/chofer/notificaciones');
  });
});
