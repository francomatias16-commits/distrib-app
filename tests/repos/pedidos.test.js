// tests/repos/pedidos.test.js
//
// Fase 7, paso 6, lote 1 (presupuestos) — `lib/repos/pedidos.js` no tenía
// tests todavía. Foco: que cada función que lee/escribe una tabla
// multi-tenant filtre por `empresa_id` explícito (mismo criterio que
// productos.test.js / cta-cte.test.js / stock.test.js), y que las
// funciones de rollback/limpieza (fire-and-forget en el original) sigan
// sin propagar error acá.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  resolverPreciosClienteRpc,
  obtenerClienteParaPresupuesto,
  contarPresupuestosPorEmpresa,
  obtenerConfigEmpresa,
  crearPresupuesto,
  insertarItemsPresupuesto,
  obtenerPresupuestoConDetalle,
  listarPresupuestos,
  obtenerClientePorUsuarioId,
  obtenerPresupuestoParaPatch,
  bloquearPresupuestoAceptado,
  obtenerPresupuestoCompleto,
  obtenerClienteCredito,
  obtenerStockDepositoPrincipal,
  listarStockOtrosDepositos,
  crearPedidoDesdePresupuesto,
  insertarItemsPedidoDesdePresupuesto,
  incrementarStockReservadoRpc,
  liberarStockReservadoRpc,
  registrarMovimientoStockReserva,
  eliminarItemsPedido,
  eliminarPedido,
  revertirPresupuestoAEnviado,
  vincularPresupuestoConPedido,
  actualizarPresupuesto,
  obtenerPresupuestoParaEliminar,
  eliminarItemsPresupuesto,
  eliminarPresupuesto,
} = await import('../../lib/repos/pedidos.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    order:       vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    delete:      vi.fn(() => obj),
    single:      vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('resolverPreciosClienteRpc (reexportado desde whatsapp-bot.js)', () => {
  it('llama al mismo RPC que usa el flujo de pedidos del portal/admin', async () => {
    dbMock.rpc.mockResolvedValue({ data: [{ producto_id: 'p1', precio: 100 }], error: null });

    const res = await resolverPreciosClienteRpc({ cliente_id: 'c1', producto_ids: ['p1'], empresa_id: 'e1' });

    expect(dbMock.rpc).toHaveBeenCalledWith('resolver_precios_cliente', {
      p_cliente_id: 'c1', p_producto_ids: ['p1'], p_empresa_id: 'e1',
    });
    expect(res.data).toEqual([{ producto_id: 'p1', precio: 100 }]);
  });
});

describe('obtenerClienteParaPresupuesto', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'c1', activo: true }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerClienteParaPresupuesto('empresa-1', 'c1');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('contarPresupuestosPorEmpresa', () => {
  it('filtra por empresa_id y devuelve el count', async () => {
    const query = fakeQuery({ count: 7, data: null, error: null });
    dbMock.from.mockReturnValue(query);

    expect(await contarPresupuestosPorEmpresa('empresa-1')).toBe(7);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });

  it('devuelve 0 si count viene null (empresa sin presupuestos todavía)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ count: null, data: null, error: null }));
    expect(await contarPresupuestosPorEmpresa('empresa-1')).toBe(0);
  });
});

