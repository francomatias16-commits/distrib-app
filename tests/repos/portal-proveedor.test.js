// tests/repos/portal-proveedor.test.js
//
// Fase 7 — `portal_proveedor.js` (Innovación #10, "Vidriera Inversa") no
// tenía tests de repo. Foco en aislamiento por empresa_id/proveedor_id en
// cada función de la superficie pública (la portada del portal se abre sin
// login, así que un filtro faltante ahí sería mucho más grave que en el
// resto de la API), y en la política de error silenciosa vs. throw de cada
// función.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerProveedorParaLink,
  insertarTokenPortal,
  listarTokensPortal,
  revocarTokenPortal,
  validarTokenPortalRpc,
  listarNotificacionesProveedor,
  obtenerProveedorPortal,
  obtenerNombreEmpresa,
  listarOrdenesCompraProveedor,
  listarFacturasProveedorPortal,
  obtenerOrdenCompraParaConfirmar,
  actualizarFechaEsperadaOrden,
  obtenerOrdenCompraParaFactura,
  insertarFacturaProveedorPortal,
} = await import('../../lib/repos/portal-proveedor.js');

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

describe('obtenerProveedorParaLink', () => {
  it('filtra por id Y empresa_id — silenciosa (devuelve null si no existe)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const prov = await obtenerProveedorParaLink('empresa-1', 'prov-x');
    expect(dbMock.from).toHaveBeenCalledWith('proveedores');
    expect(prov).toBeNull();
  });

  it('devuelve el proveedor si existe', async () => {
    const query = fakeQuery({ data: { id: 'prov-1', razon_social: 'ACME' }, error: null });
    dbMock.from.mockReturnValue(query);
    const prov = await obtenerProveedorParaLink('empresa-1', 'prov-1');
    expect(query.eq).toHaveBeenCalledWith('id', 'prov-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(prov.razon_social).toBe('ACME');
  });
});

describe('insertarTokenPortal', () => {
  it('inserta y devuelve la fila — propaga el error (throw)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(insertarTokenPortal({ empresa_id: 'e1', proveedor_id: 'p1', token_hash: 'h', creado_por: 'u1', expira_at: '2026-01-01' }))
      .rejects.toBeTruthy();
  });

  it('devuelve la fila creada si no hay error', async () => {
    const row = { id: 'tok-1', creado_at: 'x', expira_at: 'y' };
    dbMock.from.mockReturnValue(fakeQuery({ data: row, error: null }));
    const data = await insertarTokenPortal({ empresa_id: 'e1', proveedor_id: 'p1', token_hash: 'h', creado_por: 'u1', expira_at: 'y' });
    expect(data).toEqual(row);
  });
});

describe('listarTokensPortal', () => {
  it('filtra por proveedor_id Y empresa_id — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(listarTokensPortal('empresa-1', 'prov-1')).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'prov-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('revocarTokenPortal', () => {
  it('filtra por id Y empresa_id — propaga el error (throw)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(revocarTokenPortal('empresa-1', 'tok-1')).rejects.toBeTruthy();
  });

  it('devuelve null si el token no existe (404 en el handler)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const data = await revocarTokenPortal('empresa-1', 'tok-x');
    expect(data).toBeNull();
  });
});

describe('validarTokenPortalRpc', () => {
  it('envuelve la RPC y devuelve { data, error } tal cual — el handler decide', async () => {
    dbMock.rpc.mockReturnValue({ single: vi.fn(() => Promise.resolve({ data: { valido: true, proveedor_id: 'p1', empresa_id: 'e1' }, error: null })) });
    const { data, error } = await validarTokenPortalRpc('hash123');
    expect(dbMock.rpc).toHaveBeenCalledWith('validar_token_portal_proveedor', { p_token_hash: 'hash123' });
    expect(error).toBeNull();
    expect(data.valido).toBe(true);
  });
});

describe('listarNotificacionesProveedor', () => {
  it('filtra por empresa_id Y payload->>proveedor_id — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(listarNotificacionesProveedor('empresa-1', 'prov-1')).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('payload->>proveedor_id', 'prov-1');
  });
});

