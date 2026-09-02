// tests/handlers/prospectos-competencia.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 3, Capa 1 (prospección geográfica).
// Cubre: el mismo gate de feature flag que captura-competencia.js
// (comparten iniciativa), validaciones de alta, el scoping vendedor vs.
// dueño/admin en listar/marcar_estado, y accion=ranking_ruta (filtro por
// radio + orden por distancia mínima a cualquier parada).

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

const crearProspectoMock = vi.fn(async () => ({ data: { id: 'p1' }, error: null }));
const listarProspectosMock = vi.fn(async () => ({ data: [], error: null }));
const marcarEstadoProspectoMock = vi.fn(async () => ({ data: { id: 'p1' }, error: null }));
const obtenerMetricasProspectosMock = vi.fn(async () => ({ data: [], error: null }));
const listarProspectosActivosParaRankingMock = vi.fn(async () => ({ data: [], error: null }));
const obtenerParadasConCoordsDeRutaMock = vi.fn(async () => ({ data: [], error: null }));

vi.mock('../../lib/repos/prospectos-competencia.js', async () => {
  const real = await vi.importActual('../../lib/repos/prospectos-competencia.js');
  return {
    distanciaHaversineMetros: real.distanciaHaversineMetros,
    crearProspecto: (...args) => crearProspectoMock(...args),
    listarProspectos: (...args) => listarProspectosMock(...args),
    marcarEstadoProspecto: (...args) => marcarEstadoProspectoMock(...args),
    obtenerMetricasProspectos: (...args) => obtenerMetricasProspectosMock(...args),
    listarProspectosActivosParaRanking: (...args) => listarProspectosActivosParaRankingMock(...args),
    obtenerParadasConCoordsDeRuta: (...args) => obtenerParadasConCoordsDeRutaMock(...args),
  };
});

const { verificarToken } = await import('../../lib/auth-helpers.js');
const { default: handler } = await import('../../lib/handlers/prospectos-competencia.js');

/** Mock mínimo de req/res estilo Vercel — mismo criterio que
 * tests/handlers/captura-competencia-flag.test.js. */
function mockReqRes({ method = 'GET', query = {}, body = {} } = {}) {
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
  return { req: { method, query, body, headers: {} }, res };
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
  dbMock.from.mockReturnValue(empresaQueryConConfig({ captura_competencia_habilitada: true }));
  crearProspectoMock.mockResolvedValue({ data: { id: 'p1' }, error: null });
  listarProspectosMock.mockResolvedValue({ data: [], error: null });
  marcarEstadoProspectoMock.mockResolvedValue({ data: { id: 'p1' }, error: null });
  obtenerMetricasProspectosMock.mockResolvedValue({ data: [], error: null });
  listarProspectosActivosParaRankingMock.mockResolvedValue({ data: [], error: null });
  obtenerParadasConCoordsDeRutaMock.mockResolvedValue({ data: [], error: null });
});

describe('ex-gate del feature flag (sacado a pedido — ver captura-competencia.js)', () => {
  it('sin la clave en config, igual deja pasar (la función ya no depende del flag)', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({}));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(listarProspectosMock).toHaveBeenCalled();
  });

  it('con la clave en true, sigue dejando pasar (compatibilidad con empresas que la tenían activada)', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('accion=crear', () => {
  it('rechaza sin nombre', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'crear' }, body: { lat: 1, lng: 2 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(crearProspectoMock).not.toHaveBeenCalled();
  });

  it('rechaza sin coordenadas numéricas válidas', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'crear' }, body: { nombre: 'X', lat: 'no-numero', lng: 2 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rechaza coordenadas fuera de rango', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'crear' }, body: { nombre: 'X', lat: 200, lng: 2 } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('con datos válidos, crea con el vendedor_id del perfil autenticado', async () => {
    const { req, res } = mockReqRes({
      method: 'POST',
      query: { accion: 'crear' },
      body: { nombre: 'Almacén Don José', rubro: 'Almacén', lat: -27.46, lng: -58.99 },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(crearProspectoMock).toHaveBeenCalledWith(expect.objectContaining({
      empresa_id: 'e1', vendedor_id: 'u1', nombre: 'Almacén Don José', lat: -27.46, lng: -58.99,
    }));
  });
});

describe('accion=listar — scoping por rol', () => {
  it('vendedor: se filtra por su propio id', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });
    await handler(req, res);
    expect(listarProspectosMock).toHaveBeenCalledWith('e1', 'u1');
  });

  it('dueño/admin: sin filtro, ve la bandeja completa de la empresa', async () => {
    verificarToken.mockResolvedValueOnce({ id: 'u2', empresa_id: 'e1', rol: 'admin' });
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'listar' } });
    await handler(req, res);
    expect(listarProspectosMock).toHaveBeenCalledWith('e1', null);
  });
});

