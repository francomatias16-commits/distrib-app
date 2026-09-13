// Cierra F4-04 del checklist de pase manual (checklist_pase_manual.md §4):
// "comparar cantidad_disponible en /admin/stock vs /cliente/catalogo
// antes/después de: venta POS, anulación de esa venta, transferencia
// entre depósitos". Es el último ítem de B1 (PLAN_CIERRE_DEFINITIVO) que
// seguía sin spec.
//
// ── Qué SÍ prueba este spec (mismo criterio que
// flujo/flujo-completo-pedido-monto.spec.js, léase esa cabecera para el
// detalle) ─────────────────────────────────────────────────────────────
// Cada uno de los 3 flujos toca dos pantallas que en producción NO
// comparten ningún estado en memoria — admin/pos.html, admin/stock.html
// y cliente/catalogo.html son 3 documentos HTML distintos, cada uno con
// su propio fetch/RPC — así que la única forma de que "vendé algo en POS"
// se refleje en "lo que ve el admin en Stock" y en "lo que ve el cliente
// en el catálogo" es que las 3 lean, tarde o temprano, la MISMA fuente de
// verdad en la base real. Este spec no tiene una base real detrás (ver
// limitación de fondo más abajo): en su lugar arma un único "almacén"
// mutable en JS (`crearAlmacen()`) y hace que los 3 mocks de red
// (`fn_stock_lista_agrupada`, `/api/pos`, `/api/pos/anular`,
// `transferir_stock`, `/api/cliente/productos`) lean/escriban sobre ESE
// mismo objeto. Eso SÍ deja detectar bugs reales de wiring frontend: si
// alguna pantalla dejara de pedir el dato fresco (ej. cachea la lista de
// stock y no la refresca tras volver de POS), el test lo vería porque
// seguiría mostrando el valor viejo aunque el almacén ya haya cambiado —
// exactamente el mismo patrón de verificación que ya usa
// facturacion-notas-credito.spec.js (F3-05) con su `estadoRed`.
//
// Lo que NO prueba (mismo límite ya documentado en flujo-completo-
// pedido-monto.spec.js): que `registrar_venta_pos`/`transferir_stock`
// hagan la aritmética correcta contra Postgres real, ni que la
// concurrencia entre dos cajas a la vez esté bien resuelta del lado
// servidor. Eso es trabajo de `npm run test:integration` contra un
// Supabase de test real (bloqueado hoy, ver Etapa 0 del plan de
// auditoría).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin, sembrarSesionCliente } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarDexie, vendorizarSupabase, mockApi } from '../../helpers/mock-network.js';
import { PosPage } from '../../page-objects/admin/pos.page.js';
import { StockPage } from '../../page-objects/admin/stock.page.js';

const PRODUCTO_ID = 'e2e-sync-producto-1';
const PRODUCTO_CODIGO = '7790000000001';
const PRODUCTO_NOMBRE = 'Yerba E2E 1kg';
const DEP_A = 'e2e-sync-dep-a';
const DEP_B = 'e2e-sync-dep-b';
const CAJA_ID = 'caja-sync-1';
const EMPRESA_ID = 'e2e-empresa-sync-1';
const CLIENTE_ID = 'e2e-cliente-sync-1';

const DEPOSITOS = [
  { id: DEP_A, nombre: 'Depósito Central', es_principal: true },
  { id: DEP_B, nombre: 'Depósito Sucursal', es_principal: false },
];

/** "Base de datos" en memoria compartida entre los 3 mocks de red. */
function crearAlmacen(inicial) {
  const cantidades = { ...inicial };
  return {
    get: (dep) => cantidades[dep] || 0,
    sumar: (dep, delta) => { cantidades[dep] = (cantidades[dep] || 0) + delta; },
    total: () => Object.values(cantidades).reduce((a, b) => a + b, 0),
    depositosConStock: () => Object.keys(cantidades),
  };
}

