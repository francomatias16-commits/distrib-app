// Fase 1 (P0), octava página (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 12
// — orden: pedidos, pos, stock, facturacion, cobranzas, clientes, cta-cte,
// compras, productos).
//
// Cubre listado + alta de una orden de compra (con sus tres variantes de
// resultado — éxito, validación de cliente y rechazo del servidor —, mismo
// criterio que el resto de la Fase 1). Alcance deliberado, igual que el
// piloto de `pedidos`/`clientes`: NO cubre "Recepcionar" (que además de
// `/api/compras?accion=recepcionar` dispara `ajustar_stock` por cada ítem
// recibido — una RPC por línea, más parecido en complejidad al flujo de
// `producir_con_insumos` de stock.spec.js que a un submit simple) ni
// "Aprobar" (OC auto-generada desde Automatización, `/api/stock-auto`).
// Ambos quedan para una vuelta futura si hace falta profundizar esta
// página más allá del alta.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed, mockApi } from '../../helpers/mock-network.js';
import { ComprasPage } from '../../page-objects/admin/compras.page.js';

const ORDEN_ID = 'e2e-orden-000000000001';
const PROVEEDOR_ID = 'e2e-proveedor-000000000001';
const PRODUCTO_ID = 'e2e-producto-000000000001';

const PROVEEDORES = [
  { id: PROVEEDOR_ID, razon_social: 'Proveedor E2E SRL' },
];

const PRODUCTOS = [
  { id: PRODUCTO_ID, nombre: 'Producto E2E', codigo: 'COD-001', costo: 100, unidad: 'u' },
];

function ordenCompra(overrides = {}) {
  return {
    id: ORDEN_ID,
    numero: 'OC-0001',
    proveedores: { razon_social: 'Proveedor E2E SRL' },
    proveedor_id: PROVEEDOR_ID,
    fecha_pedido: '2026-08-01T00:00:00Z',
    fecha_esperada: null,
    total: 1000,
    estado: 'borrador',
    ...overrides,
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

/** Setup de red compartido por los tests. */
async function armarPagina(page, { ordenInicial = ordenCompra() } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  mockearTabla(page, 'productos', { onSelect: () => PRODUCTOS });

  const contadoresApi = mockApi(page, {
    '/api/proveedores': ({ request }) => {
      if (request.method() !== 'GET') return { json: {} };
      return { json: { proveedores: PROVEEDORES } };
    },
    '/api/compras': ({ request }) => {
      const url = new URL(request.url());
      if (request.method() === 'GET') {
        if (url.searchParams.get('id')) return { json: ordenInicial };
        return { json: { ordenes: [ordenInicial], total: 1 } };
      }
      // El POST de alta lo pisa cada test que lo necesita con su propio
      // mockApi() registrado DESPUÉS de armarPagina() (Playwright prioriza
      // el último route() que matchea — mismo criterio que mockearRpc).
      return { json: { ok: true } };
    },
  });

  const comprasPage = new ComprasPage(page, staticServer.baseURL);
  return { comprasPage, contadoresApi };
}

test.describe('Compras / Órdenes de compra (admin) — Fase 1 P0', () => {
  test('la lista carga desde /api/compras con los datos de la orden', async ({ page }) => {
    const { comprasPage } = await armarPagina(page);
    const erroresConsola = comprasPage.capturarErroresConsola();

    await comprasPage.goto();

    await expect(comprasPage.fila(ORDEN_ID)).toBeVisible();
    await expect(comprasPage.fila(ORDEN_ID)).toContainText('OC-0001');
    await expect(comprasPage.fila(ORDEN_ID)).toContainText('Proveedor E2E SRL');
    await expect(comprasPage.fila(ORDEN_ID)).toContainText('Borrador');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('crear orden con proveedor y producto válidos envía el POST correcto', async ({ page }) => {
    const { comprasPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/api/compras**', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      bodyCapturado = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: true, id: 'e2e-orden-nueva' }),
      });
    });

    await comprasPage.goto();
    await comprasPage.abrirModalNuevo();

    await comprasPage.selectProveedor.selectOption(PROVEEDOR_ID);
    await comprasPage.agregarFilaItem();
    await comprasPage.completarItem(0, { productoId: PRODUCTO_ID, cantidad: 5, precioCosto: 200 });

    // subtotal = 5 * 200 = 1000, +21% IVA = 1210 — confirma que
    // actualizarTotalesOC() recalculó con el precio tipeado, no con el
    // costo por defecto que trajo seleccionarProductoOC() (100).
    await expect(comprasPage.ocTotal).toContainText('1.210,00');

    await comprasPage.guardarOrden();

    await expect(comprasPage.toast).toBeVisible();
    await expect(comprasPage.toast).toContainText('Orden de compra creada');
    await expect(comprasPage.modalOC).not.toBeVisible();

    expect(bodyCapturado).toMatchObject({
      proveedor_id: PROVEEDOR_ID,
      items: [{ producto_id: PRODUCTO_ID, cantidad: 5, precio_costo: 200 }],
    });
  });

  test('sin proveedor no dispara ningún request — validación de cliente', async ({ page }) => {
    const { comprasPage } = await armarPagina(page);

    let huboPost = false;
    await page.route('**/api/compras**', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') huboPost = true;
      await route.fallback();
    });

    await comprasPage.goto();
    await comprasPage.abrirModalNuevo();

    // Sin proveedor seleccionado: guardarOC() corta antes de pedir
    // confirmación ("Seleccioná un proveedor") — el modal se queda abierto.
    await comprasPage.agregarFilaItem();
    await comprasPage.completarItem(0, { productoId: PRODUCTO_ID, cantidad: 1, precioCosto: 100 });
    await comprasPage.btnGuardarOC.click();

    await expect(comprasPage.toast).toContainText('Seleccioná un proveedor');
    await expect(comprasPage.modalOC).toBeVisible();
    expect(huboPost).toBe(false);
  });

  test('rechazo del servidor muestra el error y no pierde los datos del formulario', async ({ page }) => {
    const { comprasPage } = await armarPagina(page);

    await page.route('**/api/compras**', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 400,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: 'El proveedor no tiene productos habilitados para este rubro' }),
      });
    });

    await comprasPage.goto();
    await comprasPage.abrirModalNuevo();

    await comprasPage.selectProveedor.selectOption(PROVEEDOR_ID);
    await comprasPage.agregarFilaItem();
    await comprasPage.completarItem(0, { productoId: PRODUCTO_ID, cantidad: 3, precioCosto: 150 });
    await comprasPage.guardarOrden();

    await expect(comprasPage.toast).toContainText('El proveedor no tiene productos habilitados para este rubro');
    // A diferencia del camino feliz, acá el modal NO se cierra (guardarOC()
    // hace `return` apenas ve `!res.ok`, antes de cerrarModalOC()) — los
    // datos tipeados siguen en el formulario.
    await expect(comprasPage.modalOC).toBeVisible();
    await expect(comprasPage.selectProveedor).toHaveValue(PROVEEDOR_ID);
  });
});
