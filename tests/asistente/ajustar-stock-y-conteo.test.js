// tests/asistente/ajustar-stock-y-conteo.test.js
//
// Fase 5 (siguiente lote, en el orden acordado): ajustar_stock_asistente /
// registrar_conteo_stock_asistente (lib/asistente-tools/stock.js). Cubre
// resolverAjusteStock/resolverConteoStock (_helpers.js) — resolución de
// producto (vía RPC buscar_productos_asistente) y depósito (vía ILIKE) — y
// los dos caminos de escritura: ajustar_stock/producir_con_insumos para el
// ajuste, registrar_conteo_stock para el conteo.
//
// Mismo patrón que registrar-cobro-cliente.test.js: se mockea solo
// lib/repos/_db.js. Para 'depositos' se replica el filtro ILIKE en memoria
// (igual que el mock de 'categorias' en crear-editar-producto.test.js) para
// poder probar "no encontrado" sin un mock por nombre.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_STOCK } = await import('../../lib/asistente-tools/stock.js');

const ajustarStock = TOOLS_STOCK.find((t) => t.name === 'ajustar_stock_asistente');
const registrarConteo = TOOLS_STOCK.find((t) => t.name === 'registrar_conteo_stock_asistente');

const EMPRESA_ID = 'e1';
const USUARIO_ID = 'u1';

const DEPOSITOS = [
  { id: 'd1', nombre: 'Depósito Central' },
  { id: 'd2', nombre: 'Depósito Norte' },
];

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

// Un único candidato de producto claro (similitud 1) — la ambigüedad ya la
// cubre desambiguacion.test.js, acá se mantiene siempre inequívoco.
function mockProductoEncontrado({ id = 'p1', nombre = 'Fideos' } = {}) {
  return { id, nombre, similitud: 1 };
}

// Router: 'depositos' filtra en memoria por el texto pasado a .ilike (como
// haría Postgres), así "Sur" no matchea ninguno de DEPOSITOS sin necesidad
// de mock por nombre; 'stock' devuelve la fila de cantidad actual configurada
// por el test.
function mockDb({ depositosDisponibles = DEPOSITOS, stockRow = { data: { cantidad: 0 }, error: null } } = {}) {
  dbMock.from.mockImplementation((tabla) => {
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
    if (tabla === 'stock') {
      return fakeQuery(stockRow);
    }
    throw new Error(`tabla no mockeada en este test: ${tabla}`);
  });
}

function mockRpc({ producto = mockProductoEncontrado(), ajustarStockResult = null, producirResult = null, conteoResult = null } = {}) {
  dbMock.rpc.mockImplementation((rpc) => {
    if (rpc === 'buscar_productos_asistente') return Promise.resolve({ data: producto ? [producto] : [], error: null });
    if (rpc === 'ajustar_stock') return Promise.resolve(ajustarStockResult ?? { data: { ok: true, stock_nuevo: 0 }, error: null });
    if (rpc === 'producir_con_insumos') return Promise.resolve(producirResult ?? { data: { ok: true, stock_nuevo: 0 }, error: null });
    if (rpc === 'registrar_conteo_stock') return Promise.resolve(conteoResult ?? { data: { ok: true, stock_nuevo: 0 }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('ajustar_stock_asistente — resumen()', () => {
  it('cantidad <= 0: rechaza sin tocar la base', async () => {
    await expect(ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 0 },
    })).rejects.toThrow('La cantidad debe ser mayor a cero.');
    expect(dbMock.rpc).not.toHaveBeenCalled();
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('producto no encontrado: mensaje concreto', async () => {
    mockDb();
    mockRpc({ producto: null });
    await expect(ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Inexistente', deposito: 'Central', tipo: 'ingreso', cantidad: 5 },
    })).rejects.toThrow('No encontré ningún producto parecido a "Inexistente"');
  });

  it('depósito que no existe: mensaje concreto', async () => {
    mockDb();
    mockRpc();
    await expect(ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Sur', tipo: 'ingreso', cantidad: 5 },
    })).rejects.toThrow('No encontré ningún depósito parecido a "Sur"');
  });

  it('egreso mayor al stock disponible: rechaza con los números concretos', async () => {
    mockDb({ stockRow: { data: { cantidad: 3 }, error: null } });
    mockRpc();
    await expect(ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'egreso', cantidad: 5 },
    })).rejects.toThrow('No hay suficiente stock de "Fideos" en "Depósito Central": disponible 3, se pidió restar 5.');
  });

  it('egreso válido: arma el texto con el nuevo stock', async () => {
    mockDb({ stockRow: { data: { cantidad: 10 }, error: null } });
    mockRpc();
    const resumen = await ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'egreso', cantidad: 4, motivo: 'merma' },
    });
    expect(resumen).toBe('Restar 4 de "Fideos" en "Depósito Central" por motivo "merma". Stock: 10 → 6.');
  });

  it('ingreso sin motivo dado: usa "ajuste_manual" por default', async () => {
    mockDb({ stockRow: { data: { cantidad: 10 }, error: null } });
    mockRpc();
    const resumen = await ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5 },
    });
    expect(resumen).toBe('Sumar 5 de "Fideos" en "Depósito Central" por motivo "ajuste_manual". Stock: 10 → 15.');
  });

  it('ingreso por producción: agrega el aviso de descuento de insumos', async () => {
    mockDb({ stockRow: { data: { cantidad: 10 }, error: null } });
    mockRpc();
    const resumen = await ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5, motivo: 'produccion' },
    });
    expect(resumen).toBe(
      'Sumar 5 de "Fideos" en "Depósito Central" por motivo "produccion" ' +
      '(producción propia: si el producto tiene receta cargada, se descontarán los insumos correspondientes). Stock: 10 → 15.'
    );
  });

  it('egreso por producción: NO agrega el aviso (el aviso es solo para ingreso)', async () => {
    mockDb({ stockRow: { data: { cantidad: 10 }, error: null } });
    mockRpc();
    const resumen = await ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'egreso', cantidad: 5, motivo: 'produccion' },
    });
    expect(resumen).not.toContain('producción propia');
  });
});

