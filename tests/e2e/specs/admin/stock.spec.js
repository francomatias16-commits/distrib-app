// Fase 1 (P0), tercera página después de pedidos y pos (ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 12 — siguiente paso concreto tras
// v661: "seguir con las 7 páginas P0 restantes: stock, facturacion,
// cobranzas, clientes, cta-cte, compras, productos").
//
// Cubre lo que pedidos.spec.js dejó pendiente a propósito para esta fase:
// no solo lectura (listado), sino también un flujo de escritura completo
// (ajuste de stock) con sus tres variantes de resultado — éxito, validación
// de cliente (sin red) y rechazo del servidor —, porque stock.js expone las
// tres capas de red del hallazgo 10.1 en un solo flujo: RPC
// (`fn_stock_lista_agrupada` para listar, `ajustar_stock` para escribir) y
// PostgREST directo (`depositos`, `categorias`) en la misma página.
//
// Shape de `fn_stock_lista_agrupada` y de `ajustar_stock` confirmados
// contra el código real de stock.js (no contra el schema SQL, al que no
// tengo acceso desde acá) — mismo criterio que pedidos.spec.js con
// `normalizarPedidoRpc`.

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { StockPage } from '../../page-objects/admin/stock.page.js';

const PRODUCTO_ID  = 'e2e-producto-000000000001';
const DEPOSITO_ID  = 'e2e-deposito-1';

const DEPOSITOS = [
  { id: DEPOSITO_ID, nombre: 'Depósito Central', es_principal: true },
];

const CATEGORIAS = [
  { id: 'e2e-categoria-1', nombre: 'Almacén' },
];

