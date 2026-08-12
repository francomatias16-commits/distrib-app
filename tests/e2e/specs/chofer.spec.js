// chofer-offline.js — nivel de módulo (no UI de remito.html, que requiere
// sesión autenticada completa). Se ejercita window.ChoferOffline tal cual
// lo llamaría remito.html, en un browser real: IndexedDB/Dexie real,
// eventos online/offline reales. Ver README de esta suite para el porqué.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/static-server.js';
import { vendorizarDexie, mockApi, irOffline, irOnline } from '../helpers/mock-network.js';

const PEDIDO_ID = 'pedido-test-001';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirHarness(page, { onNoEntregar } = {}) {
  const redEstado = { offline: false };
  await vendorizarDexie(page);
  const contadores = mockApi(page, {
    '/api/chofer/remitos/': ({ request }) => {
      if (!request.url().includes('/no-entregar')) return { status: 404, json: {} };
      return onNoEntregar ? onNoEntregar() : { json: { ok: true } };
    },
  }, redEstado);

  await page.goto(`${staticServer.baseURL}/tests/e2e/fixtures/harness-chofer.html`);
  await page.waitForFunction(() => window.ChoferOffline);
  await page.evaluate(() => window.ChoferOffline.init({ getToken: async () => 'token-chofer-fake' }));
  return { contadores, redEstado };
}

async function encolarNoEntregar(page) {
  await page.evaluate(({ pedidoId }) => window.ChoferOffline.encolarAccion('no_entregar', {
    pedido_id: pedidoId,
    motivo: 'cliente_ausente',
    notas: 'Nadie atendió en el domicilio',
    foto_data_url: null, // sin foto: _subirImagen corta antes de pegarle a la red
  }), { pedidoId: PEDIDO_ID });
}

test.describe('chofer-offline.js — offline (Etapa 3)', () => {

  test('modo avión a mitad de una "no entrega": se encola y sincroniza sola al reconectar', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onNoEntregar: () => { llamadas++; return { json: { ok: true } }; } });

    await irOffline(context, redEstado, page);
    await encolarNoEntregar(page);

    await expect.poll(() => page.evaluate(() => window.ChoferOffline.getContadorPendientes())).toBe(1);
    expect(llamadas).toBe(0); // todavía no intentó red

    await irOnline(context, redEstado, page);
    await expect.poll(
      () => page.evaluate(() => window.ChoferOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);
    expect(llamadas).toBe(1);
  });

  test('conflicto: "pedido no está despachado" (400) no se reintenta a ciegas', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, {
      onNoEntregar: () => { llamadas++; return { status: 400, json: { error: 'El pedido no está despachado' } }; },
    });

    await irOffline(context, redEstado, page);
    await encolarNoEntregar(page);
    await irOnline(context, redEstado, page);

    // El rechazo 400 se mapea a conflicto (ver _errorConflicto), no a
    // reintento — tiene que aparecer en getConflictos(), no seguir en
    // getPendientes() creciendo intentos.
    await expect.poll(
      () => page.evaluate(async () => (await window.ChoferOffline.getConflictos()).length),
      { timeout: 5000 }
    ).toBe(1);

    expect(llamadas).toBe(1); // un solo intento — no reintenta un conflicto real
    const pendientes = await page.evaluate(() => window.ChoferOffline.getContadorPendientes());
    expect(pendientes).toBe(0);
  });

  test('reconexión intermitente: no dispara dos syncs en paralelo sobre el mismo outbox', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, {
      onNoEntregar: () => { llamadas++; return { json: { ok: true } }; }, // sin delay a propósito: el peor caso para la carrera es rápido, no lento
    });

    await irOffline(context, redEstado, page);
    await encolarNoEntregar(page);
    await expect.poll(() => page.evaluate(() => window.ChoferOffline.getContadorPendientes())).toBe(1);

    for (let i = 0; i < 5; i++) {
      await irOnline(context, redEstado, page);
      await irOffline(context, redEstado, page);
    }
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(() => window.ChoferOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    // Ver nota en README — si esto falla con llamadas > 1, es la carrera
    // de syncEnCurso (chequeo síncrono, seteo post-await) sobre una sola
    // acción encolada.
    expect(llamadas).toBe(1);
  });
});
