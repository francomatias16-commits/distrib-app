// Page object para `frontend/chofer/index.html` — home del portal
// (2/5 del bloque, ver PLAN_E2E_COBERTURA_TOTAL.md sección 29). A
// diferencia de `login.html`, esta SIEMPRE asume sesión sembrada de
// antemano con `sembrarSesionChofer` (salvo el spec que ejercita
// justamente el caso "sin sesión").
//
// Particularidades reales de esta página (no del arnés):
// - El dato de la ruta NO sale de PostgREST directo, sale de
//   `GET /api/chofer/remitos` (capa `/api/*`, con
//   `Authorization: Bearer <token>` armado a mano en el fetch) — usar
//   `mockApi`, no `mockearTabla`.
// - `gps-tracker.js` (cargado sin defer, antes que el resto) pega su
//   PROPIO fetch a esa misma ruta apenas carga la página, además del que
//   dispara `cargarRuta()` — cualquier spec que cuente invocaciones de
//   `/api/chofer/remitos` va a ver 2+ llamadas por carga, no 1. No es un
//   bug, y por eso el spec de esta página no hace asserts de conteo
//   sobre ese endpoint.
// - "Cerrar sesión" (`btnSalir`) usa `confirm()` NATIVO del navegador
//   (sin overlay en el DOM) — se acepta con `page.once('dialog', ...)`,
//   mismo patrón que `cliente/cuenta.page.js::canjear()`.

import { expect } from '@playwright/test';

export class ChoferIndexPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/chofer`);
  }

  get fechaHoy()            { return this.page.locator('#fechaHoy'); }
  get resumenBar()          { return this.page.locator('#resumenBar'); }
  get numTotal()            { return this.page.locator('#numTotal'); }
  get numPendientes()       { return this.page.locator('#numPendientes'); }
  get numEntregados()       { return this.page.locator('#numEntregados'); }
  get listaRemitos()        { return this.page.locator('#listaRemitos'); }
  get emptyState()          { return this.listaRemitos.locator('.empty-state'); }
  get btnRefrescar()        { return this.page.locator('#btnRefrescar'); }
  get btnSalir()            { return this.page.locator('#btnSalir'); }
  get linkNotificaciones()  { return this.page.locator('a[href="/chofer/notificaciones"]'); }

  card(pedidoId) {
    return this.listaRemitos.locator(`.card-remito[data-id="${pedidoId}"]`);
  }

  async abrirCard(pedidoId) {
    await this.card(pedidoId).click();
  }

  async refrescar() {
    await this.btnRefrescar.click();
  }

  /** Acepta el `confirm()` nativo de "¿Cerrar sesión?". */
  async salir() {
    this.page.once('dialog', (d) => d.accept());
    await this.btnSalir.click();
  }

  /** Rechaza el `confirm()` — el flujo de salida real que un chofer puede tomar por error. */
  async cancelarSalir() {
    this.page.once('dialog', (d) => d.dismiss());
    await this.btnSalir.click();
  }
}
