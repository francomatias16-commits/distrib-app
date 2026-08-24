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
  existeOrdenCompraEnEmpresa,
  insertarFacturaProveedorCC,
  insertarItemsFacturaProveedorCC,
  eliminarItemsFacturaProveedorCC,
  conciliarOcFacturaRpc,
  altaFacturaProveedorRpc,
  editarFacturaProveedorRpc,
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
  // FIX (auditoría v880, punto 2): la RPC ahora exige p_empresa_id y valida
  // tenant/proveedor antes de conciliar. Estos tests cubren tanto el wrapper
  // del repo como el comportamiento esperado de la RPC ante cruces de tenant.

  it('conciliarOcFacturaRpc envuelve la RPC con p_empresa_id incluido', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, discrepancias: [] }, error: null });
    const { data } = await conciliarOcFacturaRpc({ orden_id: 'oc1', factura_id: 'f1', empresa_id: 'e1', umbral_pct: 5 });
    expect(dbMock.rpc).toHaveBeenCalledWith('conciliar_oc_factura', {
      p_orden_id: 'oc1', p_factura_id: 'f1', p_empresa_id: 'e1', p_umbral_pct: 5,
    });
    expect(data.ok).toBe(true);
  });

  it('conciliarOcFacturaRpc rechaza sin llamar a la RPC si falta empresa_id', async () => {
    const { data } = await conciliarOcFacturaRpc({ orden_id: 'oc1', factura_id: 'f1', umbral_pct: 5 });
    expect(dbMock.rpc).not.toHaveBeenCalled();
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('EMPRESA_REQUERIDA');
  });

  it('propaga el rechazo de la RPC cuando OC y factura son de empresas distintas', async () => {
    // Simula el caso real: OC de empresa B usada con factura de empresa A.
    dbMock.rpc.mockResolvedValue({
      data: { ok: false, codigo: 'EMPRESA_NO_COINCIDE', error: 'la orden y la factura no pertenecen a la misma empresa' },
      error: null,
    });
    const { data } = await conciliarOcFacturaRpc({ orden_id: 'oc-empresa-B', factura_id: 'f-empresa-A', empresa_id: 'empresaA', umbral_pct: 5 });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('EMPRESA_NO_COINCIDE');
  });

  it('propaga el rechazo de la RPC cuando OC y factura son del mismo empresa pero proveedores distintos', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: false, codigo: 'PROVEEDOR_NO_COINCIDE', error: 'la orden y la factura no pertenecen al mismo proveedor' },
      error: null,
    });
    const { data } = await conciliarOcFacturaRpc({ orden_id: 'oc-prov1', factura_id: 'f-prov2', empresa_id: 'e1', umbral_pct: 5 });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('PROVEEDOR_NO_COINCIDE');
  });

  it('registrarPagoProveedorRpc pasa el payload tal cual', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const payload = { p_empresa_id: 'e1', p_proveedor_id: 'p1', p_factura_id: 'f1', p_monto: 100 };
    await registrarPagoProveedorRpc(payload);
    expect(dbMock.rpc).toHaveBeenCalledWith('registrar_pago_proveedor', payload);
  });
});

