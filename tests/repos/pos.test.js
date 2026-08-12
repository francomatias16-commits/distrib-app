// tests/repos/pos.test.js
//
// Fase 7, paso 9 — `pos.js` no tenía tests de repo todavía pese a los 3
// sub-lotes previos (catálogo/stock, config varios, caja/turno). Se suma
// acá, con el sub-lote 4 (núcleo transaccional), porque es el bloque más
// sensible de todo el módulo: venta, anulación, facturación y devolución
// tocan stock, pagos y cta_cte. Foco del checklist (punto 5): que ninguna
// de estas funciones devuelva/edite datos de otra empresa — la clase de
// bug que ya se auditó una vez en AUDITORIA_2026.
//
// No se cubren acá `resumenTurnoCajaRpc`, `cerrarTurnoCajaRpc`, etc.
// (sub-lote 3) ni el resto de sub-lotes anteriores — quedan pendientes de
// una pasada de tests propia, fuera del alcance de este sub-lote (mismo
// criterio que dejó pendiente la cobertura de pedidos.js más allá de
// presupuestos).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));
// resolverPreciosClienteRpc se reexporta desde whatsapp-bot.js — no se
// duplica cobertura acá, ya la tiene tests/repos/whatsapp-bot.test.js.
vi.mock('../../lib/repos/whatsapp-bot.js', () => ({ resolverPreciosClienteRpc: vi.fn() }));

const {
  obtenerUmbralDescuentoUsuario,
  obtenerCajaParaVenta,
  obtenerClienteActivoParaVenta,
  registrarVentaPosRpc,
  obtenerVentaParaAnular,
  anularVentaPosRpc,
  obtenerVentaParaFacturar,
  obtenerVentaParaTicket,
  listarVentasPos,
  listarDevolucionesDeVenta,
  obtenerVentaParaDevolucion,
  registrarDevolucionPosRpc,
} = await import('../../lib/repos/pos.js');

// Mismo query builder falso que tests/repos/stock.test.js/cta-cte.test.js.
function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    order:       vi.fn(() => obj),
    range:       vi.fn(() => obj),
    ilike:       vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    lte:         vi.fn(() => obj),
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

describe('obtenerUmbralDescuentoUsuario', () => {
  it('busca por id de usuario (no lleva empresa_id — el caller ya validó al perfil autenticado)', async () => {
    const query = fakeQuery({ data: { supervisor_umbral_descuento_pct: 20 }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerUmbralDescuentoUsuario('usuario-1');

    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('id', 'usuario-1');
    expect(data).toEqual({ supervisor_umbral_descuento_pct: 20 });
  });
});

describe('obtenerCajaParaVenta', () => {
  it('filtra por id Y empresa_id — no debe traer una caja de otra empresa', async () => {
    const query = fakeQuery({ data: { id: 'caja-1', deposito_id: 'dep-1', activa: true }, error: null });
    dbMock.from.mockReturnValue(query);

    const caja = await obtenerCajaParaVenta('caja-1', 'empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('cajas_pos');
    expect(query.eq).toHaveBeenCalledWith('id', 'caja-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(caja.deposito_id).toBe('dep-1');
  });

  it('devuelve null si la caja no existe o pertenece a otra empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const caja = await obtenerCajaParaVenta('caja-ajena', 'empresa-1');

    expect(caja).toBeNull();
  });
});

describe('obtenerClienteActivoParaVenta', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'cliente-1', activo: true }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerClienteActivoParaVenta('cliente-1', 'empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('clientes');
    expect(query.eq).toHaveBeenCalledWith('id', 'cliente-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('registrarVentaPosRpc', () => {
  it('llama registrar_venta_pos con el payload tal cual (la RPC valida stock/turno/pagos server-side)', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, venta_id: 'venta-1' }, error: null });

    const payload = { p_empresa_id: 'empresa-1', p_caja_id: 'caja-1', p_items: [] };
    const { data, error } = await registrarVentaPosRpc(payload);

    expect(dbMock.rpc).toHaveBeenCalledWith('registrar_venta_pos', payload);
    expect(error).toBeNull();
    expect(data.ok).toBe(true);
  });

  it('propaga el error de la RPC sin ocultarlo (falla al registrar la venta no debe pasar silenciosa)', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const { error } = await registrarVentaPosRpc({});

    expect(error).toEqual({ message: 'boom' });
  });
});

