// tests/asistente/orden-compra.test.js
//
// Fase 5 (siguiente lote, en el orden acordado): crear_orden_compra_asistente
// / recepcionar_orden_compra_asistente (lib/asistente-tools/proveedores.js).
// Cubre resolverOrdenCompraDesdeArgs/resolverRecepcionOrdenCompra
// (_helpers.js): resolución de proveedor/producto/depósito, la lógica de
// "recepcionar todo lo pendiente" vs. recepción parcial puntual, y los
// bloqueos de estado (orden cancelada/ya recibida).
//
// Mismo patrón que los tests anteriores de Fase 5: se mockea solo
// lib/repos/_db.js. 'ordenes_compra' y 'proveedores' devuelven la lista
// completa de candidatos (como 'depositos' en crear-editar-producto.test.js)
// y se deja que la lógica real de match exacto/ambigüedad decida — así no
// hace falta reimplementar el ILIKE de Postgres en el mock.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_PROVEEDORES } = await import('../../lib/asistente-tools/proveedores.js');

const crearOC = TOOLS_PROVEEDORES.find((t) => t.name === 'crear_orden_compra_asistente');
const recepcionarOC = TOOLS_PROVEEDORES.find((t) => t.name === 'recepcionar_orden_compra_asistente');

const EMPRESA_ID = 'e1';
const USUARIO_ID = 'u1';

const PROVEEDOR = { id: 'prov1', razon_social: 'Distribuidora SRL', nombre_fantasia: null, activo: true };

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    or: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

function mockProductoEncontrado({ id = 'p1', nombre = 'Fideos' } = {}) {
  return { id, nombre, similitud: 1 };
}

// Router de tablas. 'depositos' filtra en memoria por el texto de .ilike
// (como en ajustar-stock-y-conteo.test.js); 'proveedores'/'ordenes_compra'
// devuelven la lista completa de candidatos tal cual, dejando que la
// lógica real (elegirPorMatchExacto/armarErrorDesambiguacion) decida.
function mockDb({
  proveedores = [PROVEEDOR],
  ordenes = [],
  renglones = [],
  depositosDisponibles = [{ id: 'd1', nombre: 'Depósito Central' }],
} = {}) {
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'proveedores') return fakeQuery({ data: proveedores, error: null });
    if (tabla === 'ordenes_compra') return fakeQuery({ data: ordenes, error: null });
    if (tabla === 'ordenes_compra_items') return fakeQuery({ data: renglones, error: null });
    if (tabla === 'depositos') {
      const obj = {
        select: vi.fn(() => obj),
        eq: vi.fn(() => obj),
        ilike: vi.fn((_col, val) => { obj.__buscado = val; return obj; }),
        then: (resolve, reject) => {
          const buscado = String(obj.__buscado || '').replace(/%/g, '').trim().toLowerCase();
          const data = depositosDisponibles.filter((d) => d.nombre.toLowerCase().includes(buscado));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return obj;
    }
    throw new Error(`tabla no mockeada en este test: ${tabla}`);
  });
}

