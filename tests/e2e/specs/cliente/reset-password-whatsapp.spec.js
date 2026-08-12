// Modal de reset de contraseña por WhatsApp en frontend/cliente/login.html
// (ver CHANGELOG_v719). Reemplaza el viejo link "¿Olvidaste tu
// contraseña?" que solo mostraba un mensaje estático — ahora abre un modal
// de dos pasos que pega contra POST /api/auth/reset-password-whatsapp y
// POST /api/auth/confirmar-codigo-whatsapp (dos endpoints nuevos de
// lib/handlers/auth.js, NO Supabase REST/RPC — por eso se mockean acá con
// `mockApi`, mismo mecanismo que el resto de la suite usa para `/api/*`,
// y no con `mockearTabla`/`mockearRpc`, que son para `/rest/v1/*`).
//
// TODAVÍA NO corrido contra Chromium real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { mockearRestGenerico, mockearRpc } from '../../helpers/supabase-rest-mock.js';
import { ClienteLoginPage } from '../../page-objects/cliente/login.page.js';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function prepararRed(page, { reset, confirmar } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearRpc(page, 'empresa_publica_actual', () => ({ nombre: 'Distribuidora Fluxo', logo_url: null }));

  const contadores = mockApi(page, {
    '/api/auth/reset-password-whatsapp': reset
      ?? (() => ({ json: { ok: true, mensaje: 'Si el número está registrado, te enviamos un código por WhatsApp.' } })),
    '/api/auth/confirmar-codigo-whatsapp': confirmar
      ?? (() => ({ json: { ok: true, mensaje: 'Contraseña actualizada correctamente.' } })),
  });

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), contadores };
}