describe('accion=marcar_estado', () => {
  it('rechaza sin id', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'marcar_estado' }, body: { estado: 'visitado' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rechaza un estado fuera del enum', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'marcar_estado' }, body: { id: 'p1', estado: 'en_camino' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(marcarEstadoProspectoMock).not.toHaveBeenCalled();
  });

  it('404 si el repo no encuentra/actualiza ninguna fila (id ajeno o de otra empresa)', async () => {
    marcarEstadoProspectoMock.mockResolvedValueOnce({ data: null, error: null });
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'marcar_estado' }, body: { id: 'p1', estado: 'visitado' } });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('vendedor: la actualización queda acotada a sus propios prospectos', async () => {
    const { req, res } = mockReqRes({ method: 'POST', query: { accion: 'marcar_estado' }, body: { id: 'p1', estado: 'visita_planificada' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(marcarEstadoProspectoMock).toHaveBeenCalledWith('e1', 'p1', 'visita_planificada', { vendedor_id_filtro: 'u1', captura_id: undefined });
  });
});

describe('accion=ranking_ruta', () => {
  it('rechaza sin ruta_id', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'ranking_ruta' } });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('sin paradas con coordenadas, devuelve lista vacía sin consultar prospectos', async () => {
    obtenerParadasConCoordsDeRutaMock.mockResolvedValueOnce({ data: [], error: null });
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'ranking_ruta', ruta_id: 'r1' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.prospectos).toEqual([]);
    expect(listarProspectosActivosParaRankingMock).not.toHaveBeenCalled();
  });

  it('ordena por distancia mínima a cualquier parada y descarta lo que queda fuera del radio (500m)', async () => {
    obtenerParadasConCoordsDeRutaMock.mockResolvedValueOnce({
      data: [{ lat: -27.46, lng: -58.99 }],
      error: null,
    });
    listarProspectosActivosParaRankingMock.mockResolvedValueOnce({
      data: [
        { id: 'lejos', nombre: 'Lejos', lat: -27.60, lng: -59.10 }, // muy lejos, > 500m
        { id: 'cerca', nombre: 'Cerca', lat: -27.4605, lng: -58.9905 }, // a metros de la parada
      ],
      error: null,
    });
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'ranking_ruta', ruta_id: 'r1' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.prospectos).toHaveLength(1);
    expect(res.body.prospectos[0].id).toBe('cerca');
    expect(res.body.prospectos[0].distancia_metros).toBeLessThanOrEqual(500);
  });

  describe('radio y tope configurables por empresa (pendiente del changelog v1018)', () => {
    it('un radio más amplio en empresas.config incluye un prospecto que con el default (500m) quedaría afuera', async () => {
      dbMock.from.mockReturnValue(empresaQueryConConfig({
        captura_competencia_habilitada: true,
        captura_competencia_radio_ranking_metros: 3000, // dentro del clamp (50–5000)
      }));
      obtenerParadasConCoordsDeRutaMock.mockResolvedValueOnce({
        data: [{ lat: -27.46, lng: -58.99 }],
        error: null,
      });
      listarProspectosActivosParaRankingMock.mockResolvedValueOnce({
        data: [{ id: 'lejos', nombre: 'Lejos', lat: -27.478, lng: -58.99 }], // ~2km, > 500m del default
        error: null,
      });
      const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'ranking_ruta', ruta_id: 'r1' } });
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.prospectos).toHaveLength(1);
      expect(res.body.prospectos[0].id).toBe('lejos');
    });

    it('un tope de resultados más chico en empresas.config corta la lista antes que el default (20)', async () => {
      dbMock.from.mockReturnValue(empresaQueryConConfig({
        captura_competencia_habilitada: true,
        captura_competencia_radio_ranking_metros: 5000, // suficiente para que entren los 3
        captura_competencia_max_ranking_resultados: 2,
      }));
      obtenerParadasConCoordsDeRutaMock.mockResolvedValueOnce({
        data: [{ lat: -27.46, lng: -58.99 }],
        error: null,
      });
      listarProspectosActivosParaRankingMock.mockResolvedValueOnce({
        data: [
          { id: 'a', nombre: 'A', lat: -27.4601, lng: -58.9901 },
          { id: 'b', nombre: 'B', lat: -27.4602, lng: -58.9902 },
          { id: 'c', nombre: 'C', lat: -27.4603, lng: -58.9903 },
        ],
        error: null,
      });
      const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'ranking_ruta', ruta_id: 'r1' } });
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.prospectos).toHaveLength(2);
    });

    it('un valor de config fuera de rango (negativo, cero o absurdamente alto) cae al default en vez de romper el cálculo', async () => {
      dbMock.from.mockReturnValue(empresaQueryConConfig({
        captura_competencia_habilitada: true,
        captura_competencia_radio_ranking_metros: -100, // inválido → default (500m)
        captura_competencia_max_ranking_resultados: 999999, // fuera de rango → clamp al tope (100)
      }));
      obtenerParadasConCoordsDeRutaMock.mockResolvedValueOnce({
        data: [{ lat: -27.46, lng: -58.99 }],
        error: null,
      });
      listarProspectosActivosParaRankingMock.mockResolvedValueOnce({
        data: [
          { id: 'lejos', nombre: 'Lejos', lat: -27.60, lng: -59.10 }, // > 500m
          { id: 'cerca', nombre: 'Cerca', lat: -27.4605, lng: -58.9905 },
        ],
        error: null,
      });
      const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'ranking_ruta', ruta_id: 'r1' } });
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.prospectos).toHaveLength(1);
      expect(res.body.prospectos[0].id).toBe('cerca');
    });
  });
});

