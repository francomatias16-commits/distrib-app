// tests/asistente/clientes-recompensas-bugfix.test.js
//
// Bugfix (hallazgo durante Fase 4 — voz): crear_recompensa_asistente y
// editar_recompensa_asistente llamaban a validarCamposRecompensa() /
// describirRecompensa() / construirCambiosRecompensa() sin que existieran
// en ningún lado del repo — ni en clientes.js, ni importadas, ni en
// _helpers.js. Cualquier uso real revienta con
// `ReferenceError: validarCamposRecompensa is not defined` (confirmado
// ejecutando el archivo real antes de este fix). Ningún test lo cubría:
// el único archivo de tests/asistente/ que menciona "recompensa" es un
// comentario, no una llamada real a estas dos tools.
//
// Este archivo cubre: (1) que las tools ya no revientan por referencia
// indefinida, (2) la validación de campos numéricos (puntos, valor, cupo)
// que se agregó junto con el fix — mismo criterio que el resto del
// código: Number.isFinite + rango, no solo `!valor`, para no dejar pasar
// un NaN si un valor dictado por voz se transcribe mal.

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

const crear = TOOLS_CLIENTES.find((t) => t.name === 'crear_recompensa_asistente');
const editar = TOOLS_CLIENTES.find((t) => t.name === 'editar_recompensa_asistente');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

// Simula la tabla `recompensas` para los 3 flujos que la tocan:
//   - búsqueda difusa por nombre (buscarRecompensaPorTexto): .ilike(...) sin .single()
//   - lectura de la fila completa antes de un patch (armarCambiosRecompensa): .eq(...).single()
//   - insert/update final: .insert()/.update()...select().single()
// Cada llamada a db.from('recompensas') devuelve un objeto nuevo (mismo
// patrón que fakeQuery de clientes-formato-error.test.js), así que no
// hace falta trackear cuántas veces se invocó.
function mockTablaRecompensas({ busqueda = [], filaActual = null, resultado = null } = {}) {
  dbMock.from.mockImplementation((tabla) => {
    if (tabla !== 'recompensas') throw new Error(`tabla no mockeada en este test: ${tabla}`);
    let modo = 'filaActual';
    const obj = {
      select: vi.fn(() => obj),
      eq: vi.fn(() => obj),
      ilike: vi.fn(() => { modo = 'busqueda'; return obj; }),
      insert: vi.fn(() => { modo = 'resultado'; return obj; }),
      update: vi.fn(() => { modo = 'resultado'; return obj; }),
      single: vi.fn(() => Promise.resolve(
        modo === 'resultado' ? { data: resultado, error: null } : { data: filaActual, error: null }
      )),
      then: (resolve, reject) => Promise.resolve({ data: busqueda, error: null }).then(resolve, reject),
    };
    return obj;
  });
}

describe('crear_recompensa_asistente — ya no revienta por referencia indefinida', () => {
  it('resumen(): arma la frase para un descuento porcentual', async () => {
    const texto = await crear.resumen({
      args: { nombre: '10% off', puntos_requeridos: 200, tipo: 'descuento_porcentaje', valor: 10, cantidad_disponible: 50 },
    });
    expect(texto).toBe('Crear la recompensa "10% off": 10% de descuento a cambio de 200 puntos, cupo de 50 canje(s).');
  });

  it('resumen(): envio_gratis no requiere "valor"', async () => {
    const texto = await crear.resumen({
      args: { nombre: 'Envío gratis VIP', puntos_requeridos: 500, tipo: 'envio_gratis' },
    });
    expect(texto).toBe('Crear la recompensa "Envío gratis VIP": envío gratis a cambio de 500 puntos, cupo ilimitado.');
  });

  it('rechaza un descuento porcentual mayor a 100%', async () => {
    const err = await crear.resumen({
      args: { nombre: 'Mala', puntos_requeridos: 100, tipo: 'descuento_porcentaje', valor: 150 },
    }).catch((e) => e);
    expect(err.message).toBe('Un descuento porcentual no puede superar el 100%.');
  });

  it('rechaza puntos_requeridos no numérico (ej. transcripción de voz fallida)', async () => {
    const err = await crear.resumen({
      args: { nombre: 'Mala', puntos_requeridos: 'no-numero', tipo: 'descuento_fijo', valor: 100 },
    }).catch((e) => e);
    expect(err.message).toBe('Los puntos requeridos tienen que ser un número mayor a cero.');
  });

  it('rechaza tipo inválido', async () => {
    const err = await crear.resumen({
      args: { nombre: 'Mala', puntos_requeridos: 100, tipo: 'no_existe', valor: 100 },
    }).catch((e) => e);
    expect(err.message).toContain('debe ser descuento_fijo, descuento_porcentaje, envio_gratis o producto_gratis');
  });

  it('execute(): inserta la fila y devuelve ok', async () => {
    mockTablaRecompensas({ resultado: { id: 'r1', nombre: '10% off' } });
    const resultado = await crear.execute({
      empresaId: EMPRESA_ID,
      args: { nombre: '10% off', puntos_requeridos: 200, tipo: 'descuento_porcentaje', valor: 10 },
    });
    expect(resultado).toEqual({ ok: true, id: 'r1', nombre: '10% off' });
  });
});

describe('editar_recompensa_asistente — ya no revienta por referencia indefinida', () => {
  const RECOMPENSA_BUSQUEDA = [{ id: 'r1', nombre: '10% off', puntos_requeridos: 200, activa: true }];
  const FILA_ACTUAL = {
    nombre: '10% off', descripcion: null, puntos_requeridos: 200, tipo: 'descuento_porcentaje',
    valor: 10, cantidad_disponible: 50, fecha_inicio: null, fecha_fin: null, activa: true,
  };

  it('resumen(): arma la frase de cambios sobre la fila actual', async () => {
    mockTablaRecompensas({ busqueda: RECOMPENSA_BUSQUEDA, filaActual: FILA_ACTUAL });
    const texto = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: '10% off', valor: 20 },
    });
    expect(texto).toContain('Actualizar la recompensa "10% off"');
    expect(texto).toContain('20% de descuento');
  });

  it('sin cambios: tira error pidiendo especificar algo', async () => {
    mockTablaRecompensas({ busqueda: RECOMPENSA_BUSQUEDA, filaActual: FILA_ACTUAL });
    const err = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: '10% off' },
    }).catch((e) => e);
    expect(err.message).toBe('No especificaste ningún dato para cambiar de la recompensa.');
  });

  it('rechaza un nuevo valor no numérico', async () => {
    mockTablaRecompensas({ busqueda: RECOMPENSA_BUSQUEDA, filaActual: FILA_ACTUAL });
    const err = await editar.resumen({
      empresaId: EMPRESA_ID,
      args: { referencia: '10% off', valor: 'mucho' },
    }).catch((e) => e);
    expect(err.message).toBe('El valor tiene que ser un número mayor a cero.');
  });

  it('execute(): aplica el patch y devuelve ok', async () => {
    mockTablaRecompensas({ busqueda: RECOMPENSA_BUSQUEDA, filaActual: FILA_ACTUAL, resultado: { id: 'r1', nombre: '10% off' } });
    const resultado = await editar.execute({
      empresaId: EMPRESA_ID,
      args: { referencia: '10% off', cantidad_disponible: 100 },
    });
    expect(resultado).toEqual({ ok: true, id: 'r1', nombre: '10% off' });
  });
});
