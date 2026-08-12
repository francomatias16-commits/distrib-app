// Page object para `frontend/chofer/invitacion.html` — activación de
// acceso vía link de invitación (3/5 del bloque, ver
// PLAN_E2E_COBERTURA_TOTAL.md sección 29). Portal PÚBLICO (sin login
// previo, token en la URL) hasta el momento en que el propio form activa
// una sesión — mismo patrón que `checkout.html` del portal cliente, no
// el de `login.html`.
//
// Dos llamadas a `/api/chofer-invitacion` con la MISMA URL base y
// distinto querystring (`accion=ver` al cargar, `accion=activar` al
// enviar el form) — page object expone `goto(token)` para armar la URL
// con `?t=`, el spec decide qué responde cada acción vía `mockApi`
// inspeccionando `request.url()`.
//
// Tras "Activar acceso" con éxito, el propio HTML hace
// `sb.auth.signInWithPassword({ email: data.email, password })` — mismo
// endpoint que `mockearLoginPassword` (auth-helper.js) ya cubre para
// `cliente/login.html` y `chofer/login.html`.

import { expect } from '@playwright/test';

export class ChoferInvitacionPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto(token) {
    const qs = token === undefined ? '' : `?t=${encodeURIComponent(token)}`;
    await this.page.goto(`${this.baseURL}/frontend/chofer/invitacion.html${qs}`);
  }

  get cargando()    { return this.page.locator('#cargando'); }
  get contenido()   { return this.page.locator('#contenido'); }
  get alerta()      { return this.page.locator('#alerta'); }
  get saludo()      { return this.page.locator('#saludo'); }
  get form()        { return this.page.locator('#formActivar'); }
  get inputPass()   { return this.page.locator('#password'); }
  get inputPass2()  { return this.page.locator('#password2'); }
  get btnActivar()  { return this.page.locator('#btnActivar'); }

  async completar({ password = '', password2 = '' } = {}) {
    if (password)  await this.inputPass.fill(password);
    if (password2) await this.inputPass2.fill(password2);
  }

  async activar({ password, password2 } = {}) {
    if (password !== undefined || password2 !== undefined) await this.completar({ password, password2 });
    await this.btnActivar.click();
  }
}
