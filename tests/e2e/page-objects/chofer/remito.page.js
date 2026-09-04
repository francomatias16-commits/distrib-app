// Page object para `frontend/chofer/remito.html` — detalle de un remito
// (última página del bloque chofer, ver PLAN_E2E_RECORTADO.md sección 3).
//
// Particularidades reales de esta página (no del arnés):
// - El id del remito viaja por query string (`?id=...`), no por path.
// - `GET /api/chofer/remitos?id=X` (detalle) y `POST /api/chofer/remitos`
//   (marcar despachado) comparten el mismo path base que usa `gps-tracker.js`
//   para su propio polling best-effort — por eso `mockApi` se registra con
//   la ruta base primero y las rutas más específicas (`/entregar`,
//   `/no-entregar`, `/entrega-foto`) después, para que ganen por LIFO
//   (ver mock-network.js, mismo criterio que chofer/index.page.js).
// - La firma es un `<canvas>`: no hay "click", hay que simular un trazo
//   con mouse down/move/up (`dibujarFirma()` de abajo). El botón de
//   confirmar entrega pulsa (`.urgente--pulso`) mientras no haya trazo —
//   no es un estado a testear con `toBeVisible`, es solo CSS.
// - `gps-tracker.js` (cargado sin defer, antes que el resto) intenta
//   watchPosition apenas carga la página — es 100% best-effort (si el
//   navegador de test no da permiso de geolocalización, el catch de
//   `[gps-tracker] geolocalización no disponible` lo absorbe en silencio y
//   la página funciona igual). No hace falta mockear
//   `context.grantPermissions(['geolocation'])` para que el resto del
//   flujo ande — mismo criterio ya documentado en chofer/index.page.js.

import { expect } from '@playwright/test';

export class ChoferRemitoPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto(pedidoId) {
    await this.page.goto(`${this.baseURL}/chofer/remito?id=${pedidoId}`);
  }

  get numeroRemito()   { return this.page.locator('#numeroRemito'); }
  get cuerpoRemito()   { return this.page.locator('#cuerpoRemito'); }
  get emptyState()     { return this.cuerpoRemito.locator('.empty-state'); }

  get btnDespachar()        { return this.page.locator('#btnDespachar'); }
  get btnEntregar()         { return this.page.locator('#btnEntregar'); }
  get btnNoEntregar()       { return this.page.locator('#btnNoEntregar'); }
  get btnAbrirDevolucion()  { return this.page.locator('#btnAbrirDevolucion'); }

  // ── Modal "Confirmar entrega" ──────────────────────────────────────────
  get overlayEntrega()          { return this.page.locator('#overlayEntrega'); }
  get canvasFirma()             { return this.page.locator('#canvasFirma'); }
  get btnLimpiarFirma()         { return this.page.locator('#btnLimpiarFirma'); }
  get alertaEntrega()           { return this.page.locator('#alertaEntrega'); }
  get receptorEntrega()         { return this.page.locator('#receptorEntrega'); }
  get cobroMonto()               { return this.page.locator('#cobroMonto'); }
  get cobroMedio()               { return this.page.locator('#cobroMedio'); }
  get btnConfirmarEntregaFinal() { return this.page.locator('#btnConfirmarEntregaFinal'); }
  get btnCancelarEntrega()       { return this.page.locator('#btnCancelarEntrega'); }

  // ── Modal "No se pudo entregar" ────────────────────────────────────────
  get overlayNoEntrega()      { return this.page.locator('#overlayNoEntrega'); }
  get motivoNoEntrega()       { return this.page.locator('#motivoNoEntrega'); }
  get btnConfirmarNoEntrega() { return this.page.locator('#btnConfirmarNoEntrega'); }
  get btnCancelarNoEntrega()  { return this.page.locator('#btnCancelarNoEntrega'); }

  async abrirModalEntrega() {
    await this.btnEntregar.click();
    await expect(this.overlayEntrega).toHaveClass(/show/);
  }

  async abrirModalNoEntrega() {
    await this.btnNoEntregar.click();
    await expect(this.overlayNoEntrega).toHaveClass(/show/);
  }

  /** Simula un trazo real de firma sobre el canvas (mouse down→move→up). */
  async dibujarFirma() {
    const box = await this.canvasFirma.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x - 20, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x, y - 10, { steps: 4 });
    await this.page.mouse.move(x + 20, y, { steps: 4 });
    await this.page.mouse.up();
  }

  async confirmarEntrega() {
    await this.btnConfirmarEntregaFinal.click();
  }
}
