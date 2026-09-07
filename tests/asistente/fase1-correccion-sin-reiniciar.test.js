// tests/asistente/fase1-correccion-sin-reiniciar.test.js
//
// Fase 1 del plan de robustez conversacional (corrección sin reiniciar,
// 2026-09): cubre ejecutarTool()/resolverAccionPendiente() de
// lib/asistente-tools/index.js — el mecanismo de "propuesta pendiente"
// para tools con requiereConfirmacion:true (reemplazo al corregir un
// dato, reclamo atómico al confirmar, TTL, cancelar, y el resto de los
// checks de pertenencia).
//
// Se usa la tool real `actualizar_datos_empresa` (no un fake) para que
// el test de "Confirmar" pruebe de punta a punta que resolverAccionPendiente
// ejecuta la tool real y persiste su resultado — no solo la mecánica de
// estados. Por eso el mock de la tabla `empresas` tiene que devolver una
// fila válida completa (incluido un CUIT de 11 dígitos): armarUpdateDatosEmpresa
// (lib/asistente-tools/_helpers.js) valida el CUIT actual aunque el usuario
// solo esté cambiando el teléfono, porque el handler real siempre manda
// nombre+CUIT juntos. Una fila de empresa incompleta en el mock (sin CUIT)
// no es un bug de resolverAccionPendiente: es un mock insuficiente para la
// tool elegida — de ahí el fallo original ("El CUIT debe tener 11 dígitos
// numéricos.") en vez de un fallo real del mecanismo de confirmación.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { ejecutarTool, resolverAccionPendiente, TTL_CONFIRMACION_MS } =
  await import('../../lib/asistente-tools/index.js');

const EMPRESA_ID = 'e1';
const USUARIO_ID = 'u1';
const CONVERSACION_ID = 'conv-1';
const TOOL = 'actualizar_datos_empresa';
const ROL = 'dueno';

// Fila completa y válida de `empresas` — CUIT de 11 dígitos incluido a
// propósito (ver nota de arriba). `telefono` empieza en '1' para que el
// resumen coincida con el de la sesión original ("teléfono: "1" → "2".").
function empresaActual(overrides = {}) {
  return {
    nombre: 'Distribuidora Test S.A.',
    cuit: '20304050607',
    domicilio: 'Calle Falsa 123',
    telefono: '1',
    email: 'contacto@test.com',
    logo_url: null,
    config: {},
    ...overrides,
  };
}

function filaPendiente(overrides = {}) {
  return {
    id: 'accion-1',
    tool_nombre: TOOL,
    tool_args: { telefono: '2' },
    resumen: 'Actualizar los datos de la empresa: teléfono: "1" → "2".',
    estado: 'pendiente',
    usuario_id: USUARIO_ID,
    empresa_id: EMPRESA_ID,
    conversacion_id: CONVERSACION_ID,
    creado_en: new Date().toISOString(),
    ...overrides,
  };
}

// Mismo patrón fakeQuery que tests/repos/pedidos.test.js, pero ruteado por
// nombre de tabla: cada tabla tiene su propia cola de respuestas, consumida
// en el orden real en que el código las pide (una entrada por cada
// `db.from(tabla)` distinto). Si la cola se queda corta, repite la última
// (para no tener que listar la misma fila de empresa dos veces cuando el
// código la vuelve a leer sin cambios).
function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    insert: vi.fn(() => obj),
    update: vi.fn(() => obj),
    delete: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