/** Filas de fn_stock_lista_agrupada acordes al depósito filtrado (o agregadas si no hay filtro). */
function filaStockDesdeAlmacen(almacen, depositoIdFiltro) {
  const deps = almacen.depositosConStock();
  if (depositoIdFiltro) {
    return [{
      producto_id: PRODUCTO_ID, nombre: PRODUCTO_NOMBRE, codigo: PRODUCTO_CODIGO,
      categoria_nombre: 'Almacén', unidad: 'u',
      deposito_id: depositoIdFiltro, deposito_nombre: DEPOSITOS.find((d) => d.id === depositoIdFiltro)?.nombre,
      n_depositos: 1, cantidad: almacen.get(depositoIdFiltro), cantidad_reservada: 0,
      cantidad_disponible: almacen.get(depositoIdFiltro), costo_promedio: 1500, total_count: 1,
    }];
  }
  // Sin filtro: agregado entre depósitos (mismo shape que devuelve la RPC real
  // cuando el producto tiene stock en más de uno — ver renderTabla() en stock.js).
  return [{
    producto_id: PRODUCTO_ID, nombre: PRODUCTO_NOMBRE, codigo: PRODUCTO_CODIGO,
    categoria_nombre: 'Almacén', unidad: 'u',
    deposito_id: deps.length > 1 ? null : deps[0],
    deposito_nombre: deps.length > 1 ? null : DEPOSITOS.find((d) => d.id === deps[0])?.nombre,
    n_depositos: deps.length, cantidad: almacen.total(), cantidad_reservada: 0,
    cantidad_disponible: almacen.total(), costo_promedio: 1500, total_count: 1,
  }];
}

async function armarRedComun(page, almacen) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarDexie(page);
  await vendorizarSupabase(page);

  mockearTabla(page, 'depositos', { onSelect: () => DEPOSITOS });
  mockearTabla(page, 'categorias', { onSelect: () => [] });
  mockearRpc(page, 'fn_reportes_stock_kpis', () => [{}]);
  mockearRpc(page, 'fn_stock_lista_agrupada', ({ params }) => filaStockDesdeAlmacen(almacen, params?.p_deposito_id || null));
  mockearRpc(page, 'cliente_combos_disponibles', () => []);
  mockearRpc(page, 'empresa_publica_por_id', () => ({ id: EMPRESA_ID, nombre: 'Empresa E2E' }));
}

/** Handler de `/api/cliente/productos` — stock_disponible es el TOTAL del almacén, sumado entre depósitos. */
function handlerProductosCliente(almacen) {
  return () => ({
    json: {
      productos: [{
        id: PRODUCTO_ID, nombre: PRODUCTO_NOMBRE, precio_base: 2000,
        oferta_liquidacion: null, stock_disponible: almacen.total(),
      }],
      pages: 1,
    },
  });
}

