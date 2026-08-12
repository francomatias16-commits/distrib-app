// Page object de cheques.html — Fase 2 P1 (bloque "devoluciones / cheques /
// conciliación bancaria"). Standalone, JS propio (`cheques.js`).
//
// Tres capas de red distintas conviven acá (mismo patrón que cobranzas.js,
// ver nota en cobranzas.spec.js): RPC para listado+contadores
// (`fn_cheques_lista`, `fn_cheques_contadores`), PostgREST directo para
// clientes del selector (`_sb.from('clientes')`), y **fetch crudo** (no
// `_sb.from()`) contra `/rest/v1/cheques` para alta/edición/cambio de
// estado — `guardarCheque()`/`cambiarEstado()` arman el header Authorization
// a mano en vez de pasar por el SDK. Igual cae bajo `**/rest/v1/cheques**`,
// así que `mockearTabla(page, 'cheques', ...)` lo intercepta sin problema
// (Playwright matchea por URL, no le importa qué armó el request).
//
// `data-testid="cheque-fila"` agregado en cheques.js::renderTabla() — el
// <tr> no traía selector estable con el id del cheque (mismo criterio que
// `dev-fila`/`lote-fila`).
//
// Confirmación — `guardarCheque()` pide `window.confirmar()` SIEMPRE (alta
// y edición), con label distinto según el caso. `cambiarEstado()` (select
// en la fila) y el flujo BCRA NO piden confirmación.
//
// Toast — cheques.js usa `window.mostrarToast` global directo, el getter
// heredado de PageObjectBase aplica sin overrides.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class ChequesPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/cheques.html`);
    await this.esperarAppLista();
  }

  // ── KPIs / FiltroTabs ──────────────────────────────────────────────
  // Migración (2026-08-09): las tarjetas KPI de cartera/cobrado/rechazado
  // (montos, con subtítulo "N cheques") se reemplazaron por pestañas
  // FiltroTabs — cada pestaña ahora muestra un CONTADOR (cantidad), no un
  // monto, y filtra la tabla al click. El monto sigue existiendo solo
  // para "Vencen en 3 días" (`kpi-proximos`), que quedó de solo lectura.
  get kpiProximos()     { return this.page.locator('#kpi-proximos'); }
  get kpiProximosSub()  { return this.page.locator('#kpi-proximos-sub'); }

  tabContador(key) { return this.page.locator(`#filtro-tabs-cheques .filtro-tab-count[data-key-count="${key}"]`); }
  get kpiCarteraCount()    { return this.tabContador('en_cartera'); }
  get kpiCobradosCount()   { return this.tabContador('cobrado'); }
  get kpiRechazadosCount() { return this.tabContador('rechazado'); }

  /** Click en la pestaña FiltroTabs (reemplaza el <select> visualmente
   *  oculto `#filtro-estado-cheque`, que sigue existiendo en el DOM como
   *  estado interno pero ya no es interactuable por el usuario). */
  async filtrarPorEstadoTab(key) {
    await this.page.locator(`#filtro-tabs-cheques .filtro-tab[data-key="${key}"]`).click();
  }

  get alertaVencimientos() { return this.page.locator('#alerta-vencimientos'); }

  // ── Filtros ─────────────────────────────────────────────────────────
  get inputBuscar()      { return this.page.locator('#buscar-cheque'); }
  get filtroSoloVencidos(){ return this.page.locator('#filtro-vencidos-cheque'); }

  async buscar(texto) {
    await this.inputBuscar.fill(texto);
    // Debounce de 250ms (mismo criterio que clientes.js) antes de disparar
    // fn_cheques_lista — ver cheques.js::authReady.
    await this.page.waitForTimeout(300);
  }

  // ── Tabla ───────────────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="cheque-fila"]'); }

  fila(chequeId) {
    return this.page.locator(`[data-testid="cheque-fila"][data-id="${chequeId}"]`);
  }

  botonEditar(chequeId) {
    return this.fila(chequeId).getByTitle('Editar');
  }

  botonVerificarBcra(chequeId) {
    return this.fila(chequeId).getByTitle('Verificar denuncia en BCRA');
  }

  selectEstadoFila(chequeId) {
    return this.fila(chequeId).getByTitle('Cambiar estado');
  }

  async cambiarEstadoFila(chequeId, nuevoEstado) {
    await this.selectEstadoFila(chequeId).selectOption(nuevoEstado);
  }

  async editar(chequeId) {
    await this.botonEditar(chequeId).click();
    await expect(this.modal).toBeVisible();
  }

  // ── Paginación (inyectada por JS — inyectarControlesPaginacionCheques) ─
  get infoPaginacion()   { return this.page.locator('#info-pag-cheques'); }
  get btnPaginaAnterior(){ return this.page.locator('#btn-prev-cheques'); }
  get btnPaginaSiguiente(){ return this.page.locator('#btn-next-cheques'); }

  // ── Modal alta/edición ──────────────────────────────────────────────
  get modal()        { return this.page.locator('#modal-cheque'); }
  get modalTitulo()  { return this.page.locator('#modal-cheque-titulo'); }
  get selCliente()   { return this.page.locator('#cheque-cliente'); }
  get inputNumero()  { return this.page.locator('#cheque-numero'); }
  get inputBanco()   { return this.page.locator('#cheque-banco'); }
  get inputMonto()   { return this.page.locator('#cheque-monto'); }
  get inputVencimiento() { return this.page.locator('#cheque-vencimiento'); }
  get inputRecepcion()   { return this.page.locator('#cheque-recepcion'); }
  get selEstado()    { return this.page.locator('#cheque-estado'); }
  get textareaObs()  { return this.page.locator('#cheque-obs'); }
  get btnGuardar()   { return this.page.locator('#btn-guardar-cheque'); }

  // `exact: true` es necesario acá — el botón real y el chip de cuenta
  // (`.topbar-right`, ver topbar-widgets.js::_armarMenuChip) ambos matchean
  // por nombre accesible: `#topbar-usuario` no tiene wrapper propio en esta
  // página (ni en pedidos.html/devoluciones.html — comportamiento del
  // topbar en toda la app, no algo puntual de cheques), así que
  // `_armarMenuChip` termina envolviendo TODO `.topbar-right` como un solo
  // chip clickeable, cuyo nombre accesible absorbe el texto de sus hijos
  // ("Nuevo cheque" + "Notificaciones"). Sin `exact: true`,
  // getByRole('button', {name: 'Nuevo cheque'}) matchea ambos (strict mode
  // violation) — con `exact: true` solo matchea el botón real.
  get btnNuevoCheque() { return this.page.getByRole('button', { name: 'Nuevo cheque', exact: true }); }

  async abrirModalNuevo() {
    await this.btnNuevoCheque.click();
    await expect(this.modal).toBeVisible();
  }

  async completarFormulario({ clienteId, numero, banco, monto, vencimiento, recepcion, estado, obs }) {
    if (clienteId !== undefined)    await this.selCliente.selectOption(clienteId);
    if (numero !== undefined)       await this.inputNumero.fill(numero);
    if (banco !== undefined)        await this.inputBanco.fill(banco);
    if (monto !== undefined)        await this.inputMonto.fill(String(monto));
    if (vencimiento !== undefined)  await this.inputVencimiento.fill(vencimiento);
    if (recepcion !== undefined)    await this.inputRecepcion.fill(recepcion);
    if (estado !== undefined)       await this.selEstado.selectOption(estado);
    if (obs !== undefined)          await this.textareaObs.fill(obs);
  }

  // ── Confirmación (overlay de window.confirmar(), alta y edición) ──────
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk()   { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  async guardar() {
    await this.btnGuardar.click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  // ── Modal verificación BCRA ─────────────────────────────────────────
  get modalBcra()         { return this.page.locator('#modal-bcra-denuncia'); }
  get selBcraEntidad()    { return this.page.locator('#bcra-denuncia-entidad'); }
  get inputBcraNumero()   { return this.page.locator('#bcra-denuncia-numero'); }
  get bcraResultado()     { return this.page.locator('#bcra-denuncia-resultado'); }
  get btnBcraConsultar()  { return this.page.getByRole('button', { name: 'Consultar' }); }

  async abrirModalBcra(chequeId) {
    await this.botonVerificarBcra(chequeId).click();
    await expect(this.modalBcra).toBeVisible();
  }

  async consultarBcra() {
    await this.btnBcraConsultar.click();
  }
}
