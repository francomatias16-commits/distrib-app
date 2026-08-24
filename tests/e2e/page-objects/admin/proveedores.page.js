// Page object de proveedores.html — Fase 2 P1, sigue en el bloque "usuarios /
// proveedores / notas / presupuestos" (ver PLAN_E2E_COBERTURA_TOTAL.md,
// sección 25). Standalone, JS propio (`proveedores.js`, 537 líneas) — CRUD
// contra `/api/proveedores` (`lib/handlers/proveedores.js`), más un
// sub-router `_svc=portal-admin` (`portal_proveedor.js::handlePortalAdmin`)
// para generar/listar/revocar links del portal de autogestión (#10 —
// "Vidriera Inversa").
//
// `data-testid="proveedores-fila"` + `data-id` agregado en
// proveedores.js::renderTabla() — el <tr> se arma con template literal (no
// `document.createElement`) y no traía ningún selector estable con el id,
// mismo criterio que `clientes-fila`/`dev-fila`/`cheque-fila`.
//
// Listado — a diferencia de usuarios.html (filtrado in-memory), la lista de
// proveedores es 100% server-side desde v282 (búsqueda, filtro de activo y
// paginación viajan como querystring a `/api/proveedores` — ver comentario
// en cargarProveedores()). `buscar()` dispara una request nueva tras un
// debounce de 250ms, no filtra sobre `proveedoresData` en el navegador.
//
// Confirmación — SOLO `desactivar()` pide `window.confirmar()` (mismo
// overlay genérico que usuarios/cheques/devoluciones — ver
// `dialogoConfirmar`). `guardarProveedor()` (alta y edición) y `activar()`
// NO piden confirmación, disparan el POST/PATCH directo al click de
// "Guardar" / "Activar".
//
// Toast — proveedores.js usa `window.toast` directo, el getter heredado de
// PageObjectBase aplica sin overrides.
//
// Panel "Links de acceso activos" — carga aparte de la tabla principal
// (`cargarLinksActivos()`, llamado desde init() sin esperar la tabla). Pega
// primero a `/api/proveedores?activo=&limit=2000` para resolver id→nombre,
// después una request en paralelo POR PROVEEDOR a
// `/api/proveedores?_svc=portal-admin&accion=links&proveedor_id=<id>` — con
// fixtures de más de un par de proveedores esto son N+1 requests, tenerlo
// en cuenta al mockear. Cada fila del panel tiene `id="link-row-<id>"` (no
// data-testid) — se expone `filaLink(tokenId)` en vez de agregar un
// data-testid nuevo para no tocar más superficie de la necesaria.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class ProveedoresPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/proveedores.html`);
    await this.esperarAppLista();
  }

  // ── Tabla principal ─────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="proveedores-fila"]'); }

  fila(id) {
    return this.page.locator(`[data-testid="proveedores-fila"][data-id="${id}"]`);
  }

  // ── Filtros / búsqueda (server-side, ver nota arriba) ──────────────────
  get inputBusqueda() { return this.page.locator('#busqueda'); }
  get filtroActivo()  { return this.page.locator('#filtro-activo'); }

  async buscar(texto) {
    await this.inputBusqueda.fill(texto);
    // Debounce de 250ms (ver proveedores.js::init) antes de disparar
    // cargarProveedores() de nuevo — es una request nueva, no filtrado
    // in-memory (a diferencia de usuarios.html).
    await this.page.waitForTimeout(350);
  }

  async filtrarPorActivo(valor) {
    await this.filtroActivo.selectOption(valor);
  }

  // ── Paginación (inyectada por JS — ver inyectarControlesPaginacionProveedores) ──
  get btnPaginaAnterior() { return this.page.locator('#btn-prev-proveedores'); }
  get btnPaginaSiguiente() { return this.page.locator('#btn-next-proveedores'); }
  get infoPagina() { return this.page.locator('#info-pag-proveedores'); }

  // ── Acciones de fila (onclick inline, ver renderTabla()) ────────────────
  // (2026-08-19, cierre del Hallazgo #6 — PLAN_UNIFICACION_UX_ADMIN.md §17)
  // Editar/Dar de baja/Activar siguen siendo botones .btn-tabla visibles en
  // la fila. Compras/Portal se movieron a un menú "⋮" flotante (mismo patrón
  // que Cheques/Notas de crédito — #menu-acciones-proveedor, compartido por
  // todas las filas, reposicionado por JS al abrir) — ya NO son
  // button.btn-tabla, hay que abrir el kebab primero.
  botonEditar(id)    { return this.fila(id).locator('button.btn-tabla', { hasText: 'Editar' }); }
  botonDesactivar(id) { return this.fila(id).locator('button.btn-tabla.peligro', { hasText: 'Dar de baja' }); }
  botonActivar(id)   { return this.fila(id).locator('button.btn-tabla.primario', { hasText: 'Activar' }); }
  botonKebab(id)     { return this.fila(id).locator('button.btn-kebab'); }

  get menuAcciones()      { return this.page.locator('#menu-acciones-proveedor'); }
  get botonMenuCompras()  { return this.menuAcciones.locator('.dropdown-item', { hasText: 'Compras' }); }
  get botonMenuPortal()   { return this.menuAcciones.locator('.dropdown-item', { hasText: 'Portal' }); }

  /** Abre el menú "⋮" de una fila (Compras / Portal). */
  async abrirMenuAcciones(id) {
    await this.botonKebab(id).click();
    await expect(this.menuAcciones).toBeVisible();
  }

  // ── Modal alta/edición ───────────────────────────────────────────────
  // getByRole('button', {name: 'Nuevo proveedor'}) sin exact matchea
  // también el chip del topbar (`.topbar-right`, ver
  // topbar-widgets.js::_armarMenuChip — `#topbar-usuario` no tiene wrapper
  // propio en esta página, así que `_armarMenuChip` envuelve TODO
  // `.topbar-right` como un chip clickeable cuyo nombre accesible absorbe
  // el texto de sus hijos, "Nuevo proveedor" incluido). Mismo hallazgo que
  // en cheques.page.js — con `exact: true` solo matchea el botón real.
  get btnNuevoProveedor() { return this.page.getByRole('button', { name: 'Nuevo proveedor', exact: true }); }
  get modal()       { return this.page.locator('#modal-proveedor'); }
  get modalTitulo() { return this.page.locator('#modal-titulo'); }
  get btnGuardar()  { return this.page.locator('#btn-guardar'); }

  get inputRazonSocial()    { return this.page.locator('#f-razon_social'); }
  get inputNombreFantasia() { return this.page.locator('#f-nombre_fantasia'); }
  get inputCuit()           { return this.page.locator('#f-cuit'); }
  get selectCondicionIva()  { return this.page.locator('#f-condicion_iva'); }
  get inputContacto()       { return this.page.locator('#f-contacto'); }
  get inputTelefono()       { return this.page.locator('#f-telefono'); }
  get inputEmail()          { return this.page.locator('#f-email'); }
  get inputDiasPago()       { return this.page.locator('#f-dias_pago'); }
  get inputLocalidad()      { return this.page.locator('#f-localidad'); }
  get inputDomicilio()      { return this.page.locator('#f-domicilio'); }
  get inputNotas()          { return this.page.locator('#f-notas'); }

  async abrirModalNuevo() {
    await this.btnNuevoProveedor.click();
    await expect(this.modal).toBeVisible();
  }

  async abrirModalEditar(id) {
    await this.botonEditar(id).click();
    await expect(this.modal).toBeVisible();
  }

  async completarFormulario({
    razonSocial, nombreFantasia, cuit, condicionIva, contacto,
    telefono, email, diasPago, localidad, domicilio, notas,
  } = {}) {
    if (razonSocial !== undefined) await this.inputRazonSocial.fill(razonSocial);
    if (nombreFantasia !== undefined) await this.inputNombreFantasia.fill(nombreFantasia);
    if (cuit !== undefined) await this.inputCuit.fill(cuit);
    if (condicionIva !== undefined) await this.selectCondicionIva.selectOption(condicionIva);
    if (contacto !== undefined) await this.inputContacto.fill(contacto);
    if (telefono !== undefined) await this.inputTelefono.fill(telefono);
    if (email !== undefined) await this.inputEmail.fill(email);
    if (diasPago !== undefined) await this.inputDiasPago.fill(String(diasPago));
    if (localidad !== undefined) await this.inputLocalidad.fill(localidad);
    if (domicilio !== undefined) await this.inputDomicilio.fill(domicilio);
    if (notas !== undefined) await this.inputNotas.fill(notas);
  }

  /** Click en "Guardar proveedor"/"Guardar cambios" — SIN confirmación (a diferencia de usuarios.html). */
  async guardar() {
    await this.btnGuardar.click();
  }

  // ── Confirmación (overlay de window.confirmar(), SOLO para desactivar) ──
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk()   { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  /** Click en "Dar de baja" de una fila + confirma el diálogo. */
  async desactivarFila(id) {
    await this.botonDesactivar(id).click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  /** Click en "Activar" de una fila — SIN confirmación. */
  async activarFila(id) {
    await this.botonActivar(id).click();
  }

  // ── Modal portal de autogestión (#10 — Vidriera Inversa) ────────────────
  get modalPortal()   { return this.page.locator('#modal-portal'); }
  get portalTitulo()  { return this.page.locator('#portal-titulo'); }
  get portalBody()    { return this.page.locator('#portal-body'); }
  get portalLinkInput() { return this.page.locator('#portal-link-input'); }
  get btnAbrirPortalAhora() { return this.portalBody.getByRole('button', { name: 'Abrir portal ahora' }); }
  get btnCopiarLinkPortal() { return this.portalBody.getByRole('button', { name: 'Copiar link' }); }
  get btnEnviarWhatsapp()   { return this.portalBody.getByRole('button', { name: 'Enviar por WhatsApp' }); }
  get portalError() { return this.page.locator('.portal-error'); }

  async abrirPortalFila(id) {
    await this.abrirMenuAcciones(id);
    await this.botonMenuPortal.click();
    await expect(this.modalPortal).toBeVisible();
  }

  /** Click en "Compras" del menú "⋮" de una fila (navega a Compras filtrado por proveedor). */
  async irAComprasFila(id) {
    await this.abrirMenuAcciones(id);
    await this.botonMenuCompras.click();
  }

  async cerrarModalPortal() {
    await this.page.locator('#modal-portal .modal-box-close').click();
  }

  // ── Panel "Links de acceso activos" — carga aparte, ver nota arriba ────
  get btnActualizarLinks() { return this.page.getByRole('button', { name: '↻ Actualizar' }); }

  /** Fila del panel de links activos — `id="link-row-<tokenId>"`, sin data-testid propio. */
  filaLink(tokenId) {
    return this.page.locator(`#link-row-${tokenId}`);
  }

  botonRevocar(tokenId) {
    return this.filaLink(tokenId).locator('button.btn-tabla', { hasText: 'Revocar' });
  }

  /** Click en "Revocar" de una fila del panel + confirma el diálogo. */
  async revocarLink(tokenId) {
    await this.botonRevocar(tokenId).click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }
}
