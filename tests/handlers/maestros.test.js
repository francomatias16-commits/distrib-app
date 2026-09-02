// tests/handlers/maestros.test.js
//
// Hallazgo #9 — sin casos propios. Cubre las 4 sub-tablas (zonas/
// depositos/listas-precios/categorias) detrás de un único handler:
// el gate de ?recurso= inválido cortando ANTES de auth (no llama a
// verificarToken), lectura (dueno/admin/vendedor/depositero/contador)
// vs. escritura (solo dueno/admin — el set más restrictivo del lote),
// las 5 rutas, y que un error de negocio del repo ("No podés...")
// se mapee a 400 en vez del 500 genérico.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false,
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

const RECURSOS = {
  'zonas': { tabla: 'zonas' },
  'depositos': { tabla: 'depositos' },
  'listas-precios': { tabla: 'listas_precios' },
  'categorias': { tabla: 'categorias' },
};

const reposMock = vi.hoisted(() => ({
  RECURSOS: {
    'zonas': { tabla: 'zonas' },
    'depositos': { tabla: 'depositos' },
    'listas-precios': { tabla: 'listas_precios' },
    'categorias': { tabla: 'categorias' },
  },
  listarMaestros: vi.fn(async () => [{ id: 'z1', nombre: 'Norte' }]),
  obtenerMaestro: vi.fn(async () => ({ id: 'z1', nombre: 'Norte' })),
  crearMaestro: vi.fn(async () => ({ id: 'z-nueva', nombre: 'Sur' })),
  actualizarMaestro: vi.fn(async () => ({
    antes: { nombre: 'Sur' },
    despues: { id: 'z-nueva', nombre: 'Sur editada' },
  })),
  eliminarMaestro: vi.fn(async () => ({ antes: { id: 'z-nueva', activa: true } })),
}));
vi.mock('../../lib/repos/maestros.js', () => reposMock);

const auditMock = vi.hoisted(() => ({ registrarAuditoriaSilenciosa: vi.fn(async () => {}) }));
vi.mock('../../lib/repos/index.js', () => ({ AuditRepo: auditMock }));

const { default: handler } = await import('../../lib/handlers/maestros.js');

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
  Object.assign(reposMock.RECURSOS, RECURSOS); // por si algún test lo mutó
});

describe('gate de ?recurso= (corta antes de auth)', () => {
  it('recurso inválido → 400, ni siquiera llama a verificarToken', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { recurso: 'no-existe' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'recurso inválido. Usá: zonas, depositos, listas-precios o categorias' });
    expect(verificarTokenMock).not.toHaveBeenCalled();
  });

  it('sin recurso en query → 400, mismo gate', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(verificarTokenMock).not.toHaveBeenCalled();
  });

  it.each(['zonas', 'depositos', 'listas-precios', 'categorias'])('recurso "%s" pasa el gate (llama a verificarToken)', async (recurso) => {
    verificarTokenMock.mockResolvedValue(perfilCon('dueno'));
    const res = mockRes();
    await handler({ method: 'GET', query: { recurso } }, res);

    expect(verificarTokenMock).toHaveBeenCalled();
    expect(reposMock.listarMaestros).toHaveBeenCalledWith(recurso, 'e1', { activa: undefined });
  });
});

