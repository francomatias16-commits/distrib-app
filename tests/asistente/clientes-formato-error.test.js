// tests/asistente/clientes-formato-error.test.js
//
// Fase 3 (continuacion) -- migracion de lib/asistente-tools/clientes.js
// al contrato de _respuestas.js (faltaDato/bloqueado), mismo patron que
// tests/asistente/stock-maestros-y-transferencia-formato-error.test.js:
//   - consultar_precio_producto_cliente: "sin productos para cotizar"
//     paso a faltaDato().
//   - crear_cliente: "falta razón social" paso a faltaDato(); "ya existe"
//     (por CUIT o por razón social) y "límite de clientes del plan" pasaron
//     a bloqueado(motivo, salida).
//   - editar_cliente_asistente: "ya está activo" (reactivar un cliente que
//     ya estaba activo) paso a bloqueado(), tanto en resumen() como en
//     execute().
//   - dar_de_baja_cliente_asistente: "ya está inactivo" paso a bloqueado(),
//     tanto en resumen() como en execute().
//
// No se migraron a proposito (quedan para otra pasada, documentado en el
// CHANGELOG): los wrappers de error de DB (`${tool}: ${error.message}`) y
// los "no especificaste ningún dato para cambiar" de
// editar_recompensa_asistente/editar_cliente_asistente, mismo criterio que
// editar_producto en la migracion de stock.js.
//
// Mismo patron de mock que el archivo de stock: se mockea
// lib/repos/_db.js (from + rpc) y, acá además, lib/repos/clientes.js
// (crearCliente) para simular el código LIMITE_PLAN_ALCANZADO sin
// reconstruir exigirLimitePlan().

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const clientesRepoMock = vi.hoisted(() => ({
  crearCliente: vi.fn(),
  actualizarCliente: vi.fn(),
  desactivarCliente: vi.fn(),
}));
vi.mock('../../lib/repos/clientes.js', () => clientesRepoMock);

vi.mock('../../lib/repos/audit.js', () => ({
  registrarAuditoriaSilenciosa: vi.fn(),
}));

const { TOOLS_CLIENTES } = await import('../../lib/asistente-tools/clientes.js');

const cotizar = TOOLS_CLIENTES.find((t) => t.name === 'consultar_precio_producto_cliente');
const crearCliente = TOOLS_CLIENTES.find((t) => t.name === 'crear_cliente');
const editarCliente = TOOLS_CLIENTES.find((t) => t.name === 'editar_cliente_asistente');
const darDeBaja = TOOLS_CLIENTES.find((t) => t.name === 'dar_de_baja_cliente_asistente');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
  clientesRepoMock.crearCliente.mockReset();
  clientesRepoMock.actualizarCliente.mockReset();
  clientesRepoMock.desactivarCliente.mockReset();
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

