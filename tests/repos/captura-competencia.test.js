// tests/repos/captura-competencia.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 1, punto 1.6. Complementa
// tests/handlers/captura-competencia.test.js (que mockea este repo
// entero) verificando la capa de acceso a datos en sí: qué tabla/columnas
// pide cada función, y sobre todo el fix de esta misma entrega en
// `listarCapturasPendientes` — el filtro por `vendedor_id` tiene que ser
// condicional (null → sin filtro, para que dueño/admin auditen toda la
// empresa) y no aplicarse siempre como antes.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  subirFotoCapturaStorage,
  crearCaptura,
  obtenerCapturaDetalle,
  listarCapturasPendientes,
  obtenerMetricasCaptura,
  actualizarTotalesCaptura,
  marcarCapturaConvertida,
  insertarItemsCaptura,
  confirmarItemCaptura,
  matchearProducto,
} = await import('../../lib/repos/captura-competencia.js');

/** Query builder encadenable genérico — cada método se registra como spy y
 * devuelve el mismo objeto, salvo el método terminal que resuelve la
 * promesa (igual criterio que tests/repos/cta-cte.test.js). */
function fakeQuery(result, { terminal = 'single' } = {}) {
  const obj = {
    select: vi.fn(() => obj),
    insert: vi.fn(() => obj),
    update: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    order: vi.fn(() => obj),
  };
  obj[terminal] = vi.fn(() => Promise.resolve(result));
  // Para las queries que no llaman a ningún terminal explícito (ej.
  // `listarCapturasPendientes`, que resuelve el builder directo por
  // `await`), el objeto en sí tiene que ser then-able.
  obj.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('subirFotoCapturaStorage', () => {
  it('sube al bucket privado capturas-competencia con upsert:false', async () => {
    const uploadMock = vi.fn(async () => ({ error: null }));
    dbMock.storage.from.mockReturnValue({ upload: uploadMock });

    const buffer = Buffer.from('fake-image-bytes');
    const { error } = await subirFotoCapturaStorage('e1/v1/foto.jpg', buffer, 'image/jpeg');

    expect(dbMock.storage.from).toHaveBeenCalledWith('capturas-competencia');
    expect(uploadMock).toHaveBeenCalledWith('e1/v1/foto.jpg', buffer, { contentType: 'image/jpeg', upsert: false });
    expect(error).toBeNull();
  });
});

describe('crearCaptura', () => {
  it('inserta con estado pendiente_revision fijo, sin importar lo que se pase', async () => {
    const query = fakeQuery({ data: { id: 'captura-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    await crearCaptura({ empresa_id: 'e1', vendedor_id: 'v1', imagen_path: 'e1/v1/x.jpg', proveedor_competencia_nombre: 'Dist. XYZ' });

    expect(dbMock.from).toHaveBeenCalledWith('captura_competencia');
    expect(query.insert).toHaveBeenCalledWith({
      empresa_id: 'e1',
      vendedor_id: 'v1',
      imagen_original_url: 'e1/v1/x.jpg',
      proveedor_competencia_nombre: 'Dist. XYZ',
      estado: 'pendiente_revision',
    });
  });

  it('guarda el PATH del objeto, no una URL — mismo criterio post-SEC-05 que remitos/devoluciones', async () => {
    const query = fakeQuery({ data: {}, error: null });
    dbMock.from.mockReturnValue(query);

    await crearCaptura({ empresa_id: 'e1', vendedor_id: 'v1', imagen_path: 'e1/v1/x.jpg' });

    const insertArg = query.insert.mock.calls[0][0];
    expect(insertArg.imagen_original_url).toBe('e1/v1/x.jpg');
    expect(insertArg.imagen_original_url).not.toMatch(/^https?:\/\//);
  });
});

describe('obtenerCapturaDetalle', () => {
  it('scopea por id Y empresa_id (aislamiento multi-tenant) y embebe el producto matcheado', async () => {
    const query = fakeQuery({ data: { id: 'captura-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerCapturaDetalle('captura-1', 'e1');

    expect(dbMock.from).toHaveBeenCalledWith('captura_competencia');
    expect(query.eq).toHaveBeenCalledWith('id', 'captura-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    const selectArg = query.select.mock.calls[0][0];
    // El fix de esta entrega: el detalle tiene que traer el nombre del
    // producto embebido (antes solo traía producto_id) para que la
    // pantalla de revisión pueda mostrar contra qué se compara cada
    // renglón, más costo/precio_base para poder previsualizar el margen.
    expect(selectArg).toMatch(/productos\(id,\s*nombre,\s*precio_base,\s*costo,\s*unidad\)/);
  });
});

describe('listarCapturasPendientes — fix: scoping condicional por rol', () => {
  it('vendedor_id=null → eq() se llama SOLO para empresa_id, nunca para vendedor_id', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarCapturasPendientes('e1', null);

    const llamadasEq = query.eq.mock.calls.map((args) => args[0]);
    expect(llamadasEq).toContain('empresa_id');
    expect(llamadasEq).not.toContain('vendedor_id');
  });

  it('vendedor_id con valor (vendedor de campo viendo lo suyo) → SÍ filtra por vendedor_id', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarCapturasPendientes('e1', 'vend-1');

    const llamadasEq = query.eq.mock.calls;
    expect(llamadasEq).toContainEqual(['empresa_id', 'e1']);
    expect(llamadasEq).toContainEqual(['vendedor_id', 'vend-1']);
  });

  it('siempre filtra por estados accionables (pendiente_revision, revisado) — nunca trae descartadas/convertidas', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarCapturasPendientes('e1', null);

    expect(query.in).toHaveBeenCalledWith('estado', ['pendiente_revision', 'revisado']);
  });
});

describe('actualizarTotalesCaptura / marcarCapturaConvertida', () => {
  it('actualizarTotalesCaptura escribe exactamente los 5 campos calculados por accionCerrar, scopeado por id', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarTotalesCaptura('captura-1', {
      total_competencia: 1200, total_propio_cotizado: 1000, ahorro_absoluto: 200, ahorro_porcentual: 16.67, estado: 'revisado',
    });

    expect(query.update).toHaveBeenCalledWith({
      total_competencia: 1200, total_propio_cotizado: 1000, ahorro_absoluto: 200, ahorro_porcentual: 16.67, estado: 'revisado',
    });
    expect(query.eq).toHaveBeenCalledWith('id', 'captura-1');
  });

  it('marcarCapturaConvertida fija el estado a convertido_pedido (no lo recibe como parámetro — no se puede marcar otra cosa) y setea convertido_at', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await marcarCapturaConvertida('captura-1', 'cliente-9', 'pedido-9');

    const updateArg = query.update.mock.calls[0][0];
    expect(updateArg).toMatchObject({ estado: 'convertido_pedido', cliente_id: 'cliente-9', pedido_id: 'pedido-9' });
    // convertido_at (migración 553, plan 1.7): sin esto no hay forma de medir
    // el tiempo foto→cierre — se setea acá, no en el handler, para que quede
    // fijado por la fila que realmente escribe el estado.
    expect(updateArg.convertido_at).toBeTruthy();
    expect(new Date(updateArg.convertido_at).toString()).not.toBe('Invalid Date');
  });
});

describe('insertarItemsCaptura', () => {
  it('con lista vacía no llama a insert (evita un insert de 0 filas)', async () => {
    const { error } = await insertarItemsCaptura('captura-1', []);
    expect(dbMock.from).not.toHaveBeenCalled();
    expect(error).toBeNull();
  });

  it('asocia cada item a captura_id sin pisar los campos que ya trae', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await insertarItemsCaptura('captura-1', [{ texto_original: 'Coca 500ml x1', cantidad: 1, precio_unitario_competencia: 900 }]);

    expect(query.insert).toHaveBeenCalledWith([
      { texto_original: 'Coca 500ml x1', cantidad: 1, precio_unitario_competencia: 900, captura_id: 'captura-1' },
    ]);
  });
});

describe('confirmarItemCaptura', () => {
  it('marca confirmado_manualmente:true SIEMPRE, incluso sin más cambios (revisión obligatoria, plan 1.5)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await confirmarItemCaptura('item-1', {});

    expect(query.update).toHaveBeenCalledWith({ confirmado_manualmente: true });
  });

  it('solo incluye los campos explícitamente pasados (undefined no pisa nada)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await confirmarItemCaptura('item-1', { cantidad: 3, producto_id: undefined, descartado: undefined });

    expect(query.update).toHaveBeenCalledWith({ confirmado_manualmente: true, cantidad: 3 });
  });

  it('descartado:false explícito SÍ se aplica (no se confunde con "no se pasó")', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await confirmarItemCaptura('item-1', { descartado: false });

    expect(query.update).toHaveBeenCalledWith({ confirmado_manualmente: true, descartado: false });
  });
});