describe('obtenerVentaParaAnular', () => {
  it('filtra por id Y empresa_id, con ítems/pagos/depósito embebidos', async () => {
    const query = fakeQuery({
      data: { id: 'venta-1', empresa_id: 'empresa-1', estado: 'confirmada', factura_id: null },
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const venta = await obtenerVentaParaAnular('venta-1', 'empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('ventas_pos');
    expect(query.eq).toHaveBeenCalledWith('id', 'venta-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(venta.estado).toBe('confirmada');
  });

  it('devuelve null si la venta pertenece a otra empresa (no debe filtrar el dato)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const venta = await obtenerVentaParaAnular('venta-ajena', 'empresa-1');

    expect(venta).toBeNull();
  });
});

describe('anularVentaPosRpc', () => {
  it('pasa venta_pos_id, usuario_id y motivo a la RPC anular_venta_pos', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true }, error: null });

    await anularVentaPosRpc('venta-1', 'usuario-1', 'error de carga');

    expect(dbMock.rpc).toHaveBeenCalledWith('anular_venta_pos', {
      p_venta_pos_id: 'venta-1',
      p_usuario_id:   'usuario-1',
      p_motivo:       'error de carga',
    });
  });

  it('manda motivo null si viene vacío (mismo comportamiento que el handler original)', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true }, error: null });

    await anularVentaPosRpc('venta-1', 'usuario-1', '');

    expect(dbMock.rpc).toHaveBeenCalledWith('anular_venta_pos', expect.objectContaining({ p_motivo: null }));
  });
});

describe('obtenerVentaParaFacturar', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'venta-1', estado: 'confirmada', factura_id: null }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerVentaParaFacturar('venta-1', 'empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('ventas_pos');
    expect(query.eq).toHaveBeenCalledWith('id', 'venta-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('obtenerVentaParaTicket', () => {
  it('filtra por id Y empresa_id y propaga el error (el handler responde 500 si falla)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'db down' } });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerVentaParaTicket('venta-1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toBeNull();
    expect(error).toEqual({ message: 'db down' });
  });
});

describe('listarVentasPos', () => {
  it('siempre filtra por empresa_id y pagina con range', async () => {
    const query = fakeQuery({ data: [{ id: 'venta-1' }], error: null });
    dbMock.from.mockReturnValue(query);

    await listarVentasPos({ empresa_id: 'empresa-1', limit: 30, offset: 0 });

    expect(dbMock.from).toHaveBeenCalledWith('ventas_pos');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.range).toHaveBeenCalledWith(0, 29);
    // Sin filtros opcionales, no debe llamar a estado/ilike/gte/lte de más
    expect(query.eq).not.toHaveBeenCalledWith('estado', expect.anything());
    expect(query.ilike).not.toHaveBeenCalled();
  });

  it('aplica los filtros opcionales solo cuando vienen presentes', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarVentasPos({
      empresa_id: 'empresa-1', q: 'A-0001', estado: 'confirmada',
      desde: '2026-01-01', hasta: '2026-01-31', limit: 30, offset: 0,
    });

    expect(query.eq).toHaveBeenCalledWith('estado', 'confirmada');
    expect(query.ilike).toHaveBeenCalledWith('numero', '%A-0001%');
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-01-01T00:00:00');
    expect(query.lte).toHaveBeenCalledWith('created_at', '2026-01-31T23:59:59');
  });
});

describe('listarDevolucionesDeVenta', () => {
  it('filtra por venta_pos_id Y empresa_id', async () => {
    const query = fakeQuery({ data: [{ id: 'dev-1' }], error: null });
    dbMock.from.mockReturnValue(query);

    await listarDevolucionesDeVenta('venta-1', 'empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('devoluciones_pos');
    expect(query.eq).toHaveBeenCalledWith('venta_pos_id', 'venta-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('obtenerVentaParaDevolucion', () => {
  it('filtra por id Y empresa_id — no debe permitir devolver una venta de otra empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    const venta = await obtenerVentaParaDevolucion('venta-ajena', 'empresa-1');

    expect(venta).toBeNull();
  });
});

describe('registrarDevolucionPosRpc', () => {
  it('serializa items a JSON y recorta motivo, igual que el handler original', async () => {
    dbMock.rpc.mockResolvedValue({ data: 'dev-1', error: null });

    const items = [{ venta_pos_item_id: 'item-1', cantidad_devuelta: 2 }];
    await registrarDevolucionPosRpc({ venta_pos_id: 'venta-1', items, motivo: '  producto roto  ', usuario_id: 'usuario-1' });

    expect(dbMock.rpc).toHaveBeenCalledWith('rpc_registrar_devolucion_pos', {
      p_venta_pos_id: 'venta-1',
      p_items:        JSON.stringify(items),
      p_motivo:       'producto roto',
      p_usuario_id:   'usuario-1',
    });
  });

  it('manda motivo null si no viene', async () => {
    dbMock.rpc.mockResolvedValue({ data: 'dev-1', error: null });

    await registrarDevolucionPosRpc({ venta_pos_id: 'venta-1', items: [], motivo: undefined, usuario_id: 'usuario-1' });

    expect(dbMock.rpc).toHaveBeenCalledWith('rpc_registrar_devolucion_pos', expect.objectContaining({ p_motivo: null }));
  });
});
