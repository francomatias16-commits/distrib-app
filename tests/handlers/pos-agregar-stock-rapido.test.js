// tests/handlers/pos-agregar-stock-rapido.test.js
//
// Punto 1 (mitad "agregar stock sin perder el comprobante"): nuevo endpoint
// POST /api/pos/agregar-stock-rapido. Cubre:
//  - dueno/admin/depositero ajustan directo, sin PIN.
//  - vendedor sin PIN → 403 requiere_pin, y no llega a tocar stock.
//  - vendedor con PIN correcto → ajusta.
//  - vendedor con PIN incorrecto → 403, no ajusta.
//  - validaciones básicas (cantidad, caja/producto ajenos a la empresa).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: { storage: {} } }));
vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({}),
}));

const perteneceProductoAEmpresaMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/repos/productos.js', async () => {
  const actual = await vi.importActual('../../lib/repos/productos.js');
  return {
    ...actual,
    perteneceProductoAEmpresa: perteneceProductoAEmpresaMock,
  };
});

const ajustarStockRpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/repos/stock.js', async () => {
  const actual = await vi.importActual('../../lib/repos/stock.js');
  return {
    ...actual,
    ajustarStockRpc: ajustarStockRpcMock,
  };
});

const obtenerCajaParaVentaMock = vi.hoisted(() => vi.fn());
const obtenerPinSupervisorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/repos/pos.js', async () => {
  const actual = await vi.importActual('../../lib/repos/pos.js');
  return {
    ...actual,
    obtenerCajaParaVenta: obtenerCajaParaVentaMock,
    obtenerPinSupervisor: obtenerPinSupervisorMock,
  };
});

// bcrypt real (no mockeado): el PIN de prueba se guarda ya hasheado.
import bcrypt from 'bcryptjs';

const { default: handler } = await import('../../lib/handlers/pos.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function req(perfilRol, body) {
  return {
    method: 'POST',
    query: { accion: 'agregar-stock-rapido' },
    headers: { authorization: 'Bearer token-valido' },
    body,
  };
}

const CAJA_OK = { id: 'caja1', deposito_id: 'dep1', activa: true };

beforeEach(async () => {
  vi.clearAllMocks();
  perteneceProductoAEmpresaMock.mockResolvedValue(true);
  obtenerCajaParaVentaMock.mockResolvedValue(CAJA_OK);
  ajustarStockRpcMock.mockResolvedValue({ data: { ok: true, stock_nuevo: 5 }, error: null });
  obtenerPinSupervisorMock.mockResolvedValue({
    data: { supervisor_pin: await bcrypt.hash('1234', 10) },
    error: null,
  });
});

describe('POST /api/pos/agregar-stock-rapido', () => {
  it('dueno ajusta directo, sin pedir PIN', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    const res = mockRes();

    await handler(req('dueno', { caja_id: 'caja1', producto_id: 'p1', cantidad: 3 }), res);

    expect(obtenerPinSupervisorMock).not.toHaveBeenCalled();
    expect(ajustarStockRpcMock).toHaveBeenCalledWith(expect.objectContaining({
      producto_id: 'p1', deposito_id: 'dep1', delta: 3, tipo: 'ingreso', usuario_id: 'u1',
    }));
    expect(res.json).toHaveBeenCalledWith({ ok: true, cantidad_nueva: 5 });
  });

  it('depositero ajusta directo', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u2', empresa_id: 'e1', rol: 'depositero' });
    const res = mockRes();

    await handler(req('depositero', { caja_id: 'caja1', producto_id: 'p1', cantidad: 1 }), res);

    expect(obtenerPinSupervisorMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, cantidad_nueva: 5 });
  });

  it('vendedor sin PIN → 403 requiere_pin, no toca stock', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u3', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(req('vendedor', { caja_id: 'caja1', producto_id: 'p1', cantidad: 3 }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requiere_pin: true }));
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();
  });

  it('vendedor con PIN correcto → ajusta', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u3', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(req('vendedor', { caja_id: 'caja1', producto_id: 'p1', cantidad: 3, pin_supervisor: '1234' }), res);

    expect(ajustarStockRpcMock).toHaveBeenCalledWith(expect.objectContaining({ delta: 3, tipo: 'ingreso' }));
    expect(res.json).toHaveBeenCalledWith({ ok: true, cantidad_nueva: 5 });
  });

  it('vendedor con PIN incorrecto → 403, no ajusta', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u3', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(req('vendedor', { caja_id: 'caja1', producto_id: 'p1', cantidad: 3, pin_supervisor: '9999' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'PIN de supervisor incorrecto.' }));
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();
  });

  it('sin PIN de supervisor configurado en la empresa → 403 explicativo', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u3', empresa_id: 'e1', rol: 'vendedor' });
    obtenerPinSupervisorMock.mockResolvedValue({ data: { supervisor_pin: null }, error: null });
    const res = mockRes();

    await handler(req('vendedor', { caja_id: 'caja1', producto_id: 'p1', cantidad: 3, pin_supervisor: '1234' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('No hay PIN de supervisor configurado'),
    }));
  });

  it('cantidad inválida (<=0 o no entera) → 400', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    const res = mockRes();

    await handler(req('dueno', { caja_id: 'caja1', producto_id: 'p1', cantidad: 0 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();

    res.status.mockClear();
    await handler(req('dueno', { caja_id: 'caja1', producto_id: 'p1', cantidad: 1.5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();
  });

  it('producto que no pertenece a la empresa → 404, no ajusta', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    perteneceProductoAEmpresaMock.mockResolvedValue(false);
    const res = mockRes();

    await handler(req('dueno', { caja_id: 'caja1', producto_id: 'ajeno', cantidad: 3 }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();
  });

  it('caja inactiva o de otra empresa → 404, no ajusta', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    obtenerCajaParaVentaMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(req('dueno', { caja_id: 'ajena', producto_id: 'p1', cantidad: 3 }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();
  });

  it('rol sin permiso de vender en el POS (ej. chofer) → 403 antes de cualquier otra validación', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u4', empresa_id: 'e1', rol: 'chofer' });
    const res = mockRes();

    await handler(req('chofer', { caja_id: 'caja1', producto_id: 'p1', cantidad: 3 }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(perteneceProductoAEmpresaMock).not.toHaveBeenCalled();
    expect(ajustarStockRpcMock).not.toHaveBeenCalled();
  });
});
