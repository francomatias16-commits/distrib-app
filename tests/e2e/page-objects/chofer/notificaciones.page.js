// Page object para `frontend/chofer/notificaciones.html` — historial de
// `notif_log` (4/5 del bloque, ver PLAN_E2E_COBERTURA_TOTAL.md sección
// 29). Versión más simple que `cliente/notificaciones.page.js`: sin
// chips de filtro por tipo, sin botón de activar push — solo lista +
// "Ver más". El comentario del propio HTML aclara la razón de fondo:
// acá no hace falta resolver ningún id intermedio (a diferencia del
// portal cliente, que resuelve `cliente_id`) porque
// `notif_log_select_unificada` (migración 434) filtra directo por
// `usuario_id = auth.uid()` para rol chofer.
//
// Mismo patrón de paginación que el portal cliente: `.range()` viaja
// como header HTTP `Range`, no como query param — el spec arma el mock
// leyendo ese header, no `url.searchParams`.
//
// `TIPO_CONFIG` en el HTML solo conoce `ruta_asignada` hoy — el mapa
// queda deliberadamente abierto para sumar tipos nuevos sin tocar el
// resto de la página; un tipo no mapeado cae al fallback (emoji 🔔,
// label = el tipo crudo tal cual llega de la base). Vale un test propio,
// no solo el camino feliz con `ruta_asignada`.

import { expect } from '@playwright/test';

export class ChoferNotificacionesPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/chofer/notificaciones.html`);
    await expect(this.listaNotif.locator('.loading')).toHaveCount(0, { timeout: 10_000 });
  }

  get listaNotif()   { return this.page.locator('#listaNotif'); }
  get btnCargarMas() { return this.page.locator('#btnCargarMas'); }
  get btnBack()      { return this.page.locator('.btn-back'); }

  cardsNotif() {
    return this.listaNotif.locator('.card-notif');
  }

  cardPorLabel(label) {
    return this.listaNotif.locator('.card-notif', { hasText: label });
  }

  async cargarMas() {
    await this.btnCargarMas.click();
  }
}
