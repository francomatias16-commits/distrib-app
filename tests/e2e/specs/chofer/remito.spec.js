// chofer/remito.html — última página de Fase 2 (P1) del plan recortado
// (ver PLAN_E2E_RECORTADO.md, sección 3, paso 1: "Cerrar chofer/remito.html
// (firma + geolocalización)").
//
// Geolocalización: la cubre `gps-tracker.js` (cargado en <head>, sin
// defer), 100% best-effort y en background — no bloquea ni cambia el
// render de la página si el navegador no da permiso. No hace falta
// `context.grantPermissions(['geolocation'])` para que esta suite pase
// (mismo criterio que chofer/index.page.js, ya documentado ahí). Lo que
// SÍ se ejercita acá a fondo es la firma digital, que es la pieza real de
// "confirmar entrega" que faltaba cobertura.
//
// NOTA: escrito en un sandbox sin Chromium instalable (red restringida a
// los dominios del proyecto, sin acceso al CDN de Playwright/apt) — no se
// pudo correr contra un navegador real todavía. Sigue el mismo patrón que
// el resto de la suite chofer/ (varios specs de ese bloque también están
// escritos y sin corrida real confirmada — ver comentario en
// chofer/index.spec.js). Correr con:
//   npx playwright test -c playwright.config.e2e.js tests/e2e/specs/chofer/remito.spec.js

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, mockApi, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico, mockearAuthGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionChofer } from '../../helpers/auth-helper.js';
import { ChoferRemitoPage } from '../../page-objects/chofer/remito.page.js';

const PEDIDO_ID = 'remito-e2e-001';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

function remitoDetalle(overrides = {}) {
  return {
    id: PEDIDO_ID,
    numero_pedido: '2001',
    estado: 'despachado',
    total: 15000,
    forma_pago: 'cuenta_corriente',
    empresa_id: 'empresa-e2e-001',
    clientes: { nombre_fantasia: 'Kiosco Don José', domicilio: 'San Martín 450', telefono: '3564123456' },
    pedido_items: [
      { productos: { nombre: 'Coca-Cola 2.25L', unidad: 'un.' }, cantidad: 2, precio_unitario: 3000, subtotal: 6000 },
    ],
    ...overrides,
  };
}

// `remitos` es un dict-string genérico: gps-tracker.js pega su propio GET
// a `/api/chofer/remitos` (sin id, para detectar ruta activa) apenas carga
// la página, ADEMÁS del que dispara `cargarRemito()` con `?id=X` — mismo
// hallazgo que ya documentó chofer/index.page.js. Un único handler que
// inspecciona la query string cubre ambos casos sin falsos 404 ruidosos en
// consola.
async function prepararRed(page, { detalle = remitoDetalle(), onDespachar, onEntregar, onNoEntregar, onEntregaFoto, sesion = true } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  if (sesion) await sembrarSesionChofer(page);
  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  mockearAuthGenerico(page);

  // Orden importa: mockApi registra por LIFO (ver comentario en el page
  // object), así que la ruta base va primero y las específicas después.
  const contadores = mockApi(page, {
    '/api/chofer/remitos': ({ request }) => {
      if (request.method() === 'POST') {
        return onDespachar ? onDespachar() : { json: { ok: true } };
      }
      // GET con o sin ?id= — gps-tracker.js pega el mismo path sin id.
      const url = new URL(request.url());
      if (!url.searchParams.get('id')) return { json: { remitos: [], ruta_id: null } };
      return { json: detalle };
    },
    '/entregar': () => (onEntregar ? onEntregar() : { json: { ok: true } }),
    '/no-entregar': () => (onNoEntregar ? onNoEntregar() : { json: { ok: true } }),
    '/api/chofer/entrega-foto': () => (onEntregaFoto ? onEntregaFoto() : { json: { url: 'https://storage.test/firma.png' } }),
  });

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), contadores };
}

