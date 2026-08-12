// Activación de acceso del chofer vía link de invitación — tercera
// página del bloque (ver PLAN_E2E_COBERTURA_TOTAL.md sección 29).
// Público hasta que el propio form abre sesión — no usar
// `sembrarSesionChofer` acá (ver nota en el page object).
//
// Las 2 llamadas a `/api/chofer-invitacion` (accion=ver al cargar,
// accion=activar al enviar) comparten la misma URL base — se
// distinguen por querystring dentro de un único handler de `mockApi`,
// inspeccionando `request.url()`.
//
// Hallazgo real del backend (`lib/handlers/chofer_invitacion.js`): tras
// activar, el HTML hace `signInWithPassword({ email: data.email,
// password })` con el email que devuelve el backend — si ESE paso
// falla (poco probable, pero contemplado explícitamente en el código
// con un comentario propio), no muestra error: manda derecho a
// `/chofer/login` en vez de `/chofer`. Cubierto como caso propio, no
// una variante menor del camino feliz.
//
// TODAVÍA NO corrido contra Chromium real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, mockApi, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { mockearLoginPassword } from '../../helpers/auth-helper.js';
import { ChoferInvitacionPage } from '../../page-objects/chofer/invitacion.page.js';

const TOKEN = 'token-e2e-abc123';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

function safeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function prepararRed(page, { ver, activar, onLogin } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  const contadores = mockApi(page, {
    '/api/chofer-invitacion': ({ request }) => {
      const url = new URL(request.url());
      const accion = url.searchParams.get('accion');
      if (accion === 'ver') {
        return ver ? ver({ url, request }) : { json: { nombre: 'Juan Pérez', telefono: '3462123456' } };
      }
      if (accion === 'activar') {
        return activar
          ? activar({ request, body: safeJson(request.postData()) })
          : { json: { ok: true, email: 'juan@chofer.distrib' } };
      }
      return { status: 400, json: { error: 'Acción desconocida' } };
    },
  });
  const contarLogin = mockearLoginPassword(page, onLogin);

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola), contadores, contarLogin };
}

test.describe('chofer/invitacion.html', () => {

  test('sin token en la URL: error inmediato, no llega a pegarle a la API', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(undefined);

    await expect(invitacionPage.alerta).toContainText('Este link no es válido');
    await expect(invitacionPage.form).toBeHidden();
    expect(contadores['/api/chofer-invitacion']).toBe(0);
  });

  test('token inválido/vencido: muestra el mensaje que manda el backend', async ({ page }) => {
    await prepararRed(page, {
      ver: () => ({ status: 410, json: { error: 'Este link venció. Pedile a tu contacto habitual que te genere uno nuevo.' } }),
    });
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);

    await expect(invitacionPage.alerta).toContainText('Este link venció');
    await expect(invitacionPage.form).toBeHidden();
  });

  test('token válido: saluda por nombre y muestra el form', async ({ page }) => {
    const { erroresConsola } = await prepararRed(page, {
      ver: () => ({ json: { nombre: 'María Gómez', telefono: '3462999888' } }),
    });
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);

    await expect(invitacionPage.cargando).toBeHidden();
    await expect(invitacionPage.saludo).toContainText('María Gómez');
    await expect(invitacionPage.form).toBeVisible();
    expect(erroresConsola()).toEqual([]);
  });

  test('nombre con caracteres especiales: se escapa, no se interpreta como HTML', async ({ page }) => {
    await prepararRed(page, { ver: () => ({ json: { nombre: '<b>Hackerman</b>', telefono: '111' } }) });
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);

    await expect(invitacionPage.saludo.locator('b')).toHaveCount(0);
    await expect(invitacionPage.saludo).toContainText('<b>Hackerman</b>');
  });

  test('contraseñas que no coinciden: error local, no llega a pegarle a "activar"', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);
    await invitacionPage.activar({ password: 'secreto123', password2: 'otra1234' });

    await expect(invitacionPage.alerta).toContainText('Las contraseñas no coinciden');
    expect(contadores['/api/chofer-invitacion']).toBe(1); // solo el "ver" inicial
  });

  test('contraseña corta: la validación nativa (minlength=8) bloquea el submit', async ({ page }) => {
    const { contadores } = await prepararRed(page);
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);
    await invitacionPage.activar({ password: '1234', password2: '1234' });

    expect(contadores['/api/chofer-invitacion']).toBe(1); // solo el "ver" inicial, nunca "activar"
  });

  test('activación exitosa: inicia sesión con el email devuelto por el backend y redirige a /chofer', async ({ page }) => {
    let emailUsado = null;
    const { contarLogin } = await prepararRed(page, {
      activar: () => ({ json: { ok: true, email: 'maria@chofer.distrib' } }),
      onLogin: ({ body }) => { emailUsado = body?.email; return { json: sesionOk() }; },
    });
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);
    await invitacionPage.activar({ password: 'secreto123', password2: 'secreto123' });

    await expect(page).toHaveURL(/\/chofer\/?$/, { timeout: 10_000 });
    expect(emailUsado).toBe('maria@chofer.distrib');
    expect(contarLogin()).toBe(1);
  });

  test('activación OK pero el login automático falla: manda al login normal, no rompe', async ({ page }) => {
    await prepararRed(page, {
      activar: () => ({ json: { ok: true, email: 'maria@chofer.distrib' } }),
      onLogin: () => ({ status: 400, json: { error_description: 'Invalid login credentials' } }),
    });
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);
    await invitacionPage.activar({ password: 'secreto123', password2: 'secreto123' });

    await expect(page).toHaveURL(/\/chofer\/login/, { timeout: 10_000 });
  });

  test('backend rechaza la activación (ej. link ya usado en una carrera): muestra el error y reactiva el botón', async ({ page }) => {
    const { contarLogin } = await prepararRed(page, {
      activar: () => ({ status: 410, json: { error: 'Este link ya fue usado. Si no pudiste entrar, pedile a tu contacto habitual que te genere uno nuevo.' } }),
    });
    const invitacionPage = new ChoferInvitacionPage(page, staticServer.baseURL);
    await invitacionPage.goto(TOKEN);
    await invitacionPage.activar({ password: 'secreto123', password2: 'secreto123' });

    await expect(invitacionPage.alerta).toContainText('Este link ya fue usado');
    await expect(invitacionPage.btnActivar).toBeEnabled();
    await expect(invitacionPage.btnActivar).toHaveText('Activar acceso');
    await expect(page).toHaveURL(/\/chofer\/invitacion/);
    expect(contarLogin()).toBe(0);
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
    user: { id: 'e2e-user-chofer-invitacion-1', aud: 'authenticated', role: 'authenticated', email: 'x@chofer.distrib' },
  };
}
