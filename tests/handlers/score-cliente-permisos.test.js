// tests/handlers/score-cliente-permisos.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟠 Alto #15, resuelto en v960 pero sin
// ningún test de regresión hasta ahora. `GET /api/score?accion=cliente`
// (lib/handlers/score.js) era la única acción de este archivo sin chequeo
// de rol después de verificarToken() — a diferencia de sus hermanas
// 'alertas'/'resolver-alerta'/'reglas', que ya tenían el mismo fix por un
// hallazgo previo (comentario "FIX auditoría, etapa 12" en el propio
// código). Un cliente logueado en el portal (rol 'cliente') podía pasar el
// cliente_id de OTRO cliente de la misma empresa (no es un dato secreto —
// aparece en URLs/listados) y ver su score, límite/días de crédito y si
// recibió una oferta de plan de pago por deuda: información financiera de
// un tercero. Los repos subyacentes solo scopean por empresa_id, nunca por
// el cliente_id del que llama, así que el gate tiene que estar en el
// handler.
//
// Fix aplicado (v960): mismo gate que el resto del archivo —
// ['dueno','admin','vendedor','contador'].includes(perfil?.rol).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

vi.mock('../../lib/security-headers.js', () => ({
  aplicarHeaders: () => {},
}));

vi.mock('../../lib/handlers/_auto-push.js', () => ({
  notifAuto: vi.fn(async () => {}),
}));

const reposMock = vi.hoisted(() => ({
  historialScoreLlamadas: [],
  obtenerScoreClienteLlamadas: [],
  ultimoEnvioLlamadas: [],
}));

vi.mock('../../lib/repos/index.js', () => ({
  ScoreRepo: {
    historialScore: (empresaId, clienteId) => {
      reposMock.historialScoreLlamadas.push({ empresaId, clienteId });
      return Promise.resolve([{ fecha: '2026-08-01', score: 80 }]);
    },
  },
  ClienteRepo: {
    obtenerScoreCliente: (empresaId, clienteId) => {
      reposMock.obtenerScoreClienteLlamadas.push({ empresaId, clienteId });
      return Promise.resolve({ id: clienteId, score_actual: 80, limite_credito: 100000, dias_credito: 30 });
    },
  },
  NotifRepo: {
    ultimoEnvio: (empresaId, clienteId, tipo) => {
      reposMock.ultimoEnvioLlamadas.push({ empresaId, clienteId, tipo });
      return Promise.resolve(null);
    },
  },
  EmpresaRepo: {},
}));

const { default: handler } = await import('../../lib/handlers/score.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

const EMPRESA_1 = 'empresa-1';
const CLIENTE_AJENO = 'cliente-de-otro-empresa-o-otro-usuario';

beforeEach(() => {
  verificarTokenMock.mockReset();
  reposMock.historialScoreLlamadas = [];
  reposMock.obtenerScoreClienteLlamadas = [];
  reposMock.ultimoEnvioLlamadas = [];
});

describe('GET /api/score?accion=cliente — control de acceso (regresión hallazgo Alto #15, v960)', () => {
  it('rechaza con 401 si no hay sesión válida', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler({ method: 'GET', query: { accion: 'cliente', cliente_id: CLIENTE_AJENO }, headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(reposMock.historialScoreLlamadas).toHaveLength(0);
  });

  it('rechaza con 403 a un cliente del portal — antes no había NINGÚN chequeo de rol acá', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u-cliente', rol: 'cliente', empresa_id: EMPRESA_1 });
    const res = mockRes();

    await handler({ method: 'GET', query: { accion: 'cliente', cliente_id: CLIENTE_AJENO }, headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    // Ni siquiera debería haber llegado a consultar el score de un tercero.
    expect(reposMock.historialScoreLlamadas).toHaveLength(0);
    expect(reposMock.obtenerScoreClienteLlamadas).toHaveLength(0);
  });

  it('rechaza con 403 a un chofer (rol de menor privilegio, sin acceso a datos financieros)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u-chofer', rol: 'chofer', empresa_id: EMPRESA_1 });
    const res = mockRes();

    await handler({ method: 'GET', query: { accion: 'cliente', cliente_id: CLIENTE_AJENO }, headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('permite a un rol autorizado (vendedor) consultar, scopeado a su propia empresa', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u-vend', rol: 'vendedor', empresa_id: EMPRESA_1 });
    const res = mockRes();

    await handler({ method: 'GET', query: { accion: 'cliente', cliente_id: 'cliente-legitimo' }, headers: {} }, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.historialScoreLlamadas).toEqual([{ empresaId: EMPRESA_1, clienteId: 'cliente-legitimo' }]);
    expect(reposMock.obtenerScoreClienteLlamadas).toEqual([{ empresaId: EMPRESA_1, clienteId: 'cliente-legitimo' }]);
  });

  it('permite a dueno, admin y contador (mismo set de roles que el resto del archivo)', async () => {
    for (const rol of ['dueno', 'admin', 'contador']) {
      verificarTokenMock.mockResolvedValue({ id: `u-${rol}`, rol, empresa_id: EMPRESA_1 });
      const res = mockRes();

      await handler({ method: 'GET', query: { accion: 'cliente', cliente_id: 'c1' }, headers: {} }, res);

      expect(res.status).not.toHaveBeenCalledWith(403);
    }
  });

  it('un cliente autenticado no puede usar su propio token válido para leer el cliente_id de otro (regresión del escenario real del hallazgo)', async () => {
    // Este es exactamente el escenario documentado: un cliente logueado en
    // el portal, con sesión propia válida, pasando el cliente_id de un
    // competidor/otro cliente de la misma distribuidora.
    verificarTokenMock.mockResolvedValue({ id: 'u-cliente-legitimo', rol: 'cliente', empresa_id: EMPRESA_1 });
    const res = mockRes();

    await handler({ method: 'GET', query: { accion: 'cliente', cliente_id: CLIENTE_AJENO }, headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reposMock.ultimoEnvioLlamadas).toHaveLength(0);
  });

  it('responde 400 si falta cliente_id (validación existente, no regresión pero cierra el flujo)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u-admin', rol: 'admin', empresa_id: EMPRESA_1 });
    const res = mockRes();

    await handler({ method: 'GET', query: { accion: 'cliente' }, headers: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
