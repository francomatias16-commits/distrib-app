// tests/handlers/gastos-generales.test.js
//
// Hallazgo #9 (deuda técnica de bajo riesgo, documentada) — este handler
// no tenía casos propios. Cubre: gate de lectura/escritura (roles
// dueno/admin/contador leen y escriben, igual que reglas_precio; vendedor/
// depositero/chofer quedan afuera), las 5 rutas (resumen/detalle/listado/
// alta/edición/baja) y que la auditoría silenciosa se dispare con el
// recurso/acción correctos en alta, edición y baja (soft-delete).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

const reposMock = vi.hoisted(() => ({
  listarGastosGenerales: vi.fn(async () => [{ id: 'g1', descripcion: 'Alquiler' }]),
  obtenerGastoGeneral: vi.fn(async () => ({ id: 'g1', descripcion: 'Alquiler' })),
  obtenerResumenGastosGenerales: vi.fn(async () => ({ total: 1000, por_categoria: [] })),
  crearGastoGeneral: vi.fn(async () => ({ id: 'g-nuevo', descripcion: 'Luz' })),
  actualizarGastoGeneral: vi.fn(async () => ({
    antes: { descripcion: 'Luz' },
    despues: { id: 'g-nuevo', descripcion: 'Luz y gas' },
  })),
  eliminarGastoGeneral: vi.fn(async () => ({ antes: { id: 'g-nuevo', activo: true } })),
}));
vi.mock('../../lib/repos/gastos-generales.js', () => reposMock);

const auditMock = vi.hoisted(() => ({ registrarAuditoriaSilenciosa: vi.fn(async () => {}) }));
vi.mock('../../lib/repos/index.js', () => ({ AuditRepo: auditMock }));

const { default: handler } = await import('../../lib/handlers/gastos-generales.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function perfilCon(rol) {
  return { id: 'u1', empresa_id: 'e1', rol };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gate de lectura (leer: dueno/admin/contador)', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede leer (sin 401/403)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.listarGastosGenerales).toHaveBeenCalledWith('e1', expect.any(Object));
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede leer (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reposMock.listarGastosGenerales).not.toHaveBeenCalled();
  });

  it('sin token → 401', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('gate de escritura (escribir: dueno/admin/contador — mismo set que lectura en este recurso)', () => {
  it('vendedor no puede crear (403 en POST, corta ya en el gate de lectura porque tampoco lee)', async () => {
    verificarTokenMock.mockResolvedValue(perfilCon('vendedor'));
    const res = mockRes();

    await handler({ method: 'POST', query: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(reposMock.crearGastoGeneral).not.toHaveBeenCalled();
  });

  it.each(['dueno', 'admin', 'contador'])('%s puede crear (POST)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'POST', query: {}, body: { descripcion: 'Luz' } }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(reposMock.crearGastoGeneral).toHaveBeenCalledWith('e1', 'u1', { descripcion: 'Luz' });
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'e1', 'u1', 'gastos_generales', 'INSERT', 'g-nuevo', null, { id: 'g-nuevo', descripcion: 'Luz' }
    );
  });
});

describe('rutas GET', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('contador')));

  it('?_svc=resumen sin desde/hasta → 400, no llama al repo', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { _svc: 'resumen' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.obtenerResumenGastosGenerales).not.toHaveBeenCalled();
  });

  it('?_svc=resumen con desde/hasta → devuelve el resumen', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { _svc: 'resumen', desde: '2026-01-01', hasta: '2026-01-31' } }, res);

    expect(reposMock.obtenerResumenGastosGenerales).toHaveBeenCalledWith('e1', { desde: '2026-01-01', hasta: '2026-01-31' });
    expect(res.json).toHaveBeenCalledWith({ total: 1000, por_categoria: [] });
  });

  it('?id=uuid → detalle', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { id: 'g1' } }, res);

    expect(reposMock.obtenerGastoGeneral).toHaveBeenCalledWith('e1', 'g1');
    expect(res.json).toHaveBeenCalledWith({ id: 'g1', descripcion: 'Alquiler' });
  });

  it('?id=uuid inexistente → 404', async () => {
    reposMock.obtenerGastoGeneral.mockRejectedValueOnce(new Error('No encontrado'));
    const res = mockRes();
    await handler({ method: 'GET', query: { id: 'no-existe' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('sin filtros → listado completo con los query params pasados tal cual', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { activo: 'true', categoria: 'servicios' } }, res);

    expect(reposMock.listarGastosGenerales).toHaveBeenCalledWith('e1', {
      activo: 'true', categoria: 'servicios', desde: undefined, hasta: undefined, busqueda: undefined,
    });
  });
});

describe('PATCH', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('admin')));

  it('sin id → 400', async () => {
    const res = mockRes();
    await handler({ method: 'PATCH', query: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.actualizarGastoGeneral).not.toHaveBeenCalled();
  });

  it('con id → edita y audita UPDATE con antes/después', async () => {
    const res = mockRes();
    await handler({ method: 'PATCH', query: { id: 'g-nuevo' }, body: { descripcion: 'Luz y gas' } }, res);

    expect(reposMock.actualizarGastoGeneral).toHaveBeenCalledWith('e1', 'g-nuevo', { descripcion: 'Luz y gas' });
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'e1', 'u1', 'gastos_generales', 'UPDATE', 'g-nuevo', { descripcion: 'Luz' }, { id: 'g-nuevo', descripcion: 'Luz y gas' }
    );
    expect(res.json).toHaveBeenCalledWith({ id: 'g-nuevo', descripcion: 'Luz y gas' });
  });

  it('id inexistente → 404, no audita', async () => {
    reposMock.actualizarGastoGeneral.mockRejectedValueOnce(new Error('No encontrado'));
    const res = mockRes();
    await handler({ method: 'PATCH', query: { id: 'no-existe' }, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(auditMock.registrarAuditoriaSilenciosa).not.toHaveBeenCalled();
  });
});

describe('DELETE (soft-delete)', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('dueno')));

  it('sin id → 400', async () => {
    const res = mockRes();
    await handler({ method: 'DELETE', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('con id → soft-delete (activo:false) y audita UPDATE', async () => {
    const res = mockRes();
    await handler({ method: 'DELETE', query: { id: 'g-nuevo' } }, res);

    expect(reposMock.eliminarGastoGeneral).toHaveBeenCalledWith('e1', 'g-nuevo');
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'e1', 'u1', 'gastos_generales', 'UPDATE', 'g-nuevo', { id: 'g-nuevo', activo: true }, { activo: false }
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('id inexistente → 404', async () => {
    reposMock.eliminarGastoGeneral.mockRejectedValueOnce(new Error('No encontrado'));
    const res = mockRes();
    await handler({ method: 'DELETE', query: { id: 'no-existe' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

it('método no soportado → 405', async () => {
  verificarTokenMock.mockResolvedValue(perfilCon('dueno'));
  const res = mockRes();
  await handler({ method: 'PUT', query: {} }, res);

  expect(res.status).toHaveBeenCalledWith(405);
});
