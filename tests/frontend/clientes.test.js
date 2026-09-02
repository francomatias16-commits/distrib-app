// tests/frontend/clientes.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo #16. `renderAlertasScorePanel()` (panel
// de alertas de nivel de confianza en la ficha de Clientes) interpola
// `a.clientes?.razon_social` y `a.mensaje` directo en `panel.innerHTML`
// — ambos son datos que terminan reflejando lo que cargó el usuario en el
// ABM de Clientes (razón social) o texto derivado de reglas de score, así
// que son el mismo vector de XSS almacenado que #19/#23. Ya está fijado
// en el código actual envolviendo ambos campos en `sanitize()`; este test
// cubre esa regresión.
//
// ACTUALIZADO (25/08/2026, split de clientes.js): a diferencia del resto
// de los scripts de frontend/admin/js (clásicos, sin bundler, testeados
// vía vm.runInContext — ver tests/helpers/cargar-script-frontend.js),
// clientes.js se cargaba como <script type="module"> y su split real
// (frontend/admin/js/clientes/) usa import/export de verdad. vm.runInContext
// no soporta esa sintaxis, así que este test usa el loader ES real de Node
// (import() dinámico) con `document`/`window` stubeados en globalThis antes
// de invocar la función — mismos fakes (crearElementoFake/crearDocumentoFake)
// que usa el resto de la suite.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { crearDocumentoFake, crearElementoFake } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const SCORE_CLIENTE = path.resolve(__dirname, '../../frontend/admin/js/clientes/score-cliente.js');

const PAYLOAD = '<img src=x onerror=alert(1)>';

let renderAlertasScorePanel;
beforeEach(async () => {
  // window === globalThis (mismo patrón que sandbox.window = sandbox en
  // cargarScripts): ui-utils.js hace `window.sanitize = function(...)`,
  // así que con este alias queda accesible como identificador bare
  // `sanitize` — que es como lo usa score-cliente.js, igual que en el
  // navegador real (ambos <script> comparten el mismo objeto global).
  globalThis.window = globalThis;
  // ui-utils.js hace document.addEventListener('visibilitychange', ...) a
  // nivel de módulo (no dentro de una función) — necesita un document
  // mínimo ya presente en el momento del import, antes de que cada test
  // pise globalThis.document con su propio crearDocumentoFake().
  globalThis.document = globalThis.document || { addEventListener: () => {} };
  await import(UI_UTILS);
  // Import dinámico real: se cachea después de la primera carga (los
  // módulos ES son singleton), pero como document/window se reasignan en
  // globalThis antes de cada test, y la función los lee como variables
  // libres en el momento en que se llama (no en el momento del import),
  // el aislamiento entre tests se mantiene igual.
  ({ renderAlertasScorePanel } = await import(SCORE_CLIENTE));
});

function cargar() {
  const panel = crearElementoFake();
  const documento = crearDocumentoFake({ 'panel-alertas-score': panel });
  globalThis.document = documento;
  return { panel };
}

describe('clientes/score-cliente.js — renderAlertasScorePanel (hallazgo #16, XSS panel de alertas de score)', () => {
  it('escapa razon_social maliciosa', () => {
    const { panel } = cargar();
    renderAlertasScorePanel([
      { id: 'a1', clientes: { razon_social: PAYLOAD }, mensaje: 'Score por debajo del umbral' },
    ]);
    expect(panel.innerHTML).not.toContain(PAYLOAD);
    expect(panel.innerHTML).toContain('&lt;img');
  });

  it('escapa mensaje malicioso', () => {
    const { panel } = cargar();
    renderAlertasScorePanel([
      { id: 'a1', clientes: { razon_social: 'Cliente OK' }, mensaje: PAYLOAD },
    ]);
    expect(panel.innerHTML).not.toContain(PAYLOAD);
    expect(panel.innerHTML).toContain('&lt;img');
  });

  it('clientes ausente (join que no matcheó): no revienta, razon_social se muestra vacía', () => {
    const { panel } = cargar();
    expect(() => renderAlertasScorePanel([
      { id: 'a1', clientes: null, mensaje: 'Alerta sin cliente resuelto' },
    ])).not.toThrow();
    expect(panel.innerHTML).toContain('Alerta sin cliente resuelto');
  });

  it('datos limpios se muestran sin alterar y se limita a las primeras 3 alertas', () => {
    const { panel } = cargar();
    const alertas = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      clientes: { razon_social: `Cliente & Cía ${i}` },
      mensaje: `Mensaje ${i}`,
    }));
    renderAlertasScorePanel(alertas);
    expect(panel.innerHTML).toContain('Cliente &amp; Cía 0');
    expect(panel.innerHTML).toContain('5 alerta(s) de nivel de confianza');
    // El título cuenta las 5, pero el listado de filas se corta en 3
    // (alertas.slice(0, 3)) — solo se muestran los primeros 3 mensajes.
    expect(panel.innerHTML).toContain('Mensaje 2');
    expect(panel.innerHTML).not.toContain('Mensaje 3');
  });

  it('lista vacía: oculta el panel (display none) en vez de renderizar', () => {
    const { panel } = cargar();
    renderAlertasScorePanel([]);
    expect(panel.style.display).toBe('none');
  });
});
