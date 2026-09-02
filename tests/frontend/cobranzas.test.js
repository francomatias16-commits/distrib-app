// tests/frontend/cobranzas.test.js
//
// Regresión hallazgo #19 (AUDITORIA_BUGS_v954.md) — XSS almacenado en la
// tabla de "Facturas pendientes" de Cobranzas: `f.numero_factura`,
// `f.cliente_nombre` y el label del chip de prioridad se interpolaban
// crudos en el innerHTML, mientras el resto del archivo sí pasaba datos
// de usuario por `window.sanitize()`. `cliente_nombre` lo carga cualquier
// usuario con permiso de ABM de Clientes → mismo vector de escalamiento
// que #16. Fix: los tres valores envueltos en `window.sanitize()`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { cargarScripts, crearDocumentoFake, crearElementoFake, asignarVariableDeModulo } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS  = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const COBRANZAS = path.resolve(__dirname, '../../frontend/admin/js/cobranzas.js');

const PAYLOAD = '<img src=x onerror=alert(1)>';

// `cobranzaPriorizada` y `_sb` son `let` de nivel superior de cobranzas.js
// (lexical environment del vm.Context, NO propiedades de `sandbox`/`window`
// — ver nota en tests/helpers/cargar-script-frontend.js), así que hay que
// mutarlas con asignarVariableDeModulo(); asignar sandbox.cobranzaPriorizada
// directamente no las toca.
function cargar() {
  const tbody = crearElementoFake();
  const documento = crearDocumentoFake({ 'tbody-facturas': tbody });
  const { sandbox, contexto } = cargarScripts([UI_UTILS, COBRANZAS], { documento });
  return { sandbox, contexto, tbody };
}

describe('cobranzas.js — renderPriorizada (#19, tabla priorizada por score)', () => {
  it('escapa cliente_nombre malicioso', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'cobranzaPriorizada', [
      { cliente_id: '1', cliente_nombre: PAYLOAD, numero_factura: 'A-0001', saldo_pendiente: 1000, dias_vencida: 5, prioridad: 'accion_urgente', score_cobrabilidad: 10 },
    ]);
    sandbox.renderPriorizada();
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
    expect(tbody.innerHTML).toContain('&lt;img');
  });

  it('escapa numero_factura malicioso', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'cobranzaPriorizada', [
      { cliente_id: '1', cliente_nombre: 'Cliente OK', numero_factura: PAYLOAD, saldo_pendiente: 1000, dias_vencida: 5, prioridad: 'accion_urgente', score_cobrabilidad: 10 },
    ]);
    sandbox.renderPriorizada();
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
  });

  it('datos limpios se muestran sin alterar', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'cobranzaPriorizada', [
      { cliente_id: '1', cliente_nombre: 'Tuercas & Bulones S.A.', numero_factura: 'A-0001', saldo_pendiente: 1000, dias_vencida: 5, prioridad: 'accion_urgente', score_cobrabilidad: 10 },
    ]);
    sandbox.renderPriorizada();
    expect(tbody.innerHTML).toContain('Tuercas &amp; Bulones S.A.');
    expect(tbody.innerHTML).toContain('A-0001');
  });
});

describe('cobranzas.js — renderFacturas/tabla por pestaña (#19, misma línea 171)', () => {
  it('cliente_nombre ya estaba sanitizado (no regresiona) al pasar por la tabla no-priorizada', async () => {
    const tbody = crearElementoFake();
    const documento = crearDocumentoFake({ 'tbody-facturas': tbody });
    const rpcResult = { data: [{ id: 'f1', numero: 'A-0002', cliente_nombre: PAYLOAD, total: 1000, pendiente: 1000, vencimiento: '2026-09-01' }], error: null };
    const sb = { rpc: async () => rpcResult };
    const { sandbox, contexto } = cargarScripts([UI_UTILS, COBRANZAS], { documento });
    // _sb solo se asigna en el .then() de window.authReady (que en el
    // helper nunca resuelve a propósito), así que hay que setearla a mano.
    asignarVariableDeModulo(contexto, sandbox, '_sb', sb);
    await sandbox.renderFacturas('hoy');
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
    expect(tbody.innerHTML).toContain('&lt;img');
  });
});
