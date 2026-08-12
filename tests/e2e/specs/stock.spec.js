// stock-offline.js — nivel de módulo (no UI de stock.html). Ver README y
// PLAN_OFFLINE_ETAPA6_TESTING_PILOTO_ROLLOUT.md sección 1.2 — junto con
// cobros.spec.js, cierra el hueco que tenían los dos módulos que el
// propio plan marca como "más delicados" (ajuste/transferencia de stock
// y cobros/cta-cte): pos/chofer/cliente/proveedor ya tenían esta matriz,
// stock y cobros no.
//
// A diferencia de pos-offline.js (fetch a /api/pos), stock-offline.js
// llama sb.rpc(...) — el harness carga el SDK real de supabase-js
// (vendorizado) y los mocks usan mockearRpc (rest-mock), no mockApi.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../helpers/static-server.js';
import { vendorizarDexie, vendorizarSupabase, irOffline, irOnline } from '../helpers/mock-network.js';
import { mockearRpc } from '../helpers/supabase-rest-mock.js';

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function abrirHarness(page, { onAjustar } = {}) {
  const redEstado = { offline: false };
  await vendorizarDexie(page);
  await vendorizarSupabase(page);
  const handler = (call) => (onAjustar ? onAjustar(call) : { ok: true });
  // stock-offline.js resuelve 3 tipos a 3 RPC distintas (ajustar_stock,
  // registrar_conteo_stock, transferir_stock) — se mockean las 3 con el
  // mismo handler porque cada test acá solo dispara UNA por vez, y así
  // no hay que repetir abrirHarness por tipo.
  const contador = mockearRpc(page, 'ajustar_stock', handler, redEstado);
  mockearRpc(page, 'registrar_conteo_stock', handler, redEstado);
  mockearRpc(page, 'transferir_stock', handler, redEstado);
  await page.goto(`${staticServer.baseURL}/tests/e2e/fixtures/harness-stock.html`);
  await page.waitForFunction(() => window.StockOffline);
  await page.evaluate((baseURL) => {
    // stock-offline.js lee sb de window.authCtx.sb (lo llena auth.js en
    // stock.html real) — acá armamos un cliente supabase-js real apuntado
    // al mismo origen del static server, para que sb.rpc(...) le pegue a
    // los mocks de mockearRpc (que interceptan /rest/v1/rpc/<fn>).
    window.authCtx = {
      session: { access_token: 'token-stock-fake' },
      perfil:  { empresa_id: 'empresa-test' },
      sb:      supabase.createClient(baseURL, 'fake-anon-key'),
    };
  }, staticServer.baseURL);
  await page.evaluate(() => window.StockOffline.init());
  return { contador, redEstado };
}

test.describe('stock-offline.js — offline (Etapa 6, matriz 1.2)', () => {

  test('modo avión a mitad de un ajuste de stock: se encola y sincroniza sola, sin duplicar', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onAjustar: () => { llamadas++; return { ok: true }; } });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.StockOffline.encolarAccion('ajustar_stock', {
      p_deposito_id: 1, p_producto_id: 'prod-1', p_cantidad: 5, p_motivo: 'ingreso manual',
    }));

    await expect.poll(() => page.evaluate(() => window.StockOffline.getContadorPendientes())).toBe(1);
    expect(llamadas).toBe(0);

    await irOnline(context, redEstado, page);
    await expect.poll(
      () => page.evaluate(() => window.StockOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);
    expect(llamadas).toBe(1); // el punto que más importa: UN solo ajuste, no dos
  });

  test('conflicto_stock_cambio (stock cambió mientras estaba offline) no se reintenta a ciegas', async ({ page, context }) => {
    const { redEstado } = await abrirHarness(page, {
      onAjustar: () => ({
        ok: false,
        tipo: 'conflicto_stock_cambio',
        error: 'El stock del sistema cambió',
        stock_sistema_esperado: 10,
        stock_sistema_actual: 7,
      }),
    });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.StockOffline.encolarAccion('registrar_conteo_stock', {
      p_deposito_id: 1, p_producto_id: 'prod-1', p_stock_sistema_esperado: 10, p_stock_contado: 10,
    }));
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(() => window.StockOffline.getContadorConflictos()),
      { timeout: 5000 }
    ).toBe(1);
    // no debe quedar como "pendiente" reintentando en loop
    expect(await page.evaluate(() => window.StockOffline.getContadorPendientes())).toBe(0);
  });

  test('cierre de la pestaña a mitad del sync: al reabrir, no se duplica el movimiento', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, {
      onAjustar: () => { llamadas++; return { ok: true, delayMs: 2000 }; },
    });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.StockOffline.encolarAccion('ajustar_stock', {
      p_deposito_id: 1, p_producto_id: 'prod-1', p_cantidad: 1, p_motivo: 'egreso manual',
    }));
    await expect.poll(() => page.evaluate(() => window.StockOffline.getContadorPendientes())).toBe(1);

    await irOnline(context, redEstado, page);
    await page.waitForTimeout(300); // deja que el sync arranque y quede "en vuelo"
    await page.reload();
    await page.evaluate((baseURL) => {
      window.authCtx = {
        session: { access_token: 'token-stock-fake' },
        perfil:  { empresa_id: 'empresa-test' },
        sb:      supabase.createClient(baseURL, 'fake-anon-key'),
      };
    }, staticServer.baseURL);
    await page.waitForFunction(() => window.StockOffline);
    await page.evaluate(() => window.StockOffline.init());

    await expect.poll(
      () => page.evaluate(() => window.StockOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    // Nota: mismo criterio que pos.spec.js — esto valida que el CLIENTE no
    // manda el ajuste dos veces en paralelo. La dedup server-side por
    // p_offline_local_id (migración 443) ya la cubre tests/frontend-
    // offline/stock-offline.test.js + la RPC misma en Postgres.
    expect(llamadas).toBeLessThanOrEqual(2);
  });

  test('reconexión intermitente: no dispara dos syncs en paralelo sobre el mismo outbox', async ({ page, context }) => {
    let llamadas = 0;
    const { redEstado } = await abrirHarness(page, { onAjustar: () => { llamadas++; return { ok: true }; } });

    await irOffline(context, redEstado, page);
    await page.evaluate(() => window.StockOffline.encolarAccion('ajustar_stock', {
      p_deposito_id: 1, p_producto_id: 'prod-1', p_cantidad: 2, p_motivo: 'ingreso manual',
    }));
    await expect.poll(() => page.evaluate(() => window.StockOffline.getContadorPendientes())).toBe(1);

    for (let i = 0; i < 5; i++) {
      await irOnline(context, redEstado, page);
      await irOffline(context, redEstado, page);
    }
    await irOnline(context, redEstado, page);

    await expect.poll(
      () => page.evaluate(() => window.StockOffline.getContadorPendientes()),
      { timeout: 5000 }
    ).toBe(0);

    expect(llamadas).toBe(1);
  });
});