describe('ajustar_stock_asistente — execute()', () => {
  it('ingreso normal: llama ajustar_stock con delta positivo', async () => {
    mockDb();
    mockRpc({ ajustarStockResult: { data: { ok: true, stock_nuevo: 15 }, error: null } });

    const res = await ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5, motivo: 'devolucion_cliente', notas: 'nota x' },
    });

    expect(res).toEqual({ ok: true, producto: 'Fideos', deposito: 'Depósito Central', stock_nuevo: 15 });
    expect(dbMock.rpc).toHaveBeenCalledWith('ajustar_stock', {
      p_producto_id: 'p1', p_deposito_id: 'd1', p_delta: 5, p_tipo: 'ingreso',
      p_motivo: 'devolucion_cliente', p_notas: 'nota x', p_usuario_id: USUARIO_ID,
    });
  });

  it('egreso normal: llama ajustar_stock con delta negativo', async () => {
    mockDb();
    mockRpc({ ajustarStockResult: { data: { ok: true, stock_nuevo: 5 }, error: null } });

    await ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'egreso', cantidad: 5 },
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('ajustar_stock', {
      p_producto_id: 'p1', p_deposito_id: 'd1', p_delta: -5, p_tipo: 'egreso',
      p_motivo: 'ajuste_manual', p_notas: null, p_usuario_id: USUARIO_ID,
    });
  });

  it('ingreso por producción: llama producir_con_insumos (no ajustar_stock) y propaga tiene_receta/insumos_consumidos', async () => {
    mockDb();
    mockRpc({ producirResult: { data: { ok: true, stock_nuevo: 20, tiene_receta: true, insumos_consumidos: [{ producto_id: 'ins1', cantidad: 2 }] }, error: null } });

    const res = await ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5, motivo: 'produccion' },
    });

    expect(res).toEqual({
      ok: true, producto: 'Fideos', deposito: 'Depósito Central',
      stock_nuevo: 20, tiene_receta: true, insumos_consumidos: [{ producto_id: 'ins1', cantidad: 2 }],
    });
    expect(dbMock.rpc).toHaveBeenCalledWith('producir_con_insumos', {
      p_producto_id: 'p1', p_deposito_id: 'd1', p_cantidad: 5,
      p_motivo: 'produccion', p_notas: null, p_usuario_id: USUARIO_ID,
    });
    expect(dbMock.rpc).not.toHaveBeenCalledWith('ajustar_stock', expect.anything());
  });

  it('egreso con motivo "produccion": NO entra por producir_con_insumos (solo aplica a ingreso)', async () => {
    mockDb();
    mockRpc({ ajustarStockResult: { data: { ok: true, stock_nuevo: 5 }, error: null } });

    await ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'egreso', cantidad: 5, motivo: 'produccion' },
    });

    expect(dbMock.rpc).toHaveBeenCalledWith('ajustar_stock', expect.objectContaining({ p_tipo: 'egreso' }));
    expect(dbMock.rpc).not.toHaveBeenCalledWith('producir_con_insumos', expect.anything());
  });

  it('error de Postgres en ajustar_stock: propaga con contexto', async () => {
    mockDb();
    mockRpc({ ajustarStockResult: { data: null, error: { message: 'constraint violada' } } });

    await expect(ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5 },
    })).rejects.toThrow('ajustar_stock_asistente: constraint violada');
  });

  it('la RPC responde ok:false sin dar error de Postgres: usa el mensaje que trae, o uno genérico', async () => {
    mockDb();
    mockRpc({ ajustarStockResult: { data: { ok: false, error: 'motivo puntual del rechazo' }, error: null } });

    await expect(ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5 },
    })).rejects.toThrow('motivo puntual del rechazo');
  });

  it('error de Postgres en producir_con_insumos: propaga con contexto', async () => {
    mockDb();
    mockRpc({ producirResult: { data: null, error: { message: 'sin insumos suficientes' } } });

    await expect(ajustarStock.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'ingreso', cantidad: 5, motivo: 'produccion' },
    })).rejects.toThrow('ajustar_stock_asistente: sin insumos suficientes');
  });
});

