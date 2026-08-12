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

  btnReintentarFila(facturaId) {
    return this.page.locator(`#btn-reintentar-${facturaId}`);
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
}
