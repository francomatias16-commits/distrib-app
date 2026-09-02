// tests/handlers/eventos-dispatcher.test.js
//
// PLAN_ERP_SINCRONIZACION_2026.md — Fase 3: despachador de eventos.
// Lo crítico acá es el comportamiento de aislamiento entre listeners
// (Promise.allSettled: uno que falla no debe frenar a los demás) y que
// el estado en eventos_negocio quede coherente con el resultado real.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  eventosPendientes: [],
  updates: [],
}));

const listenersMock = vi.hoisted(() => {
  const ok1 = vi.fn(async () => {});
  const ok2 = vi.fn(async () => {});
  const falla = vi.fn(async () => { throw new Error('boom'); });
  ok1.listenerNombre = 'ok1';
  ok2.listenerNombre = 'ok2';
  falla.listenerNombre = 'falla';
  return { ok1, ok2, falla };
});

// Refleja el contrato real de reclamarEventos() (SYNC-06): SELECT con
// .order().limit()[.eq('empresa_id',x)].or(filtroOr) — el filtroOr combina
// "estado.in.(...)" con la rama de lease vencido para 'procesando' — y un
// claim atómico .update(cambios).eq('id',x).eq('estado',y).select('*').maybeSingle().
// despacharEvento() sigue usando la forma simple .update(cambios).eq('id',x)
// awaited directo, sin select/maybeSingle — el mock soporta ambas formas.
vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => {
      if (tabla !== 'eventos_negocio') throw new Error(`tabla inesperada en el mock: ${tabla}`);
      return {
        select: () => {
          const state = {};
          const builder = {
            order: () => builder,
            limit: () => builder,
            eq: (_col, empresaId) => { state.empresaId = empresaId; return builder; },
            or: (filtroOr) => { state.filtroOr = filtroOr; return builder; },
            then: (resolve) => {
              const inMatch = state.filtroOr?.match(/estado\.in\.\(([^)]*)\)/);
              const estadosIn = inMatch ? inMatch[1].split(',') : [];
              const leaseMatch = state.filtroOr?.match(/procesando_desde\.lt\.([^)]*)\)/);
              const leaseLimite = leaseMatch ? leaseMatch[1] : null;
              let data = dbMock.eventosPendientes.filter((e) => {
                if (estadosIn.includes(e.estado)) return true;
                if (leaseLimite && e.estado === 'procesando' && e.procesando_desde && e.procesando_desde < leaseLimite) return true;
                return false;
              });
              if (state.empresaId) data = data.filter((e) => e.empresa_id === state.empresaId);
              resolve({ data, error: null });
            },
          };
          return builder;
        },
        update: (cambios) => {
          const state = {};
          const builder = {
            eq: (col, val) => {
              if (col === 'id') state.id = val;
              if (col === 'estado') state.estadoEsperado = val;
              return builder;
            },
            select: () => builder,
            // claim atómico de reclamarEventos(): solo "gana" si el estado sigue
            // siendo el que se leyó (misma condición de carrera que el código real).
            maybeSingle: () => {
              const evento = dbMock.eventosPendientes.find(
                (e) => e.id === state.id && (state.estadoEsperado === undefined || e.estado === state.estadoEsperado),
              );
              if (!evento) return Promise.resolve({ data: null, error: null });
              Object.assign(evento, cambios);
              dbMock.updates.push({ id: state.id, cambios });
              return Promise.resolve({ data: { ...evento }, error: null });
            },
            // forma simple de despacharEvento(): awaited directo sin select/maybeSingle.
            then: (resolve) => {
              dbMock.updates.push({ id: state.id, cambios });
              resolve({ error: null });
            },
          };
          return builder;
        },
      };
    },
  }),
}));

vi.mock('../../lib/eventos-listeners/pedido_creado.js', () => ({
  listenersPedidoCreado: [listenersMock.ok1, listenersMock.ok2],
}));

// Fase 4: cliente_en_mora ya tiene listener registrado (a diferencia de
// pedido_facturado/factura_anulada, que siguen en [] — ver test de abajo
// "no tiene listeners registrados..."). Se mockea acá con su propio spy
// para no depender de lib/handlers/notif.js (módulo pesado) en este test,
// que es sobre el comportamiento del despachador, no de la lógica de deuda.
vi.mock('../../lib/eventos-listeners/cliente_en_mora.js', () => ({
  listenersClienteEnMora: [listenersMock.ok1],
}));

