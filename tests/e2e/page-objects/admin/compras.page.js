// Page object de Fase 1 (P0), octava página del orden (pedidos, pos, stock,
// facturacion, cobranzas, clientes, cta-cte, compras, productos — ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 12).
//
// A diferencia de cta-cte.js (RPC + PostgREST + fetch a mano, todo
// mezclado), compras.js concentra casi todo su CRUD en `/api/compras`
// (fetch a mano, con `Authorization: Bearer <token>` propio, mismo patrón
// que facturacion.js) — el único punto que sale por otro lado es el combo
// de productos del formulario (`sb.from('productos')`, PostgREST directo)
// y la recepción de mercadería, que pega a `ajustar_stock` (RPC) — esta
// última queda fuera del alcance deliberado de este spec (ver más abajo).
//
// `data-testid` agregado (10.2 sigue aplicando): `<tr>` en `renderTabla()`
// no traía ningún selector estable con el id de la orden — se agregó
// `data-testid="oc-fila" data-id="${o.id}"`, mismo criterio que
// `factura-fila`/`cc-fila` en las páginas anteriores.
//
// Los modales de esta página (`#modal-oc`, `#modal-detalle`) alternan
// `style.display = 'flex' | 'none'` a mano, no una clase `open`/`hidden`
// como en stock.html/cta-cte.html — por eso el page object usa
// `toBeVisible()`/`not.toBeVisible()` en vez de `toHaveClass()`, que
// funciona igual sin importar el mecanismo real detrás.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class ComprasPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/compras.html`);
    await this.esperarAppLista();
  }

  // ── Filtros ─────────────────────────────────────────────────────────
  get filtroProveedor() { return this.page.locator('#filtro-proveedor'); }
  get filtroEstado() { return this.page.locator('#filtro-estado'); }

  // ── Tabla principal ─────────────────────────────────────────────────
  get filas() {
    return this.page.locator('[data-testid="oc-fila"]');
  }

  fila(ordenId) {
    return this.page.locator(`[data-testid="oc-fila"][data-id="${ordenId}"]`);
  }

  // ── Modal: nueva orden de compra ────────────────────────────────────
  get btnNuevaOrden() { return this.page.getByRole('button', { name: 'Nueva orden', exact: true }); }
  get modalOC() { return this.page.locator('#modal-oc'); }
  get selectProveedor() { return this.page.locator('#oc-proveedor'); }
  get inputFechaEsperada() { return this.page.locator('#oc-fecha-esperada'); }
  get inputNotas() { return this.page.locator('#oc-notas'); }
  get btnGuardarOC() { return this.page.locator('#btn-guardar-oc'); }
  get ocTotal() { return this.page.locator('#oc-total'); }

  async abrirModalNuevo() {
    await this.btnNuevaOrden.click();
    await expect(this.modalOC).toBeVisible();
  }

  /** Agrega UN ítem nuevo (fila vacía) al formulario — botón "+ Agregar producto". */
  async agregarFilaItem() {
    await this.page.getByRole('button', { name: /Agregar producto/i }).click();
  }

  filaItem(idx) {
    return this.page.locator('#tbody-items-oc tr').nth(idx);
  }

  /**
   * Completa la fila `idx` ya agregada con `agregarFilaItem()`.
   *
   * El selector de producto era antes un `<select>` nativo con TODO el
   * catálogo (impracticable para buscar entre cientos de productos) —
   * ahora es un combo con filtro en vivo (`prod-combo-input` +
   * `prod-combo-lista`). Al enfocar vacío, el combo muestra igual un
   * primer lote de productos sin necesidad de tipear nada, así que para
   * el test alcanza con enfocar el input y clickear la opción por su
   * `data-testid="prod-opt-<id>"` — no hace falta reproducir el tipeo.
   *
   * Los inputs de cantidad/costo actualizan `itemsOC` (y recalculan el
   * total) por `onchange` — evento nativo que el browser dispara recién
   * al perder el foco, no al tipear. `.fill()` no fuerza ese blur, así
   * que sin el `.blur()` explícito de acá el ÚLTIMO campo tocado queda
   * sin confirmar hasta que algo le saca el foco por su cuenta (ej.
   * clickear "Guardar") — un usuario real tabulando entre campos no lo
   * nota, pero una aserción sobre `#oc-total` justo después de
   * `completarItem()` sí lee el valor viejo. Mismo patrón esperable en
   * cualquier fila con `onchange` en vez de `oninput` (ver también
   * stock.js/pedidos.js).
   */
  async completarItem(idx, { productoId, cantidad, precioCosto } = {}) {
    const fila = this.filaItem(idx);
    if (productoId !== undefined) {
      await fila.locator('.prod-combo-input').click();
      await this.page.locator(`[data-testid="prod-opt-${productoId}"]`).click();
    }
    if (cantidad !== undefined) {
      const input = fila.locator('input[type="number"]').nth(0);
      await input.fill(String(cantidad));
      await input.blur();
    }
    if (precioCosto !== undefined) {
      const input = fila.locator('input[type="number"]').nth(1);
      await input.fill(String(precioCosto));
      await input.blur();
    }
  }

  /**
   * guardarOC() pide confirmación con `window.confirmar()` (overlay propio)
   * antes de mandar el POST — mismo mecanismo ya documentado en
   * cta-cte.page.js/cobranzas.page.js.
   */
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }

  async guardarOrden() {
    await this.btnGuardarOC.click();
    await this.btnConfirmarOk.click();
  }
}
