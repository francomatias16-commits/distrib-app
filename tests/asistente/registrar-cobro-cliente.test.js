// tests/asistente/registrar-cobro-cliente.test.js
//
// Fase 5 (siguiente lote): cobertura de `registrar_cobro_cliente`
// (lib/asistente-tools/cobranzas.js) — la tool de escritura del cluster
// de cobranzas que el plan (PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md,
// §6) todavía lista como pendiente de "prueba funcional contra datos
// reales". Esto no reemplaza esa prueba (necesita Supabase real, ver
// Fase 6) — cubre la lógica propia de la tool (cálculo de saldo en el
// resumen, armado de los parámetros de la RPC, y los 3 caminos de error)
// con mocks, que sí se puede hacer en este entorno.
//
// Mismo patrón de mock que desambiguacion.test.js: se mockea únicamente
// `lib/repos/_db.js` (from + rpc) y se importa el árbol real.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_COBRANZAS } = await import('../../lib/asistente-tools/cobranzas.js');

const tool = TOOLS_COBRANZAS.find((t) => t.name === 'registrar_cobro_cliente');

const EMPRESA_ID = 'e1';
const USUARIO_ID = 'u1';

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

// Un único candidato claro (similitud 1, como un ILIKE exacto) — no es lo
// que se está probando acá (eso ya lo cubre desambiguacion.test.js), así
// que se mantiene siempre inequívoco para no mezclar preocupaciones.
function mockClienteEncontrado({ id = 'c1', razon_social = 'Juan Pérez', activo = true } = {}) {
  dbMock.rpc.mockImplementation((rpc, params) => {
    if (rpc === 'buscar_clientes_asistente') {
      return Promise.resolve({ data: [{ id, razon_social, activo, similitud: 1 }], error: null });
    }
    if (rpc === 'registrar_cobro_completo') {
      return Promise.resolve({ data: { ok: true, cobro_id: 'cobro-1' }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('registrar_cobro_cliente — resumen()', () => {
  it('monto <= 0: rechaza antes de tocar la base', async () => {
    await expect(tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Juan Pérez', monto: 0, medio: 'efectivo' } }))
      .rejects.toThrow('El monto del cobro tiene que ser mayor a cero.');
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });

  it('cliente con deuda parcial: informa cuánto debía y cuánto le queda debiendo', async () => {
    mockClienteEncontrado();
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 1000 }, error: null }));

    const resumen = await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Perez', monto: 400, medio: 'efectivo' } });

    expect(resumen).toContain('Registrar un cobro de $400 en efectivo a Juan Pérez.');
    expect(resumen).toContain('Debía $1.000, queda debiendo $600.');
  });

  it('el cobro salda la deuda exacto: no menciona "queda debiendo" ni "a favor"', async () => {
    mockClienteEncontrado();
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 500 }, error: null }));

    const resumen = await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Perez', monto: 500, medio: 'transferencia' } });

    expect(resumen).toContain('Salda toda la deuda actual ($500).');
    expect(resumen).not.toContain('queda debiendo');
    expect(resumen).not.toContain('a favor');
  });

  it('el cobro supera la deuda: informa que queda a favor', async () => {
    mockClienteEncontrado();
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 300 }, error: null }));

    const resumen = await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Perez', monto: 500, medio: 'cheque' } });

    expect(resumen).toContain('Salda toda la deuda ($300) y queda a favor $200.');
  });

  it('cliente sin deuda registrada: lo aclara en vez de mostrar $0', async () => {
    mockClienteEncontrado();
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 0 }, error: null }));

    const resumen = await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Perez', monto: 500, medio: 'efectivo' } });

    expect(resumen).toContain('Actualmente no tiene deuda registrada.');
  });

  it('cliente inactivo: lo marca en el resumen (no lo bloquea — cobrar a un inactivo es válido)', async () => {
    mockClienteEncontrado({ activo: false, razon_social: 'Cliente Dado de Baja' });
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 100 }, error: null }));

    const resumen = await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Cliente Dado de Baja', monto: 100, medio: 'efectivo' } });

    expect(resumen).toContain('Cliente Dado de Baja (inactivo)');
  });

  it('medio "otro": usa "otro medio" en el texto (el detalle real va en referencia, no en el enum)', async () => {
    mockClienteEncontrado();
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 0 }, error: null }));

    const resumen = await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Perez', monto: 200, medio: 'otro', referencia: 'Mercado Pago' } });

    expect(resumen).toContain('en otro medio a Juan Pérez');
  });
});

