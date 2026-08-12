// Login del portal chofer — arranca el bloque "portal chofer" (5/5
// páginas, cierra Fase 2/P1 del plan, ver PLAN_E2E_COBERTURA_TOTAL.md
// sección 29). Bastante más simple que `cliente/login.html`: el campo es
// un email de verdad (sin normalización de teléfono a partir de un
// número de WhatsApp), y valida ROL (`usuarios.rol` in
// chofer/dueno/admin) en vez de una tabla `clientes` asociada.
//
// Diferencia real de comportamiento frente a `cliente/login.html`: los 2
// inputs tienen `required` nativo y el `<form>` no tiene `novalidate` —
// campos vacíos ni siquiera disparan el listener de `submit` (los
// bloquea la validación nativa del browser ANTES de llegar al JS), así
// que no hay mensaje de error propio que afirmar para ese caso, a
// diferencia del portal cliente (que sí tiene su propio mensaje "Completá
// el número de WhatsApp y la contraseña").
//
// Reutiliza `mockearLoginPassword` (auth-helper.js) tal cual quedó
// documentado en `cliente/login.spec.js`. TODAVÍA NO corrido contra
// Chromium real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionChofer, mockearLoginPassword } from '../../helpers/auth-helper.js';
import { ChoferLoginPage } from '../../page-objects/chofer/login.page.js';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function prepararRed(page, { rol = 'chofer', perfil = { rol }, onLogin } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  mockearTabla(page, 'usuarios', { onSelect: () => perfil });
  const contarLogin = mockearLoginPassword(page, onLogin);

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), contarLogin };
}

test.describe('chofer/login.html', () => {

  test('campos vacíos: la validación nativa del browser bloquea el submit, no llega a pegarle al login', async ({ page }) => {
    const { contarLogin } = await prepararRed(page);
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({});

    await expect(loginPage.alerta).not.toBeVisible();
    await expect(page).toHaveURL(/\/chofer\/login\.html/);
    expect(contarLogin()).toBe(0);
  });

  test('login exitoso con rol chofer: redirige a /chofer', async ({ page }) => {
    const { contarLogin, erroresConsola } = await prepararRed(page, {
      rol: 'chofer', onLogin: () => ({ json: sesionOk() }),
    });
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ email: 'chofer1@test.local', pass: 'secreto123' });

    await expect(page).toHaveURL(/\/chofer\/?$/, { timeout: 10_000 });
    expect(contarLogin()).toBe(1);
    expect(erroresConsola()).toEqual([]);
  });

  test.describe('roles habilitados para el portal (dueno / admin), además de chofer', () => {
    for (const rol of ['dueno', 'admin']) {
      test(`login exitoso con rol ${rol}: también redirige a /chofer`, async ({ page }) => {
        await prepararRed(page, { rol, onLogin: () => ({ json: sesionOk() }) });
        const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
        await loginPage.goto();
        await loginPage.ingresar({ email: `${rol}@test.local`, pass: 'secreto123' });

        await expect(page).toHaveURL(/\/chofer\/?$/, { timeout: 10_000 });
      });
    }
  });

  test('rol sin acceso (ej. vendedor): cierra la sesión recién abierta y avisa, no redirige', async ({ page }) => {
    const { contarLogin } = await prepararRed(page, {
      rol: 'vendedor', onLogin: () => ({ json: sesionOk() }),
    });
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ email: 'vendedor@test.local', pass: 'secreto123' });

    await expect(loginPage.alerta).toBeVisible();
    await expect(loginPage.alerta).toContainText('Tu cuenta no tiene acceso al portal del chofer');
    await expect(page).toHaveURL(/\/chofer\/login\.html/);
    expect(contarLogin()).toBe(1);
    await expect(loginPage.btnIngresar).toBeEnabled();
  });

  test('sin perfil en `usuarios` (perfil null): mismo mensaje de sin acceso', async ({ page }) => {
    await prepararRed(page, { perfil: null, onLogin: () => ({ json: sesionOk() }) });
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ email: 'sinperfil@test.local', pass: 'secreto123' });

    await expect(loginPage.alerta).toContainText('Tu cuenta no tiene acceso al portal del chofer');
    await expect(page).toHaveURL(/\/chofer\/login\.html/);
  });

  test('credenciales incorrectas: error genérico, no redirige, no consulta el rol', async ({ page }) => {
    let seConsultoUsuarios = false;
    const { contarLogin } = await prepararRed(page, { onLogin: () => ({ status: 400, json: { error_description: 'Invalid login credentials' } }) });
    await page.route('**/rest/v1/usuarios**', async (route) => { seConsultoUsuarios = true; await route.fallback(); });
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.ingresar({ email: 'chofer1@test.local', pass: 'mala' });

    await expect(loginPage.alerta).toContainText('Email o contraseña incorrectos');
    await expect(page).toHaveURL(/\/chofer\/login\.html/);
    await expect(loginPage.btnIngresar).toBeEnabled();
    expect(contarLogin()).toBe(1);
    expect(seConsultoUsuarios).toBe(false);
  });

  test('con sesión ya activa: redirige directo a /chofer, sin mostrar el form', async ({ page }) => {
    await sembrarSesionChofer(page);
    await prepararRed(page);
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();

    await expect(page).toHaveURL(/\/chofer\/?$/, { timeout: 10_000 });
  });

  test('modo demo (?demo=1): precarga credenciales y muestra el aviso, sin autoenviar', async ({ page }) => {
    const { contarLogin } = await prepararRed(page);
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto({ demo: true });

    await expect(loginPage.inputEmail).toHaveValue('demo@distrib-test.local');
    await expect(loginPage.inputPass).toHaveValue('DistribDemo2026!');
    await expect(loginPage.avisoDemo).toBeVisible();
    expect(contarLogin()).toBe(0);
  });

  test('Enter en el campo de contraseña dispara el login', async ({ page }) => {
    const { contarLogin } = await prepararRed(page, { onLogin: () => ({ json: sesionOk() }) });
    const loginPage = new ChoferLoginPage(page, staticServer.baseURL);
    await loginPage.goto();
    await loginPage.completar({ email: 'chofer1@test.local', pass: 'secreto123' });
    await loginPage.inputPass.press('Enter');

    await expect(page).toHaveURL(/\/chofer\/?$/, { timeout: 10_000 });
    expect(contarLogin()).toBe(1);
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
    user: { id: 'e2e-user-chofer-login-1', aud: 'authenticated', role: 'authenticated', email: 'x@test.local' },
  };
}