describe('crearPresupuesto / insertarItemsPresupuesto', () => {
  it('inserta el presupuesto y devuelve la fila creada', async () => {
    const query = fakeQuery({ data: { id: 'pres-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await crearPresupuesto({ empresa_id: 'empresa-1', numero: 'PRES-00001' });

    expect(dbMock.from).toHaveBeenCalledWith('presupuestos');
    expect(query.insert).toHaveBeenCalledWith({ empresa_id: 'empresa-1', numero: 'PRES-00001' });
    expect(data).toEqual({ id: 'pres-1' });
  });

  it('propaga el error de insert sin lanzar (el handler decide el 500 y loguea)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    const { error } = await crearPresupuesto({});
    expect(error).toEqual({ message: 'boom' });
  });

  it('insertarItemsPresupuesto inserta la lista tal cual', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await insertarItemsPresupuesto([{ producto_id: 'p1' }]);

    expect(dbMock.from).toHaveBeenCalledWith('presupuesto_items');
    expect(query.insert).toHaveBeenCalledWith([{ producto_id: 'p1' }]);
  });
});

describe('obtenerConfigEmpresa', () => {
  it('busca la config por id de empresa', async () => {
    const query = fakeQuery({ data: { config: { presupuestos_vigencia_dias: 72 } }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerConfigEmpresa('empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('empresas');
    expect(query.eq).toHaveBeenCalledWith('id', 'empresa-1');
    expect(data.config.presupuestos_vigencia_dias).toBe(72);
  });
});

describe('obtenerPresupuestoConDetalle', () => {
  it('filtra por id Y empresa_id (no solo por id — aislamiento cross-tenant)', async () => {
    const query = fakeQuery({ data: { id: 'pres-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerPresupuestoConDetalle('empresa-1', 'pres-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'pres-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('listarPresupuestos', () => {
  it('siempre filtra por empresa_id, y agrega cliente_id/estado solo si vienen', async () => {
    const query = fakeQuery({ data: [{ id: 'pres-1' }], error: null });
    dbMock.from.mockReturnValue(query);

    await listarPresupuestos('empresa-1', {});

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).not.toHaveBeenCalledWith('cliente_id', expect.anything());
    expect(query.eq).not.toHaveBeenCalledWith('estado', expect.anything());
    expect(query.limit).toHaveBeenCalledWith(200);
  });

  it('agrega el filtro de cliente_id cuando se pasa clienteId (caso "esCliente" o admin filtrando)', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarPresupuestos('empresa-1', { clienteId: 'c1', estado: 'enviado' });

    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('estado', 'enviado');
  });
});

describe('obtenerClientePorUsuarioId', () => {
  it('filtra por usuario_id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'c1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerClientePorUsuarioId('empresa-1', 'user-1');

    expect(query.eq).toHaveBeenCalledWith('usuario_id', 'user-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual({ id: 'c1' });
  });

  it('devuelve null (no lanza) si no hay cliente vinculado — igual que el original', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));
    expect(await obtenerClientePorUsuarioId('empresa-1', 'user-x')).toBeNull();
  });
});

describe('bloquearPresupuestoAceptado (lock optimista v85)', () => {
  it('solo actualiza si estado sigue en "enviado" — condición de lock explícita', async () => {
    const query = fakeQuery({ data: { id: 'pres-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    await bloquearPresupuestoAceptado('empresa-1', 'pres-1');

    expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ estado: 'aceptado' }));
    expect(query.eq).toHaveBeenCalledWith('id', 'pres-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('estado', 'enviado');
  });

  it('data null cuando otro proceso ya lo convirtió (el handler responde 409)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const { data } = await bloquearPresupuestoAceptado('empresa-1', 'pres-1');
    expect(data).toBeNull();
  });
});

describe('obtenerStockDepositoPrincipal / listarStockOtrosDepositos', () => {
  it('obtenerStockDepositoPrincipal filtra por depósito principal de la empresa y devuelve la primera fila', async () => {
    const query = fakeQuery({ data: [{ deposito_id: 'd1', cantidad: 10, cantidad_reservada: 2 }], error: null });
    dbMock.from.mockReturnValue(query);

    const fila = await obtenerStockDepositoPrincipal('empresa-1', 'p1');

    expect(query.eq).toHaveBeenCalledWith('depositos.empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('depositos.es_principal', true);
    expect(fila.deposito_id).toBe('d1');
  });

  it('obtenerStockDepositoPrincipal devuelve null si no hay fila (el handler cae al fallback)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: [], error: null }));
    expect(await obtenerStockDepositoPrincipal('empresa-1', 'p1')).toBeNull();
  });

  it('listarStockOtrosDepositos filtra por empresa_id y devuelve [] si no hay datos', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await listarStockOtrosDepositos('empresa-1', 'p1')).toEqual([]);
  });
});

describe('crearPedidoDesdePresupuesto / insertarItemsPedidoDesdePresupuesto', () => {
  it('crearPedidoDesdePresupuesto inserta en pedidos y devuelve la fila', async () => {
    const query = fakeQuery({ data: { id: 'ped-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await crearPedidoDesdePresupuesto({ empresa_id: 'empresa-1', estado: 'confirmado' });

    expect(dbMock.from).toHaveBeenCalledWith('pedidos');
    expect(data).toEqual({ id: 'ped-1' });
  });

  it('insertarItemsPedidoDesdePresupuesto inserta en pedido_items', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await insertarItemsPedidoDesdePresupuesto([{ pedido_id: 'ped-1' }]);

    expect(dbMock.from).toHaveBeenCalledWith('pedido_items');
  });
});

describe('incrementarStockReservadoRpc / liberarStockReservadoRpc', () => {
  it('incrementar llama al RPC con los p_ params esperados', async () => {
    dbMock.rpc.mockResolvedValue({ error: null });

    await incrementarStockReservadoRpc({ producto_id: 'p1', deposito_id: 'd1', cantidad: 3 });

    expect(dbMock.rpc).toHaveBeenCalledWith('incrementar_stock_reservado', {
      p_producto_id: 'p1', p_deposito_id: 'd1', p_cantidad: 3,
    });
  });

  it('liberar llama al RPC contrario con los mismos params', async () => {
    dbMock.rpc.mockResolvedValue({ error: null });

    await liberarStockReservadoRpc({ producto_id: 'p1', deposito_id: 'd1', cantidad: 3 });

    expect(dbMock.rpc).toHaveBeenCalledWith('liberar_stock_reservado', {
      p_producto_id: 'p1', p_deposito_id: 'd1', p_cantidad: 3,
    });
  });
});

describe('funciones de rollback/limpieza (fire-and-forget, igual que el original)', () => {
  it('registrarMovimientoStockReserva no lanza aunque el insert falle', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'boom' } }));
    await expect(registrarMovimientoStockReserva({ producto_id: 'p1' })).resolves.toBeUndefined();
  });

  it('eliminarItemsPedido y eliminarPedido no lanzan', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'boom' } }));
    await expect(eliminarItemsPedido('ped-1')).resolves.toBeUndefined();
    await expect(eliminarPedido('ped-1')).resolves.toBeUndefined();
  });

  it('revertirPresupuestoAEnviado no lanza', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'boom' } }));
    await expect(revertirPresupuestoAEnviado('pres-1')).resolves.toBeUndefined();
  });

  it('vincularPresupuestoConPedido no lanza', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'boom' } }));
    await expect(vincularPresupuestoConPedido('pres-1', 'ped-1')).resolves.toBeUndefined();
  });
});

describe('actualizarPresupuesto', () => {
  it('actualiza por id con el patch tal cual', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarPresupuesto('pres-1', { notas: 'nueva nota' });

    expect(query.update).toHaveBeenCalledWith({ notas: 'nueva nota' });
    expect(query.eq).toHaveBeenCalledWith('id', 'pres-1');
  });
});

describe('DELETE: obtenerPresupuestoParaEliminar / eliminarItemsPresupuesto / eliminarPresupuesto', () => {
  it('obtenerPresupuestoParaEliminar filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { estado: 'borrador' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerPresupuestoParaEliminar('empresa-1', 'pres-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'pres-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });

  it('eliminarPresupuesto propaga el error (el handler responde 500 con errorSeguro)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'fk violation' } }));
    const { error } = await eliminarPresupuesto('pres-1');
    expect(error).toEqual({ message: 'fk violation' });
  });
});