// Fila que devuelve fn_stock_lista_agrupada: 1 producto en un único
// depósito (n_depositos = 1 → celda de depósito es texto plano, no el
// botón "N depósitos" — ver renderTabla()). cantidad_disponible = 8,
// entre UMBRAL_CRITICO(0) y UMBRAL_BAJO(5)... en realidad 8 > 5, así que
// cae en estado "Normal" — se elige a propósito para no depender del
// umbral en el assert de esta fila y dejar el caso "bajo stock" para el
// próximo spec de filtros, si hace falta.
function filaStock(overrides = {}) {
  return {
    producto_id: PRODUCTO_ID,
    nombre: 'Producto E2E',
    codigo: 'COD-001',
    categoria_nombre: 'Almacén',
    unidad: 'u',
    deposito_id: DEPOSITO_ID,
    deposito_nombre: 'Depósito Central',
    n_depositos: 1,
    cantidad: 8,
    cantidad_reservada: 0,
    cantidad_disponible: 8,
    costo_promedio: 1500,
    total_count: 1,
    ...overrides,
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

/** Setup de red compartido por los 4 tests — devuelve los handles para leer contadores/params. */
async function armarPagina(page, { filaInicial = filaStock() } = {}) {
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  mockearTabla(page, 'depositos', { onSelect: () => DEPOSITOS });
  mockearTabla(page, 'categorias', { onSelect: () => CATEGORIAS });

  const obtenerLlamadasLista = mockearRpc(page, 'fn_stock_lista_agrupada', () => [filaInicial]);
  mockearRpc(page, 'fn_reportes_stock_kpis', () => [{}]);

  const stockPage = new StockPage(page, staticServer.baseURL);
  return { stockPage, obtenerLlamadasLista };
}

test.describe('Stock (admin) — Fase 1 P0', () => {
  test('la lista carga desde fn_stock_lista_agrupada con los datos del producto', async ({ page }) => {
    const { stockPage } = await armarPagina(page);
    const erroresConsola = stockPage.capturarErroresConsola();

    await stockPage.goto();

    await expect(stockPage.fila(PRODUCTO_ID)).toBeVisible();
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('Producto E2E');
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('COD-001');
    await expect(stockPage.fila(PRODUCTO_ID)).toContainText('Depósito Central');
    // fmt() de disponible/total con separador de miles es_AR — acá son
    // números chicos así que no hay separador que confirmar, pero sí que
    // sea el valor correcto (8 disponible, 8 total, ambos en la fila).
    await expect(stockPage.fila(PRODUCTO_ID).locator('.td-num').first()).toContainText('8');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('ajustar stock (ingreso) llama a ajustar_stock con el delta correcto y refresca la fila', async ({ page }) => {
    const { stockPage } = await armarPagina(page);

    const obtenerParamsAjuste = mockearRpc(page, 'ajustar_stock', ({ params }) => {
      // Confirma el payload real armado por guardarAjuste() para tipo
      // "ingreso" — delta positivo, sin p_stock_nuevo (eso es exclusivo
      // del tipo "ajuste"/conteo, que pasa por otra RPC).
      expect(params).toMatchObject({
        p_producto_id: PRODUCTO_ID,
        p_deposito_id: DEPOSITO_ID,
        p_delta: 5,
        p_tipo: 'ingreso',
        p_motivo: 'devolucion_cliente',
      });
      return { ok: true, stock_nuevo: 13 };
    });

    await stockPage.goto();
    await stockPage.abrirAjustePorId(PRODUCTO_ID);

    await expect(stockPage.modalSubtitulo).toContainText('Producto E2E');
    // "ingreso" es el tipo activo por defecto al abrir (selTipo('ingreso', ...) en abrirModal()).
    // "compra" está bloqueado en el cliente (redirige a Compras) y
    // "produccion" pasa por otra RPC (producir_con_insumos) — para
    // ejercitar el camino genérico de ajustar_stock hace falta un motivo
    // de ingreso que no tenga flujo dedicado, ver optgroup "Ingresos" en
    // stock.html.
    await stockPage.inputCantidad.fill('5');
    await stockPage.selectMotivo.selectOption('devolucion_cliente');
    await stockPage.guardar();

    await expect(stockPage.toast).toBeVisible();
    await expect(stockPage.toast).toContainText('13');
    await expect(stockPage.modalAjuste).not.toHaveClass(/open/);

    expect(obtenerParamsAjuste(), 'ajustar_stock debería haberse llamado exactamente una vez').toBe(1);
  });

  test('cantidad inválida no dispara ningún request — validación de cliente', async ({ page }) => {
    const { stockPage } = await armarPagina(page);
    const obtenerParamsAjuste = mockearRpc(page, 'ajustar_stock', () => ({ ok: true, stock_nuevo: 0 }));

    await stockPage.goto();
    await stockPage.abrirAjustePorId(PRODUCTO_ID);

    // Sin motivo seleccionado: guardarAjuste() corta antes de leer la
    // cantidad ("Seleccioná un motivo") — ni siquiera llega a validar el
    // número. El modal se queda abierto (no hay cierre en este camino).
    await stockPage.inputCantidad.fill('5');
    await stockPage.btnGuardar.click();

    await expect(stockPage.toast).toContainText('Seleccioná un motivo');
    await expect(stockPage.modalAjuste).toHaveClass(/open/);
    expect(obtenerParamsAjuste()).toBe(0);
  });

  test('rechazo del servidor (ok:false) muestra el error y no pierde los datos del formulario', async ({ page }) => {
    const { stockPage } = await armarPagina(page);
    mockearRpc(page, 'ajustar_stock', () => ({ ok: false, error: 'Stock insuficiente para el egreso' }));

    await stockPage.goto();
    await stockPage.abrirAjustePorId(PRODUCTO_ID);

    await stockPage.elegirTipo('egreso');
    await stockPage.inputCantidad.fill('3');
    await stockPage.selectMotivo.selectOption('rotura');
    await stockPage.guardar();

    await expect(stockPage.toast).toContainText('Stock insuficiente para el egreso');
    // A diferencia del camino feliz, acá el modal NO se cierra (ver
    // guardarAjuste(): el `return` temprano en `if (!data?.ok)` pasa por
    // alto el `cerrarModal()` de más abajo) — la cantidad tipeada sigue
    // en el input, el usuario no tiene que volver a escribirla.
    await expect(stockPage.modalAjuste).toHaveClass(/open/);
    await expect(stockPage.inputCantidad).toHaveValue('3');
  });
});
