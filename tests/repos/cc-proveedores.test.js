// tests/repos/cc-proveedores.test.js
//
// Fase 7 — `cc_proveedores.js` (Etapa 8.5, cuentas corrientes con
// proveedores) no tenía tests de repo. Foco en el aislamiento por
// empresa_id de cada función y en la política de error silenciosa vs.
// throw de cada una (ver comentarios en lib/repos/cc-proveedores.js).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerPerfilCCProveedores,
  listarBalanceProveedores,
  contarFacturasConDiferencias,
  obtenerFacturaProveedorDetalle,
  listarFacturasProveedorFiltradas,
  listarPagosFactura,
  existeProveedorEnEmpresa,
  insertarFacturaProveedorCC,
  insertarItemsFacturaProveedorCC,
  eliminarItemsFacturaProveedorCC,
  conciliarOcFacturaRpc,
  actualizarConciliacionFactura,
  registrarPagoProveedorRpc,
  obtenerFacturaEstadoTotalPagado,
  actualizarFacturaProveedorCC,
} = await import('../../lib/repos/cc-proveedores.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    neq:         vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    lte:         vi.fn(() => obj),
    order:       vi.fn(() => obj),
    range:       vi.fn(() => obj),
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

describe('obtenerPerfilCCProveedores', () => {
  it('busca por id de usuario — silenciosa', async () => {
    const query = fakeQuery({ data: { empresa_id: 'e1', rol: 'admin', nombre: 'Ana', id: 'u1' }, error: null });
    dbMock.from.mockReturnValue(query);
    const perfil = await obtenerPerfilCCProveedores('u1');
    expect(dbMock.from).toHaveBeenCalledWith('usuarios');
    expect(query.eq).toHaveBeenCalledWith('id', 'u1');
    expect(perfil.empresa_id).toBe('e1');
  });
});

describe('listarBalanceProveedores', () => {
  it('filtra por empresa_id, ordena por saldo_pendiente desc, limita a 500 — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(listarBalanceProveedores({ empresa_id: 'e1' })).rejects.toBeTruthy();
    expect(dbMock.from).toHaveBeenCalledWith('v_cc_proveedor');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.limit).toHaveBeenCalledWith(500);
  });

  it('agrega filtro por proveedor_id si viene', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);
    await listarBalanceProveedores({ empresa_id: 'e1', proveedor_id: 'p1' });
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'p1');
  });
});

describe('contarFacturasConDiferencias', () => {
  it('filtra por empresa_id, tiene_diferencias=true, estado != anulada — silenciosa', async () => {
    dbMock.from.mockReturnValue({ select: vi.fn(() => ({ eq: vi.fn(function() { return this; }), neq: vi.fn(function() { return this; }), then: (r) => Promise.resolve({ count: 3 }).then(r) })) });
    const count = await contarFacturasConDiferencias('e1');
    expect(count).toBe(3);
  });

  it('devuelve 0 si count es null', async () => {
    dbMock.from.mockReturnValue({ select: vi.fn(() => ({ eq: vi.fn(function() { return this; }), neq: vi.fn(function() { return this; }), then: (r) => Promise.resolve({ count: null }).then(r) })) });
    const count = await contarFacturasConDiferencias('e1');
    expect(count).toBe(0);
  });
});

describe('obtenerFacturaProveedorDetalle', () => {
  it('filtra por empresa_id Y id, usa maybeSingle — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(obtenerFacturaProveedorDetalle({ empresa_id: 'e1', id: 'f1' })).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('id', 'f1');
  });
});

describe('listarFacturasProveedorFiltradas', () => {
  it('aplica filtros opcionales y paginación — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' }, count: null });
    dbMock.from.mockReturnValue(query);
    await expect(listarFacturasProveedorFiltradas({
      empresa_id: 'e1', proveedor_id: 'p1', estado: 'pendiente', offset: 0, hasta_range: 49,
    })).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'p1');
    expect(query.eq).toHaveBeenCalledWith('estado', 'pendiente');
    expect(query.range).toHaveBeenCalledWith(0, 49);
  });

  it('devuelve data/count con defaults si vienen null', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null, count: null }));
    const { data, count } = await listarFacturasProveedorFiltradas({ empresa_id: 'e1', offset: 0, hasta_range: 49 });
    expect(data).toEqual([]);
    expect(count).toBe(0);
  });
});

