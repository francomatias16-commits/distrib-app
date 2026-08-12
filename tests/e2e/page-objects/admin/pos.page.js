// Page object de Fase 1 (P0) para pos.html — segunda página de la fase,
// después de pedidos.page.js (ver plan, sección 11.4). A diferencia de
// pedidos.js, pos.js NO pega a PostgREST directo: todo su CRUD pasa por
// `/api/pos/*` (ver pos.js::apiGet/apiPost) más `/api/clientes` para el
// buscador de cliente — un solo mock helper (`mockApi`) alcanza acá, no
// hace falta `supabase-rest-mock.js`.
//
// data-testid agregado puntualmente (ver 10.2 del plan): solo la fila del
// carrito (`pos-item-fila`) no tenía ningún selector estable con el
// producto_id — el resto de la página (turno, búsqueda de producto,
// pagos, ticket) ya usa `id`/`data-id` semánticos existentes.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class PosPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/pos.html`);
    await this.esperarAppLista();
  }

  // ── Pantalla de turno ────────────────────────────────────────────────
  get selectCaja() { return this.page.locator('#pos-select-caja'); }
  get inputMontoInicial() { return this.page.locator('#pos-monto-inicial'); }
  get btnAbrirTurno() { return this.page.locator('#btn-abrir-turno'); }
  get turnoError() { return this.page.locator('#pos-turno-error'); }
  get pantallaTurno() { return this.page.locator('#pos-pantalla-turno'); }
  get pantallaVenta() { return this.page.locator('#pos-pantalla-venta'); }

  async abrirTurno({ caja, montoInicial } = {}) {
    if (caja !== undefined) await this.selectCaja.selectOption(caja);
    if (montoInicial !== undefined) await this.inputMontoInicial.fill(String(montoInicial));
    await this.btnAbrirTurno.click();
  }

  // ── Búsqueda y carrito ───────────────────────────────────────────────
  get inputProducto() { return this.page.locator('#pos-input-producto'); }
  get resultadosProducto() { return this.page.locator('#pos-resultados'); }

  resultadoProducto(id) {
    return this.page.locator(`.pos-producto-card[data-id="${id}"]`);
  }

  async buscarProducto(texto) {
    await this.inputProducto.fill(texto);
  }

  async agregarProductoPorEnter(texto) {
    await this.inputProducto.fill(texto);
    await this.inputProducto.press('Enter');
  }

  filaCarrito(productoId) {
    return this.page.locator(`[data-testid="pos-carrito-fila"][data-id="${productoId}"]`);
  }

  get filasCarrito() { return this.page.locator('[data-testid="pos-carrito-fila"]'); }
  get btnVaciarCarrito() { return this.page.locator('#btn-vaciar-carrito'); }
  get btnCobrar() { return this.page.locator('#btn-cobrar'); }
  get totalCarrito() { return this.page.locator('#pos-tot-total'); }

  async quitarDelCarrito(productoId) {
    await this.filaCarrito(productoId).locator('.pos-item-quitar').click();
  }

  async cambiarCantidad(productoId, cantidad) {
    await this.filaCarrito(productoId).locator('.pos-item-cant').fill(String(cantidad));
    await this.filaCarrito(productoId).locator('.pos-item-cant').blur();
  }

  async vaciarCarrito() {
    // vaciarCarrito() pide confirmación con `window.confirmar()`, un modal
    // propio (ver ui-utils.js) — NO es el diálogo nativo del navegador,
    // así que no hay que interceptar `page.on('dialog')`. Es un overlay
    // con dos botones `[data-action="ok"|"cancel"]` sin id propio.
    await this.btnVaciarCarrito.click();
    await this.page.locator('[role="dialog"] [data-action="ok"]').click();
  }

  // ── Modal de cobro ───────────────────────────────────────────────────
  get modalCobroOverlay() { return this.page.locator('#modal-cobro-overlay'); }
  get modalCobroTotal() { return this.page.locator('#pos-modal-total-monto'); }
  get cobroError() { return this.page.locator('#pos-cobro-error'); }
  get btnConfirmarCobro() { return this.page.locator('#btn-confirmar-cobro'); }
  get btnAgregarPago() { return this.page.locator('#btn-agregar-pago'); }

  get filasPago() { return this.page.locator('#pos-pagos-lista .pos-pago-fila'); }

  async abrirModalCobro() {
    await this.btnCobrar.click();
    await expect(this.modalCobroOverlay).toBeVisible();
  }

  /** Completa el monto de la primera línea de pago (ya precargada con el total al abrir el modal). */
  async setMontoPrimeraLineaPago(monto) {
    await this.filasPago.first().locator('.pos-pago-monto').fill(String(monto));
  }

  async setMedioPrimeraLineaPago(medio) {
    await this.filasPago.first().locator('.pos-pago-medio').selectOption(medio);
  }

  async confirmarCobro() {
    await this.btnConfirmarCobro.click();
  }

  // ── Ticket de venta ──────────────────────────────────────────────────
  get modalTicketOverlay() { return this.page.locator('#modal-ticket-overlay'); }
  get ticketNumero() { return this.page.locator('#pos-ticket-numero'); }
  get ticketDetalle() { return this.page.locator('#pos-ticket-detalle'); }
}