async function irACatalogoCliente(page, staticServer, almacen) {
  await sembrarSesionCliente(page);
  mockearTabla(page, 'usuarios', {
    onSelect: () => ({ nombre: 'Cliente E2E', empresa_id: EMPRESA_ID, cliente_id: CLIENTE_ID }),
  });
  mockApi(page, {
    '/api/cliente/productos': handlerProductosCliente(almacen),
    '/api/cliente/categorias': () => ({ json: [] }),
  });
  await page.goto(`${staticServer.baseURL}/frontend/cliente/catalogo.html`);
  // catalogo.html pinta el mismo producto en 2 lugares a propósito: el
  // carrusel "Destacados" (#destacadosScroll) y la grilla principal
  // (#gridProductos) — no es un duplicado accidental. Se scopea a la
  // grilla para tener un locator inequívoco bajo strict mode.
  const card = page.locator(`#gridProductos [data-producto-id="${PRODUCTO_ID}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  return card;
}

async function irAStockAdmin(page, staticServer) {
  const stockPage = new StockPage(page, staticServer.baseURL);
  await loguearComoAdmin(page);
  await stockPage.goto();
  return stockPage;
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

test.describe('Sincronización de stock — admin/pos ↔ admin/stock ↔ cliente/catalogo (F4-04)', () => {

  test('venta en POS descuenta stock: se refleja en /admin/stock y agota el producto en /cliente/catalogo', async ({ page }) => {
    // Arranca en 3 unidades para cruzar el umbral "sin stock" con la venta.
    const almacen = crearAlmacen({ [DEP_A]: 3 });
    await armarRedComun(page, almacen);

    // 1. Estado inicial en admin/stock: 3 disponibles.
    const stockPage = await irAStockAdmin(page, staticServer);
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('3');

    // 2. Estado inicial en cliente/catalogo: sin el tag "Sin stock".
    const cardCliente = await irACatalogoCliente(page, staticServer, almacen);
    await expect(cardCliente.locator('.sin-stock-tag')).toHaveCount(0);

    // 3. Vender las 3 unidades por POS.
    mockApi(page, {
      '/api/pos': () => { almacen.sumar(DEP_A, -3); return { json: { ok: true, venta_id: 'venta-sync-1', numero: '0001' } }; },
      '/api/pos/cajas': () => ({ json: [{ id: CAJA_ID, nombre: 'Caja Principal' }] }),
      '/api/pos/caja-estado': () => ({ json: { turnos: [] } }),
      '/api/pos/config-hardware': () => ({ json: {} }),
      '/api/pos/favoritos': () => ({ json: [] }),
      '/api/pos/productos': () => ({ json: [{ id: PRODUCTO_ID, nombre: PRODUCTO_NOMBRE, codigo: PRODUCTO_CODIGO, unidad: 'u', precio: 2000, stock_disponible: almacen.get(DEP_A), iva: 21 }] }),
      '/api/pos/abrir-turno': (call) => {
        const body = call.request.postDataJSON();
        return { json: { id: 'turno-sync-1', caja_id: body.caja_id, monto_inicial: body.monto_inicial } };
      },
    });
    await loguearComoAdmin(page);
    const pos = new PosPage(page, staticServer.baseURL);
    await pos.goto();
    await pos.abrirTurno({ caja: CAJA_ID, montoInicial: 0 });
    await pos.agregarProductoPorEnter(PRODUCTO_CODIGO);
    await pos.cambiarCantidad(PRODUCTO_ID, 3);
    await pos.abrirModalCobro();
    await pos.setMedioPrimeraLineaPago('efectivo');
    await pos.confirmarCobro();
    await expect(pos.modalTicketOverlay).toBeVisible();
    expect(almacen.get(DEP_A), 'la venta debe haber descontado las 3 unidades del almacén mockeado').toBe(0);

    // 4. admin/stock, sin recargar el módulo desde cero (nueva navegación,
    // simulando que el admin vuelve a la pantalla de Stock): ahora 0.
    const stockPageDespues = await irAStockAdmin(page, staticServer);
    await expect(stockPageDespues.fila(PRODUCTO_ID)).toContainText('0');

    // 5. cliente/catalogo: el producto pasa a "Sin stock".
    const cardDespues = await irACatalogoCliente(page, staticServer, almacen);
    await expect(cardDespues.locator('.sin-stock-tag')).toBeVisible();
  });

  test('anular esa venta repone el stock: desaparece "Sin stock" en /cliente/catalogo y vuelve el número en /admin/stock', async ({ page }) => {
    // Arranca ya en 0 (como quedó la venta del test anterior) para probar
    // el camino inverso de forma aislada, sin depender del test previo.
    const almacen = crearAlmacen({ [DEP_A]: 0 });
    await armarRedComun(page, almacen);

    const VENTA = { id: 'venta-sync-1', numero: '0001', total: 6000, estado: 'completada', factura_id: null, clientes: null };

    const stockAntes = await irAStockAdmin(page, staticServer);
    await expect(stockAntes.fila(PRODUCTO_ID)).toContainText('0');
    const cardAntes = await irACatalogoCliente(page, staticServer, almacen);
    await expect(cardAntes.locator('.sin-stock-tag')).toBeVisible();

    // Panel "Ventas" del admin de POS → Anular (repone stock, ver anularVenta() en pos.js).
    mockApi(page, {
      '/api/pos/anular': (call) => {
        const body = call.request.postDataJSON();
        expect(body.venta_pos_id).toBe(VENTA.id);
        expect(body.motivo).toBeTruthy();
        VENTA.estado = 'anulada';
        almacen.sumar(DEP_A, 3);
        return { json: { ok: true } };
      },
      '/api/pos/ventas': () => ({ json: [VENTA] }),
      '/api/pos/cajas': () => ({ json: [{ id: CAJA_ID, nombre: 'Caja Principal' }] }),
      '/api/pos/caja-estado': () => ({ json: { turnos: [] } }),
      '/api/pos/config-hardware': () => ({ json: {} }),
      '/api/pos/favoritos': () => ({ json: [] }),
      '/api/pos/productos': () => ({ json: [] }),
    });
    await loguearComoAdmin(page);
    const pos = new PosPage(page, staticServer.baseURL);
    await pos.goto();
    await page.evaluate(() => window.abrirModalAdmin('ventas'));
    await expect(page.locator('#modal-admin-overlay')).toBeVisible();

    const filaVenta = page.locator('.pos-venta-fila', { hasText: VENTA.numero });
    await expect(filaVenta).toBeVisible();
    await filaVenta.locator('.pos-venta-btn-anular').click();

    const dialogoMotivo = page.locator('[role="dialog"]:has(textarea[data-role="motivo"])');
    await expect(dialogoMotivo).toBeVisible();
    await dialogoMotivo.locator('textarea[data-role="motivo"]').fill('Cliente se arrepintió — E2E F4-04');
    await dialogoMotivo.locator('[data-action="ok"]').click();

    await pos.esperarToastExito('anulada');
    expect(almacen.get(DEP_A), 'anular la venta debe reponer las 3 unidades').toBe(3);

    const stockDespues = await irAStockAdmin(page, staticServer);
    await expect(stockDespues.fila(PRODUCTO_ID)).toContainText('3');
    const cardDespues = await irACatalogoCliente(page, staticServer, almacen);
    await expect(cardDespues.locator('.sin-stock-tag')).toHaveCount(0);
  });

  test('transferencia entre depósitos: /admin/stock refleja el nuevo reparto y el total en /cliente/catalogo no cambia', async ({ page }) => {
    const almacen = crearAlmacen({ [DEP_A]: 20, [DEP_B]: 5 });
    await armarRedComun(page, almacen);
    mockearRpc(page, 'transferir_stock', ({ params }) => {
      expect(params).toMatchObject({
        p_producto_id: PRODUCTO_ID, p_deposito_origen: DEP_A, p_deposito_destino: DEP_B, p_cantidad: 8,
      });
      almacen.sumar(DEP_A, -8);
      almacen.sumar(DEP_B, 8);
      return { ok: true, stock_origen_nuevo: almacen.get(DEP_A), stock_destino_nuevo: almacen.get(DEP_B) };
    });

    // 1. Total agregado inicial en cliente/catalogo: 25 (20 + 5).
    const cardAntes = await irACatalogoCliente(page, staticServer, almacen);
    await expect(cardAntes.locator('.sin-stock-tag')).toHaveCount(0);
    expect(almacen.total()).toBe(25);

    // 2. En admin/stock, filtrar por Depósito Central para ver el desglose
    // real (sin filtro, la fila viene agregada — 2 depósitos, ver
    // filaStockDesdeAlmacen) y transferir 8 unidades a Depósito Sucursal.
    const stockPage = await irAStockAdmin(page, staticServer);
    await stockPage.filtrarPorDeposito(DEP_A);
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('20');

    await stockPage.abrirAjustePorId(PRODUCTO_ID);
    await stockPage.completarTransferencia({ depositoDestinoId: DEP_B, cantidad: 8 });
    await stockPage.guardar();
    await expect(stockPage.toast).toBeVisible();
    await expect(stockPage.modalAjuste).not.toHaveClass(/open/);

    // 3. admin/stock: Depósito Central bajó a 12, Depósito Sucursal subió a 13.
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('12');
    await stockPage.filtrarPorDeposito(DEP_B);
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('13');

    // 4. cliente/catalogo: el total no cambió (la transferencia es interna,
    // no un ingreso/egreso real) — sigue disponible, 25 en total.
    expect(almacen.total()).toBe(25);
    const cardDespues = await irACatalogoCliente(page, staticServer, almacen);
    await expect(cardDespues.locator('.sin-stock-tag')).toHaveCount(0);
  });
});
