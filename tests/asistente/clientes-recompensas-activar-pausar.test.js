// tests/asistente/clientes-recompensas-activar-pausar.test.js
//
// Bug encontrado al migrar editar_recompensa_asistente al contrato de
// _respuestas.js (bloqueado() para pedir un cambio de estado que ya está
// en ese estado, mismo criterio que editar_cliente_asistente/
// dar_de_baja_cliente_asistente en clientes.js): buscarRecompensaPorTexto
// (lib/asistente-tools/_helpers.js) siempre filtraba `.eq('activa', true)`,
// pensado para canjear_recompensa_asistente (no se puede canjear una
// recompensa pausada). editar_recompensa_asistente reusaba la misma
// función para ubicar la recompensa por nombre — con el filtro puesto
// siempre, una recompensa pausada era invisible para editar_recompensa_
// asistente y nunca se podía reactivar por voz ni por texto: la búsqueda
// fallaba con "No encontré ninguna recompensa activa parecida a...", igual
// que si no existiera.
//
// Fix: buscarRecompensaPorTexto ahora acepta `incluirInactivas` (default
// false, no cambia el comportamiento de canjear_recompensa_asistente);
// editar_recompensa_asistente y armarCambiosRecompensa lo pasan en true.
// De paso se agregó el bloqueado() de "ya está activa/pausada" cuando se
// pide un cambio de estado que no cambia nada, mismo patrón que clientes.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

vi.mock('../../lib/repos/clientes.js', () => ({
  crearCliente: vi.fn(),
  actualizarCliente: vi.fn(),
  desactivarCliente: vi.fn(),
}));
vi.mock('../../lib/repos/audit.js', () => ({ registrarAuditoriaSilenciosa: vi.fn() }));

const { TOOLS_CLIENTES } = await import('../../lib/asistente-tools/clientes.js');

const editar = TOOLS_CLIENTES.find((t) => t.name === 'editar_recompensa_asistente');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

// Mismo patrón que clientes-recompensas-bugfix.test.js: cada llamada a
// db.from('recompensas') devuelve un objeto nuevo, y se distingue
// búsqueda/lectura-actual/patch por cuál método se invocó último.
function mockTablaRecompensas({ fila }) {
  const busqueda = [{ id: 'r1', nombre: fila.nombre, puntos_requeridos: fila.puntos_requeridos, activa: fila.activa }];
  dbMock.from.mockImplementation((tabla) => {
    if (tabla !== 'recompensas') throw new Error(`tabla no mockeada en este test: ${tabla}`);
    let modo = 'filaActual';
    const obj = {
      select: vi.fn(() => obj),
      eq: vi.fn(() => obj),
      ilike: vi.fn(() => { modo = 'busqueda'; return obj; }),
      update: vi.fn(() => { modo = 'resultado'; return obj; }),
      single: vi.fn(() => Promise.resolve(
        modo === 'resultado' ? { data: { id: 'r1', nombre: fila.nombre }, error: null } : { data: fila, error: null }
      )),
      then: (resolve, reject) => Promise.resolve({ data: busqueda, error: null }).then(resolve, reject),
    };
    return obj;
  });
}

const FILA_PAUSADA = {
  nombre: 'Envío gratis VIP', descripcion: null, puntos_requeridos: 500, tipo: 'envio_gratis',
  valor: null, cantidad_disponible: null, fecha_inicio: null, fecha_fin: null, activa: false,
};
const FILA_ACTIVA = { ...FILA_PAUSADA, activa: true };

describe('editar_recompensa_asistente — reactivar una recompensa pausada', () => {
  it('resumen(): encuentra la recompensa pausada (antes del fix, "no encontré...")', async () => {
    mockTablaRecompensas({ fila: FILA_PAUSADA });
    const texto = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: 'Envío gratis VIP', activa: true },
    });
    expect(texto).toContain('Actualizar la recompensa "Envío gratis VIP"');
    expect(texto).toContain('activada');
  });

  it('execute(): reactiva y devuelve ok', async () => {
    mockTablaRecompensas({ fila: FILA_PAUSADA });
    const resultado = await editar.execute({
      empresaId: EMPRESA_ID,
      args: { referencia: 'Envío gratis VIP', activa: true },
    });
    expect(resultado).toEqual({ ok: true, id: 'r1', nombre: 'Envío gratis VIP' });
  });

  it('pausar una recompensa activa: funciona igual', async () => {
    mockTablaRecompensas({ fila: FILA_ACTIVA });
    const texto = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: 'Envío gratis VIP', activa: false },
    });
    expect(texto).toContain('pausada');
  });
});

describe('editar_recompensa_asistente — bloqueado() al pedir un estado que ya tiene', () => {
  it('ya está activa: tira bloqueado, sin tocar la DB de escritura', async () => {
    mockTablaRecompensas({ fila: FILA_ACTIVA });
    const err = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: 'Envío gratis VIP', activa: true },
    }).catch((e) => e);
    expect(err.message).toBe('La recompensa "Envío gratis VIP" ya está activa.');
  });

  it('ya está pausada: tira bloqueado', async () => {
    mockTablaRecompensas({ fila: FILA_PAUSADA });
    const err = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: 'Envío gratis VIP', activa: false },
    }).catch((e) => e);
    expect(err.message).toBe('La recompensa "Envío gratis VIP" ya está pausada.');
  });
});
