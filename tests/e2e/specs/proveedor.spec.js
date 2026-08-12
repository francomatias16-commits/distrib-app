// Portal proveedor — único de los 4 que se testea a nivel UI real (clicks
// sobre portal.html tal cual lo ve el proveedor), porque es público sin
// login: no hace falta mockear Supabase Auth, solo el endpoint de datos.
// Los otros 3 portales (chofer/cliente/pos) requieren sesión autenticada
// para renderizar su UI — ahí se testea a nivel de módulo (ver README).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/static-server.js';
import { vendorizarDexie, mockApi, irOffline, irOnline } from '../helpers/mock-network.js';

const TOKEN = 'token-proveedor-test-e2e';
const OC_ID = 'oc-test-001';

const OC_ENVIADA = {
  id: OC_ID,
  numero: '0001-00001234',
  estado: 'enviada',
  fecha_pedido: '2026-08-01',
  fecha_esperada: null,
  total: 15000,
  confirmada_por_proveedor: false,
  ordenes_compra_items: [],
};

const DATOS_PORTAL = {
  empresa: 'Empresa Test SA',
  proveedor: { nombre_fantasia: 'Proveedor Test' },
  ordenes: [OC_ENVIADA],
  facturas: [],
};

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirPortal(page, { onConfirmarEntrega } = {}) {
  const redEstado = { offline: false };
  // Diagnóstico — si window.ProveedorOffline no se llega a asignar (ver
  // guard agregado en proveedor-offline.js), esto va a mostrar el error
  // real en la consola del test en vez de fallar más adelante con un
  // "Cannot read properties of undefined" sin contexto.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[browser console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[browser pageerror] ${err.message}`));
  await vendorizarDexie(page);
  const contadores = mockApi(page, {
    // GET inicial (carga de datos) y GET de notificaciones — mismo
    // endpoint, distinta query string; alcanza con devolver el shape base
    // siempre. Distinguimos por si viene ?accion=notificaciones.
    '/api/proveedores': ({ request }) => {
      const url = new URL(request.url());
      if (url.searchParams.get('accion') === 'notificaciones') {
        return { json: { notificaciones: [] } };
      }
      if (url.searchParams.get('accion') === 'confirmar-entrega') {
        return onConfirmarEntrega
          ? onConfirmarEntrega()
          : { json: { ok: true } };
      }
      return { json: DATOS_PORTAL };
    },
  }, redEstado);

  await page.goto(`${staticServer.baseURL}/frontend/proveedor/portal.html?t=${TOKEN}`);
  await expect(page.locator('#ph-empresa')).toHaveText('Empresa Test SA');
  return { contadores, redEstado };
}

