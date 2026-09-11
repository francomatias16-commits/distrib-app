// tests/handlers/catalogo-meta-permisos.test.js
//
// Cobertura nueva (v1068) para el gate de `_svc=sync-producto`
// (catalogo_meta_sync.disparar) — el único endpoint de este handler que
// NO es admin-only (empresa_config): mismos roles que pueden dar de
// alta/editar productos. El resto de las rutas (estado/conectar/
// desconectar/carga-inicial/importar) ya quedan cubiertas indirectamente
// por reusar `empresa_config`, gateado en otros handlers.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

const usuariosQueryMock = vi.hoisted(() => ({
  perfil: null, // { empresa_id, rol } — seteado por cada test
}));

const catalogoMetaRepoMock = vi.hoisted(() => ({
  obtenerProductoParaSync: vi.fn(async () => ({
    data: { id: 'p1', retailer_id: 'p1', nombre: 'Producto X', precio_base: 100, foto_url: null, activo: true },
    error: null,
  })),
  obtenerCredencialesCatalogo: vi.fn(async () => ({ data: null, error: null })), // sin catálogo conectado → 'omitido', no pega a Meta de verdad
  guardarCredencialesCatalogo: vi.fn(),
  borrarCredencialesCatalogo: vi.fn(),
  marcarSyncPush: vi.fn(async () => {}),
  marcarSyncPull: vi.fn(async () => {}),
  listarProductosParaCatalogoMeta: vi.fn(async () => ({ data: [], error: null })),
  listarProductosConRetailerId: vi.fn(async () => ({ data: [], error: null })),
  obtenerOCrearCategoriaImportadoWhatsapp: vi.fn(),
  crearProductoDesdeMeta: vi.fn(),
  actualizarProductoDesdeMeta: vi.fn(),
  listarEmpresaIdsConCatalogoConectado: vi.fn(async () => ({ data: [], error: null })),
}));

// verificarToken(req, db) usa `db` (repos/_db.js) directo, no el cliente
// lazy — solo se mockea acá el lookup de `usuarios` que necesita para
// armar el perfil.
vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    auth: authMock,
    from: (tabla) => {
      if (tabla === 'usuarios') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: usuariosQueryMock.perfil, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabla no mockeada en _db: ${tabla}`);
    },
  },
}));

vi.mock('../../lib/repos/catalogo-meta.js', () => catalogoMetaRepoMock);

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

const { default: handler } = await import('../../lib/handlers/catalogo-meta.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function reqSyncProducto() {
  return {
    method: 'POST',
    query: { _svc: 'sync-producto' },
    body: { producto_id: 'p1' },
    headers: { authorization: 'Bearer token-valido' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = null;
  catalogoMetaRepoMock.obtenerProductoParaSync.mockResolvedValue({
    data: { id: 'p1', retailer_id: 'p1', nombre: 'Producto X', precio_base: 100, foto_url: null, activo: true },
    error: null,
  });
  catalogoMetaRepoMock.obtenerCredencialesCatalogo.mockResolvedValue({ data: null, error: null });
});

describe('gate de _svc=sync-producto (catalogo_meta_sync.disparar)', () => {
  it.each(['dueno', 'admin', 'depositero'])('%s puede disparar el sync (sin 403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqSyncProducto(), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    // sin catálogo conectado (mock por default): sync se omite, pero el
    // endpoint igual responde 200 — nunca un error para el usuario.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, resultado: 'omitido' });
  });

  it.each(['vendedor', 'contador', 'chofer'])('%s NO puede disparar el sync (403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqSyncProducto(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'No tenés permiso para esta acción' });
    expect(catalogoMetaRepoMock.obtenerProductoParaSync).not.toHaveBeenCalled();
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    const res = mockRes();
    const req = { method: 'POST', query: { _svc: 'sync-producto' }, body: {}, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('sin producto_id en el body → 400', async () => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol: 'admin' };
    const res = mockRes();
    const req = { ...reqSyncProducto(), body: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('producto de otra empresa (no encontrado con ese empresa_id) → 404', async () => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol: 'admin' };
    catalogoMetaRepoMock.obtenerProductoParaSync.mockResolvedValue({ data: null, error: null });
    const res = mockRes();

    await handler(reqSyncProducto(), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('con catálogo conectado, sincroniza y marca el push', async () => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol: 'admin' };
    catalogoMetaRepoMock.obtenerCredencialesCatalogo.mockResolvedValue({
      data: { catalog_id: 'cat1', catalog_access_token: 'tok' },
      error: null,
    });
    global.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
    const res = mockRes();

    await handler(reqSyncProducto(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, resultado: 'ok' });
    expect(catalogoMetaRepoMock.marcarSyncPush).toHaveBeenCalledWith('e1');
  });
});

describe('gate de _svc=importar-cron (CRON_SECRET, fail-closed)', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'secreto-test';
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalCronSecret;
  });

  it('sin CRON_SECRET configurada → 503', async () => {
    delete process.env.CRON_SECRET;
    const res = mockRes();
    const req = { method: 'GET', query: { _svc: 'importar-cron' }, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('sin el secret correcto → 401', async () => {
    const res = mockRes();
    const req = { method: 'GET', query: { _svc: 'importar-cron' }, headers: { authorization: 'Bearer incorrecto' } };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('con el secret correcto → 200, recorre empresas conectadas', async () => {
    catalogoMetaRepoMock.listarEmpresaIdsConCatalogoConectado.mockResolvedValue({ data: [], error: null });
    const res = mockRes();
    const req = { method: 'GET', query: { _svc: 'importar-cron' }, headers: { authorization: 'Bearer secreto-test' } };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, procesadas: 0 }));
  });
});
