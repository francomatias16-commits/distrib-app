// Page object para `frontend/chofer/login.html`. Primera página del
// bloque "portal chofer" (5/5 — ver PLAN_E2E_COBERTURA_TOTAL.md sección
// 28/29) y, como `cliente/login.html`, la única del portal que NO asume
// sesión sembrada de antemano vía `sembrarSesionChofer`.
//
// Más simple que `cliente/login.html`: el campo es un email de verdad
// (`#email`, sin normalización de teléfono), y en vez de una tabla
// `clientes` asociada, valida el ROL del usuario contra `usuarios`
// (`chofer`/`dueno`/`admin`) — ver `ROLES_CHOFER` en el HTML. Reutiliza
// `mockearLoginPassword` (auth-helper.js) tal cual la dejó
// `cliente/login.html`.
//
// Nota de campo `?demo=1`: precarga credenciales de la demo pública pero
// NO auto-envía el form — cubierto en el spec, no en este page object
// (no hace falta un método propio, `goto()` con querystring alcanza).

import { expect } from '@playwright/test';

export class ChoferLoginPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto({ demo = false } = {}) {
    const qs = demo ? '?demo=1' : '';
    await this.page.goto(`${this.baseURL}/frontend/chofer/login.html${qs}`);
  }

  get inputEmail()   { return this.page.locator('#email'); }
  get inputPass()    { return this.page.locator('#password'); }
  get btnIngresar()  { return this.page.locator('#btnIngresar'); }
  get alerta()       { return this.page.locator('#alertaLogin'); }
  get avisoDemo()    { return this.page.locator('text=Credenciales de la demo pública ya cargadas'); }

  async completar({ email = '', pass = '' } = {}) {
    if (email) await this.inputEmail.fill(email);
    if (pass)  await this.inputPass.fill(pass);
  }

  async ingresar({ email, pass } = {}) {
    if (email !== undefined || pass !== undefined) await this.completar({ email, pass });
    await this.btnIngresar.click();
  }
}
