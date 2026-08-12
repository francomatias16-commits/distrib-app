// Page object para `frontend/cliente/pedidos.html`. Listado vía
// `sb.from('pedidos').select(...).eq('cliente_id', clienteId)`, con
// filtro opcional por estado (`.eq('estado', filtroActivo)`) — server-side,
// cada click en un chip dispara `cargarPedidos()` de nuevo. "Pagar
// online" (pedidos confirmado/preparando) y "Ver seguimiento en vivo"
// (solo despachado) son botones condicionales dentro del detalle
// expandible de cada card — `toggleDetalle()` es CSS puro (`.visible`),
// no dispara request.
//
// OJO — seguimiento en vivo usa Leaflet (`L.map`/`L.marker`, CDN
// `cdnjs.cloudflare.com/ajax/libs/leaflet`), que a diferencia de
// Dexie/supabase-js/PapaParse TODAVÍA NO está vendorizado en
// `fixtures/vendor/` (nadie lo necesitó hasta esta página). El spec
// inyecta un stub mínimo de `window.L` (NO la librería real) solo para
// los tests de seguimiento, para no ensuciarlos con el mismo bloqueo de
// CDN que ya se resolvió para las otras 3 libs — ver nota en el spec y
// sección 29 del plan. El resto de los tests de esta página no lo
// necesitan.
//
// `manejarRetornoDePago()` (query params `?pago=exitoso|pendiente|fallido&
// pedido=<id>` que manda Mercado Pago al volver) se ejecuta SIEMPRE
// después de la carga inicial — fuera de alcance de este page object por
// ahora (mismo patrón "candidato a próxima vuelta" que otras páginas del
// plan); cubrir si hace falta.

import { expect } from '@playwright/test';

export class ClientePedidosPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/cliente/pedidos.html`);
    await expect(this.listaPedidos.locator('.loading')).toHaveCount(0, { timeout: 10_000 });
  }

  get filtrosScroll() { return this.page.locator('#filtrosScroll'); }
  get listaPedidos()  { return this.page.locator('#listaPedidos'); }
  get overlaySeguimiento() { return this.page.locator('#overlaySeguimiento'); }
  get etaTexto()       { return this.page.locator('#etaTexto'); }
  get btnCerrarSeguimiento() { return this.page.locator('#btnCerrarSeguimiento'); }

  chipFiltro(estado) {
    return this.filtrosScroll.locator(`.chip-filtro[data-estado="${estado}"]`);
  }

  async filtrarPor(estado) {
    await this.chipFiltro(estado).click();
    await expect(this.listaPedidos.locator('.loading')).toHaveCount(0, { timeout: 10_000 });
  }

  cardPorNumero(numeroPedido) {
    return this.listaPedidos.locator('.card-pedido', { hasText: numeroPedido });
  }

  async toggleDetalle(numeroPedido) {
    await this.cardPorNumero(numeroPedido).locator('.pedido-header').click();
  }

  botonPagarOnline(numeroPedido) {
    return this.cardPorNumero(numeroPedido).locator('button.btn-seguimiento', { hasText: 'Pagar online' });
  }

  botonVerSeguimiento(numeroPedido) {
    return this.cardPorNumero(numeroPedido).locator('button.btn-seguimiento', { hasText: 'Ver seguimiento en vivo' });
  }

  async abrirSeguimiento(numeroPedido) {
    await this.botonVerSeguimiento(numeroPedido).click();
    await expect(this.overlaySeguimiento).toHaveClass(/show/);
  }

  async cerrarSeguimiento() {
    await this.btnCerrarSeguimiento.click();
    await expect(this.overlaySeguimiento).not.toHaveClass(/show/);
  }
}
