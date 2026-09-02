// tests/repos/depositos.test.js
//
// Cubre lib/repos/depositos.js — resolución de depósito/sucursal para
// pedidos (WhatsApp, admin, portal), espejo en JS de
// resolver_deposito_pedido() en SQL (ver
// supabase/migrations/550_multi_deposito_sucursal_cliente.sql). Mismo
// query builder falso que tests/repos/whatsapp-bot.test.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  resolverDepositoParaPedido, obtenerStockPorDeposito, obtenerStockDeDeposito,
} = await import('../../lib/repos/depositos.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

describe('resolverDepositoParaPedido', () => {
  it('usa el override explícito si pertenece a la empresa y está activo', async () => {
    const query = fakeQuery({ data: { id: 'd-override' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await resolverDepositoParaPedido({
      empresaId: 'e1', clienteDepositoId: 'd-cliente', depositoIdExplicito: 'd-override',
    });

    expect(dbMock.from).toHaveBeenCalledWith('depositos');
    expect(query.eq).toHaveBeenCalledWith('id', 'd-override');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('activa', true);
    expect(res).toBe('d-override');
  });

  it('cae a la sucursal del cliente si el override no es válido (otra empresa / inactivo)', async () => {
    dbMock.from
      .mockReturnValueOnce(fakeQuery({ data: null, error: null }))       // override inválido
      .mockReturnValueOnce(fakeQuery({ data: { id: 'd-cliente' }, error: null })); // sucursal cliente

    const res = await resolverDepositoParaPedido({
      empresaId: 'e1', clienteDepositoId: 'd-cliente', depositoIdExplicito: 'd-ajena',
    });

    expect(res).toBe('d-cliente');
    expect(dbMock.from).toHaveBeenCalledTimes(2);
  });

  it('cae al depósito principal si el cliente no tiene sucursal asignada', async () => {
    const query = fakeQuery({ data: { id: 'd-principal' }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await resolverDepositoParaPedido({ empresaId: 'e1' });

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('es_principal', true);
    expect(query.eq).toHaveBeenCalledWith('activa', true);
    expect(res).toBe('d-principal');
  });

  it('devuelve null si la empresa no tiene ningún depósito activo configurado', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await resolverDepositoParaPedido({ empresaId: 'e1' })).toBeNull();
  });
});

describe('obtenerStockPorDeposito', () => {
  it('filtra por deposito_id y devuelve un mapa producto_id -> disponible', async () => {
    const query = fakeQuery({
      data: [
        { producto_id: 'p1', cantidad: 10, cantidad_reservada: 2 },
        { producto_id: 'p2', cantidad: 5, cantidad_reservada: 5 },
      ],
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerStockPorDeposito(['p1', 'p2'], 'd1');

    expect(query.eq).toHaveBeenCalledWith('deposito_id', 'd1');
    expect(query.in).toHaveBeenCalledWith('producto_id', ['p1', 'p2']);
    expect(res).toEqual({ p1: 8, p2: 0 });
  });

  it('devuelve {} sin pegarle a la base si la lista de productos está vacía', async () => {
    const res = await obtenerStockPorDeposito([], 'd1');
    expect(res).toEqual({});
    expect(dbMock.from).not.toHaveBeenCalled();
  });
});

describe('obtenerStockDeDeposito', () => {
  it('busca una fila puntual por deposito_id + producto_id', async () => {
    const query = fakeQuery({ data: { id: 's1', deposito_id: 'd1', cantidad: 10, cantidad_reservada: 2 }, error: null });
    dbMock.from.mockReturnValue(query);

    const res = await obtenerStockDeDeposito('d1', 'p1');

    expect(query.eq).toHaveBeenCalledWith('deposito_id', 'd1');
    expect(query.eq).toHaveBeenCalledWith('producto_id', 'p1');
    expect(res.cantidad).toBe(10);
  });

  it('devuelve null si no hay fila de stock para ese depósito', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await obtenerStockDeDeposito('d1', 'p1')).toBeNull();
  });
});
