// Fase 0.5 del plan (PLAN_E2E_COBERTURA_TOTAL.md, sección 8, opción 2):
// "un único spec parametrizado que visite las 75 páginas, haga login, y
// verifique carga sin error de consola + el layout principal renderiza".
// Deliberadamente NO verifica comportamiento de negocio (eso es Fase 1-4,
// página por página) — el objetivo acá es barato y con cobertura 100%:
// atrapa selectores rotos, botones muertos por excepción temprana, y
// errores de JS que revientan el render, en las 75 páginas de una sola
// pasada.
//
// Qué SÍ mockeamos (para no pegarle a Supabase real ni depender de red):
// - Sesión de Supabase Auth (auth-helper.js) para las páginas que la
//   exigen.
// - Catch-all de `/rest/v1/*` y `/api/*` (supabase-rest-mock.js) — más
//   overrides puntuales donde la página redirige a login si no encuentra
//   un shape mínimo (los 2 casos: `usuarios` en el portal admin y en el
//   portal cliente, ver abajo).
//
// Qué NO verifica (a propósito, ver sección 2 del plan): que el dato haya
// quedado bien en una base real, ni el resultado de clickear cada acción
// — eso es Tier 1 profundo (Fase 1-4) y Tier 2 (Fase 5).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/static-server.js';
import { vendorizarDexie, vendorizarSupabase, filtrarRuidoRed } from '../helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico, mockearTabla } from '../helpers/supabase-rest-mock.js';
import { loguearComoAdmin, sembrarSesionChofer, sembrarSesionCliente } from '../helpers/auth-helper.js';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

// ── Inventario de páginas (sección 1 del plan) ──────────────────────────
// auth: 'admin' | 'chofer' | 'cliente' | null (público, sin sesión)

const PAGINAS_ADMIN_PUBLICAS = ['login', 'sin-permiso'];

// 54 páginas admin totales (sección 1) menos las 2 públicas de arriba.
const PAGINAS_ADMIN_CON_SESION = [
  'anomalias', 'auditoria', 'automatizacion', 'avisos', 'cajas', 'cc-proveedores',
  'cheques', 'clientes', 'cobranzas', 'comparador-precios', 'compras',
  'conciliacion-bancaria', 'cta-cte', 'dashboard', 'devoluciones', 'empresa-config',
  'export-contable', 'facturacion-config', 'facturacion', 'fidelizacion',
  'liquidacion', 'lotes', 'mercadopago-config', 'migracion', 'notas', 'notif-log',
  'observabilidad', 'pedidos', 'pos', 'presupuestos', 'productos', 'proveedores',
  'puntos', 'reglas-precio', 'rentabilidad-producto-vendedor', 'rentabilidad-zona',
  'reportes-financieros', 'reportes-stock', 'reportes-ventas', 'riesgo-cheques',
  'rutas', 'saas-billing', 'setup-wizard', 'setup', 'soporte', 'stock', 'superadmin',
  'suspendida', 'usuarios', 'vencimientos', 'whatsapp-conversaciones', 'whatsapp-onboarding',
];

// De las 52 de arriba, estas 9 NO usan el layout compartido de nav.js
// (`<div id="nav-root">` + `/frontend/admin/js/nav.js`) — tienen su
// propio nav "v3" autocontenido (dashboard.html mismo lo dice en un
// comentario: "v3 es autocontenido y no importa esas hojas") o son
// pantallas standalone sin sidebar (setup, setup-wizard, suspendida).
// CONFIRMADO por inspección directa de las 52 páginas (no es una
// suposición): son exactamente las únicas 9 sin `id="nav-root"` en el
// HTML. Esperar `#nav-root` en ellas nunca puede cumplirse — no es que
// la página tarde, el selector directamente no existe — y eso es lo que
// producía los timeouts de 10s en la corrida real, no un bug de wiring.
const PAGINAS_ADMIN_SIN_NAV_ROOT = new Set([
  'cta-cte', 'dashboard', 'liquidacion', 'lotes', 'presupuestos',
  'setup-wizard', 'setup', 'superadmin', 'suspendida',
]);

