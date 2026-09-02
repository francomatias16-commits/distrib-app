// tests/handlers/captura-competencia-ahorro-ranking.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 2, plan 2.5: reporte admin de ranking
// de ahorro acumulado por cliente (accion=ahorro_ranking).
//
// Foco: (1) el rol vendedor nunca ve este reporte, aunque tenga permiso
// 'leer' sobre 'captura_competencia' — es un agregado de TODA la empresa,
// no de sus propias capturas; (2) la forma de la respuesta (clientes[] +
// ahorro_total_empresa) y que el total se calcula sumando el acumulado de
// cada cliente devuelto, no viene de otra fuente.
//
// No duplica tests/handlers/captura-competencia-flag.test.js (gate del
// flag, ya cubierto ahí para el resto de las acciones).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

vi.mock('../../lib/security-headers.js', () => ({ aplicarHeaders: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => async () => false }));
vi.mock('../../lib/error-response.js', () => ({
  errorSeguro: (res, err) => res.status(500).json({ error: err.message }),
}));
vi.mock('../../lib/utils/image-sniff.js', () => ({ validarImagenPorContenido: vi.fn() }));
vi.mock('../../lib/repos/clientes.js', () => ({ crearCliente: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({ firmarCampoUrl: vi.fn() }));
vi.mock('../../lib/handlers/captura-competencia/_extraccion.js', () => ({ extraerRenglonesDeFactura: vi.fn() }));
vi.mock('../../lib/handlers/pedidos/crear-pedido.js', () => ({ crearPedidoParaCliente: vi.fn() }));

// `puede` real por defecto concede — cada test ajusta el rol del perfil,
// no este mock, salvo que necesite ejercitar explícitamente "sin permiso".
let permisoConcedido = true;
vi.mock('../../lib/permisos-service.js', () => ({ puede: (...args) => permisoConcedido }));

let perfilMock = { id: 'u1', empresa_id: 'e1', rol: 'admin' };
vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(async () => perfilMock),
}));

const listarAhorroAcumuladoEmpresaMock = vi.fn();
vi.mock('../../lib/repos/captura-competencia.js', () => ({
  subirFotoCapturaStorage: vi.fn(),
  crearCaptura: vi.fn(),
  insertarItemsCaptura: vi.fn(),
  obtenerCapturaDetalle: vi.fn(),
  listarCapturasPendientes: vi.fn(async () => ({ data: [], error: null })),
  obtenerMetricasCaptura: vi.fn(async () => ({ data: [], error: null })),
  actualizarTotalesCaptura: vi.fn(),
  marcarCapturaConvertida: vi.fn(),
  confirmarItemCaptura: vi.fn(),
  matchearProducto: vi.fn(),
  listarAhorroAcumuladoEmpresa: (...args) => listarAhorroAcumuladoEmpresaMock(...args),
}));

const { default: handler } = await import('../../lib/handlers/captura-competencia.js');

function mockReqRes({ method = 'GET', query = {} } = {}) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      if (this.statusCode === null) this.statusCode = 200;
      this.body = payload;
      return this;
    },
    end() { return this; },
  };
  return { req: { method, query, body: {}, headers: {} }, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  permisoConcedido = true;
  dbMock.from.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { config: { captura_competencia_habilitada: true } }, error: null }),
      }),
    }),
  });
});

describe('accion=ahorro_ranking — permisos', () => {
  it('rol vendedor -> 403, aunque puede() concedería el permiso', async () => {
    perfilMock = { id: 'u1', empresa_id: 'e1', rol: 'vendedor' };
    const { req, res } = mockReqRes({ query: { accion: 'ahorro_ranking' } });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(listarAhorroAcumuladoEmpresaMock).not.toHaveBeenCalled();
  });

  it('sin permiso "leer" sobre captura_competencia -> 403', async () => {
    perfilMock = { id: 'u1', empresa_id: 'e1', rol: 'admin' };
    permisoConcedido = false;
    const { req, res } = mockReqRes({ query: { accion: 'ahorro_ranking' } });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(listarAhorroAcumuladoEmpresaMock).not.toHaveBeenCalled();
  });

  it('rol dueno/admin con permiso -> 200 y llama al repo con la empresa del perfil', async () => {
    perfilMock = { id: 'u1', empresa_id: 'e1', rol: 'dueno' };
    listarAhorroAcumuladoEmpresaMock.mockResolvedValue({ data: [], error: null });
    const { req, res } = mockReqRes({ query: { accion: 'ahorro_ranking' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listarAhorroAcumuladoEmpresaMock).toHaveBeenCalledWith('e1');
  });
});

describe('accion=ahorro_ranking — forma de la respuesta', () => {
  beforeEach(() => {
    perfilMock = { id: 'u1', empresa_id: 'e1', rol: 'admin' };
  });

  it('devuelve clientes[] y ahorro_total_empresa calculado sumando cada fila', async () => {
    listarAhorroAcumuladoEmpresaMock.mockResolvedValue({
      data: [
        { ahorro_acumulado: 900.5, pedidos_con_ahorro: 5, ultima_actualizacion: '2026-02-01', clientes: { razon_social: 'Cliente A' } },
        { ahorro_acumulado: 100.25, pedidos_con_ahorro: 1, ultima_actualizacion: '2026-01-10', clientes: { razon_social: 'Cliente B' } },
      ],
      error: null,
    });
    const { req, res } = mockReqRes({ query: { accion: 'ahorro_ranking' } });

    await handler(req, res);

    expect(res.body.clientes).toHaveLength(2);
    expect(res.body.clientes[0].razon_social).toBe('Cliente A');
    expect(res.body.ahorro_total_empresa).toBe(1000.75);
  });

  it('lista vacía -> ahorro_total_empresa en 0, no rompe', async () => {
    listarAhorroAcumuladoEmpresaMock.mockResolvedValue({ data: [], error: null });
    const { req, res } = mockReqRes({ query: { accion: 'ahorro_ranking' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.clientes).toEqual([]);
    expect(res.body.ahorro_total_empresa).toBe(0);
  });
});