function mockRpc({ producto = mockProductoEncontrado(), crearOCResult = null, recepcionResult = null } = {}) {
  dbMock.rpc.mockImplementation((rpc) => {
    if (rpc === 'buscar_productos_asistente') return Promise.resolve({ data: producto ? [producto] : [], error: null });
    if (rpc === 'crear_orden_compra') return Promise.resolve(crearOCResult ?? { data: { ok: true, numero: 'OC-000200', orden_id: 'oc1' }, error: null });
    if (rpc === 'recepcionar_orden_compra') return Promise.resolve(recepcionResult ?? { data: { ok: true }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('crear_orden_compra_asistente — resumen()', () => {
  it('sin items: rechaza sin tocar la base', async () => {
    await expect(crearOC.resumen({ empresaId: EMPRESA_ID, args: { proveedor: 'Distribuidora', items: [] } }))
      .rejects.toThrow('La orden de compra necesita al menos un producto.');
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('proveedor no encontrado: mensaje concreto', async () => {
    mockDb({ proveedores: [] });
    mockRpc();
    await expect(crearOC.resumen({
      empresaId: EMPRESA_ID,
      args: { proveedor: 'Inexistente', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 500 }] },
    })).rejects.toThrow('No encontré ningún proveedor parecido a "Inexistente"');
  });

  it('cantidad de un item <= 0: rechaza con el nombre del producto en el mensaje', async () => {
    mockDb();
    mockRpc();
    await expect(crearOC.resumen({
      empresaId: EMPRESA_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 0, precio_costo: 500 }] },
    })).rejects.toThrow('La cantidad de "Fideos" debe ser mayor a cero.');
  });

  it('precio_costo de un item <= 0: rechaza con el nombre del producto en el mensaje', async () => {
    mockDb();
    mockRpc();
    await expect(crearOC.resumen({
      empresaId: EMPRESA_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 0 }] },
    })).rejects.toThrow('El precio de costo de "Fideos" debe ser mayor a cero.');
  });

  it('producto de un item no encontrado: mensaje concreto', async () => {
    mockDb();
    mockRpc({ producto: null });
    await expect(crearOC.resumen({
      empresaId: EMPRESA_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Inexistente', cantidad: 10, precio_costo: 500 }] },
    })).rejects.toThrow('No encontré ningún producto parecido a "Inexistente"');
  });

  it('con un solo item: arma el texto con subtotal', async () => {
    mockDb();
    mockRpc();
    const resumen = await crearOC.resumen({
      empresaId: EMPRESA_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 500 }] },
    });
    expect(resumen).toBe('Crear orden de compra a "Distribuidora SRL": 10 × Fideos ($500 c/u). Subtotal $5.000 (más IVA).');
  });

  it('con varios items: junta el detalle de todos y suma el subtotal total', async () => {
    mockDb();
    dbMock.rpc.mockImplementation((rpc, params) => {
      if (rpc === 'buscar_productos_asistente') {
        const texto = params.p_texto;
        const nombre = texto.includes('Fideos') ? 'Fideos' : 'Aceite';
        return Promise.resolve({ data: [{ id: nombre === 'Fideos' ? 'p1' : 'p2', nombre, similitud: 1 }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const resumen = await crearOC.resumen({
      empresaId: EMPRESA_ID,
      args: {
        proveedor: 'Distribuidora',
        items: [
          { producto: 'Fideos', cantidad: 10, precio_costo: 500 },
          { producto: 'Aceite', cantidad: 2, precio_costo: 1500 },
        ],
      },
    });
    expect(resumen).toBe('Crear orden de compra a "Distribuidora SRL": 10 × Fideos ($500 c/u), 2 × Aceite ($1.500 c/u). Subtotal $8.000 (más IVA).');
  });
});

describe('crear_orden_compra_asistente — execute()', () => {
  it('llama crear_orden_compra con los parámetros y el mapeo de items correcto', async () => {
    mockDb();
    mockRpc({ crearOCResult: { data: { ok: true, numero: 'OC-000201', orden_id: 'oc2' }, error: null } });

    const res = await crearOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 500 }], fecha_esperada: '2026-09-20', notas: 'urgente' },
    });

    expect(res).toEqual({ ok: true, proveedor: 'Distribuidora SRL', numero: 'OC-000201', orden_id: 'oc2' });
    expect(dbMock.rpc).toHaveBeenCalledWith('crear_orden_compra', {
      p_empresa_id: EMPRESA_ID,
      p_proveedor_id: 'prov1',
      p_fecha_esperada: '2026-09-20',
      p_notas: 'urgente',
      p_created_by: USUARIO_ID,
      p_items: [{ producto_id: 'p1', cantidad: 10, precio_costo: 500 }],
    });
  });

  it('sin fecha_esperada/notas: manda null en vez de undefined', async () => {
    mockDb();
    mockRpc();
    await crearOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 500 }] },
    });
    expect(dbMock.rpc).toHaveBeenCalledWith('crear_orden_compra', expect.objectContaining({
      p_fecha_esperada: null, p_notas: null,
    }));
  });

  it('error de Postgres: propaga con contexto', async () => {
    mockDb();
    mockRpc({ crearOCResult: { data: null, error: { message: 'FK inválida' } } });
    await expect(crearOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 500 }] },
    })).rejects.toThrow('crear_orden_compra_asistente: FK inválida');
  });

  it('la RPC responde ok:false sin error de Postgres: usa el mensaje que trae, o uno genérico', async () => {
    mockDb();
    mockRpc({ crearOCResult: { data: { ok: false, error: 'proveedor inactivo' }, error: null } });
    await expect(crearOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { proveedor: 'Distribuidora', items: [{ producto: 'Fideos', cantidad: 10, precio_costo: 500 }] },
    })).rejects.toThrow('proveedor inactivo');
  });
});

