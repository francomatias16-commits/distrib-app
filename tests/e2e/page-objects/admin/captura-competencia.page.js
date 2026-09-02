// Page object del ítem E2E pendiente de PLAN_E2E_COBERTURA_TOTAL.md, plan
// 1.6 ("Captura de competencia"): flujo completo foto → revisión → cierre
// → conversión. El test unitario del piso de margen
// (tests/handlers/captura-competencia-margen.test.js) ya cubre el control
// de mayor riesgo a nivel handler — este spec ejercita la pantalla real
// con clicks, no la lógica de negocio en sí.
//
// A diferencia de compras.js/pos.js (que también van 100% por `/api/*`),
// esta pantalla tiene el mismo endpoint base
// (`/api/captura-competencia`) para las 6 acciones del flujo, discriminadas
// por querystring `?accion=...` — el mock de red (mockApi en el spec)
// tiene que registrar una key por acción, mismo patrón ya usado en
// cuenta.spec.js para `/api/fidelizacion?accion=canjear`.
//
// `data-testid` ya presente en el HTML/JS de origen (no hubo que agregar
// ninguno): `cc-fila` en las filas de la tabla, `cc-item-cantidad` /
// `cc-item-precio-propio` en los inputs editables de cada renglón del
// panel de revisión.
//
// El panel lateral de revisión (`#panel-captura`) usa el mismo mecanismo
// `classList.add/remove('open')` que stock.html/cta-cte.html (no
// style.display a mano como el modal de "nueva captura" de esta misma
// página) — por eso acá sí corresponde `toHaveClass(/open/)` en vez de
// `toBeVisible()`, a diferencia de compras.page.js.

import { expect } from '@playwright/test';
import { PageObjectBase } from '../page-object-base.js';

export class CapturaCompetenciaPage extends PageObjectBase {
  constructor(page, baseURL) {
    super(page);
    this.baseURL = baseURL;
  }

  async goto() {
    await this.page.goto(`${this.baseURL}/frontend/admin/captura-competencia.html`);
    await this.esperarAppLista();
  }

  // ── Filtro y tabla ───────────────────────────────────────────────────
  get filtroEstado() { return this.page.locator('#cc-filtro-estado'); }
  get filas() { return this.page.locator('[data-testid="cc-fila"]'); }
  fila(capturaId) { return this.page.locator(`[data-testid="cc-fila"][data-id="${capturaId}"]`); }

  async filtrarPorEstado(valor) {
    await this.filtroEstado.selectOption(valor);
  }

  async abrirFila(capturaId) {
    // FIX: la fila tiene 2 botones ("Revisar" y "Eliminar" — ver
    // ccAbrirPanelRevision/ccDescartarCaptura en el JS de origen).
    // getByRole('button') sin filtro violaba el modo estricto de
    // Playwright apenas se agregó el botón "Eliminar" a la fila.
    await this.fila(capturaId).getByRole('button', { name: 'Revisar' }).click();
  }

  get kpis() { return this.page.locator('#cc-kpis'); }

  // ── Modal: nueva captura ─────────────────────────────────────────────
  get btnNuevaCaptura() { return this.page.getByRole('button', { name: '+ Nueva captura' }); }
  get modalNueva() { return this.page.locator('#cc-modal-nueva'); }
  get inputProveedor() { return this.page.locator('#cc-nueva-proveedor'); }
  get inputFoto() { return this.page.locator('#cc-input-foto'); }
  get previewFoto() { return this.page.locator('#cc-preview-foto'); }
  get alertaNueva() { return this.page.locator('#cc-nueva-alerta'); }
  get btnAnalizarFactura() { return this.page.locator('#cc-btn-crear-captura'); }

  async abrirModalNueva() {
    await this.btnNuevaCaptura.click();
    await expect(this.modalNueva).toBeVisible();
  }

  /**
   * Adjunta una foto vía `setInputFiles` con un buffer (mismo patrón que
   * conciliacion-bancaria.page.js para el CSV) — dispara el listener
   * `change` real de `#cc-input-foto`, que lee el archivo con FileReader
   * y arma `ccFotoBase64`/`ccFotoMimeType` que después manda el POST.
   */
  async adjuntarFoto({ nombreArchivo = 'factura-competencia.jpg', mimeType = 'image/jpeg', buffer } = {}) {
    await this.inputFoto.setInputFiles({
      name: nombreArchivo,
      mimeType,
      // PNG 1x1 válido por default — el mock de red intercepta el POST de
      // todos modos (no hay validación real de contenido de imagen del
      // lado del browser antes de mandar el base64), pero un buffer con
      // firma de archivo real evita que un futuro chequeo client-side
      // rompa el test por sorpresa.
      buffer: buffer || Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });
    await expect(this.previewFoto).toBeVisible();
  }

  async crearCaptura({ proveedor } = {}) {
    if (proveedor !== undefined) await this.inputProveedor.fill(proveedor);
    await this.btnAnalizarFactura.click();
  }