describe('accion=metricas (plan 3.5 — % de prospectos con visita/captura)', () => {
  it('sin prospectos, todo en 0 y sin división por cero', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      total_prospectos: 0,
      total_visitados: 0,
      total_con_captura: 0,
      tasa_visita_pct: 0,
      tasa_captura_pct: 0,
    });
  });

  it('calcula tasa_visita_pct (visitado + convertido) y tasa_captura_pct (captura_id no nulo) por separado', async () => {
    obtenerMetricasProspectosMock.mockResolvedValueOnce({
      data: [
        { estado: 'pendiente', captura_id: null },
        { estado: 'visita_planificada', captura_id: null },
        { estado: 'visitado', captura_id: null },
        { estado: 'visitado', captura_id: 'c1' },
        { estado: 'convertido', captura_id: 'c2' },
        { estado: 'descartado', captura_id: null },
      ],
      error: null,
    });
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total_prospectos).toBe(6);
    expect(res.body.total_visitados).toBe(3); // visitado x2 + convertido x1
    expect(res.body.total_con_captura).toBe(2);
    expect(res.body.tasa_visita_pct).toBeCloseTo(50, 5);
    expect(res.body.tasa_captura_pct).toBeCloseTo(33.3, 1);
  });

  it('vendedor: obtenerMetricasProspectos recibe su propio id como filtro (mismo scoping que listar)', async () => {
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });
    await handler(req, res);
    expect(obtenerMetricasProspectosMock).toHaveBeenCalledWith('e1', 'u1');
  });

  it('sin la clave en config, igual llega a llamar obtenerMetricasProspectos (ex-gate sacado)', async () => {
    dbMock.from.mockReturnValue(empresaQueryConConfig({}));
    const { req, res } = mockReqRes({ method: 'GET', query: { accion: 'metricas' } });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(obtenerMetricasProspectosMock).toHaveBeenCalled();
  });
});