test.describe('chofer/remito.html (detalle + confirmar entrega)', () => {

  test('sin sesión: redirige a /chofer/login', async ({ page }) => {
    await prepararRed(page, { sesion: false });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);

    await expect(page).toHaveURL(/\/chofer\/login/, { timeout: 10_000 });
  });

  test('estado "confirmado": muestra "Marcar como despachado", sin acciones de entrega', async ({ page }) => {
    const { erroresConsola } = await prepararRed(page, { detalle: remitoDetalle({ estado: 'confirmado' }) });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);

    await expect(remitoPage.btnDespachar).toBeVisible();
    await expect(remitoPage.btnEntregar).toHaveCount(0);
    expect(erroresConsola()).toEqual([]);
  });

  test('estado "despachado": muestra entregar, no-entregar y registrar devolución', async ({ page }) => {
    await prepararRed(page, { detalle: remitoDetalle({ estado: 'despachado' }) });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);

    await expect(remitoPage.btnEntregar).toBeVisible();
    await expect(remitoPage.btnNoEntregar).toBeVisible();
    await expect(remitoPage.btnAbrirDevolucion).toBeVisible();
    await expect(remitoPage.numeroRemito).toHaveText('#2001');
  });

  test('remito inexistente: muestra el error del servidor, sin acciones', async ({ page }) => {
    await prepararRed(page, {
      onDespachar: () => ({ status: 404, json: { error: 'Remito no encontrado' } }),
    });
    // Forzamos el GET de detalle a fallar sobreescribiendo el handler base.
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await page.route('**/api/chofer/remitos**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.searchParams.get('id')) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Remito no encontrado' }) });
      }
      return route.fallback();
    });
    await remitoPage.goto(PEDIDO_ID);

    await expect(remitoPage.emptyState).toContainText('Remito no encontrado');
  });

  test('confirmar entrega sin firmar: bloquea con mensaje, no llama al backend', async ({ page }) => {
    let llamadasEntregar = 0;
    await prepararRed(page, { onEntregar: () => { llamadasEntregar += 1; return { json: { ok: true } }; } });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);
    await remitoPage.abrirModalEntrega();

    await remitoPage.confirmarEntrega();

    await expect(remitoPage.alertaEntrega).toContainText('Falta la firma de quien recibe');
    await expect(remitoPage.overlayEntrega).toHaveClass(/show/); // el modal no se cierra
    expect(llamadasEntregar).toBe(0);
  });

  test('cobro parcial: pide confirmación antes de mandar el PATCH', async ({ page }) => {
    await prepararRed(page, { detalle: remitoDetalle({ total: 15000 }) });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);
    await remitoPage.abrirModalEntrega();
    await remitoPage.dibujarFirma();
    await remitoPage.cobroMonto.fill('5000');
    await remitoPage.cobroMedio.selectOption('efectivo');

    let dialogVisto = null;
    page.once('dialog', (d) => { dialogVisto = d.message(); d.dismiss(); }); // cancelamos: no se confirma la entrega
    await remitoPage.confirmarEntrega();

    await expect.poll(() => dialogVisto).toContain('faltan');
    await expect(remitoPage.overlayEntrega).toHaveClass(/show/); // se quedó en el modal, no se mandó nada
  });

  test('firma + entrega completa: sube la firma, confirma, cierra el modal y recarga', async ({ page }) => {
    let llamadasEntregaFoto = 0;
    let llamadasEntregar = 0;
    let bodyEntregar = null;
    await prepararRed(page, {
      onEntregaFoto: () => { llamadasEntregaFoto += 1; return { json: { url: 'https://storage.test/firma.png' } }; },
      onEntregar: () => { llamadasEntregar += 1; return { json: { ok: true } }; },
    });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);
    // Capturamos el body real del PATCH para confirmar que viaja firma_url.
    await page.route('**/entregar**', async (route) => {
      bodyEntregar = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await remitoPage.abrirModalEntrega();
    await remitoPage.dibujarFirma();
    await remitoPage.receptorEntrega.fill('Juan (encargado)');
    await remitoPage.confirmarEntrega();

    await expect.poll(() => llamadasEntregaFoto).toBeGreaterThan(0);
    await expect(remitoPage.overlayEntrega).not.toHaveClass(/show/, { timeout: 10_000 });
    expect(bodyEntregar?.firma_url).toBe('https://storage.test/firma.png');
    expect(bodyEntregar?.receptor).toBe('Juan (encargado)');
  });

  test('"Borrar y firmar de nuevo" limpia el trazo — confirmar sin volver a firmar vuelve a bloquear', async ({ page }) => {
    await prepararRed(page);
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);
    await remitoPage.abrirModalEntrega();
    await remitoPage.dibujarFirma();
    await remitoPage.btnLimpiarFirma.click();

    await remitoPage.confirmarEntrega();

    await expect(remitoPage.alertaEntrega).toContainText('Falta la firma de quien recibe');
  });

  test('cancelar el modal de entrega: lo cierra sin llamar al backend', async ({ page }) => {
    let llamadas = 0;
    await prepararRed(page, { onEntregar: () => { llamadas += 1; return { json: { ok: true } }; } });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);
    await remitoPage.abrirModalEntrega();

    await remitoPage.btnCancelarEntrega.click();

    await expect(remitoPage.overlayEntrega).not.toHaveClass(/show/);
    expect(llamadas).toBe(0);
  });

  test('"No se pudo entregar": confirma con motivo por defecto y cierra el modal', async ({ page }) => {
    let llamadas = 0;
    let body = null;
    await prepararRed(page, { onNoEntregar: () => { llamadas += 1; return { json: { ok: true } }; } });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);
    await page.route('**/no-entregar**', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await remitoPage.abrirModalNoEntrega();
    await remitoPage.btnConfirmarNoEntrega.click();

    await expect(remitoPage.overlayNoEntrega).not.toHaveClass(/show/, { timeout: 10_000 });
    expect(body?.motivo).toBe('nadie_en_casa'); // primer <option> del select
  });

  test('estado "entregado": no vuelve a mostrar acciones de entrega/despacho', async ({ page }) => {
    await prepararRed(page, { detalle: remitoDetalle({ estado: 'entregado', monto_cobrado: 15000, medio_cobro: 'efectivo' }) });
    const remitoPage = new ChoferRemitoPage(page, staticServer.baseURL);
    await remitoPage.goto(PEDIDO_ID);

    await expect(remitoPage.btnDespachar).toHaveCount(0);
    await expect(remitoPage.btnEntregar).toHaveCount(0);
    await expect(remitoPage.btnNoEntregar).toHaveCount(0);
    await expect(remitoPage.btnAbrirDevolucion).toBeVisible(); // se puede seguir registrando una devolución después de entregado
    await expect(remitoPage.cuerpoRemito).toContainText('Cobraste');
  });
});
