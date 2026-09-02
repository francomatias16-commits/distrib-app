// tests/repos/migracion.test.js
//
// Fase 7, paso siguiente a pos.js — `migracion.js` (repo) no tenía tests
// todavía. Foco del checklist (punto 5): que las lecturas de
// migracion_sesiones/migracion_staging_rows siempre filtren por
// empresa_id/sesion_id, y que las funciones que el handler original
// destructuraba con chequeo de error (`if (error) return errorSeguro(...)`)
// sigan devolviendo `{ data, error }` sin tragarse nada — a diferencia de
// las que el original ignoraba a propósito (ej. `obtenerSesionPorId`,
// `obtenerResumenAdvertenciasSesion`), que acá también las ignoran, mismo
// comportamiento observable.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  listarPlantillasMapeo,
  crearPlantillaMapeo,
  borrarPlantillaMapeo,
  obtenerSesionPorId,
  listarSesionesPorEmpresa,
  obtenerUltimaSesion,
  buscarSesionesDuplicadas,
  obtenerSesionOrigenEntreIds,
  crearSesion,
  actualizarSesion,
  obtenerResumenAdvertenciasSesion,
  insertarFilasStaging,
  contarFilasStaging,
  obtenerFilasSesion,
  obtenerFilasPorEntidadResultado,
  obtenerLoteSinMapear,
  obtenerDatosMapeadosDeSesion,
  obtenerFilasParaResumen,
  resetearMapeoSesion,
  obtenerFilaPorId,
  actualizarAccionFila,
  obtenerProgresoConfirmacion,
  obtenerProgresoDeshacer,
  reabrirFilasFallidas,
} = await import('../../lib/repos/migracion.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    neq:         vi.fn(() => obj),
    in:          vi.fn(() => obj),
    is:          vi.fn(() => obj),
    not:         vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    order:       vi.fn(() => obj),
    range:       vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    delete:      vi.fn(() => obj),
    single:      vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

// ─── migracion_plantillas_mapeo ────────────────────────────────────────────

describe('listarPlantillasMapeo', () => {
  it('filtra por empresa_id siempre, y por entidad solo si se pasa', async () => {
    const query = fakeQuery({ data: [{ id: 'p1' }], error: null });
    dbMock.from.mockReturnValue(query);

    await listarPlantillasMapeo('empresa-1', 'clientes');

    expect(dbMock.from).toHaveBeenCalledWith('migracion_plantillas_mapeo');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('entidad', 'clientes');
  });

  it('sin entidad, no filtra por entidad', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarPlantillasMapeo('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).not.toHaveBeenCalledWith('entidad', expect.anything());
  });
});

describe('crearPlantillaMapeo', () => {
  it('inserta y devuelve el registro creado', async () => {
    const query = fakeQuery({ data: { id: 'p1', nombre: 'Mi plantilla' }, error: null });
    dbMock.from.mockReturnValue(query);

    const campos = { empresa_id: 'empresa-1', entidad: 'clientes', nombre: 'Mi plantilla' };
    const { data } = await crearPlantillaMapeo(campos);

    expect(query.insert).toHaveBeenCalledWith(campos);
    expect(data.nombre).toBe('Mi plantilla');
  });
});

describe('borrarPlantillaMapeo', () => {
  it('filtra por id Y empresa_id — no debe poder borrar una plantilla de otra empresa', async () => {
    const query = fakeQuery({ error: null, count: 1 });
    dbMock.from.mockReturnValue(query);

    await borrarPlantillaMapeo('plantilla-1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'plantilla-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

// ─── migracion_sesiones ─────────────────────────────────────────────────────

describe('obtenerSesionPorId', () => {
  it('busca por id sin filtrar empresa_id acá — el chequeo de pertenencia lo hace el llamador', async () => {
    const query = fakeQuery({ data: { id: 'sesion-1', empresa_id: 'empresa-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerSesionPorId('sesion-1');

    expect(dbMock.from).toHaveBeenCalledWith('migracion_sesiones');
    expect(query.eq).toHaveBeenCalledWith('id', 'sesion-1');
    expect(data.id).toBe('sesion-1');
  });

  it('ignora el error igual que el original (solo destructura data)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));

    const data = await obtenerSesionPorId('sesion-x');

    expect(data).toBeNull();
  });
});

describe('listarSesionesPorEmpresa', () => {
  it('filtra por empresa_id, ordena por created_at desc, pagina con range (offset 0, limit 20 por defecto)', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarSesionesPorEmpresa('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.range).toHaveBeenCalledWith(0, 19);
  });

  it('respeta offset/limit explícitos y cappea el limit a 50', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarSesionesPorEmpresa('empresa-1', { offset: 20, limit: 999 });

    expect(query.range).toHaveBeenCalledWith(20, 69);
  });
});

describe('buscarSesionesDuplicadas', () => {
  it('con hash_contenido, filtra por hash (no por nombre+total_filas)', async () => {
    const query = fakeQuery({ data: [] });
    dbMock.from.mockReturnValue(query);

    await buscarSesionesDuplicadas('empresa-1', 'clientes', { hash_contenido: 'abc123' });

    expect(query.eq).toHaveBeenCalledWith('hash_contenido', 'abc123');
    expect(query.eq).not.toHaveBeenCalledWith('nombre_archivo_original', expect.anything());
  });

  it('sin hash_contenido, cae a nombre_archivo + total_filas', async () => {
    const query = fakeQuery({ data: [] });
    dbMock.from.mockReturnValue(query);

    await buscarSesionesDuplicadas('empresa-1', 'clientes', { nombre_archivo: 'clientes.csv', total_filas: 100 });

    expect(query.eq).toHaveBeenCalledWith('nombre_archivo_original', 'clientes.csv');
    expect(query.eq).toHaveBeenCalledWith('total_filas', 100);
  });

  it('siempre filtra por empresa_id, entidad y estados relevantes (no "subido"/"cancelado")', async () => {
    const query = fakeQuery({ data: [] });
    dbMock.from.mockReturnValue(query);

    await buscarSesionesDuplicadas('empresa-1', 'productos', { hash_contenido: 'x' });

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('entidad', 'productos');
    expect(query.in).toHaveBeenCalledWith('estado', ['mapeado', 'validado', 'confirmando', 'completado', 'error']);
  });
});

describe('crearSesion', () => {
  it('inserta los campos recibidos y devuelve el registro completo', async () => {
    const query = fakeQuery({ data: { id: 'sesion-nueva' }, error: null });
    dbMock.from.mockReturnValue(query);

    const campos = { empresa_id: 'empresa-1', entidad: 'clientes', estado: 'subido' };
    const { data } = await crearSesion(campos);

    expect(query.insert).toHaveBeenCalledWith(campos);
    expect(data.id).toBe('sesion-nueva');
  });
});

describe('actualizarSesion', () => {
  it('actualiza por id con los cambios recibidos, sin filtrar empresa_id (confía en cargarSesionPropia previo)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarSesion('sesion-1', { estado: 'completado' });

    expect(query.update).toHaveBeenCalledWith({ estado: 'completado' });
    expect(query.eq).toHaveBeenCalledWith('id', 'sesion-1');
  });
});

// ─── migracion_staging_rows ─────────────────────────────────────────────────

describe('insertarFilasStaging', () => {
  it('propaga el error si el insert falla (a diferencia de las lecturas silenciosas)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'insert falló' } }));

    const error = await insertarFilasStaging([{ sesion_id: 's1', fila_numero: 1 }]);

    expect(error.message).toBe('insert falló');
  });

  it('devuelve null si no hay error', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: null }));

    const error = await insertarFilasStaging([{ sesion_id: 's1', fila_numero: 1 }]);

    expect(error).toBeNull();
  });
});

describe('contarFilasStaging', () => {
  it('filtra por sesion_id y devuelve 0 si count viene null', async () => {
    const query = fakeQuery({ count: null, error: null });
    dbMock.from.mockReturnValue(query);

    const count = await contarFilasStaging('sesion-1');

    expect(query.eq).toHaveBeenCalledWith('sesion_id', 'sesion-1');
    expect(count).toBe(0);
  });
});

describe('obtenerFilasSesion', () => {
  it('filtra por sesion_id, sin filtro extra si soloErrores es false', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerFilasSesion('sesion-1', {});

    expect(query.eq).toHaveBeenCalledWith('sesion_id', 'sesion-1');
    expect(query.eq).not.toHaveBeenCalledWith('es_valida', false);
  });

  it('con soloErrores=true, agrega el filtro es_valida=false', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerFilasSesion('sesion-1', { soloErrores: true, offset: 10, limit: 50 });

    expect(query.eq).toHaveBeenCalledWith('es_valida', false);
    expect(query.range).toHaveBeenCalledWith(10, 59);
  });
});

