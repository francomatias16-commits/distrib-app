// Page object de conciliacion-bancaria.html — Fase 2 P1, cierra el bloque
// "devoluciones / cheques / conciliación bancaria" (ver
// PLAN_E2E_COBERTURA_TOTAL.md, sección 21). Standalone, JS propio
// (`conciliacion-bancaria.js`).
//
// A diferencia de devoluciones/cheques, esta página NO le pega a
// PostgREST/RPC en ningún lado — todo pasa por un único endpoint
// `/api/conciliacion-bancaria`, discriminado por método + querystring
// (`_svc=confirmar|deshacer|descartar|auto`, `lote_id`, `estado`). Una sola
// capa de red, se mockea entera con `mockApi` (ver spec).
//
// `data-testid="lote-item"`/`"mov-fila"` agregados en
// conciliacion-bancaria.js::renderLotes()/renderMovimientos() — ninguno de
// los dos traía selector estable con el id (mismo criterio que
// `dev-fila`/`cheque-fila`).
//
// Sin confirmación — a diferencia de cheques.js, ninguna de las acciones
// (confirmar match, deshacer, descartar, auto-conciliar) pasa por
// `window.confirmar()`: disparan el POST directo. Import de CSV tampoco.
//
// Gate de permisos — la página entera está condicionada al rol
// (`ROLES_LECTURA_CONCILIACION`/`ROLES_ESCRITURA_CONCILIACION`, ambos
// dueño/admin/contador hoy). Sin uno de esos roles: `#contenido-conciliacion`
// queda oculto y se muestra `#sin-permiso`. Con rol de lectura pero no
// habría un rol solo-lectura configurado actualmente (son la misma lista) —
// se deja el getter `wrapImport` para cuando eso cambie.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class ConciliacionBancariaPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/conciliacion-bancaria.html`);
    await this.esperarAppLista();
  }

  // ── Gate de permisos ────────────────────────────────────────────────
  get sinPermiso()   { return this.page.locator('#sin-permiso'); }
  get contenido()    { return this.page.locator('#contenido-conciliacion'); }
  get wrapImport()   { return this.page.locator('#wrap-import'); }

  // ── Importar CSV ────────────────────────────────────────────────────
  get inputCsv() { return this.page.locator('#input-csv'); }

  async importarCsv(contenido, nombreArchivo = 'extracto.csv') {
    await this.inputCsv.setInputFiles({
      name: nombreArchivo,
      mimeType: 'text/csv',
      buffer: Buffer.from(contenido, 'utf-8'),
    });
  }

  // ── Lotes (izquierda) ───────────────────────────────────────────────
  get listaLotes() { return this.page.locator('#lista-lotes'); }
  get lotes()       { return this.page.locator('[data-testid="lote-item"]'); }

  lote(loteId) {
    return this.page.locator(`[data-testid="lote-item"][data-id="${loteId}"]`);
  }

  async seleccionarLote(loteId) {
    await this.lote(loteId).click();
  }

  // ── KPIs ────────────────────────────────────────────────────────────
  get kpisGrid() { return this.page.locator('#kpis-grid'); }

  // ── Filtro + auto-conciliar ─────────────────────────────────────────
  get filtroEstado()     { return this.page.locator('#filtro-estado-mov'); }
  get btnAutoConciliar() { return this.page.locator('#btn-auto-conciliar'); }
  get tituloMovimientos(){ return this.page.locator('#titulo-movimientos'); }

  // ── Tabla de movimientos ────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="mov-fila"]'); }

  fila(movId) {
    return this.page.locator(`[data-testid="mov-fila"][data-id="${movId}"]`);
  }

  botonConfirmar(movId, cobroId) {
    // El botón "Confirmar" de cada candidato no lleva id propio — se
    // ubica por el texto del candidato (fecha+monto), único dentro de la
    // fila. Si hay varios candidatos en la fixture, `.first()` toma el
    // primero — para elegir uno puntual hay que acotar antes con
    // `.candidato-item:has-text(...)` desde el spec.
    return this.fila(movId).getByRole('button', { name: 'Confirmar' }).first();
  }

  botonDeshacer(movId) {
    return this.fila(movId).getByRole('button', { name: 'Deshacer' });
  }

  botonDescartar(movId) {
    return this.fila(movId).getByRole('button', { name: 'Descartar' });
  }
}
