// tests/lib/eventos-origen.test.js
//
// Regresión del bug encontrado en Fase 6 (checklist §6, ítem "datos de
// uso real: voz vs. a mano"): emitirEvento() resolvía el origen como
// `origen || origenALS.getStore() || null`, así que un caller compartido
// (crearPedidoParaCliente, emitirFactura, anularFactura) que siempre pasa
// un origen literal (ej. 'crearPedidoParaCliente') tapaba para siempre el
// 'asistente_voz' que ejecutarTool()/resolverAccionPendiente() intentan
// inyectar via conOrigenAsistenteVoz(). Resultado: ningún evento emitido
// desde una tool del asistente podía distinguirse de uno emitido desde
// el panel — el mecanismo existía pero nunca se activaba.
//
// El fix invierte la precedencia: origenALS (cuando está seteado) gana
// sobre el origen explícito del caller. Fuera del contexto del asistente,
// el comportamiento no cambia (se sigue usando el origen del caller).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const insertsMock = vi.hoisted(() => ({ filas: [] }));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => {
      if (tabla !== 'eventos_negocio') throw new Error(`tabla inesperada en el mock: ${tabla}`);
      return {
        insert: (fila) => {
          insertsMock.filas.push(fila);
          return {
            select: () => ({
              single: async () => ({ data: { id: 'evt-1', ...fila }, error: null }),
            }),
          };
        },
      };
    },
  }),
}));

let emitirEvento;
let conOrigenAsistenteVoz;

beforeEach(async () => {
  insertsMock.filas = [];
  vi.resetModules();
  ({ emitirEvento, conOrigenAsistenteVoz } = await import('../../lib/eventos.js'));
});

describe('emitirEvento — precedencia de origen', () => {
  it('fuera del contexto del asistente, usa el origen explícito del caller (sin cambios de comportamiento)', async () => {
    await emitirEvento({
      empresaId: 'e1',
      tipoEvento: 'pedido_creado',
      payload: {},
      origen: 'crearPedidoParaCliente',
    });
    expect(insertsMock.filas[0].origen).toBe('crearPedidoParaCliente');
  });

  it('fuera del contexto del asistente, sin origen explícito, guarda null', async () => {
    await emitirEvento({ empresaId: 'e1', tipoEvento: 'pedido_creado', payload: {} });
    expect(insertsMock.filas[0].origen).toBeNull();
  });

  it('dentro de conOrigenAsistenteVoz, el contexto GANA sobre el origen explícito del caller (bug corregido)', async () => {
    await conOrigenAsistenteVoz(async () => {
      await emitirEvento({
        empresaId: 'e1',
        tipoEvento: 'pedido_creado',
        payload: {},
        origen: 'crearPedidoParaCliente',
      });
    });
    expect(insertsMock.filas[0].origen).toBe('asistente_voz');
  });

  it('dentro de conOrigenAsistenteVoz, sin origen explícito, también resuelve a asistente_voz', async () => {
    await conOrigenAsistenteVoz(async () => {
      await emitirEvento({ empresaId: 'e1', tipoEvento: 'factura_anulada', payload: {} });
    });
    expect(insertsMock.filas[0].origen).toBe('asistente_voz');
  });

  it('no filtra el contexto a una emisión que corre fuera de la promesa envuelta (fire-and-forget no anidado)', async () => {
    let promesaSuelta;
    await conOrigenAsistenteVoz(async () => {
      // Simula un emitirEvento() disparado sin await (patrón real de los
      // callers, ej. crear-pedido.js) — igual corre DENTRO del run() de
      // AsyncLocalStorage porque la promesa se crea sincrónicamente ahí.
      promesaSuelta = emitirEvento({
        empresaId: 'e1',
        tipoEvento: 'pedido_creado',
        payload: {},
        origen: 'crearPedidoParaCliente',
      });
    });
    await promesaSuelta;
    expect(insertsMock.filas[0].origen).toBe('asistente_voz');
  });
});