describe('registrar_cobro_cliente — execute()', () => {
  it('llama a registrar_cobro_completo con los parámetros correctos y devuelve el resultado', async () => {
    mockClienteEncontrado();

    const res = await tool.execute({
      empresaId: EMPRESA_ID,
      usuarioId: USUARIO_ID,
      args: { cliente: 'Perez', monto: 400, medio: 'transferencia', referencia: 'op-123', notas: 'nota del vendedor' },
      accionPendienteId: 'accion-1',
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('registrar_cobro_completo', {
      p_empresa_id: EMPRESA_ID,
      p_cliente_id: 'c1',
      p_monto: 400,
      p_medio: 'transferencia',
      p_referencia: 'op-123',
      p_notas: 'nota del vendedor',
      p_usuario_id: USUARIO_ID,
      p_offline_local_id: 'accion-1',
    });
    expect(res).toEqual({ ok: true, cliente: 'Juan Pérez', monto: 400, medio: 'transferencia', cobro_id: 'cobro-1' });
  });

  // Punto 10 (auditoría 2026-09-11): accionPendienteId es el id estable
  // de idempotencia (ver index.js — CAS de asistente_acciones_pendientes).
  // Sin él (no debería pasar en producción, requiereConfirmacion:true
  // obliga a pasar por ese flujo), se genera un UUID nuevo por llamada en
  // vez de mandar undefined — registrar_cobro_completo requiere el
  // parámetro para poder dedupear en cualquier reintento posterior.
  it('sin accionPendienteId: genera un offline_local_id propio en vez de mandar undefined', async () => {
    mockClienteEncontrado();

    await tool.execute({ empresaId: EMPRESA_ID, usuarioId: USUARIO_ID, args: { cliente: 'Perez', monto: 100, medio: 'efectivo' } });

    const llamada = dbMock.rpc.mock.calls.find(([rpc]) => rpc === 'registrar_cobro_completo');
    expect(llamada[1].p_offline_local_id).toEqual(expect.any(String));
    expect(llamada[1].p_offline_local_id.length).toBeGreaterThan(0);
  });

  it('sin referencia/notas: manda null y una nota por defecto, no undefined', async () => {
    mockClienteEncontrado();

    await tool.execute({ empresaId: EMPRESA_ID, usuarioId: USUARIO_ID, args: { cliente: 'Perez', monto: 100, medio: 'efectivo' } });

    expect(dbMock.rpc).toHaveBeenCalledWith('registrar_cobro_completo', expect.objectContaining({
      p_referencia: null,
      p_notas: 'Cobro registrado por voz desde el asistente IA.',
    }));
  });

  it('monto <= 0: rechaza antes de resolver el cliente ni llamar a la RPC', async () => {
    await expect(tool.execute({ empresaId: EMPRESA_ID, usuarioId: USUARIO_ID, args: { cliente: 'Perez', monto: -10, medio: 'efectivo' } }))
      .rejects.toThrow('El monto del cobro tiene que ser mayor a cero.');
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });

  it('la RPC devuelve error de Postgres: propaga un mensaje con contexto, no el error crudo', async () => {
    dbMock.rpc.mockImplementation((rpc) => {
      if (rpc === 'buscar_clientes_asistente') {
        return Promise.resolve({ data: [{ id: 'c1', razon_social: 'Juan Pérez', activo: true, similitud: 1 }], error: null });
      }
      if (rpc === 'registrar_cobro_completo') {
        return Promise.resolve({ data: null, error: { message: 'connection timeout' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await expect(tool.execute({ empresaId: EMPRESA_ID, usuarioId: USUARIO_ID, args: { cliente: 'Perez', monto: 100, medio: 'efectivo' } }))
      .rejects.toThrow('registrar_cobro_cliente: connection timeout');
  });

  it('la RPC responde 200 pero con `ok:false` (validación de negocio, ej. monto no coincide): tira ese mensaje puntual', async () => {
    dbMock.rpc.mockImplementation((rpc) => {
      if (rpc === 'buscar_clientes_asistente') {
        return Promise.resolve({ data: [{ id: 'c1', razon_social: 'Juan Pérez', activo: true, similitud: 1 }], error: null });
      }
      if (rpc === 'registrar_cobro_completo') {
        return Promise.resolve({ data: { ok: false, error: 'El cliente no pertenece a esta empresa.' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await expect(tool.execute({ empresaId: EMPRESA_ID, usuarioId: USUARIO_ID, args: { cliente: 'Perez', monto: 100, medio: 'efectivo' } }))
      .rejects.toThrow('El cliente no pertenece a esta empresa.');
  });

  it('resuelve el cliente de nuevo en execute() (no reusa el de resumen) — buscar_clientes_asistente se llama en cada paso', async () => {
    mockClienteEncontrado();
    dbMock.from.mockReturnValue(fakeQuery({ data: { saldo_deuda: 0 }, error: null }));

    await tool.resumen({ empresaId: EMPRESA_ID, args: { cliente: 'Perez', monto: 100, medio: 'efectivo' } });
    const llamadasTrasResumen = dbMock.rpc.mock.calls.filter(([rpc]) => rpc === 'buscar_clientes_asistente').length;

    await tool.execute({ empresaId: EMPRESA_ID, usuarioId: USUARIO_ID, args: { cliente: 'Perez', monto: 100, medio: 'efectivo' } });
    const llamadasTrasExecute = dbMock.rpc.mock.calls.filter(([rpc]) => rpc === 'buscar_clientes_asistente').length;

    expect(llamadasTrasExecute).toBe(llamadasTrasResumen + 1);
  });
});
