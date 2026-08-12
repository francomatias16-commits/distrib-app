// Page object de la pestaña "Presupuestos" — cuarta y última página del
// bloque "usuarios / proveedores / notas / presupuestos" (ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 27). NO es una página standalone:
// `presupuestos.html` es un stub de redirect de compatibilidad
// (`window.location.replace('/admin/pedidos?tab=presupuestos')`, ver
// REQ-05) — el módulo real (`presupuestos.js`, 670 líneas, IIFE con
// prefijo `pres_`) vive como pestaña de `pedidos.html`, cargado
// condicionalmente. `pedidos.html?tab=presupuestos` activa la pestaña
// sola al cargar (ver script inline al final del HTML), así que `goto()`
// va directo ahí en vez de simular el click en la pestaña.
//
// `data-testid="presupuestos-fila"` + `data-id` agregado en
// presupuestos.js::pres_renderTabla() — la fila SÍ se arma con
// `document.createElement('tr')` (no template literal, a diferencia de
// proveedores/notas), así que el testid se setea con `tr.dataset.testid`
// en vez de interpolarlo en un string.
//
// `/api/presupuestos` (no PostgREST) para todo el CRUD — mockear con
// `mockApi()`, mismo patrón que proveedores.page.js. Además dispara
// `sb.from('clientes').select(...)` al inicializar la pestaña
// (`pres_cargarClientes()`, para el <select> del modal de alta) — mockear
// con `mockearTabla('clientes', ...)` o dejar que el catch-all de
// `mockearRestGenerico` lo cubra si el spec no necesita clientes reales.
//
// Búsqueda — a diferencia de proveedores/notas (ambas server-side), acá
// `pres_aplicarFiltros()` filtra el array `_presData` YA cargado, EN EL
// NAVEGADOR — no dispara ningún request nuevo. `buscar()` no espera
// debounce porque no hay: filtra sincrónico en el evento `input`.
//
// Confirmación — tres mecanismos DISTINTOS en la misma pestaña, ninguno
// intercambiable con otro:
//   - `pres_eliminarPresupuesto()` → `window.confirmar()` (overlay
//     custom, mismo `[data-action="ok"|"cancel"]` de siempre).
//   - `pres_rechazar()` → `confirm()` NATIVO del navegador — Playwright lo
//     intercepta con `page.on('dialog', ...)`, NO hay overlay en el DOM
//     para localizar. Ver `rechazar()` abajo.
//   - `pres_aceptarYGenerarPedido()` → SIN confirmación, dispara el PATCH
//     directo al click.
//
// Alta de presupuesto ("Nuevo presupuesto") — usa `ProductoPicker`
// (lazy-init, mismo componente que pedidos.html) para armar los ítems.
// Fuera de alcance de este page object por la misma razón que
// pedidos.page.js dejó afuera "crear pedido": mockear bien el picker es
// superficie propia que no vale la pena resolver a ciegas sin poder
// correr el test acá — ver README de la suite.
//
// WhatsApp — `pres_enviarWhatsApp()`/`pres_enviarYNotificar()` abren
// `wa.me` con `window.open(url, '_blank')`. Se intercepta con
// `page.waitForEvent('popup')` en vez de mockear una URL — el link nunca
// llega a navegar de verdad en el contexto de test porque no hay red
// hacia `wa.me` habilitada, pero la popup SÍ se abre y se puede leer su
// URL antes de cerrarla.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class PresupuestosPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/pedidos.html?tab=presupuestos`);
    await this.esperarAppLista();
    await expect(this.page.locator('#panel-presupuestos')).toHaveClass(/activo/);
  }

  // ── Tabla principal ─────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="presupuestos-fila"]'); }

  fila(id) {
    return this.page.locator(`[data-testid="presupuestos-fila"][data-id="${id}"]`);
  }

  get contador() { return this.page.locator('#pres-contador'); }

  // ── Filtros — pills de estado (server-side) + búsqueda (in-memory) ──────
  get inputBusqueda() { return this.page.locator('#pres-busqueda'); }

  pillEstado(estado) {
    // Migrado a FiltroTabs (frontend/shared/filtro-tabs.js): el contenedor
    // pasó a ser `#filtro-tabs-pres-estado` (antes `#pres-estado-pills`) y
    // cada botón ahora expone `data-key` en vez de un `onclick` inline con
    // el estado embebido en el string — usamos ese atributo en vez de
    // parsear `onclick*="pres_selEstado(...)"`, que ya no existe.
    return this.page.locator(`#filtro-tabs-pres-estado button[data-key="${estado}"]`);
  }

  async filtrarPorEstado(estado) {
    await this.pillEstado(estado).click();
  }

  /** Filtra EN EL NAVEGADOR (no hay debounce, no dispara request nuevo) — ver nota arriba. */
  async buscar(texto) {
    await this.inputBusqueda.fill(texto);
  }

  // ── Acciones de fila (onclick inline, ver pres_renderTabla()) ────────────
  botonVer(id) { return this.fila(id).locator('button.btn-acc', { hasText: 'Ver' }); }
  botonEnviarWhatsapp(id) { return this.fila(id).locator('button.btn-acc', { hasText: /Enviar por WhatsApp|Reenviar WhatsApp/ }); }
  botonEliminar(id) { return this.fila(id).locator('button.btn-danger', { hasText: 'Eliminar' }); }

  async abrirDetalle(id) {
    await this.botonVer(id).click();
    await expect(this.panelDetalle).toHaveClass(/abierto/);
  }

  // ── Panel lateral de detalle ─────────────────────────────────────────
  get panelDetalle() { return this.page.locator('#pres-panel-detalle'); }
  get panelNombre()  { return this.page.locator('#pres-panel-nombre'); }
  get panelBody()    { return this.page.locator('#pres-panel-body'); }

  botonPanel(textoOAccion) {
    return this.panelBody.locator(`button[onclick*="${textoOAccion}"]`);
  }

  cerrarPanel() {
    // pres_cerrarPanel() no tiene botón dedicado en el HTML dado — se
    // cierra como side-effect de otras acciones (eliminar, rechazar,
    // aceptar). No se expone un método de cierre manual a propósito.
  }

  // ── Eliminar (window.confirmar, overlay custom) ──────────────────────
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk()   { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  /** Click en "Eliminar" de una fila + confirma el overlay custom. */
  async eliminarFila(id) {
    await this.botonEliminar(id).click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  /** "Eliminar" desde el panel de detalle (mismo mecanismo, distinto botón). */
  async eliminarDesdePanel() {
    await this.botonPanel('pres_eliminarPresupuesto').click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  // ── Rechazar (confirm() NATIVO — sin overlay en el DOM, ver nota arriba) ──
  /** Click en "Rechazar" del panel y acepta el confirm() nativo del navegador. */
  async rechazarDesdePanel() {
    this.page.once('dialog', (dialog) => dialog.accept());
    await this.botonPanel('pres_rechazar').click();
  }

  /** Igual que rechazarDesdePanel() pero cancela el confirm() nativo. */
  async rechazarDesdePanelYCancelar() {
    this.page.once('dialog', (dialog) => dialog.dismiss());
    await this.botonPanel('pres_rechazar').click();
  }

  // ── Aceptar y generar pedido (SIN confirmación) ───────────────────────
  async aceptarYGenerarPedidoDesdePanel() {
    await this.botonPanel('pres_aceptarYGenerarPedido').click();
  }

  // ── Enviar por WhatsApp (window.open — intercepción de popup) ──────────
  /**
   * Click en "Enviar por WhatsApp"/"Reenviar WhatsApp" de una fila y
   * devuelve la URL de wa.me que se intentó abrir, sin dejarla navegar
   * de verdad (no hay red hacia wa.me habilitada en el entorno de test).
   */
  async enviarWhatsappYCapturarUrl(id) {
    // BUG DEL TEST, no de la app: wa.me hace un redirect 30x real a
    // api.whatsapp.com/send/?... — si dejamos que el popup navegue de
    // verdad, `popup.url()` termina mostrando la URL post-redirect (y
    // pegándole a la red real desde una suite que se supone 100%
    // mockeada). Interceptamos wa.me para que el popup se quede ahí
    // (sin seguir el redirect) y así `popup.url()` refleje exactamente
    // lo que generó el código, que es lo que el test quiere verificar.
    await this.page.context().route('https://wa.me/**', (route) => {
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
    });
    const [popup] = await Promise.all([
      this.page.waitForEvent('popup'),
      this.botonEnviarWhatsapp(id).click(),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    const url = popup.url();
    await popup.close();
    return url;
  }
}
