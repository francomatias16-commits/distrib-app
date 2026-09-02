// Fase 1 (P0), novena y última página (ver PLAN_E2E_COBERTURA_TOTAL.md —
// orden: pedidos, pos, stock, facturacion, cobranzas, clientes, cta-cte,
// compras, productos).
//
// Cubre listado + alta + edición de un producto (con sus variantes de
// resultado — éxito, validación de cliente y rechazo del servidor —,
// mismo criterio que el resto de la Fase 1). El alta y la edición van por
// caminos de red distintos (ver productos.page.js): alta = RPC
// `fn_crear_producto` (crea el producto + stock inicial en los depósitos
// elegidos), edición = PostgREST directo (`sb.from('productos').update()`).
//
// Alcance deliberado: NO cubre la subida de foto (`subirFotoProductoSiCorresponde`,
// que pega al bucket `productos-fotos` de Supabase Storage — otra capa de
// red distinta, sin helper genérico en la suite todavía) ni el borrado
// físico (`eliminarProducto()`, cubierto por el mismo mecanismo de
// PostgREST DELETE que ya ejercitan otros specs de la Fase 1 — se prioriza
// cerrar el alcance nuevo de esta página, no repetir cobertura).

import { test, expect } from '@playwright/test';
import { startStaticServer } from '../../helpers/static-server.js';
import { loguearComoAdmin } from '../../helpers/auth-helper.js';
import { mockearRpc, mockearTabla, mockearRestGenerico, mockearApiGenerico } from '../../helpers/supabase-rest-mock.js';
import { vendorizarSupabase, filtrarRuidoRed } from '../../helpers/mock-network.js';
import { ProductosPage } from '../../page-objects/admin/productos.page.js';

const PRODUCTO_ID = 'e2e-producto-000000000001';
const CATEGORIA_ID = 'e2e-categoria-000000000001';
const DEPOSITO_ID = 'e2e-deposito-000000000001';

const CATEGORIAS = [{ id: CATEGORIA_ID, nombre: 'Categoría E2E' }];
const DEPOSITOS = [{ id: DEPOSITO_ID, nombre: 'Depósito Central', es_principal: true }];

/** Shape real de una fila de `fn_productos_lista` (ver normalizarRpc en productos.js). */
function filaProducto(overrides = {}) {
  return {
    id: PRODUCTO_ID,
    codigo: 'COD-001',
    nombre: 'Producto E2E',
    categoria_nombre: 'Categoría E2E',
    categoria_id: CATEGORIA_ID,
    activo: true,
    estado: 'activo',
    updated_at: '2026-08-01T10:00:00Z',
    created_at: '2026-08-01T10:00:00Z',
    precio_base: 2850,
    costo: 1980,
    stock_disponible: 342,
    stock_minimo: 10,
    stock_objetivo: 0,
    foto_url: null,
    foto_fuente: null,
    total_count: 1,
    ...overrides,
  };
}

let staticServer;
test.beforeAll(async () => { staticServer = await startStaticServer(); });
test.afterAll(async () => { staticServer.server.close(); });

/** Setup de red compartido por los tests. */
async function armarPagina(page, { filaInicial = filaProducto() } = {}) {
  // Red de seguridad primero (ver 10.1) — mocks específicos, registrados
  // después, tienen prioridad.
  mockearRestGenerico(page);
  mockearApiGenerico(page);
  await vendorizarSupabase(page);

  await loguearComoAdmin(page);

  const listaRpc = mockearRpc(page, 'fn_productos_lista', () => [filaInicial]);
  mockearRpc(page, 'fn_productos_contadores', () => ([{ total_productos: 1, total_activos: 1, total_sin_stock: 0 }]));
  mockearTabla(page, 'categorias', { onSelect: () => CATEGORIAS });
  mockearTabla(page, 'depositos', { onSelect: () => DEPOSITOS });

  const productosPage = new ProductosPage(page, staticServer.baseURL);
  return { productosPage, listaRpc };
}

