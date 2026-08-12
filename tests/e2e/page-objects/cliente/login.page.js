// Page object para `frontend/cliente/login.html`. Sin Supabase Auth
// previo (es la pantalla que lo crea) — a diferencia de casi todo el
// resto del portal cliente, acá NO usar `sembrarSesionCliente` antes de
// `goto()` salvo que el test sea justamente el caso "ya tenía sesión,
// redirige directo" (ver spec).
//
// El "email" real de Supabase Auth es ficticio, armado a partir del
// número de WhatsApp (`${digits}@portal.distrib`, mismo algoritmo que el
// backend — ver `ingresar()` en el HTML): "3462 123456" → agrega el
// prefijo país "54" → "3462123456" → "543462123456@portal.distrib". El
// page object expone el campo como `inputTelefono` (el HTML lo llama
// `#inputEmail` por legado, pero es un teléfono) para no confundir en el
// spec.

import { expect } from '@playwright/test';

export class ClienteLoginPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/cliente/login.html`);
  }

  get inputTelefono()  { return this.page.locator('#inputEmail'); }
  get inputPass()      { return this.page.locator('#inputPass'); }
  get btnIngresar()    { return this.page.locator('#btnIngresar'); }
  get btnTogglePass()  { return this.page.locator('#btnTogglePass'); }
  get alertaError()    { return this.page.locator('#alertaError'); }
  get textoError()     { return this.page.locator('#textoError'); }
  get nombreEmpresa()  { return this.page.locator('#nombreEmpresa'); }
  get logoEmpresa()    { return this.page.locator('#logoEmpresa'); }
  get linkOlvide()     { return this.page.locator('#linkOlvide'); }

  // Modal de reset por WhatsApp (v719) — ver CHANGELOG_v719.
  get modalReset()          { return this.page.locator('#modalReset'); }
  get pasoTelefono()        { return this.page.locator('#pasoTelefono'); }
  get pasoCodigo()          { return this.page.locator('#pasoCodigo'); }
  get resetTelefono()       { return this.page.locator('#resetTelefono'); }
  get resetCodigo()         { return this.page.locator('#resetCodigo'); }
  get resetPassNueva()      { return this.page.locator('#resetPassNueva'); }
  get resetMsg1()           { return this.page.locator('#resetMsg1'); }
  get resetMsg2()           { return this.page.locator('#resetMsg2'); }
  get btnEnviarCodigo()     { return this.page.locator('#btnEnviarCodigo'); }
  get btnConfirmarCodigo()  { return this.page.locator('#btnConfirmarCodigo'); }
  get btnCancelarReset1()   { return this.page.locator('#btnCancelarReset1'); }
  get btnVolverPaso1()      { return this.page.locator('#btnVolverPaso1'); }

  async completar({ telefono = '', pass = '' } = {}) {
    if (telefono) await this.inputTelefono.fill(telefono);
    if (pass)     await this.inputPass.fill(pass);
  }

  async ingresar({ telefono, pass } = {}) {
    if (telefono !== undefined || pass !== undefined) await this.completar({ telefono, pass });
    await this.btnIngresar.click();
  }

  async togglePass() {
    await this.btnTogglePass.click();
  }

  async abrirModalReset() {
    await this.linkOlvide.click();
  }

  async pedirCodigo(telefono) {
    if (telefono !== undefined) await this.resetTelefono.fill(telefono);
    await this.btnEnviarCodigo.click();
  }

  async confirmarCodigo({ codigo, passNueva } = {}) {
    if (codigo !== undefined)    await this.resetCodigo.fill(codigo);
    if (passNueva !== undefined) await this.resetPassNueva.fill(passNueva);
    await this.btnConfirmarCodigo.click();
  }
}
