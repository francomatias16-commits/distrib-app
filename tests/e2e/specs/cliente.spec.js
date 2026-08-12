// cliente-offline.js — nivel de módulo (no UI de carrito.html, que
// requiere sesión autenticada). Ver README.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/static-server.js';
import { vendorizarDexie, mockApi, irOffline, irOnline } from '../helpers/mock-network.js';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirHarness(page, { onConfirmar } = {}) {
  const redEstado = { offline: false };
  await vendorizarDexie(page);
  const contadores = mockApi(page, {
    '/api/pedidos': () => (onConfirmar ? onConfirmar() : { json: { ok: true, pedido_id: 'p-1' } }),
  }, redEstado);
  await page.goto(`${staticServer.baseURL}/tests/e2e/fixtures/harness-cliente.html`);
  await page.waitForFunction(() => window.ClienteOffline);
  await page.evaluate(() => window.ClienteOffline.init({
    getToken: async () => 'token-cliente-fake',
    empresaId: 'empresa-test',
  }));
  return { contadores, redEstado };
}

function idempotencyKey() {
  return `idem-${Math.random().toString(36).slice(2)}`;
}

test.describe('cliente-offline.js — offline (Etapa 3)', () => {

  test('modo avión a mitad de confirmar el pedido: se encola y sincroniza sola', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onConfirmar: () => { llamadas++; return { json: { ok: true } }; } });
    const key = idempotencyKey();

    await irOffline(context, redEstado, page);
    await page.evaluate((idempotency_key) => window.ClienteOffline.encolarPedido({
      items: [{ producto_id: 'prod-1', cantidad: 2 }],
      canal: 'web',
      idempotency_key,
    }), key);

    await expect.poll(() => page.evaluate(() => window.ClienteOffline.getContadorPendientes())).toBe(1);
    expect(llamadas).toBe(0);

    await irOnline(context, redEstado, page);
    await expect.poll(
      () => page.evaluate(() => window.ClienteOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);
    expect(llamadas).toBe(1);
  });

  test('conflicto por stock_insuficiente (409) no se reintenta a ciegas', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, {
      onConfirmar: () => {
        llamadas++;
        return { status: 409, json: { tipo: 'stock_insuficiente', error: 'Sin stock suficiente' } };
      },
    });
    const key = idempotencyKey();

    await irOffline(context, redEstado, page);
    await page.evaluate((idempotency_key) => window.ClienteOffline.encolarPedido({
      items: [{ producto_id: 'prod-1', cantidad: 50 }],
      canal: 'web',
      idempotency_key,
    }), key);
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(async () => (await window.ClienteOffline.getConflictos()).length),
      { timeout: 5000 }
    ).toBe(1);
    expect(llamadas).toBe(1);
  });

  test('encolarPedido sin idempotency_key rechaza antes de tocar el outbox (defensa en profundidad)', async ({ page }) => {
    await abrirHarness(page);
    const lanzoError = await page.evaluate(async () => {
      try {
        await window.ClienteOffline.encolarPedido({ items: [{ producto_id: 'x', cantidad: 1 }] });
        return false;
      } catch {
        return true;
      }
    });
    expect(lanzoError).toBe(true);
  });

  test('reconexión intermitente: no dispara dos syncs en paralelo', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onConfirmar: () => { llamadas++; return { json: { ok: true } }; } });
    const key = idempotencyKey();

    await irOffline(context, redEstado, page);
    await page.evaluate((idempotency_key) => window.ClienteOffline.encolarPedido({
      items: [{ producto_id: 'prod-1', cantidad: 1 }],
      canal: 'web',
      idempotency_key,
    }), key);
    await expect.poll(() => page.evaluate(() => window.ClienteOffline.getContadorPendientes())).toBe(1);

    for (let i = 0; i < 5; i++) {
      await irOnline(context, redEstado, page);
      await irOffline(context, redEstado, page);
    }
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(() => window.ClienteOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);
    expect(llamadas).toBe(1);
  });
});
