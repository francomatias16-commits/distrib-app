// Page object de Fase 1 (P0), novena y última página del orden (pedidos,
// pos, stock, facturacion, cobranzas, clientes, cta-cte, compras,
// productos — ver PLAN_E2E_COBERTURA_TOTAL.md).
//
// Tercer patrón de red mixto encontrado (mismo hallazgo 10.1 que
// pedidos/stock): el listado principal sale por RPC (`fn_productos_lista`,
// con paginación/orden/filtros resueltos en SQL y `total_count` en cada
// fila), la edición/borrado son PostgREST directo (`sb.from('productos')`),
// y el ALTA es una RPC distinta (`fn_crear_producto`) — a diferencia de
// pedidos/stock, acá alta y edición no comparten el mismo camino de red
// porque el alta también crea el stock inicial en los depósitos elegidos.
//
// `data-testid` NO hizo falta (10.2 sigue aplicando): `<tr data-id="${p.id}">`
// en `renderTabla()` ya trae el id del producto de forma estable, mismo
// criterio que `fila-pedido`/`fila-stock`.
//
// El botón "..." de cada fila (`abrirMenuAcciones()`) ya NO muestra un
// `confirm()` nativo sin conexión — abre directo el mismo modal
// Nuevo/Editar producto que usa el botón "+", precargado. No hay una fila
// clickeable aparte ni un modal de "detalle" de solo lectura distinto del
// de edición, a diferencia de `pedidos.html`.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class ProductosPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/productos.html`);
    await this.esperarAppLista();
  }

  // ── Filtros ─────────────────────────────────────────────────────────
  get filtroEstado() { return this.page.locator('#prod-filtro-estado'); }
  get filtroCategoria() { return this.page.locator('#prod-filtro-cat'); }
  get filtroFoto() { return this.page.locator('#prod-filtro-foto'); }
  get buscador() { return this.page.locator('#prod-tag-input'); }

  // ── Tabla principal ─────────────────────────────────────────────────
  get filas() {
    return this.page.locator('#prod-tbody tr[data-id]');
  }

  fila(productoId) {
    return this.page.locator(`#prod-tbody tr[data-id="${productoId}"]`);
  }

  /** Botón "..." de la fila — abre el modal de edición precargado. */
  async abrirEdicionPorId(productoId) {
    await this.fila(productoId).locator('.prod-menu-btn').click();
    await expect(this.modalProducto).toHaveClass(/open/);
  }

  // ── Modal: nuevo/editar producto ────────────────────────────────────
  // OJO: `.prod-add-btn` sola ya no alcanza — el tab de Combos (mismo
  // archivo productos.html) agregó su propio botón "Nuevo combo"
  // (#cb-btn-nuevo) reusando la misma clase para heredar el estilo. Ambos
  // conviven en el DOM aunque el tab de combos esté oculto, así que el
  // locator por clase sola rompe en "strict mode" (matchea los 2). Se
  // desambigua por aria-label, que es único para cada botón.
  get btnNuevoProducto() { return this.page.getByRole('button', { name: 'Nuevo producto', exact: true }); }
  get modalProducto() { return this.page.locator('#modal-producto'); }
  get modalTitulo() { return this.page.locator('#modal-prod-titulo'); }
  get inputNombre() { return this.page.locator('#fp-nombre'); }
  get inputCodigo() { return this.page.locator('#fp-codigo'); }
  get selectCategoria() { return this.page.locator('#fp-categoria_id'); }
  get selectActivo() { return this.page.locator('#fp-activo'); }
  get inputPrecio() { return this.page.locator('#fp-precio_base'); }
  get inputCosto() { return this.page.locator('#fp-costo'); }
  get inputStockMinimo() { return this.page.locator('#fp-stock_minimo'); }
  get btnGuardar() { return this.page.locator('#btn-guardar-producto'); }
  get btnEliminar() { return this.page.locator('#btn-eliminar-producto'); }
  get depositosError() { return this.page.locator('#fp-depositos-error'); }
  get checklistDepositos() { return this.page.locator('.fp-deposito-chk'); }

  async abrirModalNuevo() {
    await this.btnNuevoProducto.click();
    await expect(this.modalProducto).toHaveClass(/open/);
  }

  async completarFormulario({ nombre, codigo, categoriaId, precio, costo, stockMinimo, activo } = {}) {
    if (nombre !== undefined) await this.inputNombre.fill(nombre);
    if (codigo !== undefined) await this.inputCodigo.fill(codigo);
    if (categoriaId !== undefined) await this.selectCategoria.selectOption(categoriaId);
    if (precio !== undefined) await this.inputPrecio.fill(String(precio));
    if (costo !== undefined) await this.inputCosto.fill(String(costo));
    if (stockMinimo !== undefined) await this.inputStockMinimo.fill(String(stockMinimo));
    if (activo !== undefined) await this.selectActivo.selectOption(String(activo));
  }

  /** Tilda TODOS los depósitos del checklist (solo tiene sentido en el alta). */
  async marcarTodosLosDepositos() {
    const chks = this.checklistDepositos;
    const n = await chks.count();
    for (let i = 0; i < n; i++) await chks.nth(i).check();
  }

  /** Destilda todos los depósitos — para el caso de validación "sin depósito". */
  async desmarcarTodosLosDepositos() {
    const chks = this.checklistDepositos;
    const n = await chks.count();
    for (let i = 0; i < n; i++) await chks.nth(i).uncheck();
  }

  /**
   * guardarProducto() pide confirmación con `window.confirmar()` (overlay
   * propio) antes de mandar la request — mismo mecanismo ya documentado en
   * cta-cte.page.js/cobranzas.page.js/compras.page.js.
   */
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancel() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  async guardar() {
    await this.btnGuardar.click();
    await this.btnConfirmarOk.click();
  }

  async eliminar() {
    await this.btnEliminar.click();
    await this.btnConfirmarOk.click();
  }
}
