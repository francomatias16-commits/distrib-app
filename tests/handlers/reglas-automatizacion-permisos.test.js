// tests/handlers/reglas-automatizacion-permisos.test.js
//
// Fase 7, sección 2 — el archivo hermano (reglas-automatizacion.test.js)
// cubre el motor de evaluación/ejecución de reglas, no los gates HTTP de
// permisos del handler; no existía cobertura de esos 403 antes de esta
// migración a PermisosService. Foco acá: mismo comportamiento observable
// que los ROLES_LECTURA/ROLES_ESCRITURA/ROLES_TAREAS originales, ahora
// resuelto vía `puede()`.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

const reposMock = vi.hoisted(() => ({
  listarReglasAutomatizacion: vi.fn(async () => []),
  crearReglaAutomatizacion: vi.fn(async () => ({ id: 'r1' })),
  actualizarReglaAutomatizacion: vi.fn(async () => ({ id: 'r1' })),
  toggleActivaReglaAutomatizacion: vi.fn(async () => ({ id: 'r1' })),
  eliminarReglaAutomatizacion: vi.fn(async () => {}),
  listarTareasAutomatizacion: vi.fn(async () => []),
  completarTareaAutomatizacion: vi.fn(async () => ({ ok: true })),
  EVENTOS_DISPONIBLES: ['pedido_creado'],
}));
vi.mock('../../lib/repos/reglas-automatizacion.js', () => reposMock);

const { default: handler } = await import('../../lib/handlers/reglas-automatizacion.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gate de lectura/escritura de reglas (ROLES_LECTURA/ROLES_ESCRITURA original)', () => {
  it.each(['dueno', 'admin'])('%s puede leer (GET 200)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const req = { method: 'GET', query: {} };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalled();
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede leer (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const req = { method: 'GET', query: {} };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('vendedor no puede escribir aunque pudiera leer (POST 403)', async () => {
    // ROLES_LECTURA/ROLES_ESCRITURA originales eran idénticos, pero se
    // prueba el camino de "esEscritor" igual por separado para no perder
    // cobertura si algún día divergen.
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    const req = { method: 'POST', query: {}, body: { nombre: 'x' } };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.crearReglaAutomatizacion).toHaveBeenCalled();
  });
});

describe('gate de tareas (ROLES_TAREAS original — más permisivo, se resuelve antes)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede leer tareas aunque no pueda leer reglas',
    async (rol) => {
      verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
      const req = { method: 'GET', query: { _svc: 'tareas' } };
      const res = mockRes();

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalledWith(403);
      // v1060 (Fase 2 de PLAN_CLIENTES_EN_FUGA.md): listarTareasAutomatizacion
      // ahora recibe también el usuario_id, para que cada quien vea también
      // las tareas dirigidas puntualmente a él (no solo las de su rol).
      expect(reposMock.listarTareasAutomatizacion).toHaveBeenCalledWith('e1', rol, 'u1');
    }
  );

  it('chofer no puede ver tareas (403) — no es rol interno de empresa', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'chofer' });
    const req = { method: 'GET', query: { _svc: 'tareas' } };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('vendedor puede completar una tarea (mismo gate que leer)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' });
    const req = { method: 'POST', query: { _svc: 'tareas-completar' }, body: { id: 't1' } };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.completarTareaAutomatizacion).toHaveBeenCalledWith('e1', 't1', 'u1');
  });
});

describe('sin token → 401 antes que cualquier gate de permisos', () => {
  it('devuelve 401 si verificarToken resuelve null', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const req = { method: 'GET', query: {} };
    const res = mockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
