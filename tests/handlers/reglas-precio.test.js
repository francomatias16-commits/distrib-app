// tests/handlers/reglas-precio.test.js
//
// Hallazgo #9 — sin casos propios. Cubre: gate de lectura (dueno/admin/
// contador/vendedor) vs. escritura (dueno/admin/contador, sin vendedor —
// el caso interesante de este handler porque, a diferencia de
// gastos_generales/maestros, lectura y escritura NO tienen el mismo set),
// la precedencia de ?_svc=toggle sobre el POST de alta genérico, y las
// 5 rutas.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false,
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

const reposMock = vi.hoisted(() => ({
  listarReglasPrecio: vi.fn(async () => [{ id: 'r1', nombre: '2x1 fin de semana' }]),
  crearReglaPrecio: vi.fn(async () => ({ id: 'r-nueva', nombre: 'Descuento mayorista' })),
  actualizarReglaPrecio: vi.fn(async () => ({ id: 'r1', nombre: 'Editada' })),
  toggleActivaReglaPrecio: vi.fn(async () => ({ id: 'r1', activa: false })),
  eliminarReglaPrecio: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../lib/repos/reglas-precio.js', () => reposMock);

const { default: handler } = await import('../../lib/handlers/reglas-precio.js');

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

describe('gate de lectura (leer: dueno/admin/contador/vendedor)', () => {
  it.each(['dueno', 'admin', 'contador', 'vendedor'])('%s puede leer', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.listarReglasPrecio).toHaveBeenCalledWith('e1', { activa: undefined, busqueda: undefined });
  });

  it.each(['depositero', 'chofer'])('%s NO puede leer (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('sin token → 401', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('gate de escritura (escribir: dueno/admin/contador — vendedor lee pero NO escribe)', () => {
  it('vendedor puede leer (GET) pero no crear (POST): 403, no llama al repo', async () => {
    verificarTokenMock.mockResolvedValue(perfilCon('vendedor'));
    const resGet = mockRes();
    await handler({ method: 'GET', query: {} }, resGet);
    expect(resGet.status).not.toHaveBeenCalledWith(403);

    const resPost = mockRes();
    await handler({ method: 'POST', query: {}, body: { nombre: 'x' } }, resPost);

    expect(resPost.status).toHaveBeenCalledWith(403);
    expect(reposMock.crearReglaPrecio).not.toHaveBeenCalled();
  });

  it.each(['dueno', 'admin', 'contador'])('%s puede crear (POST)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'POST', query: {}, body: { nombre: 'Descuento mayorista' } }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(reposMock.crearReglaPrecio).toHaveBeenCalledWith('e1', { nombre: 'Descuento mayorista' });
  });
});

describe('rutas de escritura', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('admin')));

  it('POST ?_svc=toggle tiene precedencia sobre el alta genérica — no llama a crearReglaPrecio', async () => {
    const res = mockRes();
    await handler({ method: 'POST', query: { _svc: 'toggle' }, body: { id: 'r1', activa: false } }, res);

    expect(reposMock.toggleActivaReglaPrecio).toHaveBeenCalledWith('e1', 'r1', false);
    expect(reposMock.crearReglaPrecio).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ id: 'r1', activa: false });
  });

  it('POST ?_svc=toggle sin id → 400', async () => {
    const res = mockRes();
    await handler({ method: 'POST', query: { _svc: 'toggle' }, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.toggleActivaReglaPrecio).not.toHaveBeenCalled();
  });

  it('PATCH sin id → 400', async () => {
    const res = mockRes();
    await handler({ method: 'PATCH', query: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.actualizarReglaPrecio).not.toHaveBeenCalled();
  });

  it('PATCH con id (en query) → edita', async () => {
    const res = mockRes();
    await handler({ method: 'PATCH', query: { id: 'r1' }, body: { nombre: 'Editada' } }, res);

    expect(reposMock.actualizarReglaPrecio).toHaveBeenCalledWith('e1', 'r1', { nombre: 'Editada' });
    expect(res.json).toHaveBeenCalledWith({ id: 'r1', nombre: 'Editada' });
  });

  it('DELETE sin id → 400', async () => {
    const res = mockRes();
    await handler({ method: 'DELETE', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.eliminarReglaPrecio).not.toHaveBeenCalled();
  });

  it('DELETE con id → elimina', async () => {
    const res = mockRes();
    await handler({ method: 'DELETE', query: { id: 'r1' } }, res);

    expect(reposMock.eliminarReglaPrecio).toHaveBeenCalledWith('e1', 'r1');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

it('método no soportado → 405', async () => {
  verificarTokenMock.mockResolvedValue(perfilCon('dueno'));
  const res = mockRes();
  await handler({ method: 'PUT', query: {} }, res);

  expect(res.status).toHaveBeenCalledWith(405);
});
