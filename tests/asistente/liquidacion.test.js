// tests/asistente/liquidacion.test.js
//
// Fase 5 (último lote del primer round, en el orden acordado):
// generar_ofertas_liquidacion_asistente / guardar_reglas_liquidacion_asistente
// (lib/asistente-tools/liquidacion.js). Cubre armarCambiosReglaLiquidacion
// (_helpers.js) — merge de cambios parciales sobre las reglas actuales
// (o los defaults si la empresa nunca configuró nada), validación de rangos
// (0-100 en los descuentos, orden nivel1>nivel2>nivel3) — y los dos caminos
// de RPC: generar_ofertas_liquidacion (dry_run true/false) y el upsert de
// guardarReglas (repos/stock.js, que a su vez usa lib/repos/_db.js).
//
// Mismo patrón que los tests anteriores de Fase 5: se mockea solo
// lib/repos/_db.js — tanto _helpers.js como repos/stock.js terminan
// pegándole a esa misma capa, así que no hace falta mockear repos/stock.js
// por separado.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_LIQUIDACION } = await import('../../lib/asistente-tools/liquidacion.js');

const generarOfertas = TOOLS_LIQUIDACION.find((t) => t.name === 'generar_ofertas_liquidacion_asistente');
const guardarReglas = TOOLS_LIQUIDACION.find((t) => t.name === 'guardar_reglas_liquidacion_asistente');

const EMPRESA_ID = 'e1';

// Router de 'reglas_liquidacion': maybeSingle() sirve a obtenerReglas()
// (lectura de las reglas actuales, o null si la empresa nunca configuró
// nada); single() sirve a guardarReglas() (upsert), devolviendo el payload
// tal cual se guardó salvo que el test fuerce un resultado/error puntual.
function mockDb({ reglasActuales = null, upsertResult = null } = {}) {
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'reglas_liquidacion') {
      const obj = {
        select: vi.fn(() => obj),
        eq: vi.fn(() => obj),
        upsert: vi.fn((payload) => { obj.__payload = payload; return obj; }),
        maybeSingle: vi.fn(() => Promise.resolve({ data: reglasActuales, error: null })),
        single: vi.fn(() => Promise.resolve(upsertResult ?? { data: { id: 'rl1', empresa_id: EMPRESA_ID, ...obj.__payload }, error: null })),
      };
      return obj;
    }
    throw new Error(`tabla no mockeada en este test: ${tabla}`);
  });
}

const REGLAS_DEFAULT = {
  dias_alerta: 7, dias_nivel1: 3, pct_nivel1: 10,
  dias_nivel2: 1, pct_nivel2: 15, dias_nivel3: 0, pct_nivel3: 25,
  activo: true,
};

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('generar_ofertas_liquidacion_asistente — resumen() (dry_run)', () => {
  it('llama la RPC con p_dry_run:true', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, creadas: [], desactivadas: 0 }, error: null });
    await generarOfertas.resumen({ empresaId: EMPRESA_ID });
    expect(dbMock.rpc).toHaveBeenCalledWith('generar_ofertas_liquidacion', { p_empresa_id: EMPRESA_ID, p_dry_run: true });
  });

  it('sin cambios (nada creado ni desactivado): lo dice explícitamente', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, creadas: [], desactivadas: 0 }, error: null });
    const resumen = await generarOfertas.resumen({ empresaId: EMPRESA_ID });
    expect(resumen).toBe('Generar ofertas de liquidación ahora: no habría cambios (ningún lote nuevo dentro de la ventana configurada, ni ofertas para desactivar).');
  });

  it('solo crea/actualiza ofertas: menciona solo esa parte', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, creadas: [{ id: 'of1' }, { id: 'of2' }], desactivadas: 0 }, error: null });
    const resumen = await generarOfertas.resumen({ empresaId: EMPRESA_ID });
    expect(resumen).toBe('Generar ofertas de liquidación ahora: crear o actualizar 2 oferta(s).');
  });

  it('solo desactiva ofertas: menciona solo esa parte', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, creadas: [], desactivadas: 3 }, error: null });
    const resumen = await generarOfertas.resumen({ empresaId: EMPRESA_ID });
    expect(resumen).toBe('Generar ofertas de liquidación ahora: desactivar 3 oferta(s) vencida(s) o sin stock.');
  });

  it('crea y desactiva a la vez: junta ambas partes con "y"', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, creadas: [{ id: 'of1' }], desactivadas: 2 }, error: null });
    const resumen = await generarOfertas.resumen({ empresaId: EMPRESA_ID });
    expect(resumen).toBe('Generar ofertas de liquidación ahora: crear o actualizar 1 oferta(s) y desactivar 2 oferta(s) vencida(s) o sin stock.');
  });

  it('error de Postgres: propaga con contexto', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await expect(generarOfertas.resumen({ empresaId: EMPRESA_ID })).rejects.toThrow('generar_ofertas_liquidacion_asistente: timeout');
  });

  it('la RPC responde ok:false sin error de Postgres: usa el mensaje que trae, o uno genérico', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: false, error: 'reglas no configuradas' }, error: null });
    await expect(generarOfertas.resumen({ empresaId: EMPRESA_ID })).rejects.toThrow('reglas no configuradas');
  });
});

