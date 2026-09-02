// Page object de vencimientos.html (tab "Lotes y vencimientos") — Fase 2 P1
// (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 21). `lotes.html` es solo un
// redirect stub a `/admin/vencimientos` (hallazgo 15, mismo patrón que
// `cta-cte.html`) — este page object apunta directo a `vencimientos.html`.
//
// `data-testid="lote-fila"` agregado en lotes.js::renderTablaLotes() (10.2
// sigue aplicando) — el `<tr>` no traía ningún selector estable con el id
// del lote, mismo criterio que `oc-fila`/`cc-fila` en las páginas anteriores.
//
// Toast — OJO: a diferencia de la mayoría de las páginas admin (ver
// PageObjectBase.toast), lotes.js define su PROPIA función `toast()` a nivel
// de script clásico, que pisa `window.toast` de ui-utils.js (la última
// declaración de función gana en el scope global compartido entre scripts
// clásicos). La de lotes.js reutiliza el `<div id="toast">` estático del
// HTML y le pone clase `toast ${tipo} visible` — NO `toast--visible` como
// la de ui-utils.js. Por eso se pisa el getter `toast` acá en vez de usar
// el de la base.
//
// Confirmación — guardarLote()/darDeBajaLote() piden confirmación con
// `window.confirmar()` (overlay propio), mismo mecanismo que
// compras.page.js/cta-cte.page.js.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class VencimientosPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/vencimientos.html`);
    await this.esperarAppLista();
    // FIX: vencimientos.html tampoco tiene `#app-preloader` — igual que
    // compras.page.js, `esperarAppLista()` no da ninguna garantía de que
    // `initLotes()` (`await cargarDepositos(); await cargarLotes();`,
    // corridos tras `window.authReady.then(...)`) haya terminado. Abrir el
    // modal y elegir depósito/producto antes de eso puede pasar con el
    // `<select id="f-deposito_id">` todavía sin las `<option>` que inyecta
    // `cargarDepositos()` — a diferencia del combo de compras esto no
    // cuelga 30s (selectOption falla rápido si la opción no existe
    // todavía), pero sigue siendo una carrera real. Como `cargarLotes()`
    // corre DESPUÉS de `cargarDepositos()` en la misma cadena, esperar a
    // que `#tbody-lotes` deje el placeholder "Cargando..." garantiza que
    // ambas ya terminaron.
    await expect(this.page.locator('#tbody-lotes')).not.toContainText('Cargando...');
  }

  // ── Toast (override — ver nota arriba) ────────────────────────────────
  get toast() { return this.page.locator('#toast.visible'); }

  async esperarToastExito(textoParcial) {
    const toast = this.toast;
    await expect(toast).toBeVisible({ timeout: 5000 });
    if (textoParcial) await expect(toast).toContainText(textoParcial);
  }

  // ── Banner de alertas ───────────────────────────────────────────────
  get bannerAlertas() { return this.page.locator('#banner-alertas'); }

  // ── Filtros ─────────────────────────────────────────────────────────
  get inputBusqueda() { return this.page.locator('#busqueda'); }
  get filtroEstado() { return this.page.locator('#filtro-estado'); }
  get filtroDeposito() { return this.page.locator('#filtro-deposito'); }

  // ── Tabla principal ─────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="lote-fila"]'); }

  fila(loteId) {
    return this.page.locator(`[data-testid="lote-fila"][data-id="${loteId}"]`);
  }

  // ── Modal: nuevo / editar lote ─────────────────────────────────────
  get btnNuevoLote() { return this.page.locator('#btn-nuevo-lote'); }
  get modalLote() { return this.page.locator('#modal-lote'); }
  get inputBusquedaProducto() { return this.page.locator('#f-producto-busq'); }
  get sugerenciasProducto() { return this.page.locator('#f-producto-sugs'); }
  get inputNumeroLote() { return this.page.locator('#f-numero_lote'); }
  get selectDeposito() { return this.page.locator('#f-deposito_id'); }
  get inputCantidad() { return this.page.locator('#f-cantidad'); }
  get inputCostoUnitario() { return this.page.locator('#f-costo_unitario'); }
  get inputFechaFabricacion() { return this.page.locator('#f-fecha_fabricacion'); }
  get inputFechaVencimiento() { return this.page.locator('#f-fecha_vencimiento'); }
  get btnGuardarLote() {
    // FIX: el botón nunca tuvo clase `.btn-guardar` (solo `.btn
    // .btn--primary`, sin id) — `.modal-box-footer .btn-guardar` nunca
    // matcheaba nada, timeout de 30s clickeando un botón que en los
    // hechos no existía con ese selector. Va por texto, que sí es único
    // en la página.
    return this.page.getByRole('button', { name: 'Guardar lote' });
  }

  async abrirModalNuevo() {
    await this.btnNuevoLote.click();
    await expect(this.modalLote).toBeVisible();
  }

  abrirModalEditar(loteId) {
    return this.fila(loteId).getByRole('button', { name: 'Editar' }).click();
  }

  /** Escribe la búsqueda y elige la primera sugerencia del dropdown de productos. */
  async buscarYElegirProducto(query) {
    await this.inputBusquedaProducto.fill(query);
    await expect(this.sugerenciasProducto).toBeVisible();
    await this.sugerenciasProducto.locator('.sug-item').first().click();
  }

  // ── Confirmación (overlay de window.confirmar()) ──────────────────────
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  /** guardarLote() pide confirmación antes de mandar el POST/PATCH. */
  async guardarLote() {
    await this.btnGuardarLote.click();
    await this.btnConfirmarOk.click();
  }

  /** Botón "Dar de baja" de la fila — pide confirmación de tipo danger, igual patrón. */
  async darDeBaja(loteId) {
    await this.fila(loteId).getByRole('button', { name: 'Dar de baja' }).click();
    await this.btnConfirmarOk.click();
  }

  /** Botón "Eliminar" de la fila (solo visible con cantidad 0) — mismo patrón de confirmación. */
  async eliminar(loteId) {
    await this.fila(loteId).getByRole('button', { name: 'Eliminar' }).click();
    await this.btnConfirmarOk.click();
  }
}