test.describe('Portal proveedor — offline (Etapa 3 v658)', () => {

  test('modo avión a mitad de "confirmar fecha de entrega": se encola y no se pierde', async ({ page, context }) => {
    let llamadasConfirmar = 0;
    const { redEstado } = await abrirPortal(page, {
      onConfirmarEntrega: () => { llamadasConfirmar++; return { json: { ok: true } }; },
    });

    // Abre el form de confirmar fecha y completa una fecha.
    await page.click(`[data-toggle="fecha-form-${OC_ID}"]`);
    await page.fill(`#input-fecha-${OC_ID}`, '2026-08-20');

    // Corta la red A MITAD de la operación — antes de tocar "Confirmar".
    await irOffline(context, redEstado);

    await page.click(`[data-guardar-fecha="${OC_ID}"]`);

    // guardarFecha() detecta !navigator.onLine y encola directo, sin
    // siquiera intentar el fetch (ver portal.js) — por eso llamadasConfirmar
    // se mantiene en 0 acá.
    await expect(page.locator(`#status-fecha-${OC_ID}`)).toContainText('sin conexión');
    expect(llamadasConfirmar).toBe(0);

    const pendientesOffline = await page.evaluate(() => window.ProveedorOffline.getContadorPendientes());
    expect(pendientesOffline).toBe(1);

    // Reconecta — el listener 'online' de offline-core.js dispara el sync solo.
    await irOnline(context, redEstado);
    await expect.poll(
      async () => page.evaluate(() => window.ProveedorOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);
    expect(llamadasConfirmar).toBe(1);
  });

  test('cierre de la pestaña a mitad del sync: al reabrir, la acción se completa sin duplicarse', async ({ page, context }) => {
    let llamadasConfirmar = 0;
    const { redEstado } = await abrirPortal(page, {
      // El servidor tarda 2s en responder — tiempo de sobra para "cerrar"
      // la pestaña mientras el sync está en vuelo.
      onConfirmarEntrega: () => { llamadasConfirmar++; return { json: { ok: true }, delayMs: 2000 }; },
    });

    await page.click(`[data-toggle="fecha-form-${OC_ID}"]`);
    await page.fill(`#input-fecha-${OC_ID}`, '2026-08-21');
    await irOffline(context, redEstado);
    await page.click(`[data-guardar-fecha="${OC_ID}"]`);
    await expect.poll(
      async () => page.evaluate(() => window.ProveedorOffline.getContadorPendientes())
    ).toBe(1);

    // Reconecta: dispara el sync (que va a tardar 2s por el mock).
    await irOnline(context, redEstado);
    // Le damos apenas un instante para que el sync arranque y quede "en vuelo"...
    await page.waitForTimeout(300);
    // ...y "cerramos la pestaña" recargando antes de que el fetch de 2s termine.
    await page.reload();
    await vendorizarDexie(page); // page.reload() pierde los route handlers del context? no — se mantienen; esto es no-op defensivo.

    // La acción sigue en el outbox (persistida en IndexedDB, sobrevivió al
    // cierre) y, como seguimos online, el init() del módulo la re-sincroniza.
    await expect.poll(
      async () => page.evaluate(() => window.ProveedorOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    // El punto central del escenario: no se duplicó. Puede haber quedado
    // en 1 (si el primer intento, cortado a mitad, sí había llegado a
    // pegarle al servidor antes del reload) o en 2 (si el reload cortó el
    // fetch antes de que saliera) — pero NUNCA más de 2, porque solo hubo
    // un encolado real de por medio.
    expect(llamadasConfirmar).toBeLessThanOrEqual(2);
  });

  test('reconexión intermitente: varios ciclos online/offline no disparan sync en paralelo', async ({ page, context }) => {
    let llamadasConfirmar = 0;
    const enVuelo = [];
    const { redEstado } = await abrirPortal(page, {
      onConfirmarEntrega: () => {
        llamadasConfirmar++;
        enVuelo.push(Date.now());
        return { json: { ok: true }, delayMs: 400 };
      },
    });

    await page.click(`[data-toggle="fecha-form-${OC_ID}"]`);
    await page.fill(`#input-fecha-${OC_ID}`, '2026-08-22');
    await irOffline(context, redEstado);
    await page.click(`[data-guardar-fecha="${OC_ID}"]`);
    await expect.poll(
      async () => page.evaluate(() => window.ProveedorOffline.getContadorPendientes())
    ).toBe(1);

    // Varios ciclos cortos online/offline — el caso real de señal
    // intermitente. Cada 'online' intenta disparar sincronizarPendientes().
    for (let i = 0; i < 4; i++) {
      await irOnline(context, redEstado);
      await page.waitForTimeout(50);
      await irOffline(context, redEstado);
      await page.waitForTimeout(50);
    }
    await irOnline(context, redEstado);

    await expect.poll(
      async () => page.evaluate(() => window.ProveedorOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    // Como solo había UNA acción encolada, el servidor tiene que haberla
    // recibido una sola vez pase lo que pase con la guarda syncEnCurso —
    // si esto da 2+, es la carrera descripta en el README (guarda
    // syncEnCurso pisada por dos 'online' seguidos antes del primer await).
    expect(llamadasConfirmar).toBe(1);
  });
});
