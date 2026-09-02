// Fase 1 (P0), cuarta página (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 12 —
// orden: pedidos, pos, stock, facturacion, cobranzas, clientes, cta-cte,
// compras, productos).
//
// A diferencia de las 3 anteriores, acá el flujo de escritura (reintentar
// emisión / anular comprobante) NO pasa por el SDK de Supabase — pega con
// `fetch()` a mano a `/api/facturas/reintentar` y `/api/facturas/anular`
// con `Authorization: Bearer <token>` armado en el propio módulo (ver nota
// en facturacion.page.js). Por eso acá se usa `mockApi` (helper de
// mock-network.js, igual que pos.spec.js) para esas dos rutas, combinado
// con `mockearRpc`/`mockearRestGenerico` para el listado — misma mezcla de
// las tres capas de red que ya se vio en stock.spec.js, pero repartida
// distinto: escritura por `/api/*`, lectura por RPC.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { FacturacionPage } from '../../page-objects/admin/facturacion.page.js';

const FACTURA_ERROR_ID   = 'e2e-factura-000000000001';
const FACTURA_EMITIDA_ID = 'e2e-factura-000000000002';

const CONTADORES = {
  cant_pendientes: 0,
  cant_error_afip: 1,
  cant_emitidas_mes: 1,
  monto_emitidas_mes: 25000,
};

function filaFactura(overrides = {}) {
  return {
    id: FACTURA_ERROR_ID,
    cliente_id: 'e2e-cliente-1',
    cliente_razon_social: 'Cliente E2E SRL',
    cliente_telefono: null,
    cliente_email: null,
    tipo: 'B',
    numero: null,
    pedido_id: 'e2e-pedido-000000000001',
    cae: null,
    cae_vto: null,
    vencimiento: null,
    fecha_emision: null,
    total: 15000,
    neto: 12396,
    iva: 2604,
    total_cobrado: 0,
    estado: 'error_afip',
    notas_error: 'CUIT del receptor inválido para AFIP',
    total_count: 1,
    ...overrides,
  };
}

const FACTURA_EMITIDA = filaFactura({
  id: FACTURA_EMITIDA_ID,
  estado: 'emitida',
  numero: '1234',
  cae: '75312345678901',
  cae_vto: '2026-08-20',
  fecha_emision: '2026-08-01T10:00:00Z',
  total_cobrado: 15000,
  notas_error: null,
  total_count: 1,
});

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

async function armarPagina(page, { filas = [filaFactura()] } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  mockearRpc(page, 'fn_facturas_contadores', () => CONTADORES); // .single() → objeto plano, no array
  const obtenerLlamadasLista = mockearRpc(page, 'fn_facturas_lista', () => filas);

  const facturacionPage = new FacturacionPage(page, staticServer.baseURL);
  return { facturacionPage, obtenerLlamadasLista };
}

test.describe('Facturación (admin) — Fase 1 P0', () => {
  test('la lista carga desde fn_facturas_lista y los KPIs desde fn_facturas_contadores', async ({ page }) => {
    const { facturacionPage } = await armarPagina(page, { filas: [filaFactura()] });
    const erroresConsola = facturacionPage.capturarErroresConsola();

    await facturacionPage.goto();

    await expect(facturacionPage.fila(FACTURA_ERROR_ID)).toBeVisible();
    await expect(facturacionPage.fila(FACTURA_ERROR_ID)).toContainText('Cliente E2E SRL');
    await expect(facturacionPage.kpiError).toHaveText('1');
    await expect(facturacionPage.bannerError).toBeVisible();

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('reintentar emisión desde la fila llama a /api/facturas/reintentar y refresca la lista', async ({ page }) => {
    const { facturacionPage } = await armarPagina(page, { filas: [filaFactura()] });

    const contadores = mockApi(page, {
      '/api/facturas/reintentar': ({ request }) => {
        expect(request.postDataJSON()).toEqual({ factura_id: FACTURA_ERROR_ID });
        expect(request.headers()['authorization']).toBe('Bearer e2e-fake-access-token');
        return { status: 200, json: { ok: true } };
      },
    });

    await facturacionPage.goto();
    await facturacionPage.reintentarFila(FACTURA_ERROR_ID);

    await expect(facturacionPage.toast).toContainText('Factura emitida correctamente');
    expect(contadores['/api/facturas/reintentar']).toBe(1);
  });

  test('anular sin motivo no dispara request — validación de cliente', async ({ page }) => {
    const { facturacionPage } = await armarPagina(page, { filas: [FACTURA_EMITIDA] });
    const contadores = mockApi(page, {
      '/api/facturas/anular': () => ({ status: 200, json: { ok: true } }),
    });

    await facturacionPage.goto();
    await facturacionPage.abrirDetallePorId(FACTURA_EMITIDA_ID);
    await facturacionPage.iniciarAnulacion();

    // Sin escribir nada en #motivo-anulacion — anular() corta antes de pegarle a la red.
    await facturacionPage.btnConfirmarAnular.click();

    await expect(facturacionPage.toast).toContainText('Indicá el motivo de la anulación');
    await expect(facturacionPage.modalDetalle).toHaveClass(/open/);
    expect(contadores['/api/facturas/anular']).toBe(0);
  });

  test('anular con motivo llama a /api/facturas/anular con el payload correcto y cierra el modal', async ({ page }) => {
    const { facturacionPage } = await armarPagina(page, { filas: [FACTURA_EMITIDA] });

    const contadores = mockApi(page, {
      '/api/facturas/anular': ({ request }) => {
        expect(request.postDataJSON()).toEqual({
          factura_id: FACTURA_EMITIDA_ID,
          motivo: 'Devolución total del pedido',
        });
        return { status: 200, json: { ok: true } };
      },
    });

    await facturacionPage.goto();
    await facturacionPage.abrirDetallePorId(FACTURA_EMITIDA_ID);
    await facturacionPage.iniciarAnulacion();
    await facturacionPage.confirmarAnulacion('Devolución total del pedido');

    await expect(facturacionPage.toast).toContainText('Comprobante anulado y nota de crédito generada');
    await expect(facturacionPage.modalDetalle).not.toHaveClass(/open/);
    expect(contadores['/api/facturas/anular']).toBe(1);
  });
});