describe('registrar_conteo_stock_asistente — resumen()', () => {
  it('sin cantidad_contada: rechaza sin tocar la base', async () => {
    await expect(registrarConteo.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central' },
    })).rejects.toThrow('La cantidad contada debe ser un número mayor o igual a cero.');
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });

  it('cantidad_contada negativa: rechaza', async () => {
    mockDb();
    mockRpc();
    await expect(registrarConteo.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: -1 },
    })).rejects.toThrow('La cantidad contada debe ser un número mayor o igual a cero.');
  });

  it('cantidad_contada en 0: es válida ("no queda nada")', async () => {
    mockDb({ stockRow: { data: { cantidad: 8 }, error: null } });
    mockRpc();
    const resumen = await registrarConteo.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 0 },
    });
    expect(resumen).toBe('Registrar conteo físico de "Fideos" en "Depósito Central": sistema 8 → contado 0 (diferencia -8).');
  });

  it('sin diferencia: el texto lo dice explícitamente en vez de "diferencia 0"', async () => {
    mockDb({ stockRow: { data: { cantidad: 8 }, error: null } });
    mockRpc();
    const resumen = await registrarConteo.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 8 },
    });
    expect(resumen).toBe('Registrar conteo físico de "Fideos" en "Depósito Central": sistema 8 → contado 8 (sin diferencia).');
  });

  it('diferencia positiva: se muestra con el signo +', async () => {
    mockDb({ stockRow: { data: { cantidad: 8 }, error: null } });
    mockRpc();
    const resumen = await registrarConteo.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 12 },
    });
    expect(resumen).toBe('Registrar conteo físico de "Fideos" en "Depósito Central": sistema 8 → contado 12 (diferencia +4).');
  });

  it('sin fila de stock previa (producto nunca tuvo stock en ese depósito): sistema se toma como 0', async () => {
    mockDb({ stockRow: { data: null, error: null } });
    mockRpc();
    const resumen = await registrarConteo.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 5 },
    });
    expect(resumen).toBe('Registrar conteo físico de "Fideos" en "Depósito Central": sistema 0 → contado 5 (diferencia +5).');
  });
});

describe('registrar_conteo_stock_asistente — execute()', () => {
  it('llama registrar_conteo_stock con los parámetros correctos, motivo fijo "conteo_fisico"', async () => {
    mockDb();
    mockRpc({ conteoResult: { data: { ok: true, stock_nuevo: 12, cantidad_sistema: 8, diferencia: 4 }, error: null } });

    const res = await registrarConteo.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 12, notas: 'conteo de fin de mes' },
    });

    expect(res).toEqual({ ok: true, producto: 'Fideos', deposito: 'Depósito Central', stock_nuevo: 12, cantidad_sistema: 8, diferencia: 4 });
    expect(dbMock.rpc).toHaveBeenCalledWith('registrar_conteo_stock', {
      p_producto_id: 'p1', p_deposito_id: 'd1', p_cantidad_contada: 12,
      p_motivo: 'conteo_fisico', p_notas: 'conteo de fin de mes', p_usuario_id: USUARIO_ID,
    });
  });

  it('error de Postgres: propaga con contexto', async () => {
    mockDb();
    mockRpc({ conteoResult: { data: null, error: { message: 'timeout' } } });

    await expect(registrarConteo.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 5 },
    })).rejects.toThrow('registrar_conteo_stock_asistente: timeout');
  });

  it('la RPC responde ok:false sin error de Postgres: usa el mensaje que trae, o uno genérico', async () => {
    mockDb();
    mockRpc({ conteoResult: { data: { ok: false }, error: null } });

    await expect(registrarConteo.execute({
      empresaId: EMPRESA_ID, usuarioId: USUARIO_ID,
      args: { producto: 'Fideos', deposito: 'Central', cantidad_contada: 5 },
    })).rejects.toThrow('No se pudo registrar el conteo.');
  });
});