describe('obtenerProveedorPortal', () => {
  it('FIX Fase 7: filtra por id Y empresa_id (antes solo por id) — silenciosa', async () => {
    const query = fakeQuery({ data: { id: 'p1', razon_social: 'ACME' }, error: null });
    dbMock.from.mockReturnValue(query);
    await obtenerProveedorPortal('empresa-1', 'p1');
    expect(query.eq).toHaveBeenCalledWith('id', 'p1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('obtenerNombreEmpresa', () => {
  it('devuelve el nombre — silenciosa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { nombre: 'Mi Empresa' }, error: null }));
    const nombre = await obtenerNombreEmpresa('empresa-1');
    expect(nombre).toBe('Mi Empresa');
  });

  it('devuelve undefined si no hay data', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const nombre = await obtenerNombreEmpresa('empresa-x');
    expect(nombre).toBeUndefined();
  });
});

describe('listarOrdenesCompraProveedor', () => {
  it('filtra por proveedor_id Y empresa_id — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(listarOrdenesCompraProveedor('empresa-1', 'prov-1')).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'prov-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('listarFacturasProveedorPortal', () => {
  it('filtra por proveedor_id Y empresa_id — silenciosa (degrada, no rompe la portada)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    const data = await listarFacturasProveedorPortal('empresa-1', 'prov-1');
    expect(data).toBeNull();
  });
});

describe('obtenerOrdenCompraParaConfirmar', () => {
  it('filtra por id, proveedor_id Y empresa_id — silenciosa (null → 404 en el handler)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    const orden = await obtenerOrdenCompraParaConfirmar('empresa-1', 'prov-1', 'oc-1');
    expect(query.eq).toHaveBeenCalledWith('id', 'oc-1');
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'prov-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(orden).toBeNull();
  });
});

describe('actualizarFechaEsperadaOrden', () => {
  it('filtra por id, proveedor_id Y empresa_id, marca confirmada_por_proveedor — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(actualizarFechaEsperadaOrden({ empresa_id: 'e1', proveedor_id: 'p1', orden_id: 'oc1', fecha_esperada: '2026-01-01' }))
      .rejects.toBeTruthy();
  });

  it('devuelve la orden actualizada', async () => {
    const row = { id: 'oc1', fecha_esperada: '2026-01-01', confirmada_por_proveedor: true };
    dbMock.from.mockReturnValue(fakeQuery({ data: row, error: null }));
    const data = await actualizarFechaEsperadaOrden({ empresa_id: 'e1', proveedor_id: 'p1', orden_id: 'oc1', fecha_esperada: '2026-01-01' });
    expect(data).toEqual(row);
  });
});

describe('obtenerOrdenCompraParaFactura', () => {
  it('filtra por id, proveedor_id Y empresa_id — silenciosa', async () => {
    const query = fakeQuery({ data: { id: 'oc1' }, error: null });
    dbMock.from.mockReturnValue(query);
    const orden = await obtenerOrdenCompraParaFactura('empresa-1', 'prov-1', 'oc-1');
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'prov-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(orden.id).toBe('oc1');
  });
});

describe('insertarFacturaProveedorPortal', () => {
  it('inserta la factura — propaga el error (throw)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    await expect(insertarFacturaProveedorPortal({ empresa_id: 'e1', proveedor_id: 'p1', numero_factura: 'F1' }))
      .rejects.toBeTruthy();
  });

  it('devuelve la factura creada', async () => {
    const row = { id: 'f1', numero_factura: 'F1', estado: 'pendiente' };
    dbMock.from.mockReturnValue(fakeQuery({ data: row, error: null }));
    const data = await insertarFacturaProveedorPortal({ empresa_id: 'e1', proveedor_id: 'p1', numero_factura: 'F1' });
    expect(data).toEqual(row);
  });
});