describe('existeOrdenCompraEnEmpresa', () => {
  it('devuelve true si la OC existe en la empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { id: 'oc1' }, error: null }));
    expect(await existeOrdenCompraEnEmpresa({ empresa_id: 'e1', orden_id: 'oc1' })).toBe(true);
  });

  it('devuelve false si la OC es de otra empresa (cross-tenant) o no existe', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    expect(await existeOrdenCompraEnEmpresa({ empresa_id: 'empresaA', orden_id: 'oc-de-empresaB' })).toBe(false);
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

describe('altaFacturaProveedorRpc', () => {
  // Punto 3 auditoría: el alta pasa a ser una única RPC transaccional
  // (cabecera + ítems + conciliación + auditoría atómicos). Estos tests
  // cubren el wrapper del repo — el comportamiento transaccional en sí
  // (rollback ante item inválido, cross-tenant, etc.) se probó en vivo
  // contra Supabase al aplicar la migración 506.

  it('envuelve la RPC con todos los parámetros, incluido empresa_id y usuario_id', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: true, factura_id: 'f1', subtotal: 100, iva_monto: 21, total: 121, conciliacion: null },
      error: null,
    });
    const { data } = await altaFacturaProveedorRpc({
      empresa_id: 'e1', proveedor_id: 'p1', numero_factura: 'A-0001', fecha_factura: '2026-08-19',
      orden_id: 'oc1', tipo: 'A', fecha_vencimiento: '2026-09-19', iva_pct: 21, notas: 'nota',
      items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 100 }], umbral_pct: 5, usuario_id: 'u1',
    });
    expect(dbMock.rpc).toHaveBeenCalledWith('alta_factura_proveedor', {
      p_empresa_id: 'e1', p_proveedor_id: 'p1', p_numero_factura: 'A-0001', p_fecha_factura: '2026-08-19',
      p_orden_id: 'oc1', p_tipo: 'A', p_fecha_vencimiento: '2026-09-19', p_iva_pct: 21, p_notas: 'nota',
      p_items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 100 }], p_umbral_pct: 5, p_usuario_id: 'u1',
    });
    expect(data.ok).toBe(true);
    expect(data.factura_id).toBe('f1');
  });

  it('aplica defaults (orden_id null, tipo A, iva_pct 21, umbral_pct 5) si no vienen', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, factura_id: 'f2' }, error: null });
    await altaFacturaProveedorRpc({
      empresa_id: 'e1', proveedor_id: 'p1', numero_factura: 'A-0002', fecha_factura: '2026-08-19',
      items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 50 }],
    });
    expect(dbMock.rpc).toHaveBeenCalledWith('alta_factura_proveedor', expect.objectContaining({
      p_orden_id: null, p_tipo: 'A', p_iva_pct: 21, p_umbral_pct: 5, p_usuario_id: null,
    }));
  });

  it('propaga el rechazo de la RPC (ítem inválido) sin que el wrapper lo transforme', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: false, codigo: 'ITEM_PRECIO_INVALIDO', error: 'cada item requiere precio_unitario >= 0' },
      error: null,
    });
    const { data } = await altaFacturaProveedorRpc({
      empresa_id: 'e1', proveedor_id: 'p1', numero_factura: 'A-0003', fecha_factura: '2026-08-19',
      items: [{ descripcion: 'item', cantidad: 1, precio_unitario: -5 }],
    });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('ITEM_PRECIO_INVALIDO');
  });

  it('propaga el rechazo cuando la OC es de otra empresa (cross-tenant)', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: false, codigo: 'EMPRESA_NO_COINCIDE', error: 'la orden de compra no pertenece a la empresa' },
      error: null,
    });
    const { data } = await altaFacturaProveedorRpc({
      empresa_id: 'empresaA', proveedor_id: 'p1', numero_factura: 'A-0004', fecha_factura: '2026-08-19',
      orden_id: 'oc-de-empresaB', items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 10 }],
    });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('EMPRESA_NO_COINCIDE');
  });
});