function mockDb({ empresas = [], pendientes = [] } = {}) {
  const queriesEmpresas = [];
  const queriesPendientes = [];
  let ie = 0;
  let ip = 0;
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'empresas') {
      // Cada entrada de `empresas` es la fila cruda (como la devolvería
      // Supabase en `data`) — se envuelve acá para que el destructuring
      // real `const { data, error } = await ...` la reciba tal cual.
      const q = fakeQuery({ data: empresas[Math.min(ie, empresas.length - 1)], error: null });
      queriesEmpresas.push(q);
      ie += 1;
      return q;
    }
    if (tabla === 'asistente_acciones_pendientes') {
      const q = fakeQuery(pendientes[Math.min(ip, pendientes.length - 1)]);
      queriesPendientes.push(q);
      ip += 1;
      return q;
    }
    throw new Error(`tabla no mockeada en este test: ${tabla}`);
  });
  return { queriesEmpresas, queriesPendientes };
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('ejecutarTool() — propuesta pendiente (tools con requiereConfirmacion)', () => {
  it('primera propuesta de una tool con requiereConfirmacion: inserta una fila pendiente, sin tocar nada previo', async () => {
    const { queriesPendientes } = mockDb({
      empresas: [empresaActual()],
      pendientes: [
        { error: null }, // UPDATE reemplazo (0 filas, no había nada previo)
        { data: { id: 'accion-1' }, error: null }, // INSERT de la propuesta nueva
      ],
    });

    const res = await ejecutarTool(TOOL, {
      empresaId: EMPRESA_ID,
      rol: ROL,
      usuarioId: USUARIO_ID,
      conversacionId: CONVERSACION_ID,
      args: { telefono: '2' },
    });

    expect(res).toEqual({
      pendiente_confirmacion: true,
      id_confirmacion: 'accion-1',
      resumen: 'Actualizar los datos de la empresa: teléfono: "1" → "2".',
    });
    // Solo dos operaciones sobre la tabla de pendientes: el reemplazo (que
    // no encuentra nada) y el insert — la tool en sí nunca se ejecuta.
    expect(queriesPendientes).toHaveLength(2);
  });

  it('CORRECCIÓN: si el usuario corrige un dato mientras la propuesta sigue pendiente, la vieja se marca reemplazada y se crea una fila nueva — no dos pendientes activas', async () => {
    const { queriesPendientes } = mockDb({
      empresas: [empresaActual(), empresaActual()],
      pendientes: [
        { error: null },
        { data: { id: 'accion-1' }, error: null },
        { error: null },
        { data: { id: 'accion-2' }, error: null },
      ],
    });

    const primera = await ejecutarTool(TOOL, {
      empresaId: EMPRESA_ID, rol: ROL, usuarioId: USUARIO_ID, conversacionId: CONVERSACION_ID,
      args: { telefono: '2' },
    });
    const segunda = await ejecutarTool(TOOL, {
      empresaId: EMPRESA_ID, rol: ROL, usuarioId: USUARIO_ID, conversacionId: CONVERSACION_ID,
      args: { telefono: '3' },
    });

    expect(primera.id_confirmacion).toBe('accion-1');
    expect(segunda.id_confirmacion).toBe('accion-2');
    expect(primera.id_confirmacion).not.toBe(segunda.id_confirmacion);

    // El segundo UPDATE de reemplazo (índice 2 en la cola: reemplazo1,
    // insert1, reemplazo2, insert2) filtró por esta misma conversación y
    // esta misma tool antes de insertar la propuesta corregida.
    const reemplazo2 = queriesPendientes[2];
    expect(reemplazo2.eq).toHaveBeenCalledWith('conversacion_id', CONVERSACION_ID);
    expect(reemplazo2.eq).toHaveBeenCalledWith('tool_nombre', TOOL);
    expect(reemplazo2.eq).toHaveBeenCalledWith('estado', 'pendiente');
  });

  it('una propuesta pendiente de OTRA conversación no se toca (nunca se reemplaza cruzado)', async () => {
    const { queriesPendientes } = mockDb({
      empresas: [empresaActual()],
      pendientes: [
        { error: null },
        { data: { id: 'accion-1' }, error: null },
      ],
    });

    await ejecutarTool(TOOL, {
      empresaId: EMPRESA_ID, rol: ROL, usuarioId: USUARIO_ID, conversacionId: 'conv-actual',
      args: { telefono: '2' },
    });

    // El UPDATE de reemplazo siempre filtra por la conversación actual —
    // nunca puede tocar una fila de 'conv-otra' aunque exista en la base
    // real, porque el filtro mismo lo excluye.
    const reemplazo = queriesPendientes[0];
    expect(reemplazo.eq).toHaveBeenCalledWith('conversacion_id', 'conv-actual');
    expect(reemplazo.eq).not.toHaveBeenCalledWith('conversacion_id', 'conv-otra');
  });

  it('si el UPDATE de reemplazo falla, no bloquea la propuesta nueva (solo loguea)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb({
      empresas: [empresaActual()],
      pendientes: [
        { error: { message: 'boom: no se pudo actualizar' } },
        { data: { id: 'accion-x' }, error: null },
      ],
    });

    const res = await ejecutarTool(TOOL, {
      empresaId: EMPRESA_ID, rol: ROL, usuarioId: USUARIO_ID, conversacionId: CONVERSACION_ID,
      args: { telefono: '2' },
    });

    expect(res.pendiente_confirmacion).toBe(true);
    expect(res.id_confirmacion).toBe('accion-x');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('resolverAccionPendiente() — Confirmar/Cancelar/expirar, siguen intactos con el mecanismo de reemplazo', () => {
  it('Cancelar: marca cancelada y no ejecuta la tool', async () => {
    const { queriesEmpresas } = mockDb({
      pendientes: [
        { data: filaPendiente(), error: null }, // lectura
        { error: null }, // update a 'cancelada'
      ],
    });

    const res = await resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: false,
    });

    expect(res).toEqual({ encontrada: true, estado: 'cancelada', resumen: filaPendiente().resumen });
    // La tool nunca se ejecuta: cero lecturas/escrituras a `empresas`.
    expect(queriesEmpresas).toHaveLength(0);
  });

  it('acción de otro usuario/empresa/conversación: nunca se resuelve, aunque se adivine el UUID', async () => {
    mockDb({
      pendientes: [
        { data: filaPendiente({ usuario_id: 'otro-usuario' }), error: null },
      ],
    });

    await expect(resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: true,
    })).rejects.toThrow('Esa acción pendiente no corresponde a esta conversación');
  });

  it('ya resuelta (no está en estado pendiente): informa el estado real sin volver a tocarla', async () => {
    const { queriesPendientes } = mockDb({
      pendientes: [
        { data: filaPendiente({ estado: 'ejecutada' }), error: null },
      ],
    });

    const res = await resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: true,
    });

    expect(res).toEqual({
      encontrada: true, estado: 'ejecutada', resumen: filaPendiente().resumen, yaResuelta: true,
    });
    // Ninguna escritura: solo la lectura inicial.
    expect(queriesPendientes).toHaveLength(1);
  });

  it('vencida por TTL: se marca expirada en vez de dejarla confirmar', async () => {
    const vencida = filaPendiente({
      creado_en: new Date(Date.now() - TTL_CONFIRMACION_MS - 60_000).toISOString(),
    });
    mockDb({
      pendientes: [
        { data: vencida, error: null },
        { error: null }, // update a 'expirada'
      ],
    });

    const res = await resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: true,
    });

    expect(res).toEqual({ encontrada: true, estado: 'expirada', resumen: vencida.resumen });
  });

  it('Confirmar: reclamo atómico (WHERE estado=pendiente) + ejecuta la tool real + guarda el resultado', async () => {
    const { queriesPendientes } = mockDb({
      empresas: [
        empresaActual(), // obtenerDatosEmpresaActual, dentro de execute()
        { ...empresaActual({ telefono: '2' }) }, // fila devuelta por el UPDATE real
      ],
      pendientes: [
        { data: filaPendiente(), error: null }, // lectura
        { data: { id: 'accion-1' }, error: null }, // reclamo atómico exitoso
        { error: null }, // update final a 'ejecutada'
      ],
    });

    const res = await resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: true,
    });

    expect(res.encontrada).toBe(true);
    expect(res.estado).toBe('ejecutada');
    expect(res.resultado).toEqual({ ok: true, empresa: empresaActual({ telefono: '2' }) });

    // El reclamo (segunda operación sobre la tabla de pendientes) filtró
    // explícitamente por estado='pendiente' — es lo que lo hace atómico.
    const reclamo = queriesPendientes[1];
    expect(reclamo.eq).toHaveBeenCalledWith('estado', 'pendiente');
  });

  it('doble click (carrera): el segundo reclamo no afecta filas y no re-ejecuta la tool', async () => {
    const { queriesEmpresas } = mockDb({
      empresas: [
        empresaActual(),
        empresaActual({ telefono: '2' }),
      ],
      pendientes: [
        { data: filaPendiente(), error: null }, // 1er click: lectura
        { data: { id: 'accion-1' }, error: null }, // 1er click: gana el reclamo
        { error: null }, // 1er click: update final a 'ejecutada'
        { data: filaPendiente(), error: null }, // 2do click: lectura (todavía ve 'pendiente', llegó justo antes)
        { data: null, error: null }, // 2do click: el reclamo no matchea ninguna fila
      ],
    });

    const primero = await resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: true,
    });
    const segundo = await resolverAccionPendiente({
      id: 'accion-1', usuarioId: USUARIO_ID, empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID, confirmar: true,
    });

    expect(primero.estado).toBe('ejecutada');
    expect(segundo).toEqual({
      encontrada: true, estado: 'ejecutada_por_otro_click', resumen: filaPendiente().resumen,
    });
    // La tool real (que toca `empresas`) solo corrió una vez: las dos
    // lecturas/escrituras de `empresas` son del primer click, no del segundo.
    expect(queriesEmpresas).toHaveLength(2);
  });
});
