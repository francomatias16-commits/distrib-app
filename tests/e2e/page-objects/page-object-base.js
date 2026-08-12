// Fase 0 del plan E2E — checks/esperas que se repiten en casi toda página
// admin porque comparten los mismos componentes de UI (toast, preloader,
// tabla con estado vacío). Un page-object por página EXTIENDE esto en vez
// de reimplementar estas esperas cada vez — ver README de la suite.

import { expect } from '@playwright/test';

export class PageObjectBase {
  /** @param {import('@playwright/test').Page} page */
  constructor(page) {
    this.page = page;
  }

  /** Espera a que auth.js resuelva y dispare `authReady` / oculte el preloader. */
  async esperarAppLista() {
    await this.page.waitForSelector('#app-preloader', { state: 'hidden', timeout: 10_000 }).catch(() => {
      // Algunas páginas no tienen preloader propio — no es fatal, el
      // resto de esperas (#nav-root, contenido) igual detectan si cargó.
    });
    await this.page.waitForSelector('#nav-root', { state: 'attached', timeout: 10_000 });
  }

  /**
   * Toast estándar. OJO — hallazgo real corriendo stock.spec.js contra
   * Chromium: `<div class="toast" id="toast">` que trae cada HTML (ver
   * pedidos.html/pos.html/stock.html) es markup MUERTO. La función real
   * (`window.toast`/`window.mostrarToast`, IIFE en ui-utils.js) nunca lo
   * toca — crea su PROPIO `<div class="toast">` sin id la primera vez que
   * se llama y lo appendea a `document.body`, reusándolo después. Por eso
   * `#toast` siempre resuelve (existe en el DOM desde el HTML estático)
   * pero se queda vacío para siempre — un falso positivo de "el toast no
   * tiene texto" en vez de un error real de aserción. El toast de verdad
   * es el que trae la clase modificadora `toast--visible` mientras está
   * mostrado.
   */
  get toast() {
    return this.page.locator('div.toast.toast--visible');
  }

  async esperarToastExito(textoParcial) {
    const toast = this.toast;
    await expect(toast).toBeVisible({ timeout: 5000 });
    if (textoParcial) await expect(toast).toContainText(textoParcial);
  }

  /** Ningún error de consola JS quedó sin capturar durante la interacción. */
  capturarErroresConsola() {
    const errores = [];
    this.page.on('console', (msg) => { if (msg.type() === 'error') errores.push(msg.text()); });
    this.page.on('pageerror', (err) => errores.push(err.message));
    return errores;
  }
}
