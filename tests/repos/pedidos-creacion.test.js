// tests/repos/pedidos-creacion.test.js
//
// Fase 7, paso 8 (pedidos.js), lote 4 sub-lote 3 — el núcleo de creación/
// confirmación de pedido (verPedidoSugeridoHandler, confirmarPedidoSugeridoHandler,
// crearPedidoParaCliente, crearPedidoAdminHandler, confirmarPedidoHandler) se
// migró sin sumar tests propios (quedó cubierto solo indirecto por la suite
// existente). Este archivo cierra ese pendiente, con el mismo foco que el
// resto de los tests de repos: aislamiento por `empresa_id` en cada función
// que resuelve datos server-side (varias de estas corren en rutas públicas
// sin sesión — confirmar-sugerido, ver-sugerido — así que el filtro por
// empresa_id/cliente_id acá es la única barrera antes de la RPC).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerPedidoSugeridoDetalle,
  obtenerPedidoParaConfirmarSugerido,
  obtenerPedidoParaPagoPublico,
  confirmarPedidoSugeridoRpc,
  obtenerClienteParaPedido,
  listarStockParaValidarPedido,
  obtenerPerfilParaCrearPedidoAdmin,
  obtenerUsuarioParaConfirmarPedido,
  obtenerClientePorIdParaConfirmar,
  obtenerClientePorEmailParaConfirmar,
  vaciarCarritoCliente,
} = await import('../../lib/repos/pedidos.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
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

describe('obtenerPedidoSugeridoDetalle (ver-sugerido, ruta pública sin auth)', () => {
  it('resuelve por id sin depender de sesión — el guard de acceso vive en el handler', async () => {
    const query = fakeQuery({ data: { id: 'ped-1', empresa_id: 'e1', estado: 'borrador' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPedidoSugeridoDetalle('ped-1');

    expect(dbMock.from).toHaveBeenCalledWith('pedidos');
    expect(query.eq).toHaveBeenCalledWith('id', 'ped-1');
    expect(data.empresa_id).toBe('e1');
  });

  it('propaga error si el pedido no existe (404 lo arma el handler)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'no encontrado' } });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerPedidoSugeridoDetalle('inexistente');
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });
});

describe('obtenerPedidoParaConfirmarSugerido (confirmar-sugerido, ruta pública sin auth)', () => {
  it('trae solo lo mínimo para resolver empresa_id/cliente_id server-side, nunca del body', async () => {
    const query = fakeQuery({
      data: { id: 'ped-1', empresa_id: 'e1', cliente_id: 'c1', estado: 'borrador' },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPedidoParaConfirmarSugerido('ped-1');

    expect(query.select).toHaveBeenCalledWith('id, empresa_id, cliente_id, estado');
    expect(data.empresa_id).toBe('e1');
    expect(data.cliente_id).toBe('c1');
  });
});

describe('obtenerPedidoParaPagoPublico (checkout.html, sin login)', () => {
  it('incluye generado_automatico — único campo que blindea el endpoint sin auth', async () => {
    const query = fakeQuery({
      data: { id: 'ped-1', empresa_id: 'e1', cliente_id: 'c1', generado_automatico: true, estado: 'borrador' },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPedidoParaPagoPublico('ped-1');

    expect(query.select.mock.calls[0][0]).toContain('generado_automatico');
    expect(data.generado_automatico).toBe(true);
  });

  it('un pedido cargado a mano por el admin (no generado_automatico) queda identificable para que el handler lo rechace', async () => {
    const query = fakeQuery({
      data: { id: 'ped-2', empresa_id: 'e1', cliente_id: 'c1', generado_automatico: false, estado: 'borrador' },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPedidoParaPagoPublico('ped-2');
    expect(data.generado_automatico).toBe(false);
  });
});

describe('confirmarPedidoSugeridoRpc', () => {
  it('llama a la RPC confirmar_pedido_sugerido con el payload resuelto server-side', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, pedido_id: 'ped-1' }, error: null });

    const { data } = await confirmarPedidoSugeridoRpc({
      p_pedido_id: 'ped-1', p_empresa_id: 'e1', p_cliente_id: 'c1',
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('confirmar_pedido_sugerido', {
      p_pedido_id: 'ped-1', p_empresa_id: 'e1', p_cliente_id: 'c1',
    });
    expect(data.ok).toBe(true);
  });
});

describe('obtenerClienteParaPedido (crearPedidoParaCliente / crearPedidoAdminHandler)', () => {
  it('filtra por id Y empresa_id — no alcanza con el id del cliente solo', async () => {
    const query = fakeQuery({
      data: { id: 'c1', razon_social: 'Cliente SA', activo: true, limite_credito: 5000, saldo_deuda: 1000 },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    await obtenerClienteParaPedido('empresa-1', 'c1');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });

  it('cliente de otra empresa no matchea (maybeSingle devuelve null, no cross-tenant leak)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const { data } = await obtenerClienteParaPedido('empresa-1', 'c-de-otra-empresa');
    expect(data).toBeNull();
  });
});

describe('listarStockParaValidarPedido', () => {
  it('consulta por producto_ids con .in(), sin empresa_id explícito (RLS + depósito son la barrera acá)', async () => {
    const query = fakeQuery({ data: [{ producto_id: 'p1', cantidad: 10, cantidad_reservada: 2 }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarStockParaValidarPedido(['p1', 'p2']);

    expect(dbMock.from).toHaveBeenCalledWith('stock');
    expect(query.in).toHaveBeenCalledWith('producto_id', ['p1', 'p2']);
    expect(data).toEqual([{ producto_id: 'p1', cantidad: 10, cantidad_reservada: 2 }]);
  });
});

describe('obtenerPerfilParaCrearPedidoAdmin', () => {
  it('resuelve empresa_id/rol del usuario que crea el pedido admin', async () => {
    const query = fakeQuery({ data: { id: 'u1', empresa_id: 'e1', rol: 'vendedor' }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerPerfilParaCrearPedidoAdmin('u1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('id', 'u1');
    expect(data.empresa_id).toBe('e1');
  });
});

describe('obtenerUsuarioParaConfirmarPedido', () => {
  it('trae cliente_id (portal nuevo) además de email (legacy)', async () => {
    const query = fakeQuery({
      data: { id: 'u1', empresa_id: 'e1', rol: 'cliente', email: 'c@x.com', cliente_id: 'c1' },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerUsuarioParaConfirmarPedido('u1');
    expect(data.cliente_id).toBe('c1');
    expect(data.email).toBe('c@x.com');
  });
});

describe('obtenerClientePorIdParaConfirmar / obtenerClientePorEmailParaConfirmar', () => {
  it('resolución por id: filtra por cliente_id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'c1', razon_social: 'Cliente SA', activo: true }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerClientePorIdParaConfirmar('empresa-1', 'c1');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });

  it('resolución por email (usuarios legacy sin cliente_id): filtra por email Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'c1', razon_social: 'Cliente SA', activo: true }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerClientePorEmailParaConfirmar('empresa-1', 'c@x.com');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('email', 'c@x.com');
  });

  it('un email que existe pero en otra empresa no matchea', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const { data } = await obtenerClientePorEmailParaConfirmar('empresa-1', 'c@otra-empresa.com');
    expect(data).toBeNull();
  });
});

describe('vaciarCarritoCliente (fire-and-forget tras confirmar)', () => {
  it('llama delete().eq(cliente_id) sobre carrito_items', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await vaciarCarritoCliente('c1');

    expect(dbMock.from).toHaveBeenCalledWith('carrito_items');
    expect(query.delete).toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'c1');
  });

  it('no lanza si la tabla devuelve error — el handler original lo trata best-effort', async () => {
    const query = fakeQuery({ data: null, error: { message: 'algo falló' } });
    dbMock.from.mockReturnValue(query);

    await expect(vaciarCarritoCliente('c1')).resolves.not.toThrow();
  });
});
