// tests/frontend/remito.test.js
//
// Regresión hallazgo ⚪ #23 (segunda mitad, AUDITORIA_BUGS_v954.md) —
// remito.js / imprimirRemito(): a diferencia del resto del archivo (que
// ya envuelve todo dato de usuario en sanitize()), esto verifica en
// concreto los dos campos de `cuit` (empresa y cliente), que aparecen en
// el encabezado, el bloque "Destinatario" y el footer del remito
// imprimible. `empresa.cuit` lo carga solo el dueño/admin (config de
// empresa) y `cliente.cuit` cualquiera con permiso de ABM de Clientes —
// riesgo bajo (no hay escalamiento de rol: quien ve el remito ya tiene
// acceso al pedido), pero mismo criterio de defense-in-depth que el
// resto de la ronda. El código ya tenía el fix aplicado (sanitize() en
// las 3 apariciones de cada campo) — este test es de regresión
// preventiva para que una futura edición no lo reintroduzca.
//
// imprimirRemito() abre una ventana nueva con window.open() y escribe el
// HTML final vía win.document.write() (no hay innerHTML de por medio),
// así que el test mockea window.open() para capturar ese HTML, y sb
// (Supabase) solo para las dos consultas a la tabla `pedidos` que hace
// la función (la principal, con el join a `clientes`, y la de
// obtenerNroRemito()) — pedido_items se evita pasando itemsPrecargados.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarScripts, crearDocumentoFake } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const REMITO   = path.resolve(__dirname, '../../frontend/admin/js/remito.js');

const PAYLOAD = '<img src=x onerror=alert(1)>';

function crearWinFake() {
  const estado = { html: '' };
  const documentoWin = {
    write: vi.fn(s => { estado.html += s; }),
    open: vi.fn(() => { estado.html = ''; }), // document.open() real limpia el buffer
    close: vi.fn(),
  };
  return { win: { document: documentoWin }, obtenerHtml: () => estado.html };
}

function crearSbFake(pedido) {
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
    from: (tabla) => {
      if (tabla !== 'pedidos') throw new Error(`[test remito] tabla no mockeada: ${tabla}`);
      return {
        select: (campos) => ({
          eq: () => ({
            single: async () => {
              // Query principal (con join a clientes) vs. la de obtenerNroRemito()
              // (solo pide remito_nro) — se distinguen por los campos pedidos.
              if (campos.includes('clientes(')) return { data: pedido, error: null };
              return { data: { remito_nro: pedido.remito_nro }, error: null };
            },
          }),
        }),
      };
    },
  };
}

const pedidoBase = {
  id: 'pedido-000123456',
  estado: 'confirmado',
  subtotal: 1000,
  descuento: 0,
  iva_total: 210,
  total: 1210,
  notas_cliente: null,
  fecha_pedido: '2026-08-01',
  fecha_entrega: '2026-08-05',
  created_at: '2026-08-01T00:00:00Z',
  remito_nro: 42,
  clientes: {
    razon_social: 'Cliente OK',
    nombre_fantasia: null,
    cuit: '20-11111111-1',
    telefono: null,
    domicilio: null,
    localidad: null,
    condicion_iva: 'responsable_inscripto',
    zonas: null,
  },
  usuarios: null,
};

const itemsBase = [
  { cantidad: 1, precio_unitario: 1000, descuento_pct: 0, subtotal: 1000, productos: { nombre: 'Producto A', unidad: 'u', codigo: 'P1' } },
];

async function generarRemito({ pedido = pedidoBase, empresaCuit = '30-12345678-9' } = {}) {
  const { win, obtenerHtml } = crearWinFake();
  const documento = crearDocumentoFake();
  const authCtx = {
    sb: crearSbFake(pedido),
    perfil: { empresas: { nombre: 'Distribuidora X', cuit: empresaCuit, logo_url: '' } },
  };
  const { sandbox } = cargarScripts([UI_UTILS, REMITO], {
    documento,
    extra: { open: vi.fn(() => win), authCtx },
  });
  await sandbox.imprimirRemito(pedido.id, itemsBase);
  return obtenerHtml();
}

describe('remito.js — imprimirRemito (#23, footer y encabezado del remito imprimible)', () => {
  it('escapa empresa.cuit malicioso (encabezado y footer)', async () => {
    const html = await generarRemito({ empresaCuit: PAYLOAD });
    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain('&lt;img');
  });

  it('escapa cliente.cuit malicioso (bloque Destinatario)', async () => {
    const pedido = { ...pedidoBase, clientes: { ...pedidoBase.clientes, cuit: PAYLOAD } };
    const html = await generarRemito({ pedido });
    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain('&lt;img');
  });

  it('datos limpios se muestran sin alterar (empresa, cliente y N° de remito)', async () => {
    const html = await generarRemito();
    expect(html).toContain('Distribuidora X');
    expect(html).toContain('CUIT: 30-12345678-9');
    expect(html).toContain('Cliente OK');
    expect(html).toContain('CUIT: 20-11111111-1');
    expect(html).toContain('N° 000042');
  });
});
