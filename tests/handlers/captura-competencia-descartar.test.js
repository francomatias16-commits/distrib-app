// tests/handlers/captura-competencia-descartar.test.js
//
// Cubre el gap real reportado: el estado 'descartado' de captura_competencia
// existía en el CHECK de la tabla (migración 551) y hasta en las etiquetas
// del frontend, pero ningún código lo fijaba nunca — el vendedor no tenía
// forma de sacar de su bandeja una captura hecha por error. Esta suite
// cubre las dos partes del fix:
//   1. accion=descartar: pasa a 'descartado', bloquea si ya es pedido real.
//   2. accionMetricas: las descartadas no cuentan para "capturas totales"
//      ni para la tasa de cierre (si contaran, descartar una captura mala
//      seguiría arrastrando para abajo la métrica para siempre).
//
// Mismo patrón de mocking que captura-competencia-margen.test.js — no se
// duplica acá la suite de permisos por acción ni el gate del flag.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(async () => ({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' })),
}));

vi.mock('../../lib/security-headers.js', () => ({ aplicarHeaders: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => async () => false }));
vi.mock('../../lib/error-response.js', () => ({
  errorSeguro: (res, err) => res.status(500).json({ error: err.message }),
}));
vi.mock('../../lib/permisos-service.js', () => ({ puede: vi.fn(() => true) }));
vi.mock('../../lib/utils/image-sniff.js', () => ({ validarImagenPorContenido: vi.fn() }));
vi.mock('../../lib/repos/clientes.js', () => ({ crearCliente: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({ firmarCampoUrl: vi.fn() }));
vi.mock('../../lib/handlers/captura-competencia/_extraccion.js', () => ({ extraerRenglonesDeFactura: vi.fn() }));
vi.mock('../../lib/handlers/pedidos/crear-pedido.js', () => ({ crearPedidoParaCliente: vi.fn() }));

const obtenerCapturaDetalleMock = vi.fn();
const marcarCapturaDescartadaMock = vi.fn(async () => ({ error: null }));
const obtenerMetricasCapturaMock = vi.fn();
vi.mock('../../lib/repos/captura-competencia.js', () => ({
  subirFotoCapturaStorage: vi.fn(),
  crearCaptura: vi.fn(),
  insertarItemsCaptura: vi.fn(),
  obtenerCapturaDetalle: (...args) => obtenerCapturaDetalleMock(...args),
  listarCapturasPendientes: vi.fn(async () => ({ data: [], error: null })),
  obtenerMetricasCaptura: (...args) => obtenerMetricasCapturaMock(...args),
  actualizarTotalesCaptura: vi.fn(),
  marcarCapturaConvertida: vi.fn(),
  marcarCapturaDescartada: (...args) => marcarCapturaDescartadaMock(...args),
  confirmarItemCaptura: vi.fn(),
  matchearProducto: vi.fn(),
  listarAhorroAcumuladoEmpresa: vi.fn(async () => ({ data: [], error: null })),
}));

const { default: handler } = await import('../../lib/handlers/captura-competencia.js');

function mockReqRes({ method = 'POST', accion, body = {} } = {}) {
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
  const req = { method, query: { accion }, body, headers: {} };
  return { req, res };
}

function mockDbEmpresas() {
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'empresas') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { config: {} }, error: null }) }) }) };
    }
    throw new Error(`db.from('${tabla}') no mockeado en este test`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbEmpresas();
  marcarCapturaDescartadaMock.mockResolvedValue({ error: null });
});

describe('accion=descartar', () => {
  it('pasa la captura a estado descartado', async () => {
    obtenerCapturaDetalleMock.mockResolvedValue({ data: { id: 'c1', estado: 'pendiente_revision' }, error: null });
    const { req, res } = mockReqRes({ accion: 'descartar', body: { id: 'c1' } });

    await handler(req, res);

    expect(marcarCapturaDescartadaMock).toHaveBeenCalledWith('c1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rechaza con 409 si la captura ya se convirtió en pedido', async () => {
    obtenerCapturaDetalleMock.mockResolvedValue({ data: { id: 'c1', estado: 'convertido_pedido' }, error: null });
    const { req, res } = mockReqRes({ accion: 'descartar', body: { id: 'c1' } });

    await handler(req, res);

    expect(marcarCapturaDescartadaMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
  });

  it('responde 404 si la captura no existe o no es de esta empresa', async () => {
    obtenerCapturaDetalleMock.mockResolvedValue({ data: null, error: null });
    const { req, res } = mockReqRes({ accion: 'descartar', body: { id: 'c-otra-empresa' } });

    await handler(req, res);

    expect(marcarCapturaDescartadaMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it('responde 400 si falta el id', async () => {
    const { req, res } = mockReqRes({ accion: 'descartar', body: {} });

    await handler(req, res);

    expect(obtenerCapturaDetalleMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});

describe('accion=metricas — las descartadas no cuentan', () => {
  it('excluye descartadas del total y de la tasa de cierre', async () => {
    obtenerMetricasCapturaMock.mockResolvedValue({
      data: [
        { estado: 'convertido_pedido', fecha_captura: '2026-08-01T10:00:00Z', convertido_at: '2026-08-01T12:00:00Z' },
        { estado: 'pendiente_revision', fecha_captura: '2026-08-02T10:00:00Z', convertido_at: null },
        { estado: 'descartado', fecha_captura: '2026-08-03T10:00:00Z', convertido_at: null },
        { estado: 'descartado', fecha_captura: '2026-08-04T10:00:00Z', convertido_at: null },
      ],
      error: null,
    });
    const { req, res } = mockReqRes({ method: 'GET', accion: 'metricas' });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    // Sin las 2 descartadas: total real = 2 (1 convertida + 1 pendiente).
    // Si las descartadas contaran, total sería 4 y la tasa 25% en vez de 50%.
    expect(res.body.total_capturas).toBe(2);
    expect(res.body.total_convertidas).toBe(1);
    expect(res.body.tasa_conversion_pct).toBe(50);
  });
});
