// Page object de usuarios.html — Fase 2 P1, arranca el bloque "usuarios /
// proveedores / notas / presupuestos" (ver PLAN_E2E_COBERTURA_TOTAL.md,
// sección 21/23). Standalone, JS propio (`usuarios.js`).
//
// A diferencia de las páginas del bloque anterior, esta NO pasa por
// `auth.js`/`PAGINA_ROLES_PERMITIDOS` para el gate de UI — igual declara
// `window.PAGINA_ROLES_PERMITIDOS` en el HTML (así que `auth.js` sí
// bloquea la navegación completa a nivel página para roles fuera de
// dueño/admin), pero el filtrado fino de qué fila es editable
// ("Solo el dueño") es lógica propia de `renderTabla()` en base a
// `usuarioActual.rol`.
//
// `data-testid="usuario-fila"` + `data-id` agregado en
// usuarios.js::renderTabla() — el <tr> (creado con `document.createElement`,
// no template literal) no traía selector estable, mismo criterio que
// `dev-fila`/`cheque-fila`/`lote-item`.
//
// Confirmación — `guardarUsuario()` pide `window.confirmar()` SIEMPRE (alta
// y edición); `cambiarEstado()` (activar/desactivar) también. Mismo overlay
// genérico que cheques.js — ver `dialogoConfirmar`.
//
// Toast — usuarios.js usa `window.mostrarToast` (alias de `window.toast`),
// el getter heredado de PageObjectBase aplica sin overrides.
//
// `#banner-limite-plan` (en el HTML) es markup MUERTO — ningún código de
// usuarios.js lo toca. El límite de plan alcanzado (`LIMITE_PLAN_ALCANZADO`)
// se comunica solo por toast (con el detalle actual/límite embebido en el
// texto), no por ese banner — mismo caso que el `#toast` muerto documentado
// en PageObjectBase. No se expone getter para ese banner acá a propósito.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class UsuariosPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/usuarios.html`);
    await this.esperarAppLista();
  }

  // ── Tabla ────────────────────────────────────────────────────────────
  get filas() { return this.page.locator('[data-testid="usuario-fila"]'); }

  fila(userId) {
    return this.page.locator(`[data-testid="usuario-fila"][data-id="${userId}"]`);
  }

  // ── Filtros ──────────────────────────────────────────────────────────
  get inputBusqueda() { return this.page.locator('#busqueda'); }
  get filtroActivo()  { return this.page.locator('#filtro-activo'); }

  async buscar(texto) {
    await this.inputBusqueda.fill(texto);
    // Debounce de 200ms (ver usuarios.js::init) antes de que renderTabla()
    // re-filtre — no dispara red, es filtrado in-memory sobre `usuariosData`.
    await this.page.waitForTimeout(300);
  }

  // ── Acciones de fila (delegación de eventos, sin onclick inline) ──────
  botonEditar(userId) {
    return this.fila(userId).locator('[data-accion="editar"]');
  }

  botonDesactivar(userId) {
    return this.fila(userId).locator('[data-accion="desactivar"]');
  }

  botonActivar(userId) {
    return this.fila(userId).locator('[data-accion="activar"]');
  }

  labelSoloDueno(userId) {
    return this.fila(userId).getByText('Solo el dueño');
  }

  // ── Modal alta/edición ──────────────────────────────────────────────
  get modal()        { return this.page.locator('#modal-usuario'); }
  get modalTitulo()  { return this.page.locator('#modal-titulo'); }
  get grupoPassword(){ return this.page.locator('#grupo-password'); }
  get inputNombre()  { return this.page.locator('#f-nombre'); }
  get inputEmail()   { return this.page.locator('#f-email'); }
  get inputPassword(){ return this.page.locator('#f-password'); }
  get selectRol()    { return this.page.locator('#f-rol'); }
  get inputTelefono(){ return this.page.locator('#f-telefono'); }
  get btnGuardar()   { return this.page.locator('#btn-guardar'); }

  async abrirModalNuevo() {
    await this.page.locator('#btn-nuevo-usuario').click();
  }

  async completarFormulario({ nombre, email, password, rol, telefono } = {}) {
    if (nombre !== undefined) await this.inputNombre.fill(nombre);
    if (email !== undefined) await this.inputEmail.fill(email);
    if (password !== undefined) await this.inputPassword.fill(password);
    if (rol !== undefined) await this.selectRol.selectOption(rol);
    if (telefono !== undefined) await this.inputTelefono.fill(telefono);
  }

  // ── Confirmación (overlay de window.confirmar(), mismo patrón que
  //    cheques.page.js) ─────────────────────────────────────────────────
  get dialogoConfirmar() { return this.page.locator('[role="dialog"]:has([data-action])').last(); }
  get btnConfirmarOk()   { return this.dialogoConfirmar.locator('[data-action="ok"]'); }
  get btnConfirmarCancelar() { return this.dialogoConfirmar.locator('[data-action="cancel"]'); }

  /** Click en "Crear usuario"/"Guardar cambios" + confirma el diálogo. */
  async guardar() {
    await this.btnGuardar.click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }

  /** Click en Desactivar/Activar de una fila + confirma el diálogo. */
  async cambiarEstadoFila(userId, { activo }) {
    const boton = activo ? this.botonActivar(userId) : this.botonDesactivar(userId);
    await boton.click();
    await expect(this.dialogoConfirmar).toBeVisible();
    await this.btnConfirmarOk.click();
  }
}
