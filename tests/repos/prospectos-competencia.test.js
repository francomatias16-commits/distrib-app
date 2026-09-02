// tests/repos/prospectos-competencia.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 3, Capa 1 (prospección geográfica).
// Cubre distanciaHaversineMetros (la pieza que reemplaza a PostGIS, que no
// está instalado) y el scoping condicional por vendedor_id — mismo criterio
// que el fix de listarCapturasPendientes (Fase 1): null → sin filtro, para
// que dueño/admin auditen la empresa completa.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  distanciaHaversineMetros,
  crearProspecto,
  listarProspectos,
  marcarEstadoProspecto,
  listarProspectosActivosParaRanking,
  obtenerParadasConCoordsDeRuta,
} = await import('../../lib/repos/prospectos-competencia.js');

/** Query builder encadenable genérico — mismo criterio que
 * tests/repos/captura-competencia.test.js. */
function fakeQuery(result, { terminal } = {}) {
  const obj = {
    select: vi.fn(() => obj),
    insert: vi.fn(() => obj),
    update: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    in: vi.fn(() => obj),
    order: vi.fn(() => obj),
  };
  if (terminal) obj[terminal] = vi.fn(() => Promise.resolve(result));
  obj.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('distanciaHaversineMetros', () => {
  it('devuelve 0 para el mismo punto', () => {
    expect(distanciaHaversineMetros(-27.46, -58.99, -27.46, -58.99)).toBeCloseTo(0, 3);
  });

  it('calcula una distancia real razonable (≈ Reconquista → Avellaneda, Santa Fe, ~15km)', () => {
    // Dos puntos con ~0.135° de diferencia en latitud sobre el mismo
    // meridiano aproximado — a esta latitud, 1° ≈ 111.2km, así que
    // 0.135° ≈ 15km. Margen amplio (±2km) porque no es el propósito del
    // test validar geografía exacta, sino que la fórmula no esté rota
    // (ej. no confundir grados con radianes, no invertir lat/lng).
    const d = distanciaHaversineMetros(-29.15, -59.65, -29.02, -59.65);
    expect(d).toBeGreaterThan(13_000);
    expect(d).toBeLessThan(17_000);
  });

  it('es simétrica (A→B == B→A)', () => {
    const ab = distanciaHaversineMetros(-27.46, -58.99, -27.50, -59.10);
    const ba = distanciaHaversineMetros(-27.50, -59.10, -27.46, -58.99);
    expect(ab).toBeCloseTo(ba, 6);
  });
});

describe('crearProspecto', () => {
  it('inserta con estado pendiente y nulls para los campos opcionales ausentes', async () => {
    const insertMock = vi.fn();
    const q = fakeQuery({ data: { id: 'p1' }, error: null }, { terminal: 'single' });
    q.insert = insertMock.mockReturnValue(q);
    dbMock.from.mockReturnValue(q);

    await crearProspecto({ empresa_id: 'e1', vendedor_id: 'v1', nombre: 'Almacén Don José', lat: -27.46, lng: -58.99 });

    expect(dbMock.from).toHaveBeenCalledWith('prospectos_competencia');
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      empresa_id: 'e1',
      vendedor_id: 'v1',
      nombre: 'Almacén Don José',
      rubro: null,
      direccion: null,
      notas: null,
      estado: 'pendiente',
    }));
  });
});

describe('listarProspectos', () => {
  it('sin filtro de vendedor (dueño/admin) no llama .eq con vendedor_id', async () => {
    const q = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(q);

    await listarProspectos('e1', null);

    expect(q.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(q.eq).not.toHaveBeenCalledWith('vendedor_id', expect.anything());
  });

  it('con vendedor_id_filtro, acota la bandeja a lo suyo', async () => {
    const q = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(q);

    await listarProspectos('e1', 'v1');

    expect(q.eq).toHaveBeenCalledWith('vendedor_id', 'v1');
  });
});

describe('marcarEstadoProspecto', () => {
  it('actualiza estado + updated_at, acotado por empresa_id, sin vendedor_id si no viene filtro', async () => {
    const q = fakeQuery({ data: { id: 'p1', empresa_id: 'e1' }, error: null }, { terminal: 'maybeSingle' });
    const updateMock = vi.fn(() => q);
    q.update = updateMock;
    dbMock.from.mockReturnValue(q);

    await marcarEstadoProspecto('e1', 'p1', 'visitado', {});

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ estado: 'visitado' }));
    expect(q.eq).toHaveBeenCalledWith('id', 'p1');
    expect(q.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(q.eq).not.toHaveBeenCalledWith('vendedor_id', expect.anything());
  });

  it('con vendedor_id_filtro, el vendedor solo puede tocar lo suyo', async () => {
    const q = fakeQuery({ data: { id: 'p1' }, error: null }, { terminal: 'maybeSingle' });
    dbMock.from.mockReturnValue(q);

    await marcarEstadoProspecto('e1', 'p1', 'descartado', { vendedor_id_filtro: 'v1' });

    expect(q.eq).toHaveBeenCalledWith('vendedor_id', 'v1');
  });

  it('incluye captura_id en el update solo cuando viene informado', async () => {
    const q = fakeQuery({ data: { id: 'p1' }, error: null }, { terminal: 'maybeSingle' });
    const updateMock = vi.fn(() => q);
    q.update = updateMock;
    dbMock.from.mockReturnValue(q);

    await marcarEstadoProspecto('e1', 'p1', 'visitado', { captura_id: 'c1' });

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ captura_id: 'c1' }));
  });
});

describe('listarProspectosActivosParaRanking', () => {
  it('filtra solo pendiente/visita_planificada', async () => {
    const q = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(q);

    await listarProspectosActivosParaRanking('e1', null);

    expect(q.in).toHaveBeenCalledWith('estado', ['pendiente', 'visita_planificada']);
  });
});

describe('obtenerParadasConCoordsDeRuta', () => {
  it('extrae solo paradas con lat/lng definidos, descartando clientes sin ubicar', async () => {
    const q = fakeQuery({
      data: [
        { pedidos: { empresa_id: 'e1', clientes: { lat: '-27.46', lng: '-58.99' } } },
        { pedidos: { empresa_id: 'e1', clientes: { lat: null, lng: null } } },
        { pedidos: { empresa_id: 'e1', clientes: null } },
      ],
      error: null,
    });
    dbMock.from.mockReturnValue(q);

    const { data, error } = await obtenerParadasConCoordsDeRuta('e1', 'r1');

    expect(error).toBeNull();
    expect(data).toEqual([{ lat: -27.46, lng: -58.99 }]);
  });

  it('propaga el error de la query sin intentar mapear', async () => {
    const q = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(q);

    const { data, error } = await obtenerParadasConCoordsDeRuta('e1', 'r1');

    expect(data).toBeNull();
    expect(error.message).toBe('boom');
  });
});