describe('gate de lectura (leer: dueno/admin/vendedor/depositero/contador)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])('%s puede leer', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'GET', query: { recurso: 'zonas' } }, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.listarMaestros).toHaveBeenCalled();
  });

  it('sin token → 401', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler({ method: 'GET', query: { recurso: 'zonas' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('gate de escritura (escribir: solo dueno/admin — el más restrictivo del lote)', () => {
  it.each(['vendedor', 'depositero', 'contador'])('%s puede leer pero NO escribir (403 en POST)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const resGet = mockRes();
    await handler({ method: 'GET', query: { recurso: 'zonas' } }, resGet);
    expect(resGet.status).not.toHaveBeenCalledWith(403);

    const resPost = mockRes();
    await handler({ method: 'POST', query: { recurso: 'zonas' }, body: { nombre: 'x' } }, resPost);

    expect(resPost.status).toHaveBeenCalledWith(403);
    expect(resPost.json).toHaveBeenCalledWith({ error: 'Solo dueño/admin puede modificar este dato' });
    expect(reposMock.crearMaestro).not.toHaveBeenCalled();
  });

  it.each(['dueno', 'admin'])('%s puede crear (POST)', async (rol) => {
    verificarTokenMock.mockResolvedValue(perfilCon(rol));
    const res = mockRes();

    await handler({ method: 'POST', query: { recurso: 'zonas' }, body: { nombre: 'Sur' } }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(reposMock.crearMaestro).toHaveBeenCalledWith('zonas', 'e1', { nombre: 'Sur' });
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'e1', 'u1', 'zonas', 'INSERT', 'z-nueva', null, { id: 'z-nueva', nombre: 'Sur' }
    );
  });
});

describe('rutas GET', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('contador')));

  it('sin id → listado, pasa el filtro ?activa= tal cual', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { recurso: 'depositos', activa: 'true' } }, res);

    expect(reposMock.listarMaestros).toHaveBeenCalledWith('depositos', 'e1', { activa: 'true' });
    expect(res.json).toHaveBeenCalledWith({ data: [{ id: 'z1', nombre: 'Norte' }] });
  });

  it('?id=uuid → detalle', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: { recurso: 'zonas', id: 'z1' } }, res);

    expect(reposMock.obtenerMaestro).toHaveBeenCalledWith('zonas', 'e1', 'z1');
    expect(res.json).toHaveBeenCalledWith({ id: 'z1', nombre: 'Norte' });
  });

  it('?id=uuid inexistente → 404', async () => {
    reposMock.obtenerMaestro.mockRejectedValueOnce(new Error('No encontrado'));
    const res = mockRes();
    await handler({ method: 'GET', query: { recurso: 'zonas', id: 'no-existe' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST (crear)', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('admin')));

  it('error de negocio ("Nombre requerido") → 400 vía errorSeguro, no 500', async () => {
    reposMock.crearMaestro.mockRejectedValueOnce(new Error('Nombre requerido'));
    const res = mockRes();
    await handler({ method: 'POST', query: { recurso: 'zonas' }, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(auditMock.registrarAuditoriaSilenciosa).not.toHaveBeenCalled();
  });

  it('error inesperado del repo → 500 vía errorSeguro', async () => {
    reposMock.crearMaestro.mockRejectedValueOnce(new Error('conexión perdida'));
    const res = mockRes();
    await handler({ method: 'POST', query: { recurso: 'zonas' }, body: { nombre: 'x' } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('PATCH (editar)', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('dueno')));

  it('sin id en el body → 400, no llama al repo', async () => {
    const res = mockRes();
    await handler({ method: 'PATCH', query: { recurso: 'zonas' }, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.actualizarMaestro).not.toHaveBeenCalled();
  });

  it('con id en el body → edita y audita UPDATE con antes/después', async () => {
    const res = mockRes();
    await handler({ method: 'PATCH', query: { recurso: 'zonas' }, body: { id: 'z-nueva', nombre: 'Sur editada' } }, res);

    expect(reposMock.actualizarMaestro).toHaveBeenCalledWith('zonas', 'e1', 'z-nueva', { nombre: 'Sur editada' });
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'e1', 'u1', 'zonas', 'UPDATE', 'z-nueva', { nombre: 'Sur' }, { id: 'z-nueva', nombre: 'Sur editada' }
    );
    expect(res.json).toHaveBeenCalledWith({ id: 'z-nueva', nombre: 'Sur editada' });
  });

  it('id inexistente → 404, no audita', async () => {
    reposMock.actualizarMaestro.mockRejectedValueOnce(new Error('No encontrado'));
    const res = mockRes();
    await handler({ method: 'PATCH', query: { recurso: 'zonas' }, body: { id: 'no-existe' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(auditMock.registrarAuditoriaSilenciosa).not.toHaveBeenCalled();
  });

  it('error de negocio del repo (ej. "No podés dar de baja...") → 400, no 500', async () => {
    reposMock.actualizarMaestro.mockRejectedValueOnce(
      new Error('No podés dar de baja el único registro activo. Cargá otro antes de dar de baja este.')
    );
    const res = mockRes();
    await handler({ method: 'PATCH', query: { recurso: 'depositos' }, body: { id: 'd1', activa: false } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('error de negocio del repo (ej. "Este registro está marcado como principal...") → 400, no 500', async () => {
    reposMock.actualizarMaestro.mockRejectedValueOnce(
      new Error('Este registro está marcado como principal/predeterminado. Marcá otro como principal antes de dar de baja este.')
    );
    const res = mockRes();
    await handler({ method: 'PATCH', query: { recurso: 'depositos' }, body: { id: 'd1', activa: false } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('DELETE (soft-delete)', () => {
  beforeEach(() => verificarTokenMock.mockResolvedValue(perfilCon('admin')));

  it('sin id → 400', async () => {
    const res = mockRes();
    await handler({ method: 'DELETE', query: { recurso: 'zonas' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(reposMock.eliminarMaestro).not.toHaveBeenCalled();
  });

  it('con id → soft-delete y audita UPDATE (activa:false)', async () => {
    const res = mockRes();
    await handler({ method: 'DELETE', query: { recurso: 'zonas', id: 'z-nueva' } }, res);

    expect(reposMock.eliminarMaestro).toHaveBeenCalledWith('zonas', 'e1', 'z-nueva');
    expect(auditMock.registrarAuditoriaSilenciosa).toHaveBeenCalledWith(
      'e1', 'u1', 'zonas', 'UPDATE', 'z-nueva', { id: 'z-nueva', activa: true }, { activa: false }
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('id inexistente → 404', async () => {
    reposMock.eliminarMaestro.mockRejectedValueOnce(new Error('No encontrado'));
    const res = mockRes();
    await handler({ method: 'DELETE', query: { recurso: 'zonas', id: 'no-existe' } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('error de negocio (único registro activo) → 400, no 500', async () => {
    reposMock.eliminarMaestro.mockRejectedValueOnce(
      new Error('No podés dar de baja el único registro activo. Cargá otro antes de dar de baja este.')
    );
    const res = mockRes();
    await handler({ method: 'DELETE', query: { recurso: 'zonas', id: 'z1' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

it('método no soportado, con rol escritor → 405 (no 403: el gate de escritura ya pasó)', async () => {
  verificarTokenMock.mockResolvedValue(perfilCon('dueno'));
  const res = mockRes();
  await handler({ method: 'PUT', query: { recurso: 'zonas' } }, res);

  expect(res.status).toHaveBeenCalledWith(405);
});

it('método no soportado, con rol NO escritor → 403 (el gate de escritura corta antes de llegar al 405)', async () => {
  verificarTokenMock.mockResolvedValue(perfilCon('vendedor'));
  const res = mockRes();
  await handler({ method: 'PUT', query: { recurso: 'zonas' } }, res);

  expect(res.status).toHaveBeenCalledWith(403);
});