describe('generar_ofertas_liquidacion_asistente — execute()', () => {
  it('llama la RPC con p_dry_run:false y devuelve los conteos', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true, creadas: [{ id: 'of1' }, { id: 'of2' }], desactivadas: 1 }, error: null });
    const res = await generarOfertas.execute({ empresaId: EMPRESA_ID });
    expect(dbMock.rpc).toHaveBeenCalledWith('generar_ofertas_liquidacion', { p_empresa_id: EMPRESA_ID, p_dry_run: false });
    expect(res).toEqual({ ok: true, creadas: 2, desactivadas: 1 });
  });

  it('sin creadas/desactivadas: devuelve ceros, no undefined', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const res = await generarOfertas.execute({ empresaId: EMPRESA_ID });
    expect(res).toEqual({ ok: true, creadas: 0, desactivadas: 0 });
  });

  it('error de Postgres: propaga con contexto', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock' } });
    await expect(generarOfertas.execute({ empresaId: EMPRESA_ID })).rejects.toThrow('generar_ofertas_liquidacion_asistente: deadlock');
  });

  it('la RPC responde ok:false sin error de Postgres: usa el mensaje que trae, o uno genérico', async () => {
    dbMock.rpc.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(generarOfertas.execute({ empresaId: EMPRESA_ID })).rejects.toThrow('No se pudo generar las ofertas de liquidación.');
  });
});

describe('guardar_reglas_liquidacion_asistente — resumen()', () => {
  it('sin ningún campo dado: rechaza en vez de proponer un no-op', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    await expect(guardarReglas.resumen({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('No especificaste ningún dato para cambiar de las reglas de liquidación.');
  });

  it('activar/desactivar: arma el texto correspondiente', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    const desactivar = await guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { activo: false } });
    expect(desactivar).toBe('Actualizar las reglas de liquidación: desactivar la liquidación automática.');

    const activar = await guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { activo: true } });
    expect(activar).toBe('Actualizar las reglas de liquidación: activar la liquidación automática.');
  });

  it('cambiar dias_alerta: menciona el nuevo radar', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    const resumen = await guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { dias_alerta: 10 } });
    expect(resumen).toBe('Actualizar las reglas de liquidación: radar a partir de 10 día(s) antes del vencimiento.');
  });

  it('cambiar varios niveles a la vez: junta todos los cambios en un solo texto', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    const resumen = await guardarReglas.resumen({
      empresaId: EMPRESA_ID,
      args: { pct_nivel3: 30, dias_nivel1: 5 },
    });
    expect(resumen).toBe('Actualizar las reglas de liquidación: nivel 1: hasta 5 día(s) restantes, nivel 3: 30% de descuento.');
  });

  it('sin reglas previas configuradas: parte de los defaults del handler', async () => {
    mockDb({ reglasActuales: null });
    const resumen = await guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { pct_nivel1: 20 } });
    expect(resumen).toBe('Actualizar las reglas de liquidación: nivel 1: 20% de descuento.');
  });

  it('porcentaje fuera de rango (>100): rechaza con el nivel y el valor pedido', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    await expect(guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { pct_nivel2: 150 } }))
      .rejects.toThrow('El descuento del nivel 2 tiene que estar entre 0 y 100 (se pidió 150).');
  });

  it('porcentaje fuera de rango (negativo): rechaza', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    await expect(guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { pct_nivel1: -5 } }))
      .rejects.toThrow('El descuento del nivel 1 tiene que estar entre 0 y 100 (se pidió -5).');
  });

  it('orden de días violado (nivel1 <= nivel2): rechaza con los 3 valores resultantes', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    await expect(guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { dias_nivel1: 1 } }))
      .rejects.toThrow('Los días de cada nivel tienen que ir de mayor a menor (nivel 1 > nivel 2 > nivel 3): quedarían 1 > 1 > 0, revisá los valores.');
  });

  it('orden de días violado (nivel2 <= nivel3): rechaza', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    await expect(guardarReglas.resumen({ empresaId: EMPRESA_ID, args: { dias_nivel3: 1 } }))
      .rejects.toThrow('Los días de cada nivel tienen que ir de mayor a menor (nivel 1 > nivel 2 > nivel 3): quedarían 3 > 1 > 1, revisá los valores.');
  });
});

describe('guardar_reglas_liquidacion_asistente — execute()', () => {
  it('hace upsert con los cambios completos + empresa_id + updated_at', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });

    const res = await guardarReglas.execute({ empresaId: EMPRESA_ID, args: { pct_nivel3: 30 } });

    expect(dbMock.from).toHaveBeenCalledWith('reglas_liquidacion');
    expect(res.ok).toBe(true);
    expect(res.reglas).toEqual(expect.objectContaining({ empresa_id: EMPRESA_ID, pct_nivel3: 30 }));
  });

  it('preserva sin tocar los campos que el usuario no pidió cambiar', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT });
    const res = await guardarReglas.execute({ empresaId: EMPRESA_ID, args: { activo: false } });
    expect(res.reglas).toEqual(expect.objectContaining({
      activo: false, dias_alerta: 7, dias_nivel1: 3, pct_nivel1: 10, dias_nivel2: 1, pct_nivel2: 15, dias_nivel3: 0, pct_nivel3: 25,
    }));
  });

  it('error de Postgres en el upsert: propaga con contexto', async () => {
    mockDb({ reglasActuales: REGLAS_DEFAULT, upsertResult: { data: null, error: { message: 'constraint violada' } } });
    await expect(guardarReglas.execute({ empresaId: EMPRESA_ID, args: { activo: false } }))
      .rejects.toThrow('guardar_reglas_liquidacion_asistente: constraint violada');
  });
});