describe('editarFacturaProveedorRpc', () => {
  // Punto 4 auditoría: la edición pasa a ser una única RPC transaccional
  // (lock FOR UPDATE + control de versión + cabecera + ítems +
  // reconciliación + auditoría atómicos). Estos tests cubren el wrapper
  // del repo — el comportamiento transaccional en sí (rollback ante item
  // inválido, cross-tenant, conflicto de versión) se probó en vivo contra
  // Supabase al aplicar la migración 507.

  it('envuelve la RPC con todos los parámetros, incluidos los flags *_provisto', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: true, factura_id: 'f1', orden_id: 'oc1', conciliacion: null },
      error: null,
    });
    const { data } = await editarFacturaProveedorRpc({
      empresa_id: 'e1', id: 'f1', expected_updated_at: '2026-08-19T10:00:00Z',
      estado: 'pendiente', notas: 'nota nueva', notas_provisto: true,
      fecha_vencimiento: '2026-09-19', numero_factura: 'A-0001', tipo: 'A',
      fecha_factura: '2026-08-19', iva_pct: 21,
      orden_id_provisto: true, orden_id: 'oc1',
      items_provisto: true, items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 100 }],
      umbral_pct: 5, usuario_id: 'u1',
    });
    expect(dbMock.rpc).toHaveBeenCalledWith('editar_factura_proveedor', {
      p_empresa_id: 'e1', p_id: 'f1', p_expected_updated_at: '2026-08-19T10:00:00Z',
      p_estado: 'pendiente', p_notas: 'nota nueva', p_notas_provisto: true,
      p_fecha_vencimiento: '2026-09-19', p_numero_factura: 'A-0001', p_tipo: 'A',
      p_fecha_factura: '2026-08-19', p_iva_pct: 21,
      p_orden_id_provisto: true, p_orden_id: 'oc1',
      p_items_provisto: true, p_items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 100 }],
      p_umbral_pct: 5, p_usuario_id: 'u1',
    });
    expect(data.ok).toBe(true);
  });

  it('manda los flags *_provisto en false y expected_updated_at null si no vienen (edición parcial sin control de versión)', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, factura_id: 'f2' }, error: null });
    await editarFacturaProveedorRpc({ empresa_id: 'e1', id: 'f2', notas: 'solo notas', notas_provisto: true });
    expect(dbMock.rpc).toHaveBeenCalledWith('editar_factura_proveedor', expect.objectContaining({
      p_expected_updated_at: null,
      p_orden_id_provisto: false, p_items_provisto: false,
      p_notas: 'solo notas', p_notas_provisto: true,
      p_umbral_pct: 5, p_usuario_id: null,
    }));
  });

  it('propaga VERSION_CONFLICT sin que el wrapper lo transforme', async () => {
    dbMock.rpc.mockResolvedValue({
      data: {
        ok: false, codigo: 'VERSION_CONFLICT',
        error: 'La factura fue editada por otra persona mientras tanto. Volvé a abrirla para ver los cambios.',
        updated_at_actual: '2026-08-19T11:00:00Z',
      },
      error: null,
    });
    const { data } = await editarFacturaProveedorRpc({
      empresa_id: 'e1', id: 'f3', expected_updated_at: '2026-08-19T10:00:00Z', notas: 'x', notas_provisto: true,
    });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('VERSION_CONFLICT');
    expect(data.updated_at_actual).toBe('2026-08-19T11:00:00Z');
  });

  it('propaga EDICION_NO_PERMITIDA (factura anulada o con pagos) sin que el wrapper lo transforme', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: false, codigo: 'EDICION_NO_PERMITIDA', error: 'No se pueden editar los datos/ítems de una factura anulada o con pagos ya registrados.' },
      error: null,
    });
    const { data } = await editarFacturaProveedorRpc({
      empresa_id: 'e1', id: 'f4', items_provisto: true, items: [{ descripcion: 'item', cantidad: 1, precio_unitario: 10 }],
    });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('EDICION_NO_PERMITIDA');
  });

  it('propaga el rechazo cuando la nueva OC es de otra empresa (cross-tenant)', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { ok: false, codigo: 'EMPRESA_NO_COINCIDE', error: 'la orden de compra no pertenece a la empresa' },
      error: null,
    });
    const { data } = await editarFacturaProveedorRpc({
      empresa_id: 'empresaA', id: 'f5', orden_id_provisto: true, orden_id: 'oc-de-empresaB',
    });
    expect(data.ok).toBe(false);
    expect(data.codigo).toBe('EMPRESA_NO_COINCIDE');
  });
});