const PAGINAS_CLIENTE_PUBLICAS = ['login'];
const PAGINAS_CLIENTE_CON_SESION = [
  'inicio', 'catalogo', 'carrito', 'checkout', 'cuenta', 'notificaciones', 'pedidos',
];

const PAGINAS_CHOFER_PUBLICAS = ['login', 'invitacion'];
const PAGINAS_CHOFER_CON_SESION = ['index', 'notificaciones', 'remito'];

const PAGINAS_PUBLICAS_ROOT = [
  'completar-registro', 'eliminacion-datos', 'index', 'privacidad', 'registro', 'terminos',
];

// Errores de consola que NO son bugs de wiring — ruido esperado del
// entorno de test (recursos externos que a propósito no mockeamos porque
// no son parte de lo que este smoke verifica) o warnings benignos del SDK.
const RUIDO_IGNORADO = [
  /favicon/i,
  /sentry/i,
  /Failed to load resource.*sheetjs/i,     // CDN externo, solo se usa al exportar
  /manifest\.json/i,
  /service-worker|sw\.js/i,
  // Firebase Cloud Messaging (push-init.js) — opcional, no bloquea el
  // render; el host gstatic.com no está en la allowlist de este sandbox.
  /firebasejs|gstatic\.com/i,
  // Wrapper propio (shared/realtime.js) sobre el WebSocket de Supabase
  // Realtime — el host real está bloqueado en este sandbox, mismo origen
  // que ya cubre filtrarRuidoRed() para el texto crudo del WebSocket.
  /\[DistribRealtime\]/,
];

function esRuidoIgnorado(texto) {
  if (RUIDO_IGNORADO.some((re) => re.test(texto))) return true;
  // Mismo criterio que filtrarRuidoRed() (mock-network.js, usado ya por
  // toda la Fase 1): CDNs opcionales bloqueados en este sandbox
  // (jsdelivr para xlsx/qrcodejs/zxing/fonts, Sentry) y el WebSocket de
  // Supabase Realtime que el SDK vendorizado igual intenta abrir contra
  // el proyecto real — no son bugs de la app bajo test.
  return filtrarRuidoRed([texto]).length === 0;
}

async function prepararRedComun(page) {
  await vendorizarDexie(page);
  // Sin esto, `auth.js` explota con "Cannot read properties of undefined
  // (reading 'createClient')" apenas se resuelve `authReady` — el CDN
  // real de `@supabase/supabase-js` está bloqueado en este sandbox (403),
  // mismo hallazgo ya documentado en la sección 11.3 del plan para
  // `pos.spec.js`/`pedidos.spec.js`. Sirve el SDK vendorizado en su lugar.
  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearApiGenerico(page);
}

async function visitarYVerificar(page, url, { esperarNavRoot = false } = {}) {
  const errores = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !esRuidoIgnorado(msg.text())) errores.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    if (!esRuidoIgnorado(err.message)) errores.push(`[pageerror] ${err.message}`);
  });

  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `${url} respondió ${response?.status()}`).toBeLessThan(400);

  if (esperarNavRoot) {
    await page.waitForSelector('#nav-root', { state: 'attached', timeout: 10_000 });
  } else {
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  }
  // Margen corto para que terminen de correr los handlers async de carga
  // inicial (DOMContentLoaded ya disparó `load`, pero varias páginas
  // encadenan awaits después) antes de leer `errores`.
  await page.waitForTimeout(300);

  expect(errores, `Errores de consola en ${url}:\n${errores.join('\n')}`).toEqual([]);
}

