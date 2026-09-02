// tests/frontend/rutas.test.js
//
// Regresión hallazgos de AUDITORIA_BUGS_v954.md sobre rutas.js:
//
// 🟠 #22 — XSS almacenado en el popup del mapa de seguimiento en vivo
// (inicializarMapa/pintarSinUbicar, tab "Seguimiento"): `cliente`, `dir`
// y `e.receptor` se insertaban sin `esc()` en el `.bindPopup()` de
// Leaflet, mientras el mismo archivo ya escapaba `e.receptor` en otros
// tres lugares (modal de detalle, tabla de reportes, popup del mapa de
// reporte cerrado). `receptor` es texto libre que carga el CHOFER al
// confirmar una entrega (frontend/chofer/remito.html) — vía de
// escalamiento real chofer → dueño/admin/vendedor con el mapa abierto.
//
// ⚪ #23 — inconsistencia menor de escaping en cambiarTipoInvitacion()
// (`<select>` "invitar chofer existente"): `c.nombre` se insertaba crudo
// en el `<option>`, sin `esc()`, a diferencia del resto del archivo
// (avatarChofer, tabla de reportes).
//
// Ambos ya tienen el fix aplicado (v962) — estos tests son de regresión
// preventiva para que no se reintroduzcan.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarScripts, crearDocumentoFake, crearElementoFake, asignarVariableDeModulo } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const RUTAS    = path.resolve(__dirname, '../../frontend/admin/js/rutas.js');

const PAYLOAD = '<img src=x onerror=alert(1)>';

/** Mock mínimo de Leaflet: sólo lo que inicializarMapa() necesita, y
 * captura el HTML pasado a bindPopup() para poder inspeccionarlo. */
function crearLeafletFake() {
  const popups = [];
  const L = {
    map: vi.fn(() => ({
      remove: vi.fn(),
      invalidateSize: vi.fn(),
      fitBounds: vi.fn(),
    })),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    divIcon: vi.fn(() => ({})),
    marker: vi.fn(() => {
      const m = {
        bindPopup: vi.fn(html => { popups.push(html); return m; }),
        addTo: vi.fn(() => m),
        remove: vi.fn(),
      };
      return m;
    }),
  };
  return { L, popups };
}

describe('rutas.js — inicializarMapa (#22, popup del mapa de seguimiento en vivo)', () => {
  function cargar() {
    const mapaEl = crearElementoFake();
    const documento = crearDocumentoFake({ mapa: mapaEl, 'mapa-sin-ubicar': crearElementoFake() });
    const { L, popups } = crearLeafletFake();
    const { sandbox } = cargarScripts([UI_UTILS, RUTAS], {
      documento,
      extra: { L, requestAnimationFrame: vi.fn() },
    });
    return { sandbox, popups };
  }

  const entregaBase = {
    estado: 'entregado',
    fecha_confirmacion: null,
    pedidos: {
      ubicacion_entrega: { lat: -27.46, lng: -60.0 },
      clientes: { razon_social: 'Cliente OK', domicilio: 'Domicilio OK', lat: -27.46, lng: -60.0 },
    },
  };

  it('escapa cliente (razon_social) malicioso', () => {
    const { sandbox, popups } = cargar();
    sandbox.inicializarMapa([{ ...entregaBase, pedidos: { ...entregaBase.pedidos, clientes: { ...entregaBase.pedidos.clientes, razon_social: PAYLOAD } } }]);
    expect(popups[0]).not.toContain(PAYLOAD);
    expect(popups[0]).toContain('&lt;img');
  });

  it('escapa dir (domicilio) malicioso', () => {
    const { sandbox, popups } = cargar();
    sandbox.inicializarMapa([{ ...entregaBase, pedidos: { ...entregaBase.pedidos, clientes: { ...entregaBase.pedidos.clientes, domicilio: PAYLOAD } } }]);
    expect(popups[0]).not.toContain(PAYLOAD);
    expect(popups[0]).toContain('&lt;img');
  });

  it('escapa receptor malicioso (cargado por el chofer)', () => {
    const { sandbox, popups } = cargar();
    sandbox.inicializarMapa([{ ...entregaBase, receptor: PAYLOAD }]);
    expect(popups[0]).not.toContain(PAYLOAD);
    expect(popups[0]).toContain('&lt;img');
  });

  it('datos limpios se muestran sin alterar', () => {
    const { sandbox, popups } = cargar();
    sandbox.inicializarMapa([{ ...entregaBase, receptor: 'Juan (encargado)' }]);
    expect(popups[0]).toContain('Cliente OK');
    expect(popups[0]).toContain('Domicilio OK');
    expect(popups[0]).toContain('Juan (encargado)');
  });
});

describe('rutas.js — pintarSinUbicar (#22, lista de entregas sin coordenadas)', () => {
  function cargar() {
    const cont = crearElementoFake();
    const documento = crearDocumentoFake({ 'mapa-sin-ubicar': cont });
    const { sandbox } = cargarScripts([UI_UTILS, RUTAS], { documento });
    return { sandbox, cont };
  }

  it('escapa razon_social malicioso', () => {
    const { sandbox, cont } = cargar();
    sandbox.pintarSinUbicar([{ pedidos: { clientes: { razon_social: PAYLOAD } } }]);
    expect(cont.innerHTML).not.toContain(PAYLOAD);
    expect(cont.innerHTML).toContain('&lt;img');
  });

  it('lista vacía oculta el bloque', () => {
    const { sandbox, cont } = cargar();
    sandbox.pintarSinUbicar([]);
    expect(cont.style.display).toBe('none');
  });
});

describe('rutas.js — cambiarTipoInvitacion (#23, select "invitar chofer existente")', () => {
  it('escapa c.nombre malicioso en el <option>', async () => {
    const selExistente = crearElementoFake();
    const documento = crearDocumentoFake(
      {
        'invitar-campos-nuevo': crearElementoFake(),
        'invitar-campos-existente': crearElementoFake(),
        'invitar-chofer-existente': selExistente,
      },
      { querySelector: () => ({ value: 'existente' }) }
    );
    const sbMock = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: async () => ({ data: [{ id: 'c1', nombre: PAYLOAD, telefono: null }] }),
            }),
          }),
        }),
      }),
    };
    const { sandbox, contexto } = cargarScripts([UI_UTILS, RUTAS], { documento });
    asignarVariableDeModulo(contexto, sandbox, 'sb', sbMock);
    asignarVariableDeModulo(contexto, sandbox, 'empresaId', 'e1');
    await sandbox.cambiarTipoInvitacion();
    expect(selExistente.innerHTML).not.toContain(PAYLOAD);
    expect(selExistente.innerHTML).toContain('&lt;img');
  });
});
