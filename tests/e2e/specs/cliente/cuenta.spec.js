// Mi cuenta del portal cliente: perfil + puntos + catálogo de recompensas
// canjeables (/api/fidelizacion) + cuenta corriente/actividad (solo
// lectura) + cambiar contraseña (/api/auth/change-password, Bearer real,
// ver comentario "FIX etapa 14" en el HTML) + logout. TODAVÍA NO corrido
// contra Chromium real (mismo estado que el resto del bloque — ver nota
// al principio de pedidos.spec.js).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { mockearTabla, mockearRestGenerico, mockearConteoTabla, mockearAuthGenerico } from '../../helpers/supabase-rest-mock.js';
import { sembrarSesionCliente } from '../../helpers/auth-helper.js';
import { ClienteCuentaPage } from '../../page-objects/cliente/cuenta.page.js';

const CLIENTE_ID = 'e2e-cliente-001';

const USUARIO = { nombre: 'Juan Pérez', email: 'juan@example.com', empresa_id: 'e2e-empresa-1', cliente_id: CLIENTE_ID };

const CLIENTE_BASE = {
  razon_social: 'Juan Pérez', email: 'juan@example.com', telefono: '11-5555-1234',
  domicilio: 'Av. Siempre Viva 742', score_actual: 82, score_categoria: 'bueno',
  saldo_deuda: 0, limite_credito: 50000,
};

const PUNTOS = { puntos_disponibles: 1200, puntos_totales: 3400 };

const RECOMPENSAS = {
  puntos_disponibles: 1200,
  recompensas: [
    { id: 'r-1', nombre: 'Gorra Fluxo', descripcion: 'Gorra de la marca', puntos_requeridos: 500 },
    { id: 'r-2', nombre: 'Heladera chica', descripcion: 'Premio grande', puntos_requeridos: 5000 },
  ],
};

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function prepararRed(page, { cliente = CLIENTE_BASE, puntos = PUNTOS, recompensas = RECOMPENSAS,
  pedidosCount = 7, onChangePassword, onCanjear } = {}) {
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });
  page.on('pageerror', (err) => erroresConsola.push(err.message));

  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  // Necesario para el test de logout: sb.auth.signOut() pega a
  // /auth/v1/logout (GoTrue), una capa distinta a /rest/v1/ que cubre
  // mockearRestGenerico. Sin esto el await de signOut() nunca resuelve
  // a tiempo en el sandbox de CI y la sesión falsa queda viva cuando
  // login.html vuelve a leerla (mismo patrón ya usado en
  // chofer/index.spec.js).
  mockearAuthGenerico(page);
  mockearTabla(page, 'usuarios', { onSelect: () => USUARIO });
  mockearTabla(page, 'clientes', { onSelect: () => cliente });
  mockearTabla(page, 'saldo_puntos', { onSelect: () => puntos });
  mockearTabla(page, 'pedidos', { onSelect: () => [] });
  // Registrado DESPUÉS de mockearTabla('pedidos', ...) a propósito — ver
  // nota de orden en el propio helper.
  mockearConteoTabla(page, 'pedidos', pedidosCount);

  // OJO orden: `mockApi` registra un `page.route` por entrada y Playwright
  // prioriza el ÚLTIMO registrado que matchea (ver nota en mock-network.js
  // y supabase-rest-mock.js) — '/api/fidelizacion?accion=canjear' es un
  // substring de sí mismo pero TAMBIÉN matchea el patrón más corto
  // '/api/fidelizacion', así que el patrón específico va DESPUÉS del
  // genérico para poder pisarlo en el POST de canje sin robarle las GET
  // del catálogo.
  mockApi(page, {
    '/api/fidelizacion': () => ({ json: recompensas }),
    '/api/fidelizacion?accion=canjear': () => (onCanjear ? onCanjear() : { json: { saldo_nuevo: puntos.puntos_disponibles - 500 } }),
    '/api/auth/change-password': () => (onChangePassword ? onChangePassword() : { json: { ok: true } }),
  });

  return { erroresConsola: () => filtrarRuidoRed(erroresConsola) };
}

