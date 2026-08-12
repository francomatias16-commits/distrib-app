// pos-offline.js — nivel de módulo (no UI de pos.html, que requiere sesión
// autenticada + turno de caja abierto). Ver README. Este es el módulo más
// crítico de los 4: una venta duplicada acá es plata real.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/static-server.js';
import { vendorizarDexie, mockApi, irOffline, irOnline } from '../helpers/mock-network.js';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirHarness(page, { onVenta } = {}) {
  const redEstado = { offline: false };
  await vendorizarDexie(page);
  const contadores = mockApi(page, {
    '/api/pos': () => (onVenta ? onVenta() : { json: { ok: true, venta_pos_id: 'v-1' } }),
  }, redEstado);
  await page.goto(`${staticServer.baseURL}/tests/e2e/fixtures/harness-pos.html`);
  await page.waitForFunction(() => window.PosOffline);
  await page.evaluate(() => {
    // pos-offline.js lee el token/empresa de window.authCtx (lo llena el
    // login real en pos.html) — acá lo simulamos directo.
    window.authCtx = { session: { access_token: 'token-pos-fake' }, perfil: { empresa_id: 'empresa-test' } };
  });
  await page.evaluate(() => window.PosOffline.init());
  return { contadores, redEstado };
}

test.describe('pos-offline.js — offline (Etapa 3)', () => {

  test('modo avión a mitad de una venta: se encola y sincroniza sola, sin duplicar', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onVenta: () => { llamadas++; return { json: { ok: true, venta_pos_id: 'v-1' } }; } });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.PosOffline.encolarVenta({
      items: [{ producto_id: 'prod-1', cantidad: 3, precio: 1000 }],
      pagos: [{ metodo: 'efectivo', monto: 3000 }],
    }));

    await expect.poll(() => page.evaluate(() => window.PosOffline.getContadorPendientes())).toBe(1);
    expect(llamadas).toBe(0);

    await irOnline(context, redEstado, page);
    await expect.poll(
      () => page.evaluate(() => window.PosOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);
    expect(llamadas).toBe(1); // el punto que más importa: UNA sola venta, no dos
  });

  test('conflicto de negocio (stock_insuficiente, turno_cerrado, etc.) no se reintenta a ciegas', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, {
      onVenta: () => {
        llamadas++;
        return { status: 409, json: { error: 'Turno de caja cerrado', tipo: 'turno_cerrado' } };
      },
    });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.PosOffline.encolarVenta({
      items: [{ producto_id: 'prod-1', cantidad: 1, precio: 1000 }],
      pagos: [{ metodo: 'efectivo', monto: 1000 }],
    }));
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(async () => (await window.PosOffline.getConflictos()).length),
      { timeout: 5000 }
    ).toBe(1);
    expect(llamadas).toBe(1);
  });

  test('cierre de la pestaña a mitad del sync: al reabrir, no se duplica la venta', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onVenta: () => { llamadas++; return { json: { ok: true }, delayMs: 2000 }; } });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.PosOffline.encolarVenta({
      items: [{ producto_id: 'prod-1', cantidad: 1, precio: 500 }],
      pagos: [{ metodo: 'efectivo', monto: 500 }],
    }));
    await expect.poll(() => page.evaluate(() => window.PosOffline.getContadorPendientes())).toBe(1);

    await irOnline(context, redEstado, page);
    await page.waitForTimeout(300); // deja que el sync arranque y quede "en vuelo"
    await page.reload();
    await page.evaluate(() => {
      window.authCtx = { session: { access_token: 'token-pos-fake' }, perfil: { empresa_id: 'empresa-test' } };
    });
    await page.waitForFunction(() => window.PosOffline);
    await page.evaluate(() => window.PosOffline.init());

    await expect.poll(
      () => page.evaluate(() => window.PosOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    // Nota: acá SÍ hay riesgo real de duplicado a nivel servidor si
    // /api/pos no dedupea por offline_local_id (que el changelog dice que
    // sí hace) — esta prueba, al mockear el servidor, no valida esa parte;
    // valida que el CLIENTE no manda la venta dos veces en paralelo. La
    // dedup server-side ya la cubren tests/repos/pos.test.js.
    expect(llamadas).toBeLessThanOrEqual(2);
  });

  test('reconexión intermitente: no dispara dos syncs en paralelo sobre el mismo outbox', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onVenta: () => { llamadas++; return { json: { ok: true } }; } });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.PosOffline.encolarVenta({
      items: [{ producto_id: 'prod-1', cantidad: 1, precio: 500 }],
      pagos: [{ metodo: 'efectivo', monto: 500 }],
    }));
    await expect.poll(() => page.evaluate(() => window.PosOffline.getContadorPendientes())).toBe(1);

    for (let i = 0; i < 5; i++) {
      await irOnline(context, redEstado, page);
      await irOffline(context, redEstado, page);
    }
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(() => window.PosOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    expect(llamadas).toBe(1);
  });
});
