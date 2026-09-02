// tests/handlers/captura-competencia-flag.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, 1.7 (Entregable Fase 1): el gate por
// empresas.config->>'captura_competencia_habilitada' (piloto gradual) se
// sacó a pedido directo — la función queda disponible siempre, para todas
// las empresas, sin depender de esa clave (ver comentario en el handler).
// Este archivo quedó como regresión: confirma que ausencia/false/true en
// esa clave dan todos el mismo resultado (200), para que un futuro cambio
// no reintroduzca el gate por accidente.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  from: vi.fn(),
}));
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

const listarCapturasPendientesMock = vi.fn(async () => ({ data: [], error: null }));
const obtenerMetricasCapturaMock = vi.fn(async () => ({ data: [], error: null }));

vi.mock('../../lib/repos/captura-competencia.js', () => ({
  subirFotoCapturaStorage: vi.fn(),
  crearCaptura: vi.fn(),
  insertarItemsCaptura: vi.fn(),
  obtenerCapturaDetalle: vi.fn(),
  listarCapturasPendientes: (...args) => listarCapturasPendientesMock(...args),
  obtenerMetricasCaptura: (...args) => obtenerMetricasCapturaMock(...args),
  actualizarTotalesCaptura: vi.fn(),
  marcarCapturaConvertida: vi.fn(),
  confirmarItemCaptura: vi.fn(),
  matchearProducto: vi.fn(),
  listarAhorroAcumuladoEmpresa: vi.fn(async () => ({ data: [], error: null })),
}));

const { default: handler } = await import('../../lib/handlers/captura-competencia.js');

/** Mock mínimo de req/res estilo Vercel, mismo criterio que el resto de
 * tests/handlers/*.test.js de este proyecto. */
function mockReqRes({ method = 'GET', query = {}, body = {} } = {}) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      // Mismo comportamiento que el objeto `res` real (Vercel/Express-like):
      // `.json()` sin `.status()` previo responde 200 por default. La
      // primera versión de este mock no lo hacía, y accionListar() llama a
      // `res.json(...)` directo (nunca pasa por `.status(200)` explícito) —
      // eso hacía fallar en falso el caso "con la clave en true", no el gate.
      if (this.statusCode === null) this.statusCode = 200;
      this.body = payload;
      return this;
    },
    end() { return this; },
  };
  const req = { method, query, body, headers: {} };
  return { req, res };
}

function empresaQueryConConfig(config) {
  return {
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { config }, error: null }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listarCapturasPendientesMock.mockResolvedValue({ data: [], error: null });
});

describe('ex-gate del feature flag de piloto (config.captura_competencia_habilitada) — ya no bloquea', () => {
  it('sin la clave en config → igual deja pasar (200), la función ya no depende del flag', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({}));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listarCapturasPendientesMock).toHaveBeenCalled();
  });

  it('con la clave explícitamente en false → igual deja pasar (200)', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({ captura_competencia_habilitada: false }));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('con la clave en true → sigue dejando pasar (compatibilidad con empresas que la tenían activada)', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({ captura_competencia_habilitada: true }));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listarCapturasPendientesMock).toHaveBeenCalled();
  });

  it('una acción inexistente da 400 (no 403) sea cual sea el estado del flag', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({}));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'algo-que-no-existe' } });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });
});

describe('accion=metricas (plan 1.7 — métrica de éxito del piloto)', () => {
  it('con flag habilitado, delega en obtenerMetricasCaptura y calcula tasa de cierre + tiempo promedio', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({ captura_competencia_habilitada: true }));
    obtenerMetricasCapturaMock.mockResolvedValue({
      data: [
        { estado: 'convertido_pedido', fecha_captura: '2026-08-01T10:00:00.000Z', convertido_at: '2026-08-01T12:00:00.000Z' },
        { estado: 'pendiente_revision', fecha_captura: '2026-08-02T10:00:00.000Z', convertido_at: null },
      ],
      error: null,
    });
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(obtenerMetricasCapturaMock).toHaveBeenCalled();
    expect(res.body.total_capturas).toBe(2);
    expect(res.body.total_convertidas).toBe(1);
    expect(res.body.tasa_conversion_pct).toBe(50);
    expect(res.body.tiempo_promedio_foto_cierre_horas).toBe(2);
  });

  it('vendedor → obtenerMetricasCaptura recibe su propio id como filtro (mismo scoping que accion=listar)', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({ captura_competencia_habilitada: true }));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(obtenerMetricasCapturaMock).toHaveBeenCalledWith('e1', 'u1');
  });

  it('sin capturas → tasa 0 y tiempo promedio null, nunca división por cero', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({ captura_competencia_habilitada: true }));
    obtenerMetricasCapturaMock.mockResolvedValue({ data: [], error: null });
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total_capturas).toBe(0);
    expect(res.body.tasa_conversion_pct).toBe(0);
    expect(res.body.tiempo_promedio_foto_cierre_horas).toBeNull();
  });

  it('sin la clave en config, igual llega a llamar obtenerMetricasCaptura (ex-gate sacado)', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({}));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(obtenerMetricasCapturaMock).toHaveBeenCalled();
  });
});