describe('obtenerLoteSinMapear', () => {
  it('filtra por sesion_id y mapeado_en IS NULL, ordena por fila_numero', async () => {
    const query = fakeQuery({ data: [{ id: 'f1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerLoteSinMapear('sesion-1', 1000);

    expect(query.eq).toHaveBeenCalledWith('sesion_id', 'sesion-1');
    expect(query.is).toHaveBeenCalledWith('mapeado_en', null);
    expect(query.limit).toHaveBeenCalledWith(1000);
    expect(data).toEqual([{ id: 'f1' }]);
  });

  it('lanza si hay error (a diferencia de las demás lecturas del repo, esta sí propagaba throw en el original)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    await expect(obtenerLoteSinMapear('sesion-1', 1000)).rejects.toThrow('timeout');
  });
});

describe('resetearMapeoSesion', () => {
  it('actualiza mapeado_en a null filtrando por sesion_id', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await resetearMapeoSesion('sesion-1');

    expect(query.update).toHaveBeenCalledWith({ mapeado_en: null });
    expect(query.eq).toHaveBeenCalledWith('sesion_id', 'sesion-1');
  });
});

describe('obtenerFilaPorId', () => {
  it('busca la fila por id (el chequeo de pertenencia a la sesión/empresa lo hace el llamador)', async () => {
    const query = fakeQuery({ data: { id: 'fila-1', sesion_id: 'sesion-1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerFilaPorId('fila-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'fila-1');
    expect(data.sesion_id).toBe('sesion-1');
  });
});

describe('actualizarAccionFila', () => {
  it('actualiza la accion de una fila puntual por id', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await actualizarAccionFila('fila-1', 'omitir');

    expect(query.update).toHaveBeenCalledWith({ accion: 'omitir' });
    expect(query.eq).toHaveBeenCalledWith('id', 'fila-1');
  });
});

describe('obtenerProgresoConfirmacion', () => {
  it('filtra por sesion_id, es_valida=true, accion != omitir, y procesado_en no nulo', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerProgresoConfirmacion('sesion-1');

    expect(query.eq).toHaveBeenCalledWith('sesion_id', 'sesion-1');
    expect(query.eq).toHaveBeenCalledWith('es_valida', true);
    expect(query.neq).toHaveBeenCalledWith('accion', 'omitir');
    expect(query.not).toHaveBeenCalledWith('procesado_en', 'is', null);
  });
});

describe('reabrirFilasFallidas', () => {
  it('limpia procesado_en/error_ejecucion solo de las filas con error de esa sesión', async () => {
    const query = fakeQuery({ data: [{ id: 'f1' }], error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await reabrirFilasFallidas('sesion-1');

    expect(query.update).toHaveBeenCalledWith({ procesado_en: null, error_ejecucion: null });
    expect(query.eq).toHaveBeenCalledWith('sesion_id', 'sesion-1');
    expect(query.not).toHaveBeenCalledWith('error_ejecucion', 'is', null);
    expect(data).toEqual([{ id: 'f1' }]);
  });
});