describe('listarPagosFactura', () => {
  it('filtra por factura_id Y empresa_id — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(listarPagosFactura({ empresa_id: 'e1', factura_id: 'f1' })).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('factura_id', 'f1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });
});

describe('existeProveedorEnEmpresa', () => {
  it('devuelve true si el proveedor existe en la empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { id: 'p1' }, error: null }));
    expect(await existeProveedorEnEmpresa('e1', 'p1')).toBe(true);
  });

  it('devuelve false si no existe', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await existeProveedorEnEmpresa('e1', 'px')).toBe(false);
  });
});

describe('insertarFacturaProveedorCC / items', () => {
  it('insertarFacturaProveedorCC propaga el error (throw)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(insertarFacturaProveedorCC({ empresa_id: 'e1' })).rejects.toBeTruthy();
  });

  it('insertarItemsFacturaProveedorCC propaga el error (throw)', async () => {
    dbMock.from.mockReturnValue({ insert: vi.fn(() => Promise.resolve({ error: { message: 'boom' } })) });
    await expect(insertarItemsFacturaProveedorCC([{ factura_id: 'f1' }])).rejects.toBeTruthy();
  });

  it('eliminarItemsFacturaProveedorCC filtra por factura_id — propaga el error (throw)', async () => {
    const del = { eq: vi.fn(() => Promise.resolve({ error: { message: 'boom' } })) };
    dbMock.from.mockReturnValue({ delete: vi.fn(() => del) });
    await expect(eliminarItemsFacturaProveedorCC('f1')).rejects.toBeTruthy();
    expect(del.eq).toHaveBeenCalledWith('factura_id', 'f1');
  });
});

describe('conciliarOcFacturaRpc / registrarPagoProveedorRpc', () => {
  it('conciliarOcFacturaRpc envuelve la RPC con los p_ params esperados', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, discrepancias: [] }, error: null });
    const { data } = await conciliarOcFacturaRpc({ orden_id: 'oc1', factura_id: 'f1', umbral_pct: 5 });
    expect(dbMock.rpc).toHaveBeenCalledWith('conciliar_oc_factura', { p_orden_id: 'oc1', p_factura_id: 'f1', p_umbral_pct: 5 });
    expect(data.ok).toBe(true);
  });

  it('registrarPagoProveedorRpc pasa el payload tal cual', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const payload = { p_empresa_id: 'e1', p_proveedor_id: 'p1', p_factura_id: 'f1', p_monto: 100 };
    await registrarPagoProveedorRpc(payload);
    expect(dbMock.rpc).toHaveBeenCalledWith('registrar_pago_proveedor', payload);
  });
});

describe('actualizarConciliacionFactura', () => {
  it('filtra por id Y empresa_id — silenciosa (fire-and-forget)', async () => {
    const query = { eq: vi.fn(function() { return this; }), then: (r) => Promise.resolve({ error: null }).then(r) };
    const upd = { update: vi.fn(() => query) };
    dbMock.from.mockReturnValue(upd);
    await actualizarConciliacionFactura({ id: 'f1', empresa_id: 'e1', conciliacion: {}, discrepancias: [] });
    expect(query.eq).toHaveBeenCalledWith('id', 'f1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });
});

describe('obtenerFacturaEstadoTotalPagado', () => {
  it('filtra por id Y empresa_id — silenciosa', async () => {
    const query = fakeQuery({ data: { estado: 'pendiente', total_pagado: 0 }, error: null });
    dbMock.from.mockReturnValue(query);
    const data = await obtenerFacturaEstadoTotalPagado({ id: 'f1', empresa_id: 'e1' });
    expect(query.eq).toHaveBeenCalledWith('id', 'f1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(data.estado).toBe('pendiente');
  });
});

describe('actualizarFacturaProveedorCC', () => {
  it('filtra por id Y empresa_id — propaga el error (throw)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(actualizarFacturaProveedorCC({ id: 'f1', empresa_id: 'e1', upd: { estado: 'pendiente' } }))
      .rejects.toBeTruthy();
  });

  it('devuelve la factura actualizada', async () => {
    const row = { id: 'f1', estado: 'pendiente' };
    dbMock.from.mockReturnValue(fakeQuery({ data: row, error: null }));
    const data = await actualizarFacturaProveedorCC({ id: 'f1', empresa_id: 'e1', upd: { estado: 'pendiente' } });
    expect(data).toEqual(row);
  });
});
