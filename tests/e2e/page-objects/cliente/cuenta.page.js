// Page object para `frontend/cliente/cuenta.html`. Carga en paralelo
// (`Promise.all`) 3 queries — `clientes` (.single()), `saldo_puntos`
// (.maybeSingle()) y `pedidos` (`count:'exact', head:true`, SOLO el
// conteo, sin filas) — más `/api/fidelizacion` (catálogo de recompensas)
// después de pintar el resto del DOM. Todo el contenido se arma con un
// único `innerHTML =` sobre `#contenidoCuenta`, así que no hay nada que
// esperar por separado salvo ese template inicial.
//
// OJO — el conteo de "Pedidos realizados" usa `head:true`: ver hallazgo
// documentado en `mockearConteoTabla` (supabase-rest-mock.js). Sin ese
// helper el valor mostrado es siempre "0", no lo que devuelva
// `mockearTabla('pedidos', { onSelect: ... })`.
//
// OJO 2 — "Activar notificaciones de mis pedidos" depende de
// `window.solicitarPermisoNotificaciones` (`/frontend/js/push-init.js`,
// `<script type="module">`), que hace un `import` ESTÁTICO de
// `https://www.gstatic.com/firebasejs/...` — corre apenas carga el
// script, sin que nadie lo pida. Ese import fallando en un sandbox sin
// salida a `gstatic.com` es el mismo "Failed to load resource" que ya
// filtra `filtrarRuidoRed` (mismo patrón que Realtime/Sentry). El botón
// en sí (visibilidad según `Notification.permission === 'default'`) SÍ
// se puede testear porque `Notification` es una API nativa del browser;
// el CLICK (dispara `initPushNotifications()`, que registra un Service
// Worker real y depende de Firebase) queda deliberadamente fuera de
// alcance de este page object — mismo criterio que el `ProductoPicker`
// en `presupuestos.page.js` (sección 27 del plan): superficie propia,
// no vale la pena mockearla a ciegas sin poder correr el test acá.
//
// "Cambiar contraseña" es un acordeón CSS puro (`.abierto`) que arranca
// cerrado — hay que abrirlo antes de poder tocar los inputs.

import { expect } from '@playwright/test';

export class ClienteCuentaPage {
  constructor(page, baseURL) {
    this.page = page;
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/cliente/cuenta.html`);
    await expect(this.contenido.locator('.loading')).toHaveCount(0, { timeout: 10_000 });
  }

  get contenido()        { return this.page.locator('#contenidoCuenta'); }
  get perfilCard()        { return this.contenido.locator('.perfil-card'); }
  get puntosValor()       { return this.contenido.locator('.puntos-valor'); }
  get puntosSub()         { return this.contenido.locator('.puntos-sub'); }
  get recompensasLista()  { return this.page.locator('#recompensasLista'); }
  get recompensasMsg()    { return this.page.locator('#recompensasMsg'); }
  get btnActivarPush()    { return this.page.locator('#btnActivarPush'); }
  get btnLogout()         { return this.page.locator('#btnLogout'); }

  // "Cuenta corriente" / "Actividad" / "Datos de contacto" son filas
  // genéricas `.info-row` con un label + un valor — se ubican por texto
  // del label en vez de por id (no tienen id individual).
  infoRow(labelTexto) {
    return this.contenido.locator('.info-row', { hasText: labelTexto });
  }

  recompensaCard(nombre) {
    return this.recompensasLista.locator('.recompensa-card', { hasText: nombre });
  }

  botonCanjear(nombreRecompensa) {
    return this.recompensaCard(nombreRecompensa).locator('button.btn-canjear');
  }

  /** Acepta el `confirm()` nativo que dispara `canjearRecompensa()`. */
  async canjear(nombreRecompensa) {
    this.page.once('dialog', (d) => d.accept());
    await this.botonCanjear(nombreRecompensa).click();
  }

  get pwToggle()   { return this.page.locator('#pwToggle'); }
  get pwBody()     { return this.page.locator('#pwBody'); }
  get pwChevron()  { return this.page.locator('#pwChevron'); }
  get pwActual()   { return this.page.locator('#pwActual'); }
  get pwNueva()    { return this.page.locator('#pwNueva'); }
  get pwNuevaRep() { return this.page.locator('#pwNuevaRep'); }
  get pwMsg()      { return this.page.locator('#pwMsg'); }
  get pwBtn()      { return this.page.locator('#pwBtn'); }

  async abrirCambiarPassword() {
    await this.pwToggle.click();
    await expect(this.pwBody).toHaveClass(/abierto/);
  }

  async completarCambioPassword({ actual = '', nueva = '', repetir = '' } = {}) {
    if (actual)   await this.pwActual.fill(actual);
    if (nueva)    await this.pwNueva.fill(nueva);
    if (repetir)  await this.pwNuevaRep.fill(repetir);
    await this.pwBtn.click();
  }

  async logout() {
    await this.btnLogout.click();
  }
}