test.describe('Productos (admin) — Fase 1 P0', () => {
  test('la lista carga desde fn_productos_lista con categoría, precio y stock correctos', async ({ page }) => {
    const { productosPage } = await armarPagina(page);
    const erroresConsola = productosPage.capturarErroresConsola();

    await productosPage.goto();

    await expect(productosPage.fila(PRODUCTO_ID)).toBeVisible();
    await expect(productosPage.fila(PRODUCTO_ID)).toContainText('Producto E2E');
    await expect(productosPage.fila(PRODUCTO_ID)).toContainText('Categoría E2E');
    await expect(productosPage.fila(PRODUCTO_ID)).toContainText('Activo');
    // formatPeso: separador de miles '.', sin decimales — mismo gotcha que
    // ya documentaba clientes.spec.js con formatPeso, acá es una función
    // distinta ('$'+toLocaleString('es-AR')) pero el separador da igual.
    await expect(productosPage.fila(PRODUCTO_ID)).toContainText('$2.850');
    await expect(productosPage.fila(PRODUCTO_ID)).toContainText('342u');

    expect(filtrarRuidoRed(erroresConsola), `Errores de consola:\n${erroresConsola.join('\n')}`).toEqual([]);
  });

  test('crear producto con depósito elegido envía el RPC fn_crear_producto correcto', async ({ page }) => {
    const { productosPage } = await armarPagina(page);

    let paramsCapturados = null;
    await page.route('**/rest/v1/rpc/fn_crear_producto**', async (route) => {
      paramsCapturados = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ id: 'e2e-producto-nuevo' }),
      });
    });

    await productosPage.goto();
    await productosPage.abrirModalNuevo();

    await productosPage.completarFormulario({
      nombre: 'Producto Nuevo E2E',
      codigo: 'COD-999',
      categoriaId: CATEGORIA_ID,
      precio: 1500,
      costo: 900,
      stockMinimo: 5,
    });
    await productosPage.marcarTodosLosDepositos();

    await productosPage.guardar();

    await expect(productosPage.toast).toBeVisible();
    await expect(productosPage.toast).toContainText('Producto creado');
    // #modal-producto es un panel lateral (right:-600px → .open{right:0},
    // siempre display:flex) — nunca display:none, así que toBeVisible()
    // no detecta el cierre (mismo gotcha ya documentado en stock.spec.js).
    await expect(productosPage.modalProducto).not.toHaveClass(/open/);

    expect(paramsCapturados).toMatchObject({
      p_nombre: 'Producto Nuevo E2E',
      p_deposito_ids: [DEPOSITO_ID],
      p_codigo: 'COD-999',
      p_categoria_id: CATEGORIA_ID,
      p_precio_base: 1500,
      p_costo: 900,
      p_stock_minimo: 5,
      p_activo: true,
    });
  });

  test('sin depósito elegido no dispara ningún request — validación de cliente', async ({ page }) => {
    const { productosPage } = await armarPagina(page);

    let huboRpc = false;
    await page.route('**/rest/v1/rpc/fn_crear_producto**', async (route) => {
      huboRpc = true;
      await route.fallback();
    });

    await productosPage.goto();
    await productosPage.abrirModalNuevo();

    await productosPage.completarFormulario({ nombre: 'Producto Sin Depósito' });
    // El checklist arranca con el depósito principal tildado por defecto
    // (poblarChecklistDepositosModal) — hay que destildarlo a propósito
    // para ejercitar la validación "elegí al menos un depósito".
    await productosPage.desmarcarTodosLosDepositos();

    // A diferencia de compras.js/cta-cte.js (donde la validación de
    // cliente corta ANTES de pedir confirmación), en guardarProducto()
    // el orden real es al revés: window.confirmar() se pide primero (el
    // nombre ya pasó su propia validación temprana) y recién DESPUÉS,
    // dentro del bloque de alta, se chequea `depositoIds.length` — hay
    // que confirmar el diálogo para llegar a esa validación.
    await productosPage.btnGuardar.click();
    await productosPage.btnConfirmarOk.click();

    await expect(productosPage.toast).toContainText('Elegí al menos un depósito');
    await expect(productosPage.depositosError).toBeVisible();
    await expect(productosPage.modalProducto).toHaveClass(/open/);
    expect(huboRpc).toBe(false);
  });

  test('editar un producto existente envía el PATCH correcto a la tabla productos', async ({ page }) => {
    const { productosPage } = await armarPagina(page);

    let bodyCapturado = null;
    await page.route('**/rest/v1/productos**', async (route) => {
      const request = route.request();
      if (request.method() !== 'PATCH') return route.fallback();
      bodyCapturado = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({}),
      });
    });

    await productosPage.goto();
    await productosPage.abrirEdicionPorId(PRODUCTO_ID);

    // El modal de edición precarga los datos del producto — confirmamos
    // que el precarga real coincide con la fila mockeada antes de tocar
    // nada, mismo criterio que clientes.spec.js con la ficha del cliente.
    await expect(productosPage.inputNombre).toHaveValue('Producto E2E');
    await expect(productosPage.inputPrecio).toHaveValue('2850');

    await productosPage.completarFormulario({ precio: 3200 });
    await productosPage.guardar();

    await expect(productosPage.toast).toBeVisible();
    await expect(productosPage.toast).toContainText('Producto actualizado');
    await expect(productosPage.modalProducto).not.toHaveClass(/open/);

    expect(bodyCapturado).toMatchObject({
      nombre: 'Producto E2E',
      precio_base: 3200,
    });
  });

  test('rechazo del servidor al crear muestra el error y no pierde los datos del formulario', async ({ page }) => {
    const { productosPage } = await armarPagina(page);

    await page.route('**/rest/v1/rpc/fn_crear_producto**', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ message: 'Ya existe un producto con ese código' }),
      });
    });

    await productosPage.goto();
    await productosPage.abrirModalNuevo();

    await productosPage.completarFormulario({ nombre: 'Producto Duplicado', codigo: 'COD-001' });
    await productosPage.marcarTodosLosDepositos();
    await productosPage.guardar();

    await expect(productosPage.toast).toContainText('No se pudo guardar el producto');
    // A diferencia del camino feliz, acá el modal NO se cierra
    // (guardarProducto() cae al catch antes de cerrarModalProducto()) —
    // los datos tipeados siguen en el formulario.
    await expect(productosPage.modalProducto).toHaveClass(/open/);
    await expect(productosPage.inputNombre).toHaveValue('Producto Duplicado');
  });
});
