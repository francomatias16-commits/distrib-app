// tests/repos/offline-dedup-tenant-scope.test.js
// Punto 5 (auditoría pre-lanzamiento 2026): el dedup offline por
// offline_local_id debe estar acotado por empresa_id en los lookups de
// fast-path. Cubre lib/repos/pedidos.js (entregas, devoluciones) y
// lib/repos/portal-proveedor.js (facturas_proveedor).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/repos/_db.js', () => {
  const query = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.from.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return { db: query };
});

import { db } from '../../lib/repos/_db.js';
import {
  buscarEntregaPorOfflineLocalId,
  buscarDevolucionPorOfflineLocalId,
} from '../../lib/repos/pedidos.js';
import { insertarFacturaProveedorPortal } from '../../lib/repos/portal-proveedor.js';

describe('dedup offline — acotado por empresa_id (punto 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.from.mockReturnValue(db);
    db.select.mockReturnValue(db);
    db.eq.mockReturnValue(db);
  });

  it('buscarEntregaPorOfflineLocalId filtra por empresa_id y offline_local_id', async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: { id: 'e1' } });
    const r = await buscarEntregaPorOfflineLocalId('empresa-1', 'local-abc');
    expect(db.from).toHaveBeenCalledWith('entregas');
    expect(db.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(db.eq).toHaveBeenCalledWith('offline_local_id', 'local-abc');
    expect(r).toEqual({ id: 'e1' });
  });

  it('buscarEntregaPorOfflineLocalId no matchea la entrega de otra empresa', async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: null });
    const r = await buscarEntregaPorOfflineLocalId('empresa-2', 'local-abc');
    expect(r).toBeNull();
  });

  it('buscarDevolucionPorOfflineLocalId filtra por empresa_id y offline_local_id', async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: { id: 'd1' } });
    const r = await buscarDevolucionPorOfflineLocalId('empresa-1', 'local-xyz');
    expect(db.from).toHaveBeenCalledWith('devoluciones');
    expect(db.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(db.eq).toHaveBeenCalledWith('offline_local_id', 'local-xyz');
    expect(r).toEqual({ id: 'd1' });
  });

  it('insertarFacturaProveedorPortal usa el fast-path acotado por empresa_id cuando ya existe', async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: { id: 'f1', numero_factura: 'A-1' } });
    const r = await insertarFacturaProveedorPortal({
      empresa_id: 'empresa-1',
      proveedor_id: 'prov-1',
      offline_local_id: 'local-fact',
    });
    expect(db.from).toHaveBeenCalledWith('facturas_proveedor');
    expect(db.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(db.eq).toHaveBeenCalledWith('offline_local_id', 'local-fact');
    expect(r).toEqual({ id: 'f1', numero_factura: 'A-1', ya_existia: true });
  });

  it('insertarFacturaProveedorPortal inserta cuando no hay offline_local_id previo', async () => {
    db.maybeSingle.mockResolvedValueOnce({ data: null });
    db.single = vi.fn().mockResolvedValueOnce({ data: { id: 'f2' }, error: null });
    db.insert = vi.fn().mockReturnValue(db);
    const r = await insertarFacturaProveedorPortal({
      empresa_id: 'empresa-1',
      proveedor_id: 'prov-1',
      offline_local_id: 'local-fact-nuevo',
    });
    expect(db.insert).toHaveBeenCalled();
    expect(r).toEqual({ id: 'f2' });
  });
});
