// Page object de devoluciones.html — Fase 2 P1 (ver PLAN_E2E_COBERTURA_TOTAL.md,
// bloque "devoluciones / cheques / conciliación bancaria"). Página standalone,
// no comparte JS con ninguna otra (a diferencia de lotes/vencimientos).
//
// `data-testid="dev-fila"` agregado en devoluciones.js::renderTabla() — el
// <tr> no traía ningún selector estable con el id de la devolución, mismo
// criterio que `lote-fila`/`oc-fila` en páginas anteriores.
//
// Toast — devoluciones.js NO define su propio toast (a diferencia de
// lotes.js): usa `window.mostrarToast` de ui-utils.js directamente, así
// que el getter `toast` de PageObjectBase (`div.toast.toast--visible`)
// aplica sin overrides.
//
// Confirmación — `eliminarDevolucion()` usa `window.confirmar()` (mismo
// overlay que compras/cta-cte/lotes) SOLO para eliminar. Aprobar/rechazar
// (`revisarDevolucion()`) NO pide confirmación — dispara directo el PATCH.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class DevolucionesPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/devoluciones.html`);
    await this.esperarAppLista();
  }

  // ── KPIs ────────────────────────────────────────────────────────────
  // Migración a FiltroTabs (mismo patrón que cheques/cobranzas): los
  // contadores pendientes/aprobadas/rechazadas ahora viven en las
  // pestañas de `#filtro-tabs-devoluciones`, no en tarjetas KPI propias.
  tabContador(key) { return this.page.locator(`#filtro-tabs-devoluciones .filtro-tab-count[data-key-count="${key}"]`); }
  get kpiPendientes() { return this.tabContador('pendiente'); }
  get kpiAprobadas()  { return this.tabContador('aprobada'); }
  get kpiRechazadas() { return this.tabContador('rechazada'); }

  // ── Filtros ─────────────────────────────────────────────────────────
  get inputBuscar()    { return this.page.locator('#buscar-dev'); }
  get filtroEstado()   { return this.page.locator('#filtro-estado'); }
  get filtroMotivo()   { return this.page.locator('#filtro-motivo'); }

  // ── Tabla ───────────────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="dev-fila"]'); }

  fila(devId) {
    return this.page.locator(`[data-testid="dev-fila"][data-id="${devId}"]`);
  }

  abrirDetalle(devId) {
    return this.fila(devId).click();
  }

  // ── Panel de detalle ────────────────────────────────────────────────
  get panel()       { return this.page.locator('#panel-devolucion'); }
  get panelTitulo() { return this.page.locator('#panel-dev-titulo'); }
  get panelBody()   { return this.page.locator('#panel-dev-body'); }
  get panelFooter() { return this.page.locator('#panel-dev-footer'); }

  get chkReponerStock()   { return this.page.locator('#chk-reponer-stock'); }
  get chkGenerarNC()      { return this.page.locator('#chk-generar-nc'); }
  get selDepositoReponer() { return this.page.locator('#sel-deposito-reponer'); }

  get btnAprobar()  { return this.panelFooter.getByRole('button', { name: 'Aprobar' }); }
  get btnRechazar() { return this.panelFooter.getByRole('button', { name: 'Rechazar' }); }
  get btnEliminar() { return this.panelFooter.getByRole('button', { name: 'Eliminar' }); }

  async aprobar() {
    await this.btnAprobar.click();
  }

  async rechazar() {
    await this.btnRechazar.click();
  }

  cerrarPanel() {
    return this.page.locator('.btn-cerrar-panel').click();
  }

  // ── Confirmación (overlay de window.confirmar(), solo para eliminar) ──
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk()   { return this.dialogoConfirmar.locator('[data-action="ok"]'); }

  async eliminar() {
    await this.btnEliminar.click();
    await this.btnConfirmarOk.click();
  }

  // ── Modal: alta manual ──────────────────────────────────────────────
  get btnNuevaDevolucion() { return this.page.getByRole('button', { name: '+ Registrar devolución' }); }
  get modalNueva()         { return this.page.locator('#modal-nueva-devolucion'); }
  get selCliente()         { return this.page.locator('#nd-cliente'); }
  get selMotivo()          { return this.page.locator('#nd-motivo'); }
  get textareaNotas()      { return this.page.locator('#nd-notas'); }
  get btnGuardarNueva()    { return this.page.locator('#nd-btn-guardar'); }

  async abrirModalNueva() {
    await this.btnNuevaDevolucion.click();
    await expect(this.modalNueva).toBeVisible();
  }
}