test.describe('Smoke universal — Fase 0.5 (carga sin error, layout renderiza)', () => {

  test.describe('Admin — páginas públicas', () => {
    for (const nombre of PAGINAS_ADMIN_PUBLICAS) {
      test(`/admin/${nombre}.html carga sin error`, async ({ page }) => {
        await prepararRedComun(page);
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/admin/${nombre}.html`);
      });
    }
  });

  test.describe('Admin — con sesión', () => {
    for (const nombre of PAGINAS_ADMIN_CON_SESION) {
      test(`/admin/${nombre}.html carga logueado sin error`, async ({ page }) => {
        await prepararRedComun(page);
        await loguearComoAdmin(page);
        const esperarNavRoot = !PAGINAS_ADMIN_SIN_NAV_ROOT.has(nombre);
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/admin/${nombre}.html`, { esperarNavRoot });
      });
    }
  });

  test.describe('Cliente — páginas públicas', () => {
    for (const nombre of PAGINAS_CLIENTE_PUBLICAS) {
      test(`/cliente/${nombre}.html carga sin error`, async ({ page }) => {
        await prepararRedComun(page);
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/cliente/${nombre}.html`);
      });
    }
  });

  test.describe('Cliente — con sesión', () => {
    for (const nombre of PAGINAS_CLIENTE_CON_SESION) {
      test(`/cliente/${nombre}.html carga logueado sin error`, async ({ page }) => {
        await prepararRedComun(page);
        const { userId } = await sembrarSesionCliente(page);
        // Sin esto, `usuario?.cliente_id` sale undefined (mock genérico
        // devuelve {}) y la página redirige sola a /cliente/login — ver
        // nota arriba del archivo.
        mockearTabla(page, 'usuarios', {
          onSelect: () => ({ nombre: 'Cliente E2E', empresa_id: 'e2e-empresa-1', cliente_id: 'e2e-cliente-1', id: userId }),
        });
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/cliente/${nombre}.html`);
      });
    }
  });

  test.describe('Chofer — páginas públicas', () => {
    for (const nombre of PAGINAS_CHOFER_PUBLICAS) {
      test(`/chofer/${nombre}.html carga sin error`, async ({ page }) => {
        await prepararRedComun(page);
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/chofer/${nombre}.html`);
      });
    }
  });

  test.describe('Chofer — con sesión', () => {
    for (const nombre of PAGINAS_CHOFER_CON_SESION) {
      test(`/chofer/${nombre}.html carga logueado sin error`, async ({ page }) => {
        await prepararRedComun(page);
        await sembrarSesionChofer(page);
        mockearTabla(page, 'usuarios', {
          onSelect: () => ({ nombre: 'Chofer E2E', empresa_id: 'e2e-empresa-1', rol: 'chofer' }),
        });
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/chofer/${nombre}.html`);
      });
    }
  });

  test.describe('Público / root', () => {
    for (const nombre of PAGINAS_PUBLICAS_ROOT) {
      test(`/${nombre}.html carga sin error`, async ({ page }) => {
        await prepararRedComun(page);
        await visitarYVerificar(page, `${staticServer.baseURL}/frontend/${nombre}.html`);
      });
    }
  });

  // Proveedor (portal.html) y scan-pos ya tienen cobertura de click real
  // en proveedor.spec.js / pos.spec.js con sus propios mocks de datos —
  // acá solo confirmamos que cargan sin romperse a nivel smoke, con un
  // token de prueba y el catch-all genérico.
  test('/proveedor/portal.html carga sin error (token de prueba)', async ({ page }) => {
    await prepararRedComun(page);
    await visitarYVerificar(page, `${staticServer.baseURL}/frontend/proveedor/portal.html?t=e2e-token-smoke`);
  });

  test('/scan-pos/portal.html carga sin error (token de prueba)', async ({ page }) => {
    await prepararRedComun(page);
    await visitarYVerificar(page, `${staticServer.baseURL}/frontend/scan-pos/portal.html?t=e2e-token-smoke`);
  });
});