// Mockea el RPC de búsqueda aproximada de clientes (buscar_clientes_asistente)
// que usan tanto buscarClientePorTexto como buscarClienteParaCobroPorTexto,
// devolviendo un único candidato claro (sin ambigüedad).
function mockClienteEncontrado(cliente) {
  dbMock.rpc.mockImplementation((rpc) => {
    if (rpc === 'buscar_clientes_asistente') {
      return Promise.resolve({ data: [{ ...cliente, similitud: 1 }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

describe('consultar_precio_producto_cliente — sin productos: migrado a faltaDato()', () => {
  it('items vacío: tira faltaDato (mensaje "Me falta ... para seguir.", sin `.opciones`)', async () => {
    mockClienteEncontrado({ id: 'c1', razon_social: 'Kiosco Sur', activo: true });
    const err = await cotizar.execute({
      empresaId: EMPRESA_ID,
      args: { cliente: 'Kiosco Sur', items: [] },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta al menos un producto para seguir.');
    expect(err.opciones).toBeUndefined();
  });
});

describe('crear_cliente — resumen(): faltaDato y bloqueado migrados', () => {
  it('sin razón social: tira faltaDato, sin tocar la DB', async () => {
    const err = await crearCliente.resumen({ empresaId: EMPRESA_ID, args: {} }).catch((e) => e);
    expect(err.message).toBe('Me falta el nombre o razón social del cliente para seguir.');
    expect(err.opciones).toBeUndefined();
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('ya existe por razón social: tira bloqueado citando el nombre, sin `.opciones`', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'clientes') {
        return fakeQuery({ data: { id: 'c1', razon_social: 'Kiosco Sur', nombre_fantasia: null }, error: null });
      }
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const err = await crearCliente.resumen({
      empresaId: EMPRESA_ID,
      args: { razon_social: 'Kiosco Sur' },
    }).catch((e) => e);
    // Nota: el template original arma "ese" + "a razón social" (sin
    // corregir la concordancia) — se preserva tal cual, no se toca
    // redacción fuera del alcance de esta migración.
    expect(err.message).toContain('Ya existe un cliente con esea razón social: "Kiosco Sur".');
    expect(err.message).toContain('No hace falta crearlo de nuevo.');
    expect(err.opciones).toBeUndefined();
  });

  it('ya existe por CUIT: el motivo del mensaje distingue "ese CUIT" de "esa razón social"', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'clientes') {
        return fakeQuery({ data: { id: 'c1', razon_social: 'Kiosco Sur', nombre_fantasia: null }, error: null });
      }
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const err = await crearCliente.resumen({
      empresaId: EMPRESA_ID,
      args: { razon_social: 'Kiosco Sur', cuit: '20304050607' },
    }).catch((e) => e);
    expect(err.message).toContain('Ya existe un cliente con ese CUIT: "Kiosco Sur".');
    expect(err.opciones).toBeUndefined();
  });
});

describe('crear_cliente — execute(): límite de plan migrado a bloqueado()', () => {
  it('LIMITE_PLAN_ALCANZADO: tira bloqueado explicando la causa y la salida, sin `.opciones`', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'clientes') return fakeQuery({ data: null, error: null }); // no existe todavía
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const limiteError = new Error('límite alcanzado');
    limiteError.code = 'LIMITE_PLAN_ALCANZADO';
    clientesRepoMock.crearCliente.mockRejectedValue(limiteError);

    const err = await crearCliente.execute({
      empresaId: EMPRESA_ID,
      usuarioId: 'u1',
      args: { razon_social: 'Cliente Nuevo' },
    }).catch((e) => e);
    expect(err.message).toBe('No se pudo crear el cliente: se llegó al límite de clientes del plan contratado. Hay que ampliar el plan para poder cargar más.');
    expect(err.opciones).toBeUndefined();
  });

  it('otro error de DB: sigue sin migrar, formato viejo `crear_cliente: <mensaje>`', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'clientes') return fakeQuery({ data: null, error: null });
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    clientesRepoMock.crearCliente.mockRejectedValue(new Error('conexión perdida'));

    const err = await crearCliente.execute({
      empresaId: EMPRESA_ID,
      usuarioId: 'u1',
      args: { razon_social: 'Cliente Nuevo' },
    }).catch((e) => e);
    expect(err.message).toBe('crear_cliente: conexión perdida');
  });
});

describe.each([
  ['editar_cliente_asistente', () => editarCliente, { referencia: 'Kiosco Sur', reactivar: true }, 'ya está activo'],
])('%s — "ya está activo" migrado a bloqueado()', (_nombre, getTool, argsBase, fraseEsperada) => {
  it('resumen(): tira bloqueado citando el nombre del cliente, sin `.opciones`', async () => {
    mockClienteEncontrado({ id: 'c1', razon_social: 'Kiosco Sur', activo: true });
    const tool = getTool();
    const err = await tool.resumen({ empresaId: EMPRESA_ID, args: argsBase }).catch((e) => e);
    expect(err.message).toBe(`El cliente "Kiosco Sur" ${fraseEsperada}.`);
    expect(err.opciones).toBeUndefined();
  });

  it('execute(): mismo chequeo, no llega a actualizarClienteRepo', async () => {
    mockClienteEncontrado({ id: 'c1', razon_social: 'Kiosco Sur', activo: true });
    const tool = getTool();
    const err = await tool.execute({ empresaId: EMPRESA_ID, usuarioId: 'u1', args: argsBase }).catch((e) => e);
    expect(err.message).toBe(`El cliente "Kiosco Sur" ${fraseEsperada}.`);
    expect(err.opciones).toBeUndefined();
    expect(clientesRepoMock.actualizarCliente).not.toHaveBeenCalled();
  });
});

describe('dar_de_baja_cliente_asistente — "ya está inactivo" migrado a bloqueado()', () => {
  it('resumen(): tira bloqueado citando el nombre del cliente, sin `.opciones`', async () => {
    mockClienteEncontrado({ id: 'c1', razon_social: 'Kiosco Sur', activo: false });
    const err = await darDeBaja.resumen({ empresaId: EMPRESA_ID, args: { referencia: 'Kiosco Sur' } }).catch((e) => e);
    expect(err.message).toBe('El cliente "Kiosco Sur" ya está inactivo.');
    expect(err.opciones).toBeUndefined();
  });

  it('execute(): mismo chequeo, no llega a desactivarClienteRepo', async () => {
    mockClienteEncontrado({ id: 'c1', razon_social: 'Kiosco Sur', activo: false });
    const err = await darDeBaja.execute({ empresaId: EMPRESA_ID, usuarioId: 'u1', args: { referencia: 'Kiosco Sur' } }).catch((e) => e);
    expect(err.message).toBe('El cliente "Kiosco Sur" ya está inactivo.');
    expect(err.opciones).toBeUndefined();
    expect(clientesRepoMock.desactivarCliente).not.toHaveBeenCalled();
  });
});
