// tests/handlers/catalogo-meta-reconciliacion.test.js
//
// FIX-DUP-01: antes de este fix, una empresa que ya tenía productos
// cargados de ambos lados (su catálogo de WhatsApp Y su panel, sin
// relación entre sí) terminaba con TODO duplicado al conectar: el pull
// creaba un producto nuevo en el panel por cada ítem de Meta que no
// matcheaba por retailer_id, y el push mandaba cada producto del panel
// como ítem nuevo a Meta. Esta suite cubre:
//   1) los helpers puros de matching (normalizarNombreProducto,
//      emparejarPorNombre) de forma aislada;
//   2) importarCatalogoDeEmpresa (vía handleImportarDesdeMeta): un ítem
//      de Meta sin match por retailer_id se vincula por nombre a un
//      producto del panel sin duplicar, y un nombre ambiguo NO se
//      auto-vincula;
//   3) handleCargaInicial: un producto del panel sin foto pero que
//      matchea por nombre a un ítem YA existente en Meta se vincula y se
//      sube igual (no se omite por falta de foto, porque no está creando
//      un ítem nuevo).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const authMock = vi.hoisted(() => ({ getUser: vi.fn() }));
const usuariosQueryMock = vi.hoisted(() => ({ perfil: null }));

const catalogoMetaRepoMock = vi.hoisted(() => ({
  obtenerCredencialesCatalogo: vi.fn(),
  guardarCredencialesCatalogo: vi.fn(),
  borrarCredencialesCatalogo: vi.fn(),
  marcarSyncPush: vi.fn(async () => {}),
  marcarSyncPull: vi.fn(async () => {}),
  listarProductosParaCatalogoMeta: vi.fn(),
  listarProductosConRetailerId: vi.fn(),
  obtenerOCrearCategoriaImportadoWhatsapp: vi.fn(async () => 'cat-importado'),
  crearProductoDesdeMeta: vi.fn(async () => ({ error: null })),
  actualizarProductoDesdeMeta: vi.fn(async () => ({ error: null })),
  obtenerProductoParaSync: vi.fn(),
  listarEmpresaIdsConCatalogoConectado: vi.fn(async () => ({ data: [], error: null })),
}));

vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    auth: authMock,
    from: (tabla) => {
      if (tabla !== 'usuarios') throw new Error(`tabla no mockeada en _db: ${tabla}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: usuariosQueryMock.perfil, error: null }),
            }),
          }),
        }),
      };
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://x/img.jpg' } }) }) },
  },
}));

vi.mock('../../lib/repos/catalogo-meta.js', () => catalogoMetaRepoMock);
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => async () => false }));

const handlerModule = await import('../../lib/handlers/catalogo-meta.js');
const { default: handler, normalizarNombreProducto, emparejarPorNombre } = handlerModule;

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function metaListResponse(items) {
  return { ok: true, json: async () => ({ data: items, paging: {} }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = { empresa_id: 'e1', rol: 'admin' };
  catalogoMetaRepoMock.obtenerCredencialesCatalogo.mockResolvedValue({
    data: { catalog_id: 'cat1', catalog_access_token: 'tok' },
    error: null,
  });
});

describe('normalizarNombreProducto', () => {
  it('ignora mayúsculas, tildes y espacios repetidos', () => {
    expect(normalizarNombreProducto('  Coca-Cola  2L  ')).toBe('coca-cola 2l');
    expect(normalizarNombreProducto('Jabón Común')).toBe('jabon comun');
    expect(normalizarNombreProducto('')).toBe('');
    expect(normalizarNombreProducto(null)).toBe('');
  });
});

describe('emparejarPorNombre', () => {
  it('matchea 1-a-1 sin ambigüedad', () => {
    const productos = [{ id: 'p1', nombre: 'Coca Cola 2L' }];
    const items = [{ retailer_id: 'wa-1', name: 'coca cola 2l' }];

    const { matches, ambiguos } = emparejarPorNombre(productos, items);

    expect(matches).toEqual([{ producto: productos[0], metaItem: items[0] }]);
    expect(ambiguos).toEqual([]);
  });

  it('no matchea si no hay ningún nombre en común', () => {
    const { matches, ambiguos } = emparejarPorNombre(
      [{ id: 'p1', nombre: 'Coca Cola 2L' }],
      [{ retailer_id: 'wa-1', name: 'Sprite 2L' }]
    );
    expect(matches).toEqual([]);
    expect(ambiguos).toEqual([]);
  });

  it('dos productos del panel con el mismo nombre → ambiguo, no se auto-vincula', () => {
    const productos = [
      { id: 'p1', nombre: 'Pan Lactal' },
      { id: 'p2', nombre: 'Pan Lactal' },
    ];
    const items = [{ retailer_id: 'wa-1', name: 'Pan Lactal' }];

    const { matches, ambiguos } = emparejarPorNombre(productos, items);

    expect(matches).toEqual([]);
    expect(ambiguos).toEqual([{ nombre: 'Pan Lactal', candidatos_panel: 2, candidatos_whatsapp: 1 }]);
  });

  it('dos ítems de Meta con el mismo nombre → ambiguo, no se auto-vincula', () => {
    const productos = [{ id: 'p1', nombre: 'Fideos 500g' }];
    const items = [
      { retailer_id: 'wa-1', name: 'Fideos 500g' },
      { retailer_id: 'wa-2', name: 'Fideos 500g' },
    ];

    const { matches, ambiguos } = emparejarPorNombre(productos, items);

    expect(matches).toEqual([]);
    expect(ambiguos[0]).toMatchObject({ candidatos_panel: 1, candidatos_whatsapp: 2 });
  });
});

describe('importar (pull): vincula por nombre en vez de duplicar', () => {
  function reqImportar() {
    return { method: 'POST', query: { _svc: 'importar' }, headers: { authorization: 'Bearer tok' } };
  }

  it('un ítem de Meta sin match por retailer_id se vincula a un producto del panel con el mismo nombre (no crea uno nuevo)', async () => {
    catalogoMetaRepoMock.listarProductosConRetailerId.mockResolvedValue({
      data: [{ id: 'p1', retailer_id: 'p1', nombre: 'Coca Cola 2L', precio_base: 100, foto_url: null }],
      error: null,
    });
    global.fetch = vi.fn(async () =>
      metaListResponse([{ id: 'wa-1', retailer_id: 'wa-1', name: 'Coca Cola 2L', price: '150.00 ARS', availability: 'in stock' }])
    );

    const res = mockRes();
    await handler(reqImportar(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.importados).toBe(0); // no se creó un producto nuevo
    expect(body.vinculados).toBe(1);
    expect(body.actualizados).toBe(0);

    // Se persiste el retailer_id real de Meta en el producto existente.
    expect(catalogoMetaRepoMock.actualizarProductoDesdeMeta).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ retailer_id: 'wa-1', precio_base: 150 })
    );
    expect(catalogoMetaRepoMock.crearProductoDesdeMeta).not.toHaveBeenCalled();
  });

  it('nombre ambiguo (2 productos del panel con el mismo nombre) → no se auto-vincula, se reporta como aviso, y el ítem se importa como nuevo', async () => {
    catalogoMetaRepoMock.listarProductosConRetailerId.mockResolvedValue({
      data: [
        { id: 'p1', retailer_id: 'p1', nombre: 'Pan Lactal', precio_base: 100, foto_url: null },
        { id: 'p2', retailer_id: 'p2', nombre: 'Pan Lactal', precio_base: 100, foto_url: null },
      ],
      error: null,
    });
    global.fetch = vi.fn(async () =>
      metaListResponse([{ id: 'wa-1', retailer_id: 'wa-1', name: 'Pan Lactal', price: '200.00 ARS', availability: 'in stock' }])
    );

    const res = mockRes();
    await handler(reqImportar(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.vinculados).toBe(0);
    expect(body.importados).toBe(1); // ambiguo → se trata como si no matcheara nada, se crea nuevo
    expect(body.con_avisos).toBeGreaterThan(0);
    expect(body.detalle_avisos.some(a => /ambigü|no se vinculó/i.test(a.motivo) || /revisar manualmente/i.test(a.motivo))).toBe(true);
  });

  it('sigue matcheando por retailer_id primero cuando ya está vinculado (comportamiento previo intacto)', async () => {
    catalogoMetaRepoMock.listarProductosConRetailerId.mockResolvedValue({
      data: [{ id: 'p1', retailer_id: 'wa-1', nombre: 'Coca Cola 2L', precio_base: 100, foto_url: null }],
      error: null,
    });
    global.fetch = vi.fn(async () =>
      metaListResponse([{ id: 'wa-1', retailer_id: 'wa-1', name: 'Coca Cola 2L', price: '150.00 ARS', availability: 'in stock' }])
    );

    const res = mockRes();
    await handler(reqImportar(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.actualizados).toBe(1);
    expect(body.vinculados).toBe(0);
    expect(body.importados).toBe(0);
  });
});

describe('carga-inicial (push): vincula por nombre y no exige foto para lo ya vinculado', () => {
  function reqCargaInicial() {
    return { method: 'POST', query: { _svc: 'carga-inicial' }, headers: { authorization: 'Bearer tok' } };
  }

  it('producto del panel SIN foto que matchea por nombre a un ítem YA existente en Meta se vincula y se sube (no se omite)', async () => {
    catalogoMetaRepoMock.listarProductosParaCatalogoMeta.mockResolvedValue({
      data: [{ id: 'p1', retailer_id: 'p1', nombre: 'Coca Cola 2L', descripcion: '', precio_base: 100, foto_url: null, activo: true }],
      error: null,
    });

    global.fetch = vi
      .fn()
      // 1) listarItemsCatalogoMeta (reconciliación)
      .mockResolvedValueOnce(metaListResponse([{ id: 'wa-1', retailer_id: 'wa-1', name: 'Coca Cola 2L' }]))
      // 2) items_batch (push real)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const res = mockRes();
    await handler(reqCargaInicial(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.omitidos).toEqual([]); // no se omitió por falta de foto
    expect(body.vinculados).toEqual([{ id: 'p1', nombre: 'Coca Cola 2L', retailer_id: 'wa-1' }]);
    expect(body.enviados).toBe(1);

    // Se persistió el link antes de subir.
    expect(catalogoMetaRepoMock.actualizarProductoDesdeMeta).toHaveBeenCalledWith('p1', { retailer_id: 'wa-1' });

    // El batch real se manda apuntando al retailer_id de Meta, no al uuid propio.
    const segundoFetchBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(segundoFetchBody.requests[0].data.id).toBe('wa-1');
    expect(segundoFetchBody.requests[0].data.allow_upsert).toBe(true);
  });

  it('producto del panel SIN foto y SIN match en Meta se sigue omitiendo (comportamiento previo intacto)', async () => {
    catalogoMetaRepoMock.listarProductosParaCatalogoMeta.mockResolvedValue({
      data: [{ id: 'p1', retailer_id: 'p1', nombre: 'Producto Nuevo Sin Foto', descripcion: '', precio_base: 50, foto_url: null, activo: true }],
      error: null,
    });
    global.fetch = vi.fn().mockResolvedValueOnce(metaListResponse([])); // catálogo de Meta vacío

    const res = mockRes();
    await handler(reqCargaInicial(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.omitidos).toEqual([
      { id: 'p1', nombre: 'Producto Nuevo Sin Foto', motivo: 'sin foto (Meta exige imagen para crear un ítem nuevo)' },
    ]);
  });

  it('si falla la consulta de reconciliación a Meta, sigue la carga inicial sin reconciliar (fail-soft)', async () => {
    catalogoMetaRepoMock.listarProductosParaCatalogoMeta.mockResolvedValue({
      data: [{ id: 'p1', retailer_id: 'p1', nombre: 'Con Foto', descripcion: '', precio_base: 50, foto_url: 'https://x/foto.jpg', activo: true }],
      error: null,
    });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'boom' }) }) // falla la reconciliación
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // el push real sigue andando

    const res = mockRes();
    await handler(reqCargaInicial(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.enviados).toBe(1);
    expect(body.vinculados).toEqual([]);
  });
});
