// tests/asistente/consultar-clientes-en-fuga.test.js
//
// Frente 2 de PLAN_COBERTURA_TOOLS_ASISTENTE.md: fn_clientes_en_fuga ya
// existía (migraciones 590/592) y ya la usa handleFugaCron
// (lib/handlers/notif.js) con el mismo cliente service_role que usa el
// asistente — a diferencia de las RPC de stock/facturas (frentes 3 y 4,
// bloqueadas por no recibir p_empresa_id explícito), esta sí lo recibe,
// así que no hizo falta ninguna migración SQL previa para exponerla acá.
// Mismo patrón de mock que listar-clientes-por-deuda.test.js: se mockea
// solo lib/repos/_db.js (rpc).

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

const consultarClientesEnFuga = TOOLS_CLIENTES.find((t) => t.name === 'consultar_clientes_en_fuga');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('consultar_clientes_en_fuga', () => {
  it('existe, es de solo lectura y tiene roles definidos', () => {
    expect(consultarClientesEnFuga).toBeTruthy();
    expect(consultarClientesEnFuga.requiereConfirmacion).toBeFalsy();
    expect(Array.isArray(consultarClientesEnFuga.roles) && consultarClientesEnFuga.roles.length > 0).toBe(true);
  });

  it('llama a la RPC con empresa_id y el límite pedido', async () => {
    const payload = {
      total_clientes_en_fuga: 3,
      clientes_mostrados: 3,
      valor_anual_total_en_riesgo: 450000,
      clientes: [{ cliente_id: 'c1', razon_social: 'Distribuidora Sur', dias_atraso: 12 }],
    };
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await consultarClientesEnFuga.execute({ empresaId: EMPRESA_ID, args: { limite: 10 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_clientes_en_fuga', {
      p_empresa_id: EMPRESA_ID,
      p_limite: 10,
    });
    expect(resultado).toEqual(payload);
  });

  it('sin "limite", usa 50 por defecto', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { clientes: [] }, error: null });

    await consultarClientesEnFuga.execute({ empresaId: EMPRESA_ID, args: {} });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_clientes_en_fuga', {
      p_empresa_id: EMPRESA_ID,
      p_limite: 50,
    });
  });

  it('un límite por encima del tope (200) se recorta', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { clientes: [] }, error: null });

    await consultarClientesEnFuga.execute({ empresaId: EMPRESA_ID, args: { limite: 9999 } });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_clientes_en_fuga', {
      p_empresa_id: EMPRESA_ID,
      p_limite: 200,
    });
  });

  it('un límite inválido (0, negativo o no numérico) cae al default de 50', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: { clientes: [] }, error: null });
    await consultarClientesEnFuga.execute({ empresaId: EMPRESA_ID, args: { limite: -5 } });
    expect(dbMock.rpc).toHaveBeenCalledWith('fn_clientes_en_fuga', {
      p_empresa_id: EMPRESA_ID,
      p_limite: 50,
    });
  });

  it('propaga el error de la RPC con el nombre de la tool en el mensaje', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db caída' } });

    await expect(consultarClientesEnFuga.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('consultar_clientes_en_fuga: db caída');
  });
});
