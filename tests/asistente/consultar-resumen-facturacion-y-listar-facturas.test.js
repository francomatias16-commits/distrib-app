// tests/asistente/consultar-resumen-facturacion-y-listar-facturas.test.js
//
// Frente 4 de PLAN_COBERTURA_TOOLS_ASISTENTE.md: fn_facturas_contadores y
// fn_facturas_lista no recibían p_empresa_id explícito (mismo bloqueo que
// las RPC de stock del frente 3 — ver comentario en
// consultar-stock-valorizacion-distribucion.test.js). Se agregó un
// overload de cada una con p_empresa_id explícito, solo para service_role
// (migración asistente_tools_reportes_stock_facturas_empresa_id_explicito).
//
// Mismo patrón de mock que facturacion-formato-error.test.js: se mockea
// solo lib/repos/_db.js (rpc). Estas dos tools nuevas no llaman a
// buscarFacturaPorReferencia/buscarPedidoFacturable, así que no hace
// falta mockear nada más de _helpers.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_FACTURACION } = await import('../../lib/asistente-tools/facturacion.js');

const consultarResumenFacturacion = TOOLS_FACTURACION.find((t) => t.name === 'consultar_resumen_facturacion');
const listarFacturas = TOOLS_FACTURACION.find((t) => t.name === 'listar_facturas');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('consultar_resumen_facturacion', () => {
  it('existe, es de solo lectura y tiene roles definidos', () => {
    expect(consultarResumenFacturacion).toBeTruthy();
    expect(consultarResumenFacturacion.requiereConfirmacion).toBeFalsy();
    expect(Array.isArray(consultarResumenFacturacion.roles) && consultarResumenFacturacion.roles.length > 0).toBe(true);
  });

  it('llama a la RPC con p_empresa_id y devuelve la primera fila (RETURNS TABLE de una sola fila)', async () => {
    const fila = { cant_pendientes: 2, cant_error_afip: 1, cant_emitidas_mes: 30, monto_emitidas_mes: 150000 };
    dbMock.rpc.mockResolvedValueOnce({ data: [fila], error: null });

    const resultado = await consultarResumenFacturacion.execute({ empresaId: EMPRESA_ID });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_facturas_contadores', { p_empresa_id: EMPRESA_ID });
    expect(resultado).toEqual(fila);
  });

  it('si la RPC ya devuelve un objeto plano (no array), lo devuelve tal cual', async () => {
    const fila = { cant_pendientes: 0, cant_error_afip: 0, cant_emitidas_mes: 0, monto_emitidas_mes: 0 };
    dbMock.rpc.mockResolvedValueOnce({ data: fila, error: null });

    const resultado = await consultarResumenFacturacion.execute({ empresaId: EMPRESA_ID });

    expect(resultado).toEqual(fila);
  });

  it('propaga el error de la RPC con el nombre de la tool en el mensaje', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db caída' } });

    await expect(consultarResumenFacturacion.execute({ empresaId: EMPRESA_ID }))
      .rejects.toThrow('consultar_resumen_facturacion: db caída');
  });
});

describe('listar_facturas', () => {
  it('existe, es de solo lectura y tiene roles definidos', () => {
    expect(listarFacturas).toBeTruthy();
    expect(listarFacturas.requiereConfirmacion).toBeFalsy();
    expect(Array.isArray(listarFacturas.roles) && listarFacturas.roles.length > 0).toBe(true);
  });

  it('sin filtros, llama a la RPC con nulls y limit/offset default (20/0)', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: [], error: null });

    await listarFacturas.execute({ empresaId: EMPRESA_ID, args: {} });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_facturas_lista', {
      p_empresa_id: EMPRESA_ID,
      p_busqueda: null,
      p_estado: null,
      p_fecha_desde: null,
      p_fecha_hasta: null,
      p_limit: 20,
      p_offset: 0,
    });
  });

  it('propaga todos los filtros pedidos (búsqueda de cliente, estado, fechas)', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: [], error: null });

    await listarFacturas.execute({
      empresaId: EMPRESA_ID,
      args: {
        busqueda: 'Distribuidora Sur',
        estado: 'pendiente',
        fecha_desde: '2026-08-01',
        fecha_hasta: '2026-08-31',
        limit: 10,
        offset: 20,
      },
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_facturas_lista', {
      p_empresa_id: EMPRESA_ID,
      p_busqueda: 'Distribuidora Sur',
      p_estado: 'pendiente',
      p_fecha_desde: '2026-08-01',
      p_fecha_hasta: '2026-08-31',
      p_limit: 10,
      p_offset: 20,
    });
  });

  it('un limit por encima del tope (50) se recorta', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: [], error: null });

    await listarFacturas.execute({ empresaId: EMPRESA_ID, args: { limit: 500 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_facturas_lista', expect.objectContaining({ p_limit: 50 }));
  });

  it('un limit u offset inválido cae al default (20/0)', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: [], error: null });

    await listarFacturas.execute({ empresaId: EMPRESA_ID, args: { limit: -5, offset: -1 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_facturas_lista', expect.objectContaining({ p_limit: 20, p_offset: 0 }));
  });

  it('devuelve los datos de la RPC tal cual, incluyendo total_count', async () => {
    const payload = [
      { id: 'f1', numero: '0001-00000123', total: 5000, estado: 'pendiente', total_count: 3 },
    ];
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await listarFacturas.execute({ empresaId: EMPRESA_ID, args: {} });

    expect(resultado).toEqual(payload);
  });

  it('propaga el error de la RPC con el nombre de la tool en el mensaje', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db caída' } });

    await expect(listarFacturas.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('listar_facturas: db caída');
  });
});
