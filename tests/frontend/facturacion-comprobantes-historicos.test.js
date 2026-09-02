// tests/frontend/facturacion-comprobantes-historicos.test.js
//
// Regresión hallazgo 🟡 #21 (AUDITORIA_BUGS_v954.md) — XSS almacenado en
// la pestaña "Comprobantes históricos" de facturacion.html: a diferencia
// de facturacion.js y notas-credito.js (que sanitizan todo dato de
// usuario de forma consistente), el script inline `type="module"` de
// esta pestaña no lo hacía — `r.numero_original`,
// `r.clientes?.nombre_fantasia/razon_social` y `r.observaciones` se
// interpolaban crudos. Son campos de texto libre cargados a mano por
// quien corre el wizard de migración histórica, vista de solo lectura
// para cualquiera con acceso a Facturación. Fix: los tres campos (y el
// mensaje de error del catch de cargarComprobantesHistoricos) envueltos
// en `window.sanitize()`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { cargarScripts, crearDocumentoFake, crearElementoFake, extraerScriptDeHtml } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS     = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const FACTURACION_HTML = path.resolve(__dirname, '../../frontend/admin/facturacion.html');

const PAYLOAD = '<img src=x onerror=alert(1)>';

// El bloque es un <script type="module">; se le saca el `import` de
// adminlte-utils.js (no resoluble en vm.Context) — no hace falta para
// renderComprobantesHist, que no usa `toast`.
function stripImport(codigo) {
  return codigo.replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*;?\s*$/m, '');
}

function cargar() {
  const script = extraerScriptDeHtml(FACTURACION_HTML, 'renderComprobantesHist');
  const scriptPath = path.join(__dirname, '__facturacion-inline-module__.js');
  require('node:fs').writeFileSync(scriptPath, stripImport(script));
  const tbody = crearElementoFake();
  const documento = crearDocumentoFake({ 'tbody-ch': tbody });
  const { sandbox } = cargarScripts([UI_UTILS, scriptPath], { documento });
  require('node:fs').unlinkSync(scriptPath);
  return { sandbox, tbody };
}

describe('facturacion.html — renderComprobantesHist (#21, pestaña Comprobantes históricos)', () => {
  it('escapa numero_original malicioso', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderComprobantesHist([
      { tipo: 'factura', numero_original: PAYLOAD, clientes: { razon_social: 'Cliente OK' }, fecha: null, monto: 100, observaciones: null },
    ]);
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
    expect(tbody.innerHTML).toContain('&lt;img');
  });

  it('escapa cliente (nombre_fantasia/razon_social) malicioso', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderComprobantesHist([
      { tipo: 'factura', numero_original: 'A-0001', clientes: { razon_social: PAYLOAD }, fecha: null, monto: 100, observaciones: null },
    ]);
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
  });

  it('escapa observaciones maliciosas', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderComprobantesHist([
      { tipo: 'factura', numero_original: 'A-0001', clientes: { razon_social: 'Cliente OK' }, fecha: null, monto: 100, observaciones: PAYLOAD },
    ]);
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
  });

  it('datos limpios se muestran sin alterar', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderComprobantesHist([
      { tipo: 'nota_credito', numero_original: 'NC-0001', clientes: { razon_social: 'Tuercas & Bulones S.A.' }, fecha: null, monto: 100, observaciones: 'Migrado a mano' },
    ]);
    expect(tbody.innerHTML).toContain('Tuercas &amp; Bulones S.A.');
    expect(tbody.innerHTML).toContain('NC-0001');
    expect(tbody.innerHTML).toContain('Migrado a mano');
  });

  it('lista vacía muestra el mensaje "Sin comprobantes históricos"', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderComprobantesHist([]);
    expect(tbody.innerHTML).toContain('Sin comprobantes históricos');
  });
});
