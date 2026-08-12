// Page object para `frontend/cliente/notificaciones.html`. Historial de
// `notif_log` con paginación real (`.range(offset, offset+19)`, PAGE=20)
// y filtro por `tipo` — a diferencia de `pedidos.html` (mismo portal),
// acá NO hay `.eq('cliente_id', ...)` en el query: el comentario del HTML
// aclara que RLS (`notif_log_select_unificada`) es quien filtra, a
// propósito, para no depender de que este script resuelva bien el
// cliente_id. El page object no necesita mockear nada distinto por eso,
// pero vale tenerlo presente si un test futuro quisiera verificar
// aislamiento entre clientes — acá no se puede, es responsabilidad de la
// política de la base, no de esta página.
//
// `.range()` viaja como header HTTP `Range: <offset>-<offset+19>`, no
// como query param — por eso el spec arma el mock de paginación leyendo
// ese header en vez de `url.searchParams`.
//
// Botón "Activar notificaciones": mismo botón/mismo criterio que
// `cuenta.page.js` (OJO 2 ahí) — solo se testea visibilidad, no el click.

import { expect } from '@playwright/test';

export class ClienteNotificacionesPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/cliente/notificaciones.html`);
    await expect(this.listaNotif.locator('.loading')).toHaveCount(0, { timeout: 10_000 });
  }

  get listaNotif()     { return this.page.locator('#listaNotif'); }
  get filtrosScroll()  { return this.page.locator('#filtrosScroll'); }
  get btnCargarMas()   { return this.page.locator('#btnCargarMas'); }
  get btnActivarPush() { return this.page.locator('#btnActivarPush'); }

  chipFiltro(tipo) {
    return this.filtrosScroll.locator(`.chip-filtro[data-tipo="${tipo}"]`);
  }

  async filtrarPor(tipo) {
    await this.chipFiltro(tipo).click();
    await expect(this.listaNotif.locator('.loading')).toHaveCount(0, { timeout: 10_000 });
  }

  async cargarMas() {
    await this.btnCargarMas.click();
  }

  cardsNotif() {
    return this.listaNotif.locator('.card-notif');
  }

  cardPorLabel(label) {
    return this.listaNotif.locator('.card-notif', { hasText: label });
  }
}
