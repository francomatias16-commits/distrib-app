// Login del portal cliente — sin registro, exclusivo para clientes que ya
// tienen usuario creado por la distribuidora. Particularidad real de esta
// página (no del arnés): el campo visible dice "Número de WhatsApp", pero
// por debajo sigue siendo `sb.auth.signInWithPassword({ email, password })`
// de Supabase — el número se normaliza a un email ficticio
// `<54+dígitos>@portal.distrib` ANTES de mandarlo (mismo algoritmo que el
// backend usa para crear esos usuarios). Primer spec del bloque que
// ejercita el propio formulario de login en vez de asumir sesión con
// `sembrarSesionCliente` — ver `mockearLoginPassword` (auth-helper.js).
// TODAVÍA NO corrido contra Chromium real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearTabla, mockearRestGenerico, mockearRpc } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionCliente, mockearLoginPassword } from '../../helpers/auth-helper.js';
import { ClienteLoginPage } from '../../page-objects/cliente/login.page.js';

const CLIENTE_ASOCIADO = { id: 'e2e-cliente-001', empresa_id: 'e2e-empresa-1' };

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function prepararRed(page, { empresa = { nombre: 'Distribuidora Fluxo', logo_url: null },
  cliente = CLIENTE_ASOCIADO, onLogin } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearRpc(page, 'empresa_publica_actual', () => empresa);
  mockearTabla(page, 'clientes', { onSelect: () => cliente });
  const contarLogin = mockearLoginPassword(page, onLogin);

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), contarLogin };
}

test.describe('cliente/login.html', () => {

  test('muestra el nombre de la empresa (función pública, sin sesión)', async ({ page }) => {
    const { erroresConsola } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();

    await expect(loginPage.nombreEmpresa).toHaveText('Distribuidora Fluxo');
    expect(erroresConsola()).toEqual([]);
  });

  test('campos vacíos: muestra el error sin llamar al login', async ({ page }) => {
    const { contarLogin } = await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({});

    await expect(loginPage.alertaError).toHaveClass(/show/);
    await expect(loginPage.textoError).toContainText('Completá el número de WhatsApp y la contraseña');
    expect(contarLogin()).toBe(0);
  });

  test('login exitoso: normaliza el teléfono a email ficticio y redirige al catálogo', async ({ page }) => {
    let emailUsado = null;
    const { contarLogin } = await prepararRed(page, {
      onLogin: ({ body }) => { emailUsado = body?.email; return { json: sesionOk() }; },
    });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ telefono: '3462 123456', pass: 'secreto123' });

    await expect(page).toHaveURL(/\/cliente\/catalogo/, { timeout: 10_000 });
    expect(emailUsado).toBe('543462123456@portal.distrib');
    expect(contarLogin()).toBe(1);
  });

  test('teléfono que ya arranca con 54: no le duplica el prefijo', async ({ page }) => {
    let emailUsado = null;
    await prepararRed(page, { onLogin: ({ body }) => { emailUsado = body?.email; return { json: sesionOk() }; } });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ telefono: '5493462123456', pass: 'secreto123' });

    await expect(page).toHaveURL(/\/cliente\/catalogo/, { timeout: 10_000 });
    expect(emailUsado).toBe('5493462123456@portal.distrib');
  });

  test('teléfono con 0 inicial (código de área): lo saca antes de anteponer 54', async ({ page }) => {
    let emailUsado = null;
    await prepararRed(page, { onLogin: ({ body }) => { emailUsado = body?.email; return { json: sesionOk() }; } });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ telefono: '03462123456', pass: 'secreto123' });

    await expect(page).toHaveURL(/\/cliente\/catalogo/, { timeout: 10_000 });
    expect(emailUsado).toBe('543462123456@portal.distrib');
  });

  test('credenciales incorrectas: muestra el error genérico y no redirige', async ({ page }) => {
    await prepararRed(page, { onLogin: () => ({ status: 400, json: { error_description: 'Invalid login credentials' } }) });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ telefono: '3462123456', pass: 'mala' });

    await expect(loginPage.textoError).toContainText('Número o contraseña incorrectos');
    await expect(page).toHaveURL(/\/cliente\/login\.html/);
    await expect(loginPage.btnIngresar).toBeEnabled();
  });

  test('login OK pero sin cliente asociado: cierra la sesión y avisa, no redirige', async ({ page }) => {
    await prepararRed(page, { cliente: null, onLogin: () => ({ json: sesionOk() }) });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ telefono: '3462123456', pass: 'secreto123' });

    await expect(loginPage.textoError).toContainText('Tu usuario no está asociado a ningún cliente');
    await expect(page).toHaveURL(/\/cliente\/login\.html/);
  });

  test('mostrar/ocultar contraseña: alterna el type del input', async ({ page }) => {
    await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();

    await expect(loginPage.inputPass).toHaveAttribute('type', 'password');
    await loginPage.togglePass();
    await expect(loginPage.inputPass).toHaveAttribute('type', 'text');
    await loginPage.togglePass();
    await expect(loginPage.inputPass).toHaveAttribute('type', 'password');
  });

  test('Enter en el campo de contraseña dispara el login', async ({ page }) => {
    const { contarLogin } = await prepararRed(page, { onLogin: () => ({ json: sesionOk() }) });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.completar({ telefono: '3462123456', pass: 'secreto123' });
    await loginPage.inputPass.press('Enter');

    await expect(page).toHaveURL(/\/cliente\/catalogo/, { timeout: 10_000 });
    expect(contarLogin()).toBe(1);
  });

  test('con sesión ya activa y cliente asociado: redirige directo, sin mostrar el form', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();

    await expect(page).toHaveURL(/\/cliente\/catalogo/, { timeout: 10_000 });
  });

  test('con sesión activa pero sin cliente asociado: cierra sesión y se queda en el login', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { cliente: null });
    const loginPage = new ClienteLoginPage(page, staticServer.baseURL);
    await loginPage.goto();

    await expect(loginPage.btnIngresar).toBeVisible();
    await expect(page).toHaveURL(/\/cliente\/login\.html/);
  });
});

function sesionOk() {
  const ahora = Math.floor(Date.now() / 1000);
  return {
    access_token: 'e2e-fake-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: ahora + 3600,
    refresh_token: 'e2e-fake-refresh-token',
    user: { id: 'e2e-user-login-1', aud: 'authenticated', role: 'authenticated', email: 'x@portal.distrib' },
  };
}
