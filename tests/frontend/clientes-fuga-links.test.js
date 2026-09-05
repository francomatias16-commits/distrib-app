// tests/frontend/clientes-fuga-links.test.js
//
// PLAN_CLIENTES_FUGA_ACCIONES.md, Fase A: la pantalla de "Clientes en
// fuga" era de solo lectura — ni el nombre del cliente ni el badge de
// acción llevaban a ningún lado. Este test cubre los dos links nuevos que
// agrega renderTablaFuga() (frontend/admin/js/clientes-fuga.js):
//   - A1: el nombre de cliente linkea a /admin/clientes?id=<cliente_id>
//     (mismo patrón de deep-link que ya soporta clientes.js).
//   - A2: el badge de "Acción ya disparada" linkea a Automatización →
//     Tareas SOLO cuando la acción es una tarea (pendiente o completada) —
//     whatsapp_enviado y sin_accion no tienen nada más para hacer, así que
//     no deben renderizar ningún link.
// Mismo criterio de mocking que cobranzas.test.js (vm.runInContext sin
// jsdom, vía tests/helpers/cargar-script-frontend.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { cargarScripts, crearDocumentoFake, crearElementoFake, asignarVariableDeModulo } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS      = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const CLIENTES_FUGA = path.resolve(__dirname, '../../frontend/admin/js/clientes-fuga.js');

function cargar() {
  const tbody = crearElementoFake();
  const documento = crearDocumentoFake({
    'tbody-clientes-fuga': tbody,
    'buscar-fuga': crearElementoFake({ value: '' }),
  });
  const { sandbox, contexto } = cargarScripts([UI_UTILS, CLIENTES_FUGA], { documento });
  return { sandbox, contexto, tbody };
}

const CLIENTE_BASE = {
  cliente_id: 'cli-1',
  razon_social: 'Almacén Ibarra',
  dias_atraso: 25,
  producto_principal: 'Aceite en caja 12x900cc',
  valor_anual_estimado: 24950,
  motivo_probable: 'posible_freno_por_deuda',
};

describe('clientes-fuga.js — renderTablaFuga (Fase A, links)', () => {
  it('A1: el nombre de cliente linkea a /admin/clientes?id=<cliente_id>', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, accion_disparada: 'sin_accion' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).toContain('href="/admin/clientes?id=cli-1"');
    expect(tbody.innerHTML).toContain('Almacén Ibarra');
  });

  it('A1: sin cliente_id, cae al fallback sin link (no rompe)', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, cliente_id: undefined, accion_disparada: 'sin_accion' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).not.toContain('/admin/clientes?id=');
    expect(tbody.innerHTML).toContain('Almacén Ibarra');
  });

  it('A2: accion_disparada=tarea_pendiente linkea a Automatización → Tareas', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, accion_disparada: 'tarea_pendiente' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).toContain('href="/admin/automatizacion#tareas-auto-card"');
    expect(tbody.innerHTML).toContain('Tarea pendiente');
  });

  it('A2: accion_disparada=tarea_completada también linkea a Automatización', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, accion_disparada: 'tarea_completada' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).toContain('href="/admin/automatizacion#tareas-auto-card"');
    expect(tbody.innerHTML).toContain('Tarea resuelta');
  });

  it('A2: accion_disparada=whatsapp_enviado NO linkea (no hay nada más para hacer)', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, accion_disparada: 'whatsapp_enviado' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).not.toContain('/admin/automatizacion');
    expect(tbody.innerHTML).toContain('WhatsApp enviado');
  });

  it('A2: accion_disparada=sin_accion NO linkea', () => {
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, accion_disparada: 'sin_accion' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).not.toContain('/admin/automatizacion');
    expect(tbody.innerHTML).toContain('Sin acción todavía');
  });

  it('escapa razon_social maliciosa incluso dentro del link nuevo', () => {
    const PAYLOAD = '<img src=x onerror=alert(1)>';
    const { sandbox, contexto, tbody } = cargar();
    asignarVariableDeModulo(contexto, sandbox, 'todosClientesFuga', [
      { ...CLIENTE_BASE, razon_social: PAYLOAD, accion_disparada: 'sin_accion' },
    ]);
    sandbox.renderTablaFuga();

    expect(tbody.innerHTML).not.toContain(PAYLOAD);
    expect(tbody.innerHTML).toContain('&lt;img');
  });
});
