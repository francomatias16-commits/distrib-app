// tests/repos/productos.test.js
//
// Fase 7, paso 3 — `productos` no tenía tests de repo (checklist punto 5).
// Foco en que cada función filtre por `empresa_id` donde corresponde (las
// funciones por lote de IDs — obtenerProductosPorIds, obtenerCostosPorIds —
// deliberadamente NO filtran por empresa_id porque los IDs ya vienen
// acotados a la empresa por el caller (items de una OC/recepción propia);
// obtenerProductosParaCotizarPedido y obtenerProductosParaSugerencias sí
// filtran, porque ahí el input no es de confianza al 100% (producto_id de
// un mensaje de WhatsApp / de un pedido histórico que pudo migrar de dueño).
//
// Lote 2 (migracion.js, auto-imagenes.js, stock.js) agrega funciones con
// distintas políticas de error a propósito — cada test lo deja explícito
// en su descripción para que quede documentado el porqué, no solo el qué.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  existeProductoParaEmpresa,
  listarProductosConStockMinimo,
  buscarProductos,
  obtenerProductosPorIds,
  obtenerCostosPorIds,
  obtenerProductosParaCotizarPedido,
  listarCodigosProductosPorEmpresa,
  listarProductosSinFoto,
  actualizarFotoProducto,
  contarProductosSinFoto,
  buscarIdsProductos,
  perteneceProductoAEmpresa,
  obtenerProductosParaSugerencias,
  obtenerNombreProducto,
  obtenerProductosParaValidarPedido,
  obtenerProductosParaCotizarConCosto,
  buscarProductosParaRemito,
  obtenerProveedorDefaultPorProductos,
  buscarProductosPos,
  obtenerCategoriasDeProductos,
  obtenerProductosParaVentaPos,
  listarProductosActivosParaAlertaStock,
} = await import('../../lib/repos/productos.js');

// Mismo query builder falso que tests/repos/empresas.test.js.
function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq:     vi.fn(() => obj),
    in:     vi.fn(() => obj),
    or:     vi.fn(() => obj),
    gt:     vi.fn(() => obj),
    limit:  vi.fn(() => obj),
    not:    vi.fn(() => obj),
    is:     vi.fn(() => obj),
    order:  vi.fn(() => obj),
    update: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

describe('existeProductoParaEmpresa', () => {
  it('filtra por empresa_id y devuelve true si hay al menos un producto', async () => {
    const query = fakeQuery({ data: [{ id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const existe = await existeProductoParaEmpresa('empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('productos');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(existe).toBe(true);
  });

  it('devuelve false si la empresa no tiene productos cargados', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: [], error: null }));

    expect(await existeProductoParaEmpresa('empresa-vacia')).toBe(false);
  });

  it('devuelve false (no explota) si la query no trae data', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await existeProductoParaEmpresa('empresa-1')).toBe(false);
  });
});

describe('listarProductosConStockMinimo', () => {
  it('filtra por empresa_id y activo=true, SIN filtrar por stock_minimo (FIX UI-005: si no se trae acá el producto con stock_minimo=0/null, el handler nunca puede aplicarle el umbral por defecto)', async () => {
    const fila = { id: 'p1', nombre: 'Aceite', unidad: 'un', stock_minimo: 5 };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarProductosConStockMinimo('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.gt).not.toHaveBeenCalled();
    expect(data).toEqual([fila]);
  });

  it('lanza si la query falla (a diferencia de existeProductoParaEmpresa, acá sí importa detectar el error)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'connection reset' } }));

    await expect(listarProductosConStockMinimo('empresa-1')).rejects.toThrow(
      '[ProductosRepo.listarConStockMinimo] connection reset',
    );
  });
});

