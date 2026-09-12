// Page object piloto de la Fase 1 (P0) — plantilla para las otras 8
// páginas P0. Usa los selectores que YA existen en el HTML/JS real
// (`#tabla-body`, `tr.fila-pedido[data-id]`, `#modal-*`) en vez de
// agregar `data-testid` en bloque — ver corrección de la sección 10.2
// del plan: el 0% de `data-testid` no significaba 0% de selectores
// estables, la mayoría de los elementos relevantes ya tienen `id` o
// `data-*` semántico.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class PedidosPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/pedidos.html`);
    await this.esperarAppLista();
  }

  get filas() {
    return this.page.locator('tr.fila-pedido');
  }

  fila(id) {
    return this.page.locator(`tr.fila-pedido[data-id="${id}"]`);
  }

  async abrirDetallePorId(id) {
    await this.fila(id).click();
    await expect(this.page.locator('#modal-titulo')).toBeVisible();
  }

  // ── Modal de detalle ────────────────────────────────────────────────
  get modalTitulo() { return this.page.locator('#modal-titulo'); }
  get modalClienteInfo() { return this.page.locator('#modal-cliente-info'); }
  get modalItems() { return this.page.locator('#modal-items'); }
  get modalTotales() { return this.page.locator('#modal-totales'); }

  async cerrarModal() {
    // pedidos.js expone `cerrarModal` en window (mismo patrón que
    // `abrirModalPorId`/`confirmarCancelar` — funciones globales
    // enganchadas por `onclick=` inline, no hay botón con id propio
    // documentado para "cerrar"; se llama directo para no depender de
    // un selector de ícono que puede cambiar).
    await this.page.evaluate(() => window.cerrarModal?.());
  }

  // ── Transición de estado (Etapa 5 del plan de auditoría) ────────────
  // abrirModal() arma los botones de "próximo estado" con clase
  // `.btn-estado.btn-est-<estado>` (pedidos.js:804) — no tienen id propio
  // porque `sig` (TRANSICIONES[p.estado]) puede traer más de una opción
  // (ej. confirmado → [preparando, cancelado]), así que el selector va
  // por el estado destino, no por posición.
  btnTransicion(estadoDestino) {
    return this.page.locator(`#modal-estado-row .btn-est-${estadoDestino}`);
  }

  get btnGenerarFactura() { return this.page.locator('#btn-generar-factura'); }

  // Mismo overlay global que ya documentó cta-cte.page.js
  // (`window.confirmar()`, frontend/admin/js/ui-utils.js) — reusado acá
  // porque cambiarEstado() pide confirmación para confirmado/preparando/
  // despachado/entregado (MENSAJE_CONFIRMACION_ESTADO).
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }

  /**
   * Click en el botón de transición + confirmar el diálogo. cambiarEstado()
   * cierra el modal solo SI la transición fue exitosa (`if (ok) cerrarModal()`)
   * — quien llama debe reabrir el modal (abrirDetallePorId) para la
   * siguiente transición.
   */
  async confirmarTransicion(estadoDestino) {
    await this.btnTransicion(estadoDestino).click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  /** Click en "Generar comprobante" (POST /api/facturas, ver facturacion.page.js para el resto del flujo). */
  async generarFactura() {
    await this.btnGenerarFactura.click();
  }
}
