// Page object de notas.html — Fase 2 P1, tercera página del bloque
// "usuarios / proveedores / notas / presupuestos" (ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 26). Standalone, JS propio
// (`notas.js`, 287 líneas). A diferencia de usuarios/proveedores, NO pega
// contra `/api/*` — el listado sale de una RPC de Postgres
// (`sb.rpc('fn_notas_lista', {...})` → `POST /rest/v1/rpc/fn_notas_lista`,
// mismo patrón que `fn_pedidos_lista` en pedidos.html) y el alta pega a
// OTRA RPC distinta (`emitir_nota_cta_cte`) — mockear con `mockearRpc()`
// de supabase-rest-mock.js para las dos, NO con `mockApi()`.
//
// `data-testid="notas-fila"` + `data-id` agregado en
// notas.js::renderTabla() — mismo criterio que proveedores/clientes.
//
// Búsqueda y filtro de tipo — 100% server-side (viajan como parámetros
// `p_busqueda`/`p_tipo` de la RPC, migración 263 — antes traía hasta 500
// filas fijas de `cta_cte` y filtraba en el navegador). `buscar()` espera
// el debounce de 250ms antes de que dispare la RPC de nuevo, igual que en
// proveedores.page.js.
//
// Confirmación — `guardarNota()` (alta) SIEMPRE pide `window.confirmar()`
// con labels custom ("Emitir"/"Revisar", no los default "Confirmar"/
// "Cancelar") antes de disparar la RPC — el texto cambia pero
// `[data-action="ok"|"cancel"]` es el mismo selector de siempre. El botón
// "Emitir Nota" además pasa por `btnAsyncClick()` (agrega `btn--loading`
// mientras corre), pero sin `opts.confirm` — la confirmación la maneja
// `guardarNota()` internamente, no `btnAsyncClick`.
//
// Detalle de nota — `verDetalleNota(id)` NO hace fetch aparte: lee del
// array `notas` que ya quedó en memoria desde `cargarNotas()`. No hay
// nada que mockear más allá de la RPC de listado para que el modal de
// detalle muestre datos.
//
// Toast — `window.mostrarToast` (no `window.toast` como en
// proveedores/usuarios) — mismo helper de ui-utils.js por debajo, el
// getter `toast` heredado de PageObjectBase sigue aplicando igual.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class NotasPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/notas.html`);
    await this.esperarAppLista();
  }

  // ── Tabla principal ─────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="notas-fila"]'); }

  fila(id) {
    return this.page.locator(`[data-testid="notas-fila"][data-id="${id}"]`);
  }

  // ── Filtros / búsqueda (server-side vía RPC, ver nota arriba) ──────────
  get inputBusqueda() { return this.page.locator('#buscar-nota'); }
  get filtroTipo()    { return this.page.locator('#filtro-tipo-nota'); }

  async buscar(texto) {
    // FIX (CI 2026-09-05, ronda 2): la primera versión de este fix usaba
    // waitForRequest, pero ese evento puede dispararse ANTES de que el
    // handler de page.route() (donde el mock de notas.spec.js asigna
    // `ultimosParams`) termine de correr — no hay orden garantizado entre
    // el evento 'request' de Playwright y la resolución del handler async
    // registrado con page.route(). Esperar la RESPUESTA en cambio sí
    // garantiza que el handler ya terminó (tuvo que llamar a
    // route.fulfill() para que la respuesta exista), así que cuando el
    // test lee la variable capturada por el mock, ya está actualizada.
    const esperaRpc = this.page.waitForResponse((res) =>
      res.url().includes('/rest/v1/rpc/fn_notas_lista') && res.request().method() === 'POST'
    );
    await this.inputBusqueda.fill(texto);
    await esperaRpc;
  }

  async filtrarPorTipo(valor) {
    // FIX (CI 2026-09-05, ronda 2): mismo motivo que buscar() — esperar la
    // respuesta en vez de la request garantiza que el handler de
    // page.route() ya asignó `ultimosParams` antes de que el test lo lea.
    const esperaRpc = this.page.waitForResponse((res) =>
      res.url().includes('/rest/v1/rpc/fn_notas_lista') && res.request().method() === 'POST'
    );
    await this.filtroTipo.selectOption(valor);
    await esperaRpc;
  }

  // ── Paginación (inyectada por JS — ver inyectarControlesPaginacionNotas) ──
  get btnPaginaAnterior() { return this.page.locator('#btn-prev-notas'); }
  get btnPaginaSiguiente() { return this.page.locator('#btn-next-notas'); }
  get infoPagina() { return this.page.locator('#info-pag-notas'); }

  // ── Ver detalle (onclick inline, ver renderTabla()) ─────────────────────
  // FIX: el botón real es `<button class="btn-tabla">Ver</button>` (ver
  // renderTabla() en notas.js) — nunca tuvo clase `btn-icon` ni atributo
  // `title="Ver detalle"` (ese title es del kebab de "Más acciones", que
  // es un botón aparte). El selector viejo nunca matcheaba nada.
  botonVerDetalle(id) { return this.fila(id).getByRole('button', { name: 'Ver' }); }

  async abrirDetalle(id) {
    await this.botonVerDetalle(id).click();
    await expect(this.modalDetalle).toBeVisible();
  }

  // ── Modal detalle ────────────────────────────────────────────────────
  get modalDetalle()  { return this.page.locator('#modal-detalle-nota'); }
  get detalleTipo()   { return this.page.locator('#detalle-nota-tipo'); }
  get detalleNumero() { return this.page.locator('#detalle-nota-numero'); }
  get detalleFecha()  { return this.page.locator('#detalle-nota-fecha'); }
  get detalleMonto()  { return this.page.locator('#detalle-nota-monto'); }
  get detalleCliente() { return this.page.locator('#detalle-nota-cliente'); }
  get detalleMotivo() { return this.page.locator('#detalle-nota-motivo'); }

  async cerrarDetalle() {
    await this.page.locator('#modal-detalle-nota .modal-close').click();
  }

  // ── Modal alta ───────────────────────────────────────────────────────
  // Mismo hallazgo que en cheques.page.js/proveedores.page.js: sin
  // `exact: true`, matchea también el chip del topbar (`.topbar-right`,
  // ver topbar-widgets.js::_armarMenuChip), cuyo nombre accesible absorbe
  // el texto de "Nueva Nota" + el resto de sus hijos.
  get btnNuevaNota() { return this.page.getByRole('button', { name: 'Nueva Nota', exact: true }); }
  get modal()        { return this.page.locator('#modal-nota'); }
  get btnTipoCredito() { return this.page.locator('#btn-tipo-credito'); }
  get btnTipoDebito()  { return this.page.locator('#btn-tipo-debito'); }
  get selectCliente()  { return this.page.locator('#nota-cliente'); }
  get inputMonto()      { return this.page.locator('#nota-monto'); }
  get inputFecha()      { return this.page.locator('#nota-fecha'); }
  get inputMotivo()     { return this.page.locator('#nota-motivo'); }
  get btnGuardar()      { return this.page.locator('#btn-guardar-nota'); }

  async abrirModalNueva() {
    await this.btnNuevaNota.click();
    await expect(this.modal).toBeVisible();
    // FIX: cargarClientes() corre en paralelo con cargarNotas() dentro del
    // mismo `Promise.all` (notas.html tampoco tiene `#app-preloader`) — el
    // modal se puede abrir antes de que `#nota-cliente` tenga sus
    // `<option>` reales (arranca completamente vacío en el HTML, ver
    // notas.html). `selectOption()` no reintenta si la opción todavía no
    // existe — falla al toque en vez de colgarse, pero sigue siendo una
    // carrera real. Se espera a que el select deje de estar vacío.
    await expect(this.selectCliente.locator('option')).not.toHaveCount(0);
  }

  async completarFormulario({ tipo, clienteId, monto, fecha, motivo } = {}) {
    if (tipo === 'credito') await this.btnTipoCredito.click();
    if (tipo === 'debito') await this.btnTipoDebito.click();
    if (clienteId !== undefined) await this.selectCliente.selectOption(clienteId);
    if (monto !== undefined) await this.inputMonto.fill(String(monto));
    if (fecha !== undefined) await this.inputFecha.fill(fecha);
    if (motivo !== undefined) await this.inputMotivo.fill(motivo);
  }

  // ── Confirmación (overlay de window.confirmar(), SIEMPRE en el alta) ────
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk()   { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  /** Click en "Emitir Nota" + confirma el diálogo — guardarNota() SIEMPRE lo pide. */
  async guardarConfirmando() {
    await this.btnGuardar.click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  /** Click en "Emitir Nota" + CANCELA el diálogo — no debería disparar la RPC. */
  async guardarYCancelar() {
    await this.btnGuardar.click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarCancelar.click();
  }
}
