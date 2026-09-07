// tests/asistente/listar-clientes-por-deuda.test.js
//
// Tool nueva (v1066, migración 597): antes ninguna tool del asistente
// hacía una consulta AGREGADA sobre saldo_deuda de clientes (solo
// existía consultar_bloqueo_cliente, que busca UN cliente puntual por
// nombre). Preguntas tipo "cuántos clientes tienen más de $150.000 en
// deuda" no matcheaban ninguna tool. Mismo patrón de mock que
// clientes-formato-error.test.js: se mockea lib/repos/_db.js (rpc).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

vi.mock('../../lib/repos/clientes.js', () => ({
  crearCliente: vi.fn(),
  actualizarCliente: vi.fn(),
  desactivarCliente: vi.fn(),
}));

vi.mock('../../lib/repos/audit.js', () => ({
  registrarAuditoriaSilenciosa: vi.fn(),
}));

const { TOOLS_CLIENTES } = await import('../../lib/asistente-tools/clientes.js');

const listarClientesPorDeuda = TOOLS_CLIENTES.find((t) => t.name === 'listar_clientes_por_deuda');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('listar_clientes_por_deuda', () => {
  it('existe y no requiere confirmación (es de solo lectura)', () => {
    expect(listarClientesPorDeuda).toBeTruthy();
    expect(listarClientesPorDeuda.requiereConfirmacion).toBeFalsy();
  });

  it('llama a la RPC con el monto mínimo y el filtro de activos por default', async () => {
    dbMock.rpc.mockResolvedValueOnce({
      data: { total_clientes: 2, clientes_mostrados: 2, deuda_total_acumulada: 300000, clientes: [] },
      error: null,
    });

    const resultado = await listarClientesPorDeuda.execute({
      empresaId: EMPRESA_ID,
      args: { monto_minimo: 150000 },
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('listar_clientes_por_deuda', {
      p_empresa_id: EMPRESA_ID,
      p_monto_minimo: 150000,
      p_solo_activos: true,
    });
    expect(resultado.total_clientes).toBe(2);
  });

  it('usa 0 como monto mínimo si no lo dan, y respeta incluir_inactivos', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { total_clientes: 66, clientes: [] }, error: null });

    await listarClientesPorDeuda.execute({
      empresaId: EMPRESA_ID,
      args: { incluir_inactivos: true },
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('listar_clientes_por_deuda', {
      p_empresa_id: EMPRESA_ID,
      p_monto_minimo: 0,
      p_solo_activos: false,
    });
  });

  it('propaga el error de la RPC con el prefijo de la tool', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    await expect(listarClientesPorDeuda.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('listar_clientes_por_deuda: boom');
  });
});