describe('recepcionar_orden_compra_asistente — resumen()', () => {
  it('sin numero_oc: rechaza sin tocar la base', async () => {
    await expect(recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: '  ' } }))
      .rejects.toThrow('Falta indicar el número de la orden de compra.');
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('orden no encontrada: mensaje concreto', async () => {
    mockDb({ ordenes: [] });
    await expect(recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-999' } }))
      .rejects.toThrow('No encontré ninguna orden de compra con número "OC-999".');
  });

  it('varias órdenes parecidas sin match exacto: tira ambiguo() con .opciones', async () => {
    mockDb({
      ordenes: [
        { id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' },
        { id: 'oc2', numero: 'OC-000186', estado: 'pendiente', proveedor_id: 'prov1' },
      ],
    });
    try {
      await recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-00018' } });
      throw new Error('no debería llegar acá');
    } catch (err) {
      expect(err.opciones).toEqual([
        { id: 'oc1', label: 'OC-000185' },
        { id: 'oc2', label: 'OC-000186' },
      ]);
    }
  });

  it('match exacto entre varias órdenes parecidas: gana el exacto', async () => {
    mockDb({
      ordenes: [
        { id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' },
        { id: 'oc2', numero: 'OC-0001850', estado: 'pendiente', proveedor_id: 'prov1' },
      ],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    const resumen = await recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-000185' } });
    expect(resumen).toContain('orden OC-000185');
  });

  it('orden cancelada: rechaza (bloqueado, sin `.opciones`)', async () => {
    mockDb({ ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'cancelada', proveedor_id: 'prov1' }] });
    const err = await recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-000185' } }).catch((e) => e);
    expect(err.message).toBe('La orden OC-000185 está cancelada, no se puede recepcionar.');
    expect(err.opciones).toBeUndefined();
  });

  it('orden ya recibida por completo: rechaza (bloqueado, sin `.opciones`)', async () => {
    mockDb({ ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'recibida', proveedor_id: 'prov1' }] });
    const err = await recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-000185' } }).catch((e) => e);
    expect(err.message).toBe('La orden OC-000185 ya fue recibida por completo.');
    expect(err.opciones).toBeUndefined();
  });

  it('sin items pedidos: recepciona todo lo pendiente (cantidad - cantidad_recibida de cada renglón)', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [
        { producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 4, precio_costo: 500, productos: { nombre: 'Fideos' } },
        { producto_id: 'p2', descripcion: 'Aceite', cantidad: 5, cantidad_recibida: 5, precio_costo: 1500, productos: { nombre: 'Aceite' } },
      ],
    });
    const resumen = await recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-000185' } });
    // Aceite ya está completo (5-5=0) y se filtra; solo queda Fideos pendiente.
    expect(resumen).toBe('Recepcionar orden OC-000185 en el depósito principal de la empresa: 6 × Fideos.');
  });

  it('sin renglones pendientes: mensaje concreto (bloqueado, sin `.opciones`)', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 10, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    const err = await recepcionarOC.resumen({ empresaId: EMPRESA_ID, args: { numero_oc: 'OC-000185' } }).catch((e) => e);
    expect(err.message).toBe('La orden OC-000185 no tiene renglones pendientes de recepción.');
    expect(err.opciones).toBeUndefined();
  });

  it('items puntuales: recepción parcial solo de lo pedido', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [
        { producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } },
        { producto_id: 'p2', descripcion: 'Aceite', cantidad: 5, cantidad_recibida: 0, precio_costo: 1500, productos: { nombre: 'Aceite' } },
      ],
    });
    mockRpc({ producto: mockProductoEncontrado({ id: 'p1', nombre: 'Fideos' }) });
    const resumen = await recepcionarOC.resumen({
      empresaId: EMPRESA_ID,
      args: { numero_oc: 'OC-000185', items: [{ producto: 'Fideos', cantidad_recibida: 3 }] },
    });
    expect(resumen).toBe('Recepcionar orden OC-000185 en el depósito principal de la empresa: 3 × Fideos.');
  });

  it('item puntual con cantidad_recibida <= 0: rechaza', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    mockRpc();
    await expect(recepcionarOC.resumen({
      empresaId: EMPRESA_ID,
      args: { numero_oc: 'OC-000185', items: [{ producto: 'Fideos', cantidad_recibida: 0 }] },
    })).rejects.toThrow('La cantidad recibida de "Fideos" debe ser mayor a cero.');
  });

  it('item puntual de un producto que la orden no tiene: rechaza', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    mockRpc({ producto: mockProductoEncontrado({ id: 'p2', nombre: 'Aceite' }) });
    await expect(recepcionarOC.resumen({
      empresaId: EMPRESA_ID,
      args: { numero_oc: 'OC-000185', items: [{ producto: 'Aceite', cantidad_recibida: 2 }] },
    })).rejects.toThrow('"Aceite" no está en la orden OC-000185.');
  });

  it('con depósito indicado: lo resuelve y lo nombra en el resumen', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
      depositosDisponibles: [{ id: 'd1', nombre: 'Depósito Norte' }],
    });
    const resumen = await recepcionarOC.resumen({
      empresaId: EMPRESA_ID,
      args: { numero_oc: 'OC-000185', deposito: 'Norte' },
    });
    expect(resumen).toBe('Recepcionar orden OC-000185 en "Depósito Norte": 10 × Fideos.');
  });
});