describe('matchearProducto', () => {
  it('llama al RPC de matching pasando empresa_id y el texto crudo', async () => {
    dbMock.rpc.mockResolvedValue({ data: [{ producto_id: 'p1', nombre: 'Coca Cola 500ml', precio_base: 1000, score: 0.92 }], error: null });

    const resultado = await matchearProducto('e1', 'COCA COLA 500ML X1');

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_captura_matchear_producto', { p_empresa_id: 'e1', p_texto: 'COCA COLA 500ML X1' });
    expect(resultado).toEqual({ producto_id: 'p1', nombre: 'Coca Cola 500ml', precio_base: 1000, score: 0.92 });
  });

  it('sin match por debajo del umbral → null, nunca fuerza un match falso (ej. renglón de flete)', async () => {
    dbMock.rpc.mockResolvedValue({ data: [], error: null });
    expect(await matchearProducto('e1', 'FLETE')).toBeNull();

    dbMock.rpc.mockResolvedValue({ data: null, error: null });
    expect(await matchearProducto('e1', 'DESCUENTO ESPECIAL')).toBeNull();
  });

  it('error en el RPC → null (degrada a "sin match", no revienta la creación de la captura)', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'función no existe' } });
    expect(await matchearProducto('e1', 'algo')).toBeNull();
  });
});

describe('obtenerMetricasCaptura — plan 1.7 (métrica de éxito del piloto)', () => {
  it('trae TODOS los estados (a diferencia de listarCapturasPendientes) — la tasa de cierre necesita el total real', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerMetricasCaptura('e1', null);

    expect(dbMock.from).toHaveBeenCalledWith('captura_competencia');
    expect(query.in).not.toHaveBeenCalled();
    const llamadasEq = query.eq.mock.calls.map((args) => args[0]);
    expect(llamadasEq).toContain('empresa_id');
    expect(llamadasEq).not.toContain('vendedor_id');
  });

  it('con vendedor_id → sí filtra (mismo scoping condicional que listarCapturasPendientes)', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerMetricasCaptura('e1', 'vend-1');

    expect(query.eq.mock.calls).toContainEqual(['vendedor_id', 'vend-1']);
  });

  it('trae exactamente estado/fecha_captura/convertido_at — lo mínimo para calcular tasa y tiempo en el handler', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerMetricasCaptura('e1');

    const selectArg = query.select.mock.calls[0][0];
    expect(selectArg).toBe('estado, fecha_captura, convertido_at');
  });
});