const { despacharEvento, despacharPendientes, TIPOS_EVENTO_SIN_LISTENER } = await import('../../lib/eventos-dispatcher.js');

describe('despacharEvento (Fase 3 — despachador de eventos)', () => {
  beforeEach(() => {
    dbMock.eventosPendientes = [];
    dbMock.updates = [];
    listenersMock.ok1.mockClear();
    listenersMock.ok2.mockClear();
    listenersMock.falla.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('marca el evento como procesado si todos los listeners resuelven ok', async () => {
    const evento = { id: 'ev1', tipo_evento: 'pedido_creado', empresa_id: 'e1', payload: { pedido_id: 'p1' } };
    const resultado = await despacharEvento(evento);

    expect(resultado.ok).toBe(true);
    expect(listenersMock.ok1).toHaveBeenCalledWith(evento.payload, evento);
    expect(listenersMock.ok2).toHaveBeenCalledWith(evento.payload, evento);
    expect(dbMock.updates).toHaveLength(1);
    expect(dbMock.updates[0].cambios.estado).toBe('procesado');
  });

  it('no tiene listeners registrados para un tipo sin migrar → no toca el evento', async () => {
    const evento = { id: 'ev2', tipo_evento: 'pedido_facturado', empresa_id: 'e1', payload: {} };
    const resultado = await despacharEvento(evento);

    expect(resultado.listeners).toBe(0);
    expect(dbMock.updates).toHaveLength(0);
  });

  it('Fase 4: cliente_en_mora sí tiene listener registrado y lo despacha', async () => {
    const evento = { id: 'ev-mora', tipo_evento: 'cliente_en_mora', empresa_id: 'e1', payload: { cliente_id: 'c1', saldo_vencido: 100 } };
    const resultado = await despacharEvento(evento);

    expect(resultado.listeners).toBe(1);
    expect(resultado.ok).toBe(true);
    expect(listenersMock.ok1).toHaveBeenCalledWith(evento.payload, evento);
    expect(dbMock.updates[0].cambios.estado).toBe('procesado');
  });
});

describe('despacharEvento — aislamiento entre listeners', () => {
  beforeEach(() => {
    dbMock.eventosPendientes = [];
    dbMock.updates = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('un listener que falla no impide que corran los demás, y el evento queda en error', async () => {
    // Reemplazo puntual del registro para este test: uno de los dos listeners falla.
    vi.doMock('../../lib/eventos-listeners/pedido_creado.js', () => ({
      listenersPedidoCreado: [listenersMock.ok1, listenersMock.falla],
    }));
    vi.resetModules();
    const { despacharEvento: despachar2 } = await import('../../lib/eventos-dispatcher.js');

    const evento = { id: 'ev3', tipo_evento: 'pedido_creado', empresa_id: 'e1', payload: {} };
    const resultado = await despachar2(evento);

    expect(resultado.ok).toBe(false);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0].listener).toBe('falla');
    expect(listenersMock.ok1).toHaveBeenCalled(); // el que sí funcionaba, corrió igual
    expect(dbMock.updates[0].cambios.estado).toBe('error');
  });
});

describe('despacharPendientes', () => {
  beforeEach(() => {
    dbMock.eventosPendientes = [
      { id: 'a', tipo_evento: 'pedido_creado', empresa_id: 'e1', estado: 'pendiente', payload: {} },
      { id: 'b', tipo_evento: 'pedido_creado', empresa_id: 'e2', estado: 'pendiente', payload: {} },
    ];
    dbMock.updates = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('procesa solo los eventos pendientes', async () => {
    const resultado = await despacharPendientes({});
    expect(resultado.ok).toBe(true);
    expect(resultado.procesados).toBe(2);
  });
});

describe('TIPOS_EVENTO_SIN_LISTENER (Fase 8 — anotación de observabilidad)', () => {
  it('incluye pedido_facturado y factura_anulada — quedan en pendiente para siempre por diseño', () => {
    expect(TIPOS_EVENTO_SIN_LISTENER).toContain('pedido_facturado');
    expect(TIPOS_EVENTO_SIN_LISTENER).toContain('factura_anulada');
  });

  it('no incluye tipos que sí tienen listener migrado', () => {
    expect(TIPOS_EVENTO_SIN_LISTENER).not.toContain('pedido_creado');
    expect(TIPOS_EVENTO_SIN_LISTENER).not.toContain('cliente_en_mora');
    expect(TIPOS_EVENTO_SIN_LISTENER).not.toContain('cheques_por_vencer');
  });
});
