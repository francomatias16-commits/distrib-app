// Page object de Fase 1 (P0), sexta página del orden (pedidos, pos, stock,
// facturacion, cobranzas, clientes, cta-cte, compras, productos — ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 12).
//
// `/admin/cta-cte.html` en sí es un STUB de redirect (`window.location.
// replace('/admin/cobranzas?vista=saldos')`, ver hallazgo 11.2 del plan) —
// no hay nada que testear ahí. La lógica real vive en `cta-cte.js`, cargado
// por `cobranzas.html` y montado en `#vista-saldos` ("Saldos por cliente",
// la vista con la que se fusionó en la auditoría IA/UX de Fase 0). Por eso
// este page object navega directo a `cobranzas.html?vista=saldos` — mismo
// criterio que ya documentaba `cobranzas.page.js` para dejarlo para "más
// adelante en el plan".
//
// Cuatro capas de red conviven acá (una más que el hallazgo 10.1 original):
// RPC para listar (`fn_cta_cte_kpis`, `fn_cta_cte_lista`) y para escribir
// (`registrar_cobro_completo`), y un CUARTO patrón que no había aparecido
// hasta esta página: `fetch()` A MANO contra `/rest/v1/cta_cte` (no vía
// `sb.from()`) con headers armados por `getHeaders()` propio del módulo —
// para el detalle de movimientos del panel lateral. `mockearTabla` lo cubre
// igual porque intercepta por URL, sin importar si la request salió del SDK
// o de un `fetch()` directo.
//
// `data-testid` agregado (10.2 sigue aplicando): `<tr onclick="abrirCliente(...)">`
// en `renderTabla()` no traía NINGÚN selector estable con el id del cliente
// — se agregó `data-testid="cc-fila" data-cliente-id="${c.cliente_id}"`
// (cta-cte.js), mismo criterio que `factura-fila`/`pos-carrito-fila` en las
// páginas anteriores.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class CtaCtePage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/cobranzas.html?vista=saldos`);
    await this.esperarAppLista();
    await expect(this.page.locator('#vista-saldos')).toBeVisible();
  }

  // ── KPIs ────────────────────────────────────────────────────────────
  // Migración (Fase 0 auditoría IA/UX + FiltroTabs): las 4 tarjetas KPI
  // (Total/Vencido/Por vencer/Al día) se reemplazaron por las pestañas de
  // `#filtro-tabs-saldos` — a diferencia de cheques/cobranzas acá SÍ
  // siguen mostrando un monto (no un conteo): cta-cte.js::actualizarKPIsSaldos()
  // escribe "$ N" a mano en el mismo span que genera FiltroTabs
  // (`.filtro-tab-count[data-key-count="<key>"]`), en vez de usar
  // `FiltroTabs.actualizarContadores()` (que formatea como número plano).
  tabMonto(key) { return this.page.locator(`#filtro-tabs-saldos .filtro-tab-count[data-key-count="${key}"]`); }
  get kpiTotal()     { return this.tabMonto(''); }
  get kpiVencido()   { return this.tabMonto('vencido'); }
  get kpiPorVencer() { return this.tabMonto('por_vencer'); }
  get kpiAlDia()     { return this.tabMonto('al_dia'); }

  /** Click en la pestaña FiltroTabs (reemplaza el <select> oculto `#filtro-estado`). */
  async filtrarPorEstadoTab(key) {
    await this.page.locator(`#filtro-tabs-saldos .filtro-tab[data-key="${key}"]`).click();
  }

  // ── Tabla de clientes ───────────────────────────────────────────────
  get inputBuscar() { return this.page.locator('#buscar-cliente'); }

  get filas() {
    return this.page.locator('[data-testid="cc-fila"]');
  }

  fila(clienteId) {
    return this.page.locator(`[data-testid="cc-fila"][data-cliente-id="${clienteId}"]`);
  }

  async buscar(texto) {
    // onBusquedaClienteInput() debounce a 250ms antes de recargar.
    await this.inputBuscar.fill(texto);
    await this.page.waitForTimeout(300);
  }

  /** Click en la fila entera → abre el panel lateral (abrirCliente()). */
  async abrirClientePorId(clienteId) {
    await this.fila(clienteId).click();
    await expect(this.panelCliente).toHaveClass(/open/);
  }

  /**
   * Click en el botón "Cobrar" de la fila → abre el modal de cobro directo
   * (abrirModalCobroDirecto()), SIN pasar por el panel lateral. El botón
   * hace `event.stopPropagation()` en el HTML así que no dispara también
   * abrirCliente().
   */
  async cobrarDesdeFilaPorId(clienteId) {
    await this.fila(clienteId).getByRole('button', { name: 'Cobrar' }).click();
    await expect(this.modalCobro).not.toHaveClass(/hidden/);
  }

  // ── Panel lateral (detalle de cliente) ─────────────────────────────
  get panelCliente() { return this.page.locator('#panel-cliente'); }
  get panelNombre() { return this.page.locator('#panel-nombre'); }
  get panelBody() { return this.page.locator('#panel-body'); }
  get btnRegistrarCobro() { return this.page.getByRole('button', { name: 'Registrar cobro' }); }

  async cerrarPanel() {
    await this.page.locator('.btn-cerrar-panel').click();
    await expect(this.panelCliente).not.toHaveClass(/open/);
  }

  // ── Modal: registrar cobro ──────────────────────────────────────────
  get modalCobro() { return this.page.locator('#modal-cobro'); }
  get inputMonto() { return this.page.locator('#cobro-monto'); }
  get selectMedio() { return this.page.locator('#cobro-medio'); }
  get inputFecha() { return this.page.locator('#cobro-fecha'); }
  get inputComprobante() { return this.page.locator('#cobro-comprobante'); }
  get inputObs() { return this.page.locator('#cobro-obs'); }
  get btnGuardarCobro() { return this.page.locator('#btn-guardar-cobro'); }

  async completarCobro({ monto, medio, comprobante, obs } = {}) {
    if (monto !== undefined) await this.inputMonto.fill(String(monto));
    if (medio !== undefined) await this.selectMedio.selectOption(medio);
    if (comprobante !== undefined) await this.inputComprobante.fill(comprobante);
    if (obs !== undefined) await this.inputObs.fill(obs);
  }

  /**
   * guardarCobro() pide confirmación con `window.confirmar()` (overlay
   * propio) antes de llamar a la RPC — mismo mecanismo que ya documentaba
   * `cobranzas.page.js`: filtrar por `:has([data-action])` porque
   * `nav-mobile.js` también trae otros `[role="dialog"]` en el DOM que no
   * hay que confundir con este.
   */
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  async guardarCobro() {
    await this.btnGuardarCobro.click();
    await this.btnConfirmarOk.click();
  }
}
