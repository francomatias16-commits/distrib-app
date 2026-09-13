// Page object de Fase 1 (P0), cuarta página después de pedidos/pos/stock
// (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 12 — orden: pedidos, pos,
// stock, facturacion, cobranzas, clientes, cta-cte, compras, productos).
//
// facturacion.js mezcla las tres capas de red otra vez (10.1): RPC para
// listar (`fn_facturas_lista`, `fn_facturas_contadores`), PostgREST directo
// para el detalle de ítems (`pedido_items`), y — a diferencia de las 3
// páginas anteriores — `fetch()` A MANO a `/api/facturas/*` con
// `Authorization: Bearer <token>` armado en el propio módulo (no pasa por
// `window.api`), porque reintentar/anular pegan a la integración ARCA real
// del lado servidor. `sb.auth.getSession()` lee la sesión fake sembrada por
// `loguearComoAdmin()`, así que el token existe igual aunque sea falso.
//
// data-testid agregado (10.2 sigue aplicando): `<tr class="fila-factura">`
// no traía NINGÚN selector estable con el id de la factura (a diferencia de
// `fila-pedido`/`fila-stock`, que sí traen `data-id` de fábrica) — mismo
// gap puntual que `pos-carrito-fila` en la página anterior. Se agregó
// `data-testid="factura-fila" data-id="${f.id}"` en `renderTabla()`
// (facturacion.js). Los botones de acción por fila SÍ ya tenían id propio
// (`btn-reintentar-${id}`, `btn-pdf-${id}`), no hizo falta tocarlos.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class FacturacionPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/facturacion.html`);
    await this.esperarAppLista();
  }

  // ── Tabla principal (tab "Facturas") ────────────────────────────────
  get filas() {
    return this.page.locator('[data-testid="factura-fila"]');
  }

  fila(facturaId) {
    return this.page.locator(`[data-testid="factura-fila"][data-id="${facturaId}"]`);
  }

  btnKebabFila(facturaId) {
    return this.page.locator(`.btn-kebab-factura[data-factura-id="${facturaId}"]`);
  }

  get menuAcciones() { return this.page.locator('#menu-acciones-factura'); }

  /** Abre el menú "⋮" flotante de la fila — reintentar/PDF viven ahí, no directo en la fila. */
  async abrirMenuAcciones(facturaId) {
    await this.btnKebabFila(facturaId).click();
    await expect(this.menuAcciones).toBeVisible();
  }

  btnReintentarFila(facturaId) {
    return this.page.locator(`#btn-reintentar-${facturaId}`);
  }

  btnPdfFila(facturaId) {
    return this.page.locator(`#btn-pdf-${facturaId}`);
  }

  /** Abre el kebab de la fila y clickea "Reintentar emisión" en el menú flotante. */
  async reintentarFila(facturaId) {
    await this.abrirMenuAcciones(facturaId);
    await this.btnReintentarFila(facturaId).click();
  }

  async abrirDetallePorId(facturaId) {
    await this.fila(facturaId).click();
    await expect(this.modalDetalle).toHaveClass(/open/);
  }

  // ── KPIs / banner ────────────────────────────────────────────────────
  get kpiPendientes() { return this.page.locator('#kpi-pendientes'); }
  get kpiError() { return this.page.locator('#kpi-error'); }
  get bannerError() { return this.page.locator('#banner-error'); }

  // ── Modal de detalle ─────────────────────────────────────────────────
  get modalDetalle() { return this.page.locator('#modal-detalle'); }
  get modalTitulo() { return this.page.locator('#modal-titulo'); }
  get modalSubtitulo() { return this.page.locator('#modal-subtitulo'); }
  get modalErrorBox() { return this.page.locator('#modal-error-box'); }
  get btnModalReintentar() { return this.page.locator('#btn-modal-reintentar'); }
  get btnAnular() { return this.page.locator('.btn-anular').first(); }
  get seccionConfirmAnular() { return this.page.locator('#confirm-anular-seccion'); }
  get inputMotivoAnulacion() { return this.page.locator('#motivo-anulacion'); }
  get btnConfirmarAnular() { return this.page.locator('#btn-confirmar-anular'); }

  async iniciarAnulacion() {
    // El botón "Anular" del modal (estado "emitida") solo despliega la
    // sección de motivo — mostrarConfirmAnular() reemplaza el contenido de
    // #modal-acciones y recién ahí aparece #btn-confirmar-anular.
    await this.btnAnular.click();
    await expect(this.seccionConfirmAnular).toBeVisible();
  }

  async confirmarAnulacion(motivo) {
    if (motivo !== undefined) await this.inputMotivoAnulacion.fill(motivo);
    await this.btnConfirmarAnular.click();
  }

  /** window.cerrarModal() global de facturacion.js — mismo patrón que pedidos.page.js. */
  async cerrarModal() {
    await this.page.evaluate(() => window.cerrarModal?.());
  }

  // ── Tab "Notas de crédito" (notas-credito.js, mismo <script> clásico,
  // comparte scope global con facturacion.js — ver CHANGELOG F3-05) ─────
  get tabFacturas() { return this.page.locator('#tab-facturas'); }
  get tabNC() { return this.page.locator('#tab-nc'); }
  get panelNC() { return this.page.locator('#panel-nc'); }

  async irATabFacturas() {
    await this.tabFacturas.click();
  }

  async irATabNC() {
    await this.tabNC.click();
    await expect(this.panelNC).toBeVisible();
  }

  get btnNuevoNC() { return this.page.locator('#btn-nuevo-nc'); }
  get modalNC() { return this.page.locator('#modal-nc'); }
  get selClienteNC() { return this.page.locator('#nc-cliente'); }
  get selFacturaNC() { return this.page.locator('#nc-factura'); }
  get selTipoNC() { return this.page.locator('#nc-tipo'); }
  get inputMotivoNC() { return this.page.locator('#nc-motivo'); }
  // El onclick pasó a ser `btnAsyncClick(this, agregarItemNC)` (guard
  // anti-doble-click) — ya no matchea `button[onclick="agregarItemNC()"]`
  // literal. Se ubica por texto, scopeado al modal de NC para no chocar
  // con otros botones "+ Agregar" de la página.
  get btnAgregarItemNC() { return this.modalNC.locator('button', { hasText: 'Agregar ítem' }); }
  get btnGuardarNC() { return this.page.locator('#btn-guardar-nc'); }

  async abrirModalNuevaNC() {
    await this.btnNuevoNC.click();
    await expect(this.modalNC).toBeVisible();
  }

  /**
   * Completa el alta mínima: cliente, factura asociada (dispara
   * `onClienteNC()` → carga `#nc-factura` desde `facturas` filtradas por
   * `cliente_id`, ver notas-credito.js), motivo y un ítem con precio > 0
   * (guardarNC() descarta ítems con `precio_unitario` 0 o sin descripción).
   */
  async completarNuevaNC({ clienteId, facturaId, motivo, item }) {
    await this.selClienteNC.selectOption(clienteId);
    // onClienteNC() es async (fetch de facturas del cliente) — esperar a
    // que la opción exista antes de seleccionarla, no solo a que el
    // <select> esté "attached".
    if (facturaId) {
      await expect(this.selFacturaNC.locator(`option[value="${facturaId}"]`)).toHaveCount(1, { timeout: 5000 });
      await this.selFacturaNC.selectOption(facturaId);
    }
    await this.inputMotivoNC.fill(motivo);
    await this.btnAgregarItemNC.click();
    const filaItem = this.page.locator('#tbody-items-nc tr').first();
    await filaItem.locator('input[type="text"]').fill(item.descripcion);
    await filaItem.locator('input[data-money]').fill(String(item.precio_unitario));
  }

  /** Click en "Crear NC" + confirmar el diálogo de `window.confirmar()`. */
  async guardarNC() {
    await this.btnGuardarNC.click();
    await expect(this.dialogoConfirmarGlobal).toBeVisible();
    await this.dialogoConfirmarGlobal.locator('[data-action="ok"]').click();
  }

  filaNC(ncId) {
    // renderTablaNC() no agrega data-testid — arma la fila con
    // onclick="verDetalleNC('<id>')" en el <tr>, único selector estable.
    return this.page.locator(`tr[onclick*="verDetalleNC('${ncId}')"]`);
  }

  btnKebabNC(ncId) {
    return this.page.locator(`.btn-kebab-nc[data-nc-id="${ncId}"]`);
  }

  get menuAccionesNC() { return this.page.locator('#menu-acciones-nc'); }

  /** Abre el kebab de la fila NC y clickea "Emitir a AFIP" en el menú flotante. */
  async emitirNC(ncId) {
    await this.btnKebabNC(ncId).click();
    await expect(this.menuAccionesNC).toBeVisible();
    await this.menuAccionesNC.getByRole('menuitem', { name: 'Emitir a AFIP' }).click();
    await expect(this.dialogoConfirmarGlobal).toBeVisible();
    await this.dialogoConfirmarGlobal.locator('[data-action="ok"]').click();
  }

  // `window.confirmar()` (ui-utils.js) — mismo overlay global que ya
  // documentaron pedidos.page.js/cobranzas.page.js para sus propios
  // diálogos; acá se nombra aparte porque esta página ya usa
  // `dialogoConfirmar` para la sección de anulación in-modal (no es el
  // mismo elemento).
  get dialogoConfirmarGlobal() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
}