describe('recepcionar_orden_compra_asistente — execute()', () => {
  it('llama recepcionar_orden_compra con el mapeo de items y depósito null si no se dio', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    mockRpc({ recepcionResult: { data: { ok: true, stock_nuevo: 10 }, error: null } });

    const res = await recepcionarOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { numero_oc: 'OC-000185' },
    });

    expect(res).toEqual({ ok: true, numero: 'OC-000185', stock_nuevo: 10 });
    expect(dbMock.rpc).toHaveBeenCalledWith('recepcionar_orden_compra', {
      p_empresa_id: EMPRESA_ID,
      p_orden_id: 'oc1',
      p_items: [{ producto_id: 'p1', cantidad_recibida: 10, precio_costo: 500 }],
      p_usuario_id: USUARIO_ID,
      p_deposito_id: null,
    });
  });

  it('con depósito indicado: manda su id', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
      depositosDisponibles: [{ id: 'd9', nombre: 'Depósito Norte' }],
    });
    mockRpc();
    await recepcionarOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { numero_oc: 'OC-000185', deposito: 'Norte' },
    });
    expect(dbMock.rpc).toHaveBeenCalledWith('recepcionar_orden_compra', expect.objectContaining({ p_deposito_id: 'd9' }));
  });

  it('sin renglones pendientes: rechaza sin llegar a llamar la RPC', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 10, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    await expect(recepcionarOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { numero_oc: 'OC-000185' },
    })).rejects.toThrow('La orden OC-000185 no tiene renglones pendientes de recepción.');
    expect(dbMock.rpc).not.toHaveBeenCalledWith('recepcionar_orden_compra', expect.anything());
  });

  it('error de Postgres: propaga con contexto', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    mockRpc({ recepcionResult: { data: null, error: { message: 'constraint stock' } } });
    await expect(recepcionarOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { numero_oc: 'OC-000185' },
    })).rejects.toThrow('recepcionar_orden_compra_asistente: constraint stock');
  });

  it('la RPC responde ok:false sin error de Postgres: usa el mensaje que trae, o uno genérico', async () => {
    mockDb({
      ordenes: [{ id: 'oc1', numero: 'OC-000185', estado: 'pendiente', proveedor_id: 'prov1' }],
      renglones: [{ producto_id: 'p1', descripcion: 'Fideos', cantidad: 10, cantidad_recibida: 0, precio_costo: 500, productos: { nombre: 'Fideos' } }],
    });
    mockRpc({ recepcionResult: { data: { ok: false, error: 'depósito no pertenece a la empresa' }, error: null } });
    await expect(recepcionarOC.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { numero_oc: 'OC-000185' },
    })).rejects.toThrow('depósito no pertenece a la empresa');
  });
});
