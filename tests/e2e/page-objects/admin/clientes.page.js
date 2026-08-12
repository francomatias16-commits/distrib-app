// Page object de la Fase 1 (P0) para clientes.html — mismo patrón que
// pedidos.page.js. A diferencia de `tr.fila-pedido[data-id]`, la fila de
// clientes (`tr.fila-cliente` en clientes.js::renderTabla) NO traía ningún
// selector estable con el id (ni `id`, ni `data-*` propio) — solo la clase
// genérica `fila-cliente`. Se agregó `data-testid="clientes-fila"
// data-id="${c.id}"` en renderTabla() (clientes.js), mismo criterio que
// `data-testid="pos-carrito-fila"` en pos.js (v661) — ver 10.2 del plan:
// agregar data-testid puntual solo donde no hay nada estable, no en bloque.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class ClientesPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/clientes.html`);
    await this.esperarAppLista();
  }

  get filas() {
    return this.page.locator('[data-testid="clientes-fila"]');
  }

  fila(id) {
    return this.page.locator(`[data-testid="clientes-fila"][data-id="${id}"]`);
  }

  // El click que abre el detalle es el botón "Ver / Editar" dentro de la
  // fila (`onclick="abrirModalEditar('${c.id}')"`) — la fila en sí no tiene
  // listener propio (a diferencia de `tr.fila-pedido`, que sí abre al
  // clickear cualquier punto).
  async abrirDetallePorId(id) {
    await this.fila(id).locator('button.btn-editar').click();
    await expect(this.page.locator('#modal-titulo')).toBeVisible();
  }

  // ── Modal de detalle/edición ────────────────────────────────────────
  get modalTitulo() { return this.page.locator('#modal-titulo'); }
  get modalSubtitulo() { return this.page.locator('#modal-subtitulo'); }
  get creditoGrid() { return this.page.locator('#credito-grid'); }

  campoForm(nombre) {
    return this.page.locator(`#f-${nombre}`);
  }

  async cerrarModal() {
    // Mismo patrón que pedidos.page.js — función global enganchada por
    // onclick inline, sin id propio documentado para "cerrar" (el botón
    // de cerrar y el backdrop comparten `onclick="cerrarModal()"`).
    await this.page.evaluate(() => window.cerrarModal?.());
  }
}