describe('buscarProductos', () => {
  it('filtra por empresa_id + activo y arma el or() de código/nombre con el like recibido', async () => {
    const query = fakeQuery({ data: [{ id: 'p1', codigo: 'A1', nombre: 'Aceite', unidad: 'un' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await buscarProductos('empresa-1', { like: '%aceite%', limit: 5 });

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.or).toHaveBeenCalledWith('codigo.ilike.%aceite%,nombre.ilike.%aceite%');
    expect(query.limit).toHaveBeenCalledWith(5);
    expect(data).toHaveLength(1);
  });

  it('nunca devuelve productos de otra empresa aunque el or() matchee texto libre', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await buscarProductos('empresa-1', { like: '%x%' });

    // El filtro de empresa_id va antes del or() en la cadena real; acá lo
    // que importa es que .eq('empresa_id', ...) efectivamente se llamó,
    // no el orden de los mocks.
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('obtenerProductosPorIds', () => {
  it('devuelve [] sin consultar la base si no hay ids', async () => {
    const data = await obtenerProductosPorIds([]);

    expect(dbMock.from).not.toHaveBeenCalled();
    expect(data).toEqual([]);
  });

  it('consulta por lote de ids y trae id/nombre/codigo', async () => {
    const fila = { id: 'p1', nombre: 'Aceite', codigo: 'A1' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProductosPorIds(['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(data).toEqual([fila]);
  });
});

describe('obtenerCostosPorIds', () => {
  it('devuelve [] sin consultar la base si no hay ids', async () => {
    const data = await obtenerCostosPorIds(undefined);

    expect(dbMock.from).not.toHaveBeenCalled();
    expect(data).toEqual([]);
  });

  it('consulta por lote de ids y trae id/costo/nombre', async () => {
    const fila = { id: 'p1', costo: 50, nombre: 'Aceite' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerCostosPorIds(['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(data).toEqual([fila]);
  });
});

describe('obtenerProductosParaCotizarPedido', () => {
  it('filtra por ids Y por empresa_id — es el guard de "el producto es de esta empresa"', async () => {
    const fila = { id: 'p1', precio_base: 100, iva: 21 };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProductosParaCotizarPedido('empresa-1', ['p1', 'p2']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1', 'p2']);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual([fila]);
  });

  it('devuelve menos filas que ids pedidos si alguno no pertenece a la empresa (el caller corta el flujo)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: [{ id: 'p1', precio_base: 100, iva: 21 }], error: null }));

    const data = await obtenerProductosParaCotizarPedido('empresa-1', ['p1', 'producto-de-otra-empresa']);

    expect(data).toHaveLength(1);
  });

  it('devuelve data crudo (posiblemente undefined) sin lanzar si la query falla — comportamiento replicado tal cual del handler original', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: undefined, error: { message: 'timeout' } }));

    await expect(obtenerProductosParaCotizarPedido('empresa-1', ['p1'])).resolves.toBeUndefined();
  });
});

// ── Lote 2 (migracion.js, auto-imagenes.js, stock.js) ──────────────────────

describe('listarCodigosProductosPorEmpresa', () => {
  it('filtra por empresa_id y trae id/codigo', async () => {
    const fila = { id: 'p1', codigo: 'A1' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarCodigosProductosPorEmpresa('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual([fila]);
  });

  it('lanza si la query falla (usado por migracion.js — mejor cortar que mapear mal un producto)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'connection reset' } }));

    await expect(listarCodigosProductosPorEmpresa('empresa-1')).rejects.toThrow(
      '[ProductosRepo.listarCodigosPorEmpresa] connection reset',
    );
  });
});

describe('listarProductosSinFoto', () => {
  it('filtra por empresa_id, activo y foto_url null, con order y limit', async () => {
    const query = fakeQuery({ data: [{ id: 'p1', codigo: 'A1', nombre: 'Aceite' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarProductosSinFoto('empresa-1', { limit: 20 });

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.is).toHaveBeenCalledWith('foto_url', null);
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(query.not).not.toHaveBeenCalled();
    expect(data).toHaveLength(1);
  });

  it('aplica el .not() de exclusión solo si vienen excluirIds (evita repetir el mismo producto en la corrida)', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarProductosSinFoto('empresa-1', { limit: 20, excluirIds: ['p1', 'p2'] });

    expect(query.not).toHaveBeenCalledWith('id', 'in', '(p1,p2)');
  });

  it('lanza si la query falla, para que el handler responda el 500 con mensaje propio', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    await expect(listarProductosSinFoto('empresa-1', { limit: 20 })).rejects.toThrow(
      '[ProductosRepo.listarSinFoto] timeout',
    );
  });
});

describe('actualizarFotoProducto', () => {
  it('actualiza foto_url y foto_fuente filtrando por id del producto', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarFotoProducto('p1', { foto_url: 'https://cdn/x.webp', foto_fuente: 'serper' });

    expect(query.update).toHaveBeenCalledWith({ foto_url: 'https://cdn/x.webp', foto_fuente: 'serper' });
    expect(query.eq).toHaveBeenCalledWith('id', 'p1');
  });

  it('manda foto_fuente null si no viene fuente', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarFotoProducto('p1', { foto_url: 'https://cdn/x.webp' });

    expect(query.update).toHaveBeenCalledWith({ foto_url: 'https://cdn/x.webp', foto_fuente: null });
  });

  it('lanza si el update falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'row not found' } }));

    await expect(actualizarFotoProducto('p1', { foto_url: 'x' })).rejects.toThrow(
      '[ProductosRepo.actualizarFoto] row not found',
    );
  });
});

describe('contarProductosSinFoto', () => {
  it('filtra por empresa_id, activo y foto_url null, y devuelve el count', async () => {
    const query = fakeQuery({ count: 7, error: null });
    dbMock.from.mockReturnValue(query);

    const restantes = await contarProductosSinFoto('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.is).toHaveBeenCalledWith('foto_url', null);
    expect(restantes).toBe(7);
  });

  it('devuelve 0 (no null/undefined) si count viene vacío', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ count: null, error: null }));

    expect(await contarProductosSinFoto('empresa-1')).toBe(0);
  });
});

describe('buscarIdsProductos', () => {
  it('filtra por empresa_id + activo y arma el or() de nombre/codigo', async () => {
    const query = fakeQuery({ data: [{ id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await buscarIdsProductos('empresa-1', 'aceite');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.or).toHaveBeenCalledWith('nombre.ilike.%aceite%,codigo.ilike.%aceite%');
    expect(data).toEqual([{ id: 'p1' }]);
  });

  it('devuelve [] (no lanza) si la query falla — igual que el query directo original, que ignoraba error', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await buscarIdsProductos('empresa-1', 'x')).toEqual([]);
  });
});

describe('perteneceProductoAEmpresa', () => {
  it('filtra por id Y por empresa_id — es el guard anti cross-tenant al cargar un lote de stock', async () => {
    const query = fakeQuery({ data: { id: 'p1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const existe = await perteneceProductoAEmpresa('p1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'p1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(existe).toBe(true);
  });

  it('devuelve false si el producto es de otra empresa (o no existe)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    expect(await perteneceProductoAEmpresa('producto-ajeno', 'empresa-1')).toBe(false);
  });

  it('devuelve false (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await perteneceProductoAEmpresa('p1', 'empresa-1')).toBe(false);
  });
});

describe('obtenerProductosParaSugerencias', () => {
  it('filtra por ids, empresa_id y activo', async () => {
    const fila = { id: 'p1', nombre: 'Aceite', precio_base: 100 };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProductosParaSugerencias('empresa-1', ['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(data).toEqual([fila]);
  });

  it('propaga el error crudo (no envuelto) para que el handler loguee el objeto completo', async () => {
    const errorOriginal = { message: 'connection reset', code: 'ECONNRESET' };
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: errorOriginal }));

    await expect(obtenerProductosParaSugerencias('empresa-1', ['p1'])).rejects.toBe(errorOriginal);
  });
});

// ── pedidos.js (Fase 7, paso 6 — sub-módulo productos) ──────────────────────

describe('obtenerNombreProducto', () => {
  it('devuelve el nombre del producto', async () => {
    const query = fakeQuery({ data: { nombre: 'Aceite 1L' }, error: null });
    dbMock.from.mockReturnValue(query);

    const nombre = await obtenerNombreProducto('p1');

    expect(query.eq).toHaveBeenCalledWith('id', 'p1');
    expect(nombre).toBe('Aceite 1L');
  });

  it('devuelve null (no lanza) si la query falla — el caller cae al fallback del producto_id crudo', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await obtenerNombreProducto('p1')).toBeNull();
  });
});

describe('obtenerProductosParaValidarPedido', () => {
  it('filtra por ids y por empresa_id, trae nombre además de precio/iva', async () => {
    const fila = { id: 'p1', nombre: 'Aceite', precio_base: 100, iva: 21 };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProductosParaValidarPedido('empresa-1', ['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual([fila]);
  });

  it('devuelve data crudo (posiblemente undefined) sin lanzar si la query falla — mismo criterio que obtenerProductosParaCotizarPedido', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: undefined, error: { message: 'timeout' } }));

    await expect(obtenerProductosParaValidarPedido('empresa-1', ['p1'])).resolves.toBeUndefined();
  });
});

describe('obtenerProductosParaCotizarConCosto', () => {
  it('filtra por ids y empresa_id, trae costo además de precio_base/iva', async () => {
    const fila = { id: 'p1', precio_base: 100, iva: 21, costo: 60 };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProductosParaCotizarConCosto('empresa-1', ['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual([fila]);
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await obtenerProductosParaCotizarConCosto('empresa-1', ['p1'])).toEqual([]);
  });
});

describe('buscarProductosParaRemito', () => {
  it('filtra por empresa_id + activo, ordena por nombre y limita a 200', async () => {
    const query = fakeQuery({ data: [{ id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await buscarProductosParaRemito('empresa-1', {});

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.order).toHaveBeenCalledWith('nombre');
    expect(query.limit).toHaveBeenCalledWith(200);
    expect(query.or).not.toHaveBeenCalled();
    expect(data).toEqual([{ id: 'p1' }]);
  });

  it('aplica el or() de texto libre solo si viene busqueda', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await buscarProductosParaRemito('empresa-1', { busqueda: 'aceite' });

    expect(query.or).toHaveBeenCalledWith('nombre.ilike.%aceite%,codigo.ilike.%aceite%');
  });

  it('lanza (error crudo) si la query falla, para que el handler responda errorSeguro', async () => {
    const errorOriginal = { message: 'timeout' };
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: errorOriginal }));

    await expect(buscarProductosParaRemito('empresa-1', {})).rejects.toBe(errorOriginal);
  });
});

describe('obtenerProveedorDefaultPorProductos', () => {
  it('consulta por lote de ids y trae id/nombre/proveedor_id_default', async () => {
    const fila = { id: 'p1', nombre: 'Aceite', proveedor_id_default: 'prov-1' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProveedorDefaultPorProductos(['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(data).toEqual([fila]);
  });

  it('devuelve [] (no lanza) si la query falla — los ítems caen al camino "sin proveedor por defecto", ya manejado', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await obtenerProveedorDefaultPorProductos(['p1'])).toEqual([]);
  });
});

// ── pos.js (Fase 7, paso 6 — sub-módulo productos) ───────────────────────────

describe('buscarProductosPos', () => {
  it('filtra siempre por empresa_id + activo, sin filtros extra si no se pasan', async () => {
    const query = fakeQuery({ data: [{ id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await buscarProductosPos('empresa-1', {});

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.eq).not.toHaveBeenCalledWith('vendido_por_peso', true);
    expect(query.eq).not.toHaveBeenCalledWith('codigo', expect.anything());
    expect(query.or).not.toHaveBeenCalled();
    expect(query.limit).not.toHaveBeenCalled();
    expect(data).toEqual([{ id: 'p1' }]);
  });

  it('modo balanza: agrega eq(vendido_por_peso) + eq(codigo) + limit', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await buscarProductosPos('empresa-1', { vendidoPorPeso: true, codigo: '01234', limit: 1 });

    expect(query.eq).toHaveBeenCalledWith('vendido_por_peso', true);
    expect(query.eq).toHaveBeenCalledWith('codigo', '01234');
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('modo texto libre: agrega or() de codigo/nombre ilike', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await buscarProductosPos('empresa-1', { textoLibre: '%aceite%', limit: 20 });

    expect(query.or).toHaveBeenCalledWith('codigo.ilike.%aceite%,nombre.ilike.%aceite%');
    expect(query.limit).toHaveBeenCalledWith(20);
  });

  it('lanza (error crudo) si la query falla, para que el handler responda errorSeguro', async () => {
    const errorOriginal = { message: 'timeout' };
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: errorOriginal }));

    await expect(buscarProductosPos('empresa-1', {})).rejects.toBe(errorOriginal);
  });
});

describe('obtenerCategoriasDeProductos', () => {
  it('trae id/categoria_id por lote de ids', async () => {
    const fila = { id: 'p1', categoria_id: 'cat-1' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerCategoriasDeProductos(['p1']);

    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(data).toEqual([fila]);
  });

  it('devuelve [] sin consultar si no vienen ids', async () => {
    expect(await obtenerCategoriasDeProductos([])).toEqual([]);
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await obtenerCategoriasDeProductos(['p1'])).toEqual([]);
  });
});

describe('obtenerProductosParaVentaPos', () => {
  it('filtra por empresa_id + ids, trae nombre/precio_base/iva/activo', async () => {
    const fila = { id: 'p1', nombre: 'Aceite', precio_base: 100, iva: 21, activo: true };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerProductosParaVentaPos('empresa-1', ['p1']);

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.in).toHaveBeenCalledWith('id', ['p1']);
    expect(data).toEqual([fila]);
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await obtenerProductosParaVentaPos('empresa-1', ['p1'])).toEqual([]);
  });
});

describe('listarProductosActivosParaAlertaStock', () => {
  it('filtra por empresa_id + activo, ordena por nombre y limita a 500', async () => {
    const query = fakeQuery({ data: [{ id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarProductosActivosParaAlertaStock('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(query.order).toHaveBeenCalledWith('nombre');
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(data).toEqual([{ id: 'p1' }]);
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarProductosActivosParaAlertaStock('empresa-1')).toEqual([]);
  });
});
