// tests/asistente/crear-editar-producto.test.js
//
// Fase 5 (siguiente lote, en el orden acordado): crear_producto /
// editar_producto (lib/asistente-tools/stock.js). Cubre la resolución de
// depósitos/categoría (resolverCrearProductoDesdeArgs/
// resolverEditarProductoDesdeArgs en _helpers.js) y los dos caminos de
// escritura (insert producto+stock inicial / update de campos puntuales).
//
// Mismo patrón que registrar-cobro-cliente.test.js: se mockea solo
// lib/repos/_db.js, con un router por nombre de tabla (cada tool toca
// varias tablas distintas: depositos, categorias, productos, stock).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_STOCK } = await import('../../lib/asistente-tools/stock.js');

const crearProducto = TOOLS_STOCK.find((t) => t.name === 'crear_producto');
const editarProducto = TOOLS_STOCK.find((t) => t.name === 'editar_producto');

const EMPRESA_ID = 'e1';

const DEPOSITOS = [
  { id: 'd1', nombre: 'Depósito Central' },
  { id: 'd2', nombre: 'Depósito Norte' },
  { id: 'd3', nombre: 'Depósito Norte Anexo' },
];

const CATEGORIAS = {
  Bebidas: { id: 'cat1', nombre: 'Bebidas' },
};

// Simula que en la base SOLO existe una categoría con este nombre (la
// que uno "encontró" en la búsqueda). Se usa como categoriasDisponibles
// del mockDb: si el test busca otro nombre distinto, no matchea, que es
// justo lo que necesitan los tests de "categoría que no existe".
function mockCategoriaEncontrada(nombre, id = 'catX') {
  return [{ id, nombre }];
}

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    insert: vi.fn(() => obj),
    update: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

// Router genérico: 'depositos' siempre devuelve la lista completa (así
// resuelve resolverDepositosPorNombre); 'categorias' resuelve el nombre
// realmente pedido (capturando el argumento de .ilike) contra la lista
// de categorías disponibles en el test — así "Bebidas" matchea y
// "Limpieza"/"Inexistente" no, sin necesidad de un mock por nombre;
// 'productos'/'stock' se configuran por test según qué se esté probando.
function mockDb({ categoriasDisponibles = [CATEGORIAS.Bebidas], productosInsert = null, stockInsert = null, productosUpdate = null } = {}) {
  const queries = { productos: [], stock: [] };
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'depositos') {
      return fakeQuery({ data: DEPOSITOS, error: null });
    }
    if (tabla === 'categorias') {
      const obj = {
        select: vi.fn(() => obj),
        eq: vi.fn(() => obj),
        ilike: vi.fn((_col, val) => { obj.__buscado = val; return obj; }),
        limit: vi.fn(() => obj),
        maybeSingle: vi.fn(() => {
          const buscado = String(obj.__buscado || '').trim().toLowerCase();
          const encontrada = categoriasDisponibles.find((c) => c.nombre.toLowerCase() === buscado);
          return Promise.resolve({ data: encontrada || null, error: null });
        }),
      };
      return obj;
    }
    if (tabla === 'productos') {
      const q = fakeQuery(productosInsert ?? productosUpdate ?? { data: null, error: null });
      queries.productos.push(q);
      return q;
    }
    if (tabla === 'stock') {
      const q = fakeQuery(stockInsert ?? { error: null });
      queries.stock.push(q);
      return q;
    }
    throw new Error(`tabla no mockeada en este test: ${tabla}`);
  });
  return queries;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('crear_producto — resolución de depósitos/categoría', () => {
  it('falta el nombre: rechaza sin tocar la base', async () => {
    mockDb();
    await expect(crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: '  ', depositos: ['Central'] } }))
      .rejects.toThrow('Falta el nombre del producto.');
  });

  it('falta el/los depósito(s): rechaza con mensaje concreto', async () => {
    mockDb();
    await expect(crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: [] } }))
      .rejects.toThrow('Falta indicar en qué depósito(s) va el producto nuevo.');
  });

  it('depósito que no existe: lista los disponibles en vez de fallar en silencio', async () => {
    mockDb();
    await expect(crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Sur'] } }))
      .rejects.toThrow('No encontré ningún depósito parecido a "Sur". Depósitos disponibles: Depósito Central, Depósito Norte, Depósito Norte Anexo.');
  });

  it('depósito ambiguo ("Norte" matchea dos): tira ambiguo() con .opciones, no adivina', async () => {
    mockDb();
    try {
      await crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Norte'] } });
      throw new Error('no debería llegar acá');
    } catch (err) {
      expect(err.opciones).toEqual([
        { id: 'd2', label: 'Depósito Norte' },
        { id: 'd3', label: 'Depósito Norte Anexo' },
      ]);
    }
  });

  it('"Depósito Norte" matchea EXACTO pese a que "Depósito Norte Anexo" también contiene el texto: gana el exacto', async () => {
    mockDb();
    const resumen = await crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Depósito Norte'] } });
    expect(resumen).toContain('Depósito Norte.');
    expect(resumen).not.toContain('Anexo');
  });

  it('categoría dada que no existe: mensaje concreto, no la crea sola', async () => {
    mockDb({ categoriasDisponibles: mockCategoriaEncontrada('Inexistente') });
    await expect(crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Central'], categoria: 'Limpieza' } }))
      .rejects.toThrow('No existe ninguna categoría llamada "Limpieza"');
  });
});

