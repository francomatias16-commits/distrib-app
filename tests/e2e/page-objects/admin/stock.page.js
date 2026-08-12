// Page object de Fase 1 (P0) para stock.html — tercera página de la fase,
// después de pedidos.page.js y pos.page.js (ver PLAN_E2E_COBERTURA_TOTAL.md,
// sección 12). A diferencia de pos.js (solo /api/*) y a favor de pedidos.js
// (mezcla), stock.js pega los tres tipos de red del hallazgo 10.1: RPC
// (fn_stock_lista_agrupada, fn_reportes_stock_kpis, ajustar_stock,
// registrar_conteo_stock, transferir_stock, producir_con_insumos),
// PostgREST directo (depositos, categorias, movimientos_stock) y /api/*
// (solo /api/admin/stock/bajo, exclusivo del pill "Bajo su mínimo" — no
// hace falta mockearlo para el flujo cubierto acá).
//
// data-testid: no hizo falta agregar ninguno (10.2 sigue aplicando) — cada
// fila ya trae `class="fila-stock" data-prod-id="{id}" data-dep-id="{id}"`
// y el botón de ajuste trae los `data-*` con todo lo que abrirModal()
// necesita (`data-prod-id`, `data-dep-id`, `data-disp`, `data-total`,
// `data-reservado`, `data-nombre`, `data-unidad`, `data-costo`).

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class StockPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/stock.html`);
    await this.esperarAppLista();
  }

  // ── Tabla principal ──────────────────────────────────────────────────
  get filas() {
    return this.page.locator('tr.fila-stock');
  }

  fila(prodId) {
    return this.page.locator(`tr.fila-stock[data-prod-id="${prodId}"]`);
  }

  get inputBusqueda() { return this.page.locator('#input-busqueda'); }
  get filtroDeposito() { return this.page.locator('#filtro-deposito'); }
  get filtroCategoria() { return this.page.locator('#filtro-categoria'); }

  async buscar(texto) {
    // onBusqueda() en stock.js debounce a 350ms antes de recargar.
    await this.inputBusqueda.fill(texto);
    await this.page.waitForTimeout(400);
  }

  // ── Modal de ajuste ──────────────────────────────────────────────────
  get modalAjuste() { return this.page.locator('#modal-ajuste'); }
  get modalTitulo() { return this.page.locator('#modal-titulo'); }
  get modalSubtitulo() { return this.page.locator('#modal-subtitulo'); }
  get stockActualBox() { return this.page.locator('#stock-actual-box'); }
  get inputCantidad() { return this.page.locator('#input-cantidad'); }
  get selectMotivo() { return this.page.locator('#select-motivo'); }
  get inputNotas() { return this.page.locator('#input-notas'); }
  get previewResultado() { return this.page.locator('#preview-resultado'); }
  get btnGuardar() { return this.page.locator('#btn-guardar'); }

  tipoBtn(tipo) {
    return this.page.locator(`.tipo-btn[data-tipo="${tipo}"]`);
  }

  /** Abre el modal clickeando el botón real "Ajustar stock" de la fila (no page.evaluate). */
  async abrirAjustePorId(prodId) {
    await this.fila(prodId).locator('.btn-ajustar').click();
    await expect(this.modalAjuste).toHaveClass(/open/);
  }

  async elegirTipo(tipo) {
    await this.tipoBtn(tipo).click();
  }

  /**
   * guardarAjuste() pide confirmación con `window.confirmar()` (overlay
   * propio, ver ui-utils.js — mismo mecanismo que `vaciarCarrito()` en
   * pos.page.js), no el `confirm()` nativo del navegador.
   */
  async guardar() {
    await this.btnGuardar.click();
    await this.page.locator('[role="dialog"] [data-action="ok"]').click();
  }
}
