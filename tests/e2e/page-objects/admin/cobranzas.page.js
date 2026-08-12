// Page object de Fase 1 (P0), quinta página después de pedidos/pos/stock/
// facturacion (ver PLAN_E2E_COBERTURA_TOTAL.md, sección 12 — orden:
// pedidos, pos, stock, facturacion, cobranzas, clientes, cta-cte, compras,
// productos).
//
// OJO — cobranzas.html en realidad renderiza DOS pantallas fusionadas
// (Fase 0 auditoría IA/UX): la pestaña "¿A quién llamo hoy?" (lógica en
// cobranzas.js, `#vista-cobranza`) y "Saldos por cliente" (ex /admin/cta-cte,
// lógica en cta-cte.js, `#vista-saldos`), conmutadas client-side por
// `cambiarVistaPrincipal()` sin recargar. Este page-object (y el spec que
// lo usa) cubre A PROPÓSITO solo la primera — la pestaña "Saldos" tiene su
// propio módulo (cta-cte.js) con su propio flujo de escritura
// (`guardarCobro`, ficha de cliente) y le corresponde su propia página en
// el plan (cta-cte, más adelante en el orden). Acá solo se verifica que
// el botón "Cobrar" de una fila cruza a esa vista — el contenido de esa
// vista se prueba en cta-cte.spec.js.
//
// data-testid agregado (10.2 sigue aplicando, mismo gap que
// `factura-fila`/`pos-carrito-fila` en páginas anteriores): ninguna de las
// 2 tablas de esta pestaña (`hoy`/`semana`/`vencidas` y `priorizada`)
// traía selector estable por fila. Se agregaron `data-testid="cobranza-
// fila" data-id="${f.id}"` en `renderFacturas()` y `data-testid="cobranza-
// priorizada-fila" data-cliente-id="${f.cliente_id}"` en `renderPriorizada()`
// (cobranzas.js) — `f.factura_id` puede venir null en priorizada (deuda
// sin comprobante, ver comentario en `abrirCobroPriorizadaIdx`), por eso
// ese selector usa `cliente_id` en vez de `factura_id`/`id`.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class CobranzasPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/cobranzas.html`);
    await this.esperarAppLista();
  }

  // ── KPIs (pestaña "¿A quién llamo hoy?") ────────────────────────────
  // Migración (Fase 0 auditoría IA/UX): "Vence hoy"/"Próximos 7
  // días"/"Total vencido" ya no son tarjetas KPI aparte — se fusionaron
  // como monto directo en la etiqueta de cada tab de "Facturas
  // pendientes" (ver nota en cobranzas.html). "Cobrado hoy" sigue igual.
  get kpiCobradoHoy() { return this.page.locator('#kpi-cobrado-hoy'); }
  get kpiCobradoSub() { return this.page.locator('#kpi-cobrado-sub'); }
  get montoTabHoy() { return this.page.locator('#tabamt-hoy'); }
  get montoTabSemana() { return this.page.locator('#tabamt-semana'); }
  get montoTabVencidas() { return this.page.locator('#tabamt-vencidas'); }
  get mediosPagoGrid() { return this.page.locator('#medios-pago-grid'); }

  // ── Tabs (priorizada / hoy / semana / vencidas) ─────────────────────
  // Sin `exact:true`: el nombre accesible del botón incluye el monto hijo
  // (ej. "Vencidas $0"), así que un match exacto contra solo "Vencidas"
  // nunca matchea y el click se cuelga hasta el timeout.
  tab(nombre) {
    return this.page.getByRole('tab', { name: nombre });
  }

  async irATab(nombre) {
    await this.tab(nombre).click();
  }

  // ── Tabla "hoy"/"semana"/"vencidas" ──────────────────────────────────
  get filas() {
    return this.page.locator('[data-testid="cobranza-fila"]');
  }

  fila(facturaId) {
    return this.page.locator(`[data-testid="cobranza-fila"][data-id="${facturaId}"]`);
  }

  btnCobrarFila(facturaId) {
    return this.fila(facturaId).locator('button');
  }

  // ── Tabla "priorizada" ────────────────────────────────────────────────
  get filasPriorizadas() {
    return this.page.locator('[data-testid="cobranza-priorizada-fila"]');
  }

  filaPriorizada(clienteId) {
    return this.page.locator(`[data-testid="cobranza-priorizada-fila"][data-cliente-id="${clienteId}"]`);
  }

  btnCobrarFilaPriorizada(clienteId) {
    return this.filaPriorizada(clienteId).locator('button');
  }

  // ── Paginación server-side (solo aplica a hoy/semana/vencidas) ───────
  get infoPaginacion() { return this.page.locator('#info-pag-cob'); }
  get btnPaginaAnterior() { return this.page.locator('#btn-prev-cob'); }
  get btnPaginaSiguiente() { return this.page.locator('#btn-next-cob'); }

  // ── Recordatorio masivo ───────────────────────────────────────────────
  get btnRecordatorio() { return this.page.locator('#btn-recordatorio'); }

  // confirmar()/confirmarConTexto() de ui-utils.js arman un overlay propio
  // (no window.confirm nativo) — ver nota en ui-utils.js. A diferencia de
  // pos.html/stock.html (donde `[role="dialog"]` matchea un único elemento),
  // esta página (y en realidad cualquier página admin, por nav.js/
  // nav-mobile.js) trae OTROS `role="dialog"` que nunca hay que confundir
  // con este: `#modal-cobro`/`#modal-estado-cuenta` (estáticos, ocultos con
  // `display:none` vía clase `hidden`) y `#nav-menu-panel`/`#mnav-drawer`
  // (el menú de navegación — ESTOS se ocultan con `opacity`/`transform`,
  // no `display:none`, así que Playwright los sigue contando como
  // `:visible` aunque estén fuera de pantalla; un filtro por visibilidad a
  // secas no alcanza). El diálogo real de `confirmar()` es el único que
  // trae botones `[data-action]` — filtrar por eso es robusto sin importar
  // cómo se oculte cada componente.
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk() { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  // ── Cruce a la vista "Saldos por cliente" (cta-cte.js) ────────────────
  get vistaSaldos() { return this.page.locator('#vista-saldos'); }
}
