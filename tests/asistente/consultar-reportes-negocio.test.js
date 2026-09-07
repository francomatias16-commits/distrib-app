// tests/asistente/consultar-reportes-negocio.test.js
//
// Las 6 tools de lib/asistente-tools/reportes.js (resumen ejecutivo,
// comparativa mensual, ventas por canal, resumen de compras a proveedor,
// resumen de gastos generales, estado financiero integral) — agregadas al
// detectar en una captura real del chat-widget que el rol dueño no tenía
// forma de preguntar nada agregado del negocio (ver changelog del PR).
//
// Cada una es un wrapper fino sobre una RPC ya existente y ya usada por
// el Panel administrativo (lib/handlers/admin.js + lib/repos/admin.js):
// estos tests solo verifican que la tool arma bien los parámetros (rango
// de fechas a partir de "dias", tope de días, agrupación por defecto) y
// que propaga tanto el resultado como el error de la RPC — no vuelven a
// probar la lógica SQL en sí, eso ya lo cubre la RPC en Supabase.
//
// Mismo patrón que consultar-stock-por-texto.test.js: se mockea solo
// lib/repos/_db.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_REPORTES } = await import('../../lib/asistente-tools/reportes.js');

const EMPRESA_ID = 'e1';

function tool(nombre) {
  return TOOLS_REPORTES.find((t) => t.name === nombre);
}

describe('tools de reportes/resúmenes de negocio', () => {
  beforeEach(() => {
    dbMock.rpc.mockReset();
  });

  it('las 6 tools existen, son de solo lectura y tienen roles definidos', () => {
    const nombres = [
      'consultar_resumen_ejecutivo',
      'consultar_comparativa_mensual',
      'consultar_ventas_por_canal',
      'consultar_resumen_compras_proveedor',
      'consultar_resumen_gastos_generales',
      'consultar_estado_financiero_integral',
    ];
    for (const nombre of nombres) {
      const t = tool(nombre);
      expect(t, `falta la tool ${nombre}`).toBeTruthy();
      expect(t.requiereConfirmacion).toBeFalsy();
      expect(Array.isArray(t.roles) && t.roles.length > 0).toBe(true);
    }
  });

  it('consultar_resumen_ejecutivo: pasa empresa_id y un rango desde/hasta en base a "dias"', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { cobranza: {}, rentabilidad: {}, stock: {} }, error: null });

    const resultado = await tool('consultar_resumen_ejecutivo').execute({ empresaId: EMPRESA_ID, args: { dias: 7 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('obtener_dashboard_ejecutivo_resumen', expect.objectContaining({
      p_empresa_id: EMPRESA_ID,
    }));
    const params = dbMock.rpc.mock.calls[0][1];
    const desde = new Date(params.p_desde);
    const hasta = new Date(params.p_hasta);
    const diffDias = Math.round((hasta - desde) / 86400000);
    expect(diffDias).toBe(7);
    expect(resultado).toEqual({ cobranza: {}, rentabilidad: {}, stock: {} });
  });

  it('consultar_resumen_ejecutivo: sin "dias", usa 30 por defecto', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: {}, error: null });
    await tool('consultar_resumen_ejecutivo').execute({ empresaId: EMPRESA_ID, args: {} });
    const params = dbMock.rpc.mock.calls[0][1];
    const diffDias = Math.round((new Date(params.p_hasta) - new Date(params.p_desde)) / 86400000);
    expect(diffDias).toBe(30);
  });

  it('consultar_resumen_ejecutivo: "dias" por encima del tope (365) se recorta', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: {}, error: null });
    await tool('consultar_resumen_ejecutivo').execute({ empresaId: EMPRESA_ID, args: { dias: 5000 } });
    const params = dbMock.rpc.mock.calls[0][1];
    const diffDias = Math.round((new Date(params.p_hasta) - new Date(params.p_desde)) / 86400000);
    expect(diffDias).toBe(365);
  });

  it('consultar_comparativa_mensual: solo pasa empresa_id (la RPC resuelve la fecha de referencia sola)', async () => {
    const payload = { mes_actual_label: 'Septiembre 2026', total_actual: 100, total_anterior: 80, delta_pct: 25 };
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await tool('consultar_comparativa_mensual').execute({ empresaId: EMPRESA_ID, args: {} });

    expect(dbMock.rpc).toHaveBeenCalledWith('obtener_comparativa_mensual', { p_empresa_id: EMPRESA_ID });
    expect(resultado).toEqual(payload);
  });

  it('consultar_ventas_por_canal: arma el rango de fechas y devuelve el array tal cual', async () => {
    const payload = [{ canal: 'pos', total: 1000, cantidad: 5, porcentaje: 100 }];
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await tool('consultar_ventas_por_canal').execute({ empresaId: EMPRESA_ID, args: { dias: 15 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('obtener_ventas_por_canal', expect.objectContaining({ p_empresa_id: EMPRESA_ID }));
    expect(resultado).toEqual(payload);
  });

  it('consultar_resumen_compras_proveedor: propaga el resultado de la RPC', async () => {
    const payload = { total_facturado_periodo: 500, top_proveedores_deuda: [] };
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await tool('consultar_resumen_compras_proveedor').execute({ empresaId: EMPRESA_ID, args: {} });

    expect(dbMock.rpc).toHaveBeenCalledWith('obtener_resumen_compras_proveedor', expect.objectContaining({ p_empresa_id: EMPRESA_ID }));
    expect(resultado).toEqual(payload);
  });

  it('consultar_resumen_gastos_generales: propaga el resultado de la RPC', async () => {
    const payload = { total_periodo: 200, por_categoria: [] };
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await tool('consultar_resumen_gastos_generales').execute({ empresaId: EMPRESA_ID, args: { dias: 60 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('obtener_resumen_gastos_generales', expect.objectContaining({ p_empresa_id: EMPRESA_ID }));
    expect(resultado).toEqual(payload);
  });

  it('consultar_estado_financiero_integral: usa agrupación "mes" por defecto', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { totales: {} }, error: null });

    await tool('consultar_estado_financiero_integral').execute({ empresaId: EMPRESA_ID, args: {} });

    const params = dbMock.rpc.mock.calls[0][1];
    expect(params.p_agrupacion).toBe('mes');
    expect(params.p_empresa_id).toBe(EMPRESA_ID);
  });

  it('consultar_estado_financiero_integral: respeta la agrupación pedida', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { totales: {} }, error: null });
    await tool('consultar_estado_financiero_integral').execute({ empresaId: EMPRESA_ID, args: { agrupacion: 'anio' } });
    expect(dbMock.rpc.mock.calls[0][1].p_agrupacion).toBe('anio');
  });

  it.each([
    ['consultar_resumen_ejecutivo', 'obtener_dashboard_ejecutivo_resumen'],
    ['consultar_ventas_por_canal', 'obtener_ventas_por_canal'],
    ['consultar_resumen_compras_proveedor', 'obtener_resumen_compras_proveedor'],
    ['consultar_resumen_gastos_generales', 'obtener_resumen_gastos_generales'],
    ['consultar_estado_financiero_integral', 'obtener_estado_financiero_integral'],
  ])('%s: propaga el error de la RPC con el nombre de la tool en el mensaje', async (nombreTool, nombreRpc) => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db caída' } });
    await expect(tool(nombreTool).execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow(new RegExp(`${nombreTool}.*db caída`));
  });
});