test.describe('cliente/cuenta.html', () => {

  test('perfil: muestra nombre, email y badge de categoría', async ({ page }) => {
    await sembrarSesionCliente(page);
    const { erroresConsola } = await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    await expect(cuentaPage.perfilCard).toContainText('Juan Pérez');
    await expect(cuentaPage.perfilCard).toContainText('juan@example.com');
    await expect(cuentaPage.perfilCard).toContainText('Buen cliente');
    expect(erroresConsola()).toEqual([]);
  });

  test('puntos: muestra disponibles y totales acumulados', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    await expect(cuentaPage.puntosValor).toHaveText('1.200');
    await expect(cuentaPage.puntosSub).toContainText('3.400');
  });

  test('cuenta corriente: deuda pendiente se muestra en rojo', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { cliente: { ...CLIENTE_BASE, saldo_deuda: 15000 } });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    const fila = cuentaPage.infoRow('Saldo pendiente');
    await expect(fila).toBeVisible();
    await expect(fila.locator('.cta-info-row-val')).toHaveClass(/deuda/);
  });

  test('cuenta corriente: saldo a favor se muestra distinto de una deuda', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { cliente: { ...CLIENTE_BASE, saldo_deuda: -2000 } });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    const fila = cuentaPage.infoRow('Saldo a favor');
    await expect(fila).toBeVisible();
    await expect(fila.locator('.cta-info-row-val')).toHaveClass(/ok/);
  });

  test('actividad: muestra el conteo de pedidos realizados', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, { pedidosCount: 12 });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    await expect(cuentaPage.infoRow('Pedidos realizados')).toContainText('12');
  });

  test('recompensas: catálogo distingue "alcanza" de "puntos insuficientes"', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    await expect(cuentaPage.botonCanjear('Gorra Fluxo')).toBeEnabled();
    await expect(cuentaPage.botonCanjear('Heladera chica')).toBeDisabled();
    await expect(cuentaPage.botonCanjear('Heladera chica')).toContainText('insuficientes');
  });

  test('canjear recompensa: confirma, actualiza puntos y refresca el catálogo', async ({ page }) => {
    await sembrarSesionCliente(page);
    let bodyCanje = null;
    await prepararRed(page, {
      onCanjear: () => ({ json: { saldo_nuevo: 700 } }),
    });
    page.on('request', (req) => {
      if (req.url().includes('accion=canjear')) bodyCanje = JSON.parse(req.postData() || '{}');
    });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.canjear('Gorra Fluxo');

    await expect(cuentaPage.recompensasMsg).toContainText('Canjeaste "Gorra Fluxo"');
    await expect(cuentaPage.puntosValor).toHaveText('700');
    expect(bodyCanje).toMatchObject({ recompensa_id: 'r-1' });
  });

  test('canjear recompensa con error: muestra el mensaje y reactiva el botón', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, {
      onCanjear: () => ({ status: 400, json: { error: 'Ya no quedan unidades de esta recompensa.' } }),
    });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.canjear('Gorra Fluxo');

    await expect(cuentaPage.recompensasMsg).toContainText('Ya no quedan unidades');
    await expect(cuentaPage.botonCanjear('Gorra Fluxo')).toBeEnabled();
  });

  test('cambiar contraseña: el acordeón arranca cerrado y se abre al click', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    await expect(cuentaPage.pwBody).not.toHaveClass(/abierto/);
    await cuentaPage.abrirCambiarPassword();
  });

  test('cambiar contraseña: valida campos vacíos sin llamar al servidor', async ({ page }) => {
    await sembrarSesionCliente(page);
    let llamadas = 0;
    await prepararRed(page, { onChangePassword: () => { llamadas += 1; return { json: { ok: true } }; } });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.abrirCambiarPassword();
    await cuentaPage.completarCambioPassword({});

    await expect(cuentaPage.pwMsg).toContainText('Completá todos los campos');
    expect(llamadas).toBe(0);
  });

  test('cambiar contraseña: valida longitud mínima', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.abrirCambiarPassword();
    await cuentaPage.completarCambioPassword({ actual: 'actual123', nueva: '123', repetir: '123' });

    await expect(cuentaPage.pwMsg).toContainText('al menos 6 caracteres');
  });

  test('cambiar contraseña: valida que coincidan', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.abrirCambiarPassword();
    await cuentaPage.completarCambioPassword({ actual: 'actual123', nueva: 'nueva123', repetir: 'otra123' });

    await expect(cuentaPage.pwMsg).toContainText('no coinciden');
  });

  test('cambiar contraseña: éxito limpia los campos y muestra confirmación', async ({ page }) => {
    await sembrarSesionCliente(page);
    let bodyPw = null;
    await prepararRed(page, { onChangePassword: () => ({ json: { ok: true } }) });
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/change-password')) bodyPw = JSON.parse(req.postData() || '{}');
    });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.abrirCambiarPassword();
    await cuentaPage.completarCambioPassword({ actual: 'actual123', nueva: 'nueva123', repetir: 'nueva123' });

    await expect(cuentaPage.pwMsg).toContainText('cambiada correctamente');
    await expect(cuentaPage.pwActual).toHaveValue('');
    await expect(cuentaPage.pwNueva).toHaveValue('');
    expect(bodyPw).toMatchObject({ password_actual: 'actual123', password_nuevo: 'nueva123' });
  });

  test('cambiar contraseña: error del servidor se muestra sin limpiar los campos', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page, {
      onChangePassword: () => ({ status: 400, json: { error: 'La contraseña actual no es correcta.' } }),
    });
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.abrirCambiarPassword();
    await cuentaPage.completarCambioPassword({ actual: 'mala', nueva: 'nueva123', repetir: 'nueva123' });

    await expect(cuentaPage.pwMsg).toContainText('no es correcta');
    await expect(cuentaPage.pwActual).toHaveValue('mala');
  });

  test('botón de activar notificaciones push: visible por default', async ({ page }) => {
    // Chromium bajo Playwright arranca con Notification.permission en
    // 'denied' (no 'default' como un browser recién instalado) — no hay
    // UI de prompt en un contexto automatizado, así que no hay forma de
    // "preguntar" y el navegador cae directo a denegado. Sobreescribimos
    // el getter ANTES de que cargue cuenta.html para simular el estado
    // real de un usuario que todavía no contestó el permiso — es un tema
    // del entorno de test, no del código de la página (ver cuenta.html:
    // `btnPush.style.display = (Notification.permission === 'default') ? '' : 'none'`).
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    });
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();

    // Solo visibilidad — ver nota "OJO 2" en cuenta.page.js sobre por qué
    // el click queda fuera de alcance acá.
    await expect(cuentaPage.btnActivarPush).toBeVisible();
  });

  test('logout: cierra sesión y redirige al login', async ({ page }) => {
    await sembrarSesionCliente(page);
    await prepararRed(page);
    const cuentaPage = new ClienteCuentaPage(page, staticServer.baseURL);
    await cuentaPage.goto();
    await cuentaPage.logout();

    await expect(page).toHaveURL(/\/cliente\/login/);
  });
});