describe('crear_producto — resumen()', () => {
  it('con todos los opcionales: arma el texto completo', async () => {
    mockDb({ categoriasDisponibles: mockCategoriaEncontrada('Bebidas') });
    const resumen = await crearProducto.resumen({
      empresaId: EMPRESA_ID,
      args: { nombre: 'Coca Cola 1.5L', depositos: ['Central'], codigo: '7790001', categoria: 'Bebidas', precio_base: 1500, costo: 900, stock_minimo: 10 },
    });
    expect(resumen).toBe('Crear el producto "Coca Cola 1.5L" con stock inicial en cero en: Depósito Central. Código 7790001. Categoría "Bebidas". Precio $1.500. Costo $900. Stock mínimo 10.');
  });

  it('sin opcionales: solo el texto base, sin mencionar código/categoría/precio/costo/stock mínimo en $0', async () => {
    mockDb();
    const resumen = await crearProducto.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Central', 'Norte Anexo'] } });
    expect(resumen).toBe('Crear el producto "Fideos" con stock inicial en cero en: Depósito Central, Depósito Norte Anexo.');
  });
});

describe('crear_producto — execute()', () => {
  it('inserta el producto y una fila de stock en cero por cada depósito pedido', async () => {
    const queries = mockDb({
      productosInsert: { data: { id: 'p1' }, error: null },
      stockInsert: { error: null },
    });

    const res = await crearProducto.execute({
      empresaId: EMPRESA_ID,
      args: { nombre: 'Fideos', depositos: ['Central', 'Norte Anexo'], costo: 50 },
    });

    expect(res).toEqual({ ok: true, id: 'p1', nombre: 'Fideos', depositos: ['Depósito Central', 'Depósito Norte Anexo'] });

    const insertProducto = queries.productos[0];
    expect(insertProducto.insert).toHaveBeenCalledWith(expect.objectContaining({
      empresa_id: EMPRESA_ID, nombre: 'Fideos', activo: true, precio_base: 0, costo: 50, stock_minimo: 0,
    }));

    const insertStock = queries.stock[0];
    expect(insertStock.insert).toHaveBeenCalledWith([
      { producto_id: 'p1', deposito_id: 'd1', cantidad: 0, cantidad_reservada: 0, costo_promedio: 50 },
      { producto_id: 'p1', deposito_id: 'd3', cantidad: 0, cantidad_reservada: 0, costo_promedio: 50 },
    ]);
  });

  it('si falla el insert del producto: no intenta cargar stock', async () => {
    const queries = mockDb({
      productosInsert: { data: null, error: { message: 'nombre duplicado' } },
    });

    await expect(crearProducto.execute({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Central'] } }))
      .rejects.toThrow('crear_producto: nombre duplicado');
    expect(queries.stock).toHaveLength(0);
  });

  it('si falla el insert del stock inicial: el error distingue esa etapa de la del producto', async () => {
    mockDb({
      productosInsert: { data: { id: 'p1' }, error: null },
      stockInsert: { error: { message: 'fila duplicada' } },
    });

    await expect(crearProducto.execute({ empresaId: EMPRESA_ID, args: { nombre: 'Fideos', depositos: ['Central'] } }))
      .rejects.toThrow('crear_producto (stock inicial): fila duplicada');
  });
});

describe('editar_producto — resumen()', () => {
  function mockProductoEncontrado({ id = 'p1', nombre = 'Fideos' } = {}) {
    dbMock.rpc.mockResolvedValue({ data: [{ id, nombre, similitud: 1 }], error: null });
  }

  it('sin ningún cambio indicado: rechaza en vez de proponer un no-op', async () => {
    mockProductoEncontrado();
    mockDb();
    await expect(editarProducto.resumen({ empresaId: EMPRESA_ID, args: { producto: 'Fideos' } }))
      .rejects.toThrow('No indicaste ningún cambio para aplicar');
  });

  it('con varios campos a la vez: junta todos los cambios en un solo texto', async () => {
    mockProductoEncontrado();
    mockDb();
    const resumen = await editarProducto.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', precio_base: 1200, costo: 700, stock_minimo: 5, categoria: 'Bebidas' },
    });
    expect(resumen).toBe('Producto "Fideos": precio $1.200; costo $700; stock mínimo 5; categoría "Bebidas".');
  });

  it('activo:false → "darlo de baja"; activo:true → "reactivarlo"', async () => {
    mockProductoEncontrado();
    mockDb();
    const baja = await editarProducto.resumen({ empresaId: EMPRESA_ID, args: { producto: 'Fideos', activo: false } });
    expect(baja).toBe('Producto "Fideos": darlo de baja.');

    const reactivar = await editarProducto.resumen({ empresaId: EMPRESA_ID, args: { producto: 'Fideos', activo: true } });
    expect(reactivar).toBe('Producto "Fideos": reactivarlo.');
  });

  it('categoría pedida que no existe: mensaje concreto, igual que en crear_producto', async () => {
    mockProductoEncontrado();
    mockDb({ categoriasDisponibles: mockCategoriaEncontrada('Inexistente') });
    await expect(editarProducto.resumen({ empresaId: EMPRESA_ID, args: { producto: 'Fideos', categoria: 'Limpieza' } }))
      .rejects.toThrow('No existe ninguna categoría llamada "Limpieza"');
  });
});

describe('editar_producto — execute()', () => {
  function mockProductoEncontrado({ id = 'p1', nombre = 'Fideos' } = {}) {
    dbMock.rpc.mockResolvedValue({ data: [{ id, nombre, similitud: 1 }], error: null });
  }

  it('aplica el UPDATE scopeado por producto Y por empresa', async () => {
    mockProductoEncontrado();
    const queries = mockDb({ productosUpdate: { error: null } });

    const res = await editarProducto.execute({ empresaId: EMPRESA_ID, args: { producto: 'Fideos', precio_base: 1200 } });

    expect(res).toEqual({ ok: true, id: 'p1', nombre: 'Fideos', cambios: { precio_base: 1200 } });
    const update = queries.productos[0];
    expect(update.update).toHaveBeenCalledWith({ precio_base: 1200 });
    expect(update.eq).toHaveBeenCalledWith('id', 'p1');
    expect(update.eq).toHaveBeenCalledWith('empresa_id', EMPRESA_ID);
  });

  it('sin ningún cambio indicado: rechaza sin llegar a llamar UPDATE', async () => {
    mockProductoEncontrado();
    const queries = mockDb();
    await expect(editarProducto.execute({ empresaId: EMPRESA_ID, args: { producto: 'Fideos' } }))
      .rejects.toThrow('No indicaste ningún cambio para aplicar.');
    expect(queries.productos).toHaveLength(0);
  });

  it('error de Postgres en el UPDATE: propaga con contexto', async () => {
    mockProductoEncontrado();
    mockDb({ productosUpdate: { error: { message: 'constraint violada' } } });

    await expect(editarProducto.execute({ empresaId: EMPRESA_ID, args: { producto: 'Fideos', activo: false } }))
      .rejects.toThrow('editar_producto: constraint violada');
  });
});