  // ── Panel lateral de revisión ────────────────────────────────────────
  get panel() { return this.page.locator('#panel-captura'); }
  get panelTitulo() { return this.page.locator('#cc-panel-titulo'); }
  get panelBody() { return this.page.locator('#cc-panel-body'); }

  async esperarPanelAbierto() {
    await expect(this.panel).toHaveClass(/open/);
  }

  async cerrarPanel() {
    await this.page.locator('.btn-cerrar-panel').click();
    await expect(this.panel).not.toHaveClass(/open/);
  }

  item(itemId) { return this.page.locator(`.cc-item[data-item-id="${itemId}"]`); }

  /**
   * Completa cantidad/precio propio de un renglón ya presente en el
   * panel. Ambos inputs disparan `onchange` (no `oninput`) — igual que
   * compras.page.js, hace falta `.blur()` explícito para que el valor
   * quede confirmado (y el POST a `accion=confirmar_item` salga) antes de
   * seguir con la siguiente aserción.
   */
  async completarItem(itemId, { cantidad, precioPropio } = {}) {
    const it = this.item(itemId);
    if (cantidad !== undefined) {
      const input = it.locator('[data-testid="cc-item-cantidad"]');
      await input.fill(String(cantidad));
      await input.blur();
    }
    if (precioPropio !== undefined) {
      const input = it.locator('[data-testid="cc-item-precio-propio"]');
      await input.fill(String(precioPropio));
      await input.blur();
    }
  }

  async descartarItem(itemId, checked = true) {
    const checkbox = this.item(itemId).locator('input[type="checkbox"]');
    if (checked) await checkbox.check(); else await checkbox.uncheck();
  }

  /**
   * Busca y elige un producto propio para el renglón `itemId`. El
   * buscador es un `<input>` con debounce de 220ms (no un combo con
   * `data-testid="prod-opt-*"` como en compras.page.js) — resultados
   * inyectados a mano en `#cc-buscador-<itemId>` con
   * `.cc-buscador-resultado[data-id]`.
   */
  async buscarYElegirProducto(itemId, texto, productoId) {
    const input = this.item(itemId).locator('input[data-rol="buscar-producto"]');
    await input.fill(texto);
    const resultado = this.page.locator(`#cc-buscador-${itemId} .cc-buscador-resultado[data-id="${productoId}"]`);
    await expect(resultado).toBeVisible();
    await resultado.click();
  }

  itemWarningMargen(itemId) { return this.item(itemId).locator('.cc-item-margen-warn'); }

  // ── Cerrar cotización / resumen ──────────────────────────────────────
  get btnCerrarCotizacion() { return this.page.getByRole('button', { name: 'Cerrar cotización' }); }
  get resumenAhorro() { return this.page.locator('.cc-resumen-box .cc-resumen-linea.total span').nth(1); }

  async cerrarCotizacion() {
    await this.btnCerrarCotizacion.click();
  }

  // ── Zoom de foto ──────────────────────────────────────────────────────
  get modalZoom() { return this.page.locator('#cc-modal-zoom'); }

  async verFotoGrande() {
    await this.panelBody.locator('.cc-panel-foto-wrap img').click();
    await expect(this.modalZoom).toBeVisible();
  }

  // ── Convertir en cliente + pedido ─────────────────────────────────────
  get tabClienteExistente() { return this.page.getByRole('button', { name: 'Cliente existente' }); }
  get tabClienteNuevo() { return this.page.getByRole('button', { name: 'Cliente nuevo' }); }
  get inputBuscarCliente() { return this.page.locator('#cc-buscar-cliente'); }
  get inputRazonSocialNuevo() { return this.page.locator('#cc-nuevo-razon-social'); }
  get inputTelefonoNuevo() { return this.page.locator('#cc-nuevo-telefono'); }
  get inputDireccionNuevo() { return this.page.locator('#cc-nuevo-direccion'); }
  get clienteElegidoTexto() { return this.page.locator('#cc-cliente-elegido'); }
  get btnConvertir() { return this.page.getByRole('button', { name: 'Convertir en cliente + pedido' }); }

  async buscarYElegirCliente(texto, clienteId) {
    await this.inputBuscarCliente.fill(texto);
    const resultado = this.page.locator(`#cc-resultados-cliente .cc-buscador-resultado[data-id="${clienteId}"]`);
    await expect(resultado).toBeVisible();
    await resultado.click();
  }

  async completarClienteNuevo({ razonSocial, telefono, direccion } = {}) {
    await this.tabClienteNuevo.click();
    if (razonSocial !== undefined) await this.inputRazonSocialNuevo.fill(razonSocial);
    if (telefono !== undefined) await this.inputTelefonoNuevo.fill(telefono);
    if (direccion !== undefined) await this.inputDireccionNuevo.fill(direccion);
  }

  async convertir() {
    await this.btnConvertir.click();
  }

  get alertaConvertida() { return this.panelBody.locator('.alerta-ok'); }
}