test.describe('cliente/login.html — reset de contraseña por WhatsApp', () => {

  test('abre el modal precargado con lo tipeado en el campo de teléfono', async ({ page }) => {
    const { erroresConsola } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.completar({ telefono: '3462123456' });

    await expect(loginPage.modalReset).not.toHaveClass(/show/);
    await loginPage.abrirModalReset();

    await expect(loginPage.modalReset).toHaveClass(/show/);
    await expect(loginPage.pasoTelefono).toHaveClass(/show/);
    await expect(loginPage.resetTelefono).toHaveValue('3462123456');
    expect(erroresConsola()).toEqual([]);
  });

  test('teléfono vacío: muestra error sin llamar al backend', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('');

    await expect(loginPage.resetMsg1).toHaveClass(/show err/);
    await expect(loginPage.resetMsg1).toContainText('Ingresá tu número de WhatsApp');
    expect(contadores['/api/auth/reset-password-whatsapp']).toBe(0);
  });

  test('pide el código: llama al backend y pasa al paso 2', async ({ page }) => {
    let bodyEnviado = null;
    const { contadores } = await prepararRed(page, {
      reset: ({ request }) => { bodyEnviado = request.postDataJSON(); return { json: { ok: true } }; },
    });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462 123456');

    await expect(loginPage.pasoCodigo).toHaveClass(/show/);
    await expect(loginPage.pasoTelefono).not.toHaveClass(/show/);
    expect(contadores['/api/auth/reset-password-whatsapp']).toBe(1);
    expect(bodyEnviado).toEqual({ telefono: '3462 123456' });
  });

  test('el backend siempre responde ok (no revela si el número existe) — igual avanza al paso 2', async ({ page }) => {
    // Mismo criterio anti-enumeración que el reset por email: el handler
    // real (handleResetPasswordWhatsapp) SIEMPRE responde 200 ok:true,
    // exista o no el número — el mock replica exactamente eso.
    const { contadores } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462999999');

    await expect(loginPage.pasoCodigo).toHaveClass(/show/);
    expect(contadores['/api/auth/reset-password-whatsapp']).toBe(1);
  });

  test('error de red al pedir el código: muestra mensaje, se queda en el paso 1', async ({ page }) => {
    await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    // Sobreescribe el mock de reset-password-whatsapp para que la request falle de verdad.
    await page.route('**/api/auth/reset-password-whatsapp**', (route) => route.abort('failed'));
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');

    await expect(loginPage.resetMsg1).toHaveClass(/show err/);
    await expect(loginPage.resetMsg1).toContainText('Error de conexión');
    await expect(loginPage.pasoTelefono).toHaveClass(/show/);
  });

  test('código/contraseña vacíos en el paso 2: muestra error sin llamar al backend', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');
    await loginPage.confirmarCodigo({ codigo: '', passNueva: '' });

    await expect(loginPage.resetMsg2).toHaveClass(/show err/);
    await expect(loginPage.resetMsg2).toContainText('Completá el código y la nueva contraseña');
    expect(contadores['/api/auth/confirmar-codigo-whatsapp']).toBe(0);
  });

  test('contraseña nueva corta: error de validación client-side, no llama al backend', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');
    await loginPage.confirmarCodigo({ codigo: '123456', passNueva: '123' });

    await expect(loginPage.resetMsg2).toContainText('al menos 6 caracteres');
    expect(contadores['/api/auth/confirmar-codigo-whatsapp']).toBe(0);
  });

  test('código incorrecto: el backend responde 400 y se muestra el error, sin cerrar el modal', async ({ page }) => {
    const { contadores } = await prepararRed(page, {
      confirmar: () => ({ status: 400, json: { error: 'Código inválido o vencido.' } }),
    });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');
    await loginPage.confirmarCodigo({ codigo: '000000', passNueva: 'nuevaPass123' });

    await expect(loginPage.resetMsg2).toHaveClass(/show err/);
    await expect(loginPage.resetMsg2).toContainText('Código inválido o vencido');
    await expect(loginPage.modalReset).toHaveClass(/show/);
    expect(contadores['/api/auth/confirmar-codigo-whatsapp']).toBe(1);
  });

  test('demasiados intentos: el backend responde 429 y se muestra el error', async ({ page }) => {
    await prepararRed(page, {
      confirmar: () => ({ status: 429, json: { error: 'Demasiados intentos. Pedí un código nuevo.' } }),
    });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');
    await loginPage.confirmarCodigo({ codigo: '111111', passNueva: 'nuevaPass123' });

    await expect(loginPage.resetMsg2).toContainText('Demasiados intentos');
  });

  test('código correcto: confirma, muestra éxito y precarga el teléfono en el login', async ({ page }) => {
    let bodyConfirmar = null;
    await prepararRed(page, {
      confirmar: ({ request }) => { bodyConfirmar = request.postDataJSON(); return { json: { ok: true } }; },
    });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');
    await loginPage.confirmarCodigo({ codigo: '654321', passNueva: 'nuevaPass123' });

    await expect(loginPage.resetMsg2).toHaveClass(/show ok/);
    await expect(loginPage.resetMsg2).toContainText('Contraseña actualizada');
    expect(bodyConfirmar).toEqual({ telefono: '3462123456', codigo: '654321', password_nuevo: 'nuevaPass123' });

    // El modal se cierra solo (setTimeout de 1.4s) y precarga el teléfono.
    await expect(loginPage.modalReset).not.toHaveClass(/show/, { timeout: 3000 });
    await expect(loginPage.inputTelefono).toHaveValue('3462123456');
  });

  test('cancelar en el paso 1 cierra el modal sin llamar al backend', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.btnCancelarReset1.click();

    await expect(loginPage.modalReset).not.toHaveClass(/show/);
    expect(contadores['/api/auth/reset-password-whatsapp']).toBe(0);
  });

  test('volver en el paso 2 regresa al paso 1 sin perder el modal abierto', async ({ page }) => {
    await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.abrirModalReset();
    await loginPage.pedirCodigo('3462123456');
    await expect(loginPage.pasoCodigo).toHaveClass(/show/);

    await loginPage.btnVolverPaso1.click();

    await expect(loginPage.pasoTelefono).toHaveClass(/show/);
    await expect(loginPage.pasoCodigo).not.toHaveClass(/show/);
    await expect(loginPage.modalReset).toHaveClass(/show/);
  });
});
