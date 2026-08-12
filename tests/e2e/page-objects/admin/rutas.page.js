// Page object de Fase 2 (P1), primera página del bloque "operación de
// depósito" (rutas / lotes-vencimientos / devoluciones-cheques-conciliación
// / usuarios-proveedores-notas-presupuestos / portal cliente+chofer — ver
// PLAN_E2E_COBERTURA_TOTAL.md, priorización de Fase 2).
//
// Particularidad de esta página frente a las 9 de Fase 1: el tab "Armar
// ruta" (`#tab-armar-content`) NO es el que está activo por defecto — el
// que carga al entrar es "Resumen" (`#tab-resumen-content`), y
// `#tab-armar-content` arranca con `class="hidden"` (ver rutas.html). El
// panel de armado igual se llena en memoria desde `cargarDatos()` (corre
// en el DOMContentLoaded sin importar qué tab está visible), pero
// cualquier aserción de visibilidad sobre sus elementos falla si no se
// cambia de tab antes — por eso `goto()` cambia a "armar" automáticamente
// en vez de dejarlo a cargo de cada test.
//
// `rutas.html` también carga `rutas-resumen.js` (dashboard de la tab
// "Resumen"), que dispara sus propias queries PostgREST contra `rutas`
// apenas resuelve `authReady` — sin relación con el flujo bajo test acá,
// las cubre el catch-all de `mockearRestGenerico` (devuelve `[]`, no
// revienta nada). Fuera de alcance de este spec a propósito.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class RutasPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/rutas.html`);
    await this.esperarAppLista();
    await this.abrirTabArmar();
  }

  async abrirTabArmar() {
    await this.page.locator('#tab-armar').click();
    await expect(this.page.locator('#tab-armar-content')).not.toHaveClass(/hidden/);
  }

  // ── Filtro de fecha (compartido resumen/armar/rutas del día) ─────────
  get filtroFecha() { return this.page.locator('#filtro-fecha'); }

  // ── Panel izquierdo: pedidos pendientes de despacho ───────────────────
  get buscarPendiente() { return this.page.locator('#buscar-pendiente'); }
  get labelPendientes() { return this.page.locator('#label-pendientes'); }
  get listaPendientes() { return this.page.locator('#lista-pendientes'); }

  pedidoCard(pedidoId) {
    return this.page.locator(`.pedido-card[data-id="${pedidoId}"]`);
  }

  /** Header del grupo de zona que contiene una card (agruparZona=true, el
   *  default). El nombre de zona se pinta acá, no en cada card individual
   *  — ver `cardPedidoHtml(p, { mostrarZona: false })` en rutas.js. */
  grupoZonaDe(pedidoId) {
    return this.pedidoCard(pedidoId).locator('xpath=ancestor::div[contains(@class,"grupo-zona")][1]').locator('.grupo-zona-nombre');
  }

  /** Click para agregar (mismo resultado que el drag&drop, ver título del card). */
  async agregarPedido(pedidoId) {
    await this.pedidoCard(pedidoId).click();
  }

  // ── Panel derecho: ruta en construcción ───────────────────────────────
  get dropEmpty() { return this.page.locator('#drop-empty'); }
  get listaRuta() { return this.page.locator('#lista-ruta'); }
  get statPedidos() { return this.page.locator('#stat-pedidos'); }
  get statTotal() { return this.page.locator('#stat-total'); }

  async quitarPedido(pedidoId) {
    await this.listaRuta.locator(`button.btn-quitar[onclick*="${pedidoId}"]`).click();
  }

  // ── Formulario de cabecera de la ruta ─────────────────────────────────
  get rutaFecha() { return this.page.locator('#ruta-fecha'); }
  get rutaChofer() { return this.page.locator('#ruta-chofer'); }
  get rutaNotas() { return this.page.locator('#ruta-notas'); }
  get btnConfirmarRuta() { return this.page.locator('#btn-confirmar-ruta'); }
  get btnLimpiarRuta() { return this.page.getByRole('button', { name: 'Limpiar' }); }

  /**
   * `confirmarRuta()` pide confirmación con `window.confirmar()` (overlay
   * propio) antes de mandar los inserts — mismo mecanismo ya documentado
   * en compras.page.js/cta-cte.page.js/cobranzas.page.js.
   */
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  /** Click en "Confirmar y notificar chofer" + aceptar el diálogo de confirmación. */
  async confirmarRuta() {
    await this.btnConfirmarRuta.click();
    await this.btnConfirmarOk.click();
  }

  // ── Rutas del día (tabla debajo del panel de armado) ──────────────────
  get tablaRutasDia() { return this.page.locator('#tabla-rutas-dia'); }
  get filasRutasDia() { return this.page.locator('#tabla-rutas-dia tr').filter({ hasNot: this.page.locator('td[colspan]') }); }
}
