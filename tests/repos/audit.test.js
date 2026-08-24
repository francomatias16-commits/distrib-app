// tests/repos/audit.test.js
//
// Fase 7 — `lib/repos/audit.js` es un repo nuevo que consolida el acceso a
// `audit_log`, antes repartido en 2 inserts crudos sin try/catch en
// `migracion.js` y 2 funciones locales `auditLog` duplicadas carácter por
// carácter en `proveedores.js`/`maestros.js`. Se testean las dos políticas
// de error por separado, que es lo único que las distingue.
//
// Mismo query builder falso que tests/repos/notif.test.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  registrarAuditoria,
  registrarAuditoriaSilenciosa,
  registrarAuditoriaFinancieraDurable,
  reprocesarAuditoriaPendientes,
} = await import('../../lib/repos/audit.js');

function fakeQuery(result) {
  const obj = {
    insert: vi.fn(() => obj),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

// ── registrarAuditoria ───────────────────────────────────────────────────

describe('registrarAuditoria', () => {
  it('inserta la entrada tal cual, sin transformarla (migracion.js: alta de sesión)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    const entrada = {
      empresa_id: 'e1',
      usuario_id: 'u1',
      tabla: 'clientes',
      accion: 'INSERT',
      registro_id: 'sesion-1',
      datos_despues: { creados: 5, actualizados: 2, errores: 0 },
    };
    await registrarAuditoria(entrada);

    expect(dbMock.from).toHaveBeenCalledWith('audit_log');
    expect(query.insert).toHaveBeenCalledWith(entrada);
  });

  it('propaga la excepción si el insert falla (igual que el original, que no la atrapaba)', async () => {
    dbMock.from.mockImplementation(() => {
      throw new Error('conexión perdida');
    });

    await expect(registrarAuditoria({ tabla: 'x' })).rejects.toThrow('conexión perdida');
  });
});

// ── registrarAuditoriaSilenciosa ─────────────────────────────────────────

describe('registrarAuditoriaSilenciosa', () => {
  it('arma la entrada a partir de los 7 parámetros posicionales (proveedores.js/maestros.js)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await registrarAuditoriaSilenciosa(
      'e1', 'u1', 'proveedores', 'UPDATE', 'p1',
      { activo: true }, { activo: false },
    );

    expect(dbMock.from).toHaveBeenCalledWith('audit_log');
    expect(query.insert).toHaveBeenCalledWith({
      empresa_id: 'e1',
      usuario_id: 'u1',
      tabla: 'proveedores',
      accion: 'UPDATE',
      registro_id: 'p1',
      datos_antes: { activo: true },
      datos_despues: { activo: false },
    });
  });

  it('registro_id siempre se guarda como string (ej. ids numéricos de maestros)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await registrarAuditoriaSilenciosa('e1', 'u1', 'depositos', 'INSERT', 42, null, { nombre: 'Central' });

    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({ registro_id: '42' }),
    );
  });

  it('datos_antes/datos_despues quedan en null cuando no se pasan (alta: antes=null)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await registrarAuditoriaSilenciosa('e1', 'u1', 'proveedores', 'INSERT', 'p2', null, { nombre: 'Nuevo' });

    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({ datos_antes: null, datos_despues: { nombre: 'Nuevo' } }),
    );
  });

  it('nunca lanza, aunque el insert falle (best-effort — "audit no debe romper el flujo")', async () => {
    dbMock.from.mockImplementation(() => {
      throw new Error('conexión perdida');
    });

    await expect(
      registrarAuditoriaSilenciosa('e1', 'u1', 'proveedores', 'INSERT', 'p3', null, {}),
    ).resolves.toBeUndefined();
  });
});

// ── registrarAuditoriaFinancieraDurable (Punto 8, auditoría financiera 2026) ──

describe('registrarAuditoriaFinancieraDurable', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('inserta directo en audit_log y no toca el outbox si el insert funciona', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);

    await registrarAuditoriaFinancieraDurable(
      'e1', 'u1', 'ventas_pos', 'INSERT', 'v1', null, { total: 1000 },
    );

    expect(dbMock.from).toHaveBeenCalledTimes(1);
    expect(dbMock.from).toHaveBeenCalledWith('audit_log');
    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tabla: 'ventas_pos', registro_id: 'v1' }),
    );
  });

  it('si el insert en audit_log devuelve error, encola el mismo registro en audit_log_pendientes', async () => {
    const queryAuditLog = fakeQuery({ data: null, error: { message: 'timeout' } });
    const queryOutbox    = fakeQuery({ data: null, error: null });
    dbMock.from.mockImplementation((tabla) => (tabla === 'audit_log' ? queryAuditLog : queryOutbox));

    await registrarAuditoriaFinancieraDurable(
      'e1', 'u1', 'pagos_proveedor', 'INSERT', 'f1', null, { monto: 500 },
    );

    expect(dbMock.from).toHaveBeenNthCalledWith(1, 'audit_log');
    expect(dbMock.from).toHaveBeenNthCalledWith(2, 'audit_log_pendientes');
    expect(queryOutbox.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tabla: 'pagos_proveedor', registro_id: 'f1', datos_despues: { monto: 500 } }),
    );
  });

  it('nunca lanza, ni siquiera si tanto audit_log como el outbox fallan', async () => {
    const queryAuditLog = fakeQuery({ data: null, error: { message: 'timeout' } });
    const queryOutbox    = fakeQuery({ data: null, error: { message: 'outbox también caído' } });
    dbMock.from.mockImplementation((tabla) => (tabla === 'audit_log' ? queryAuditLog : queryOutbox));

    await expect(
      registrarAuditoriaFinancieraDurable('e1', 'u1', 'ventas_pos', 'INSERT', 'v2', null, {}),
    ).resolves.toBeUndefined();
  });

  it('si el insert directo tira una excepción (no solo error), igual intenta encolar en el outbox', async () => {
    const queryOutbox = fakeQuery({ data: null, error: null });
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'audit_log') throw new Error('conexión perdida');
      return queryOutbox;
    });

    await registrarAuditoriaFinancieraDurable('e1', 'u1', 'ventas_pos', 'UPDATE', 'v3', null, { estado: 'anulada' });

    expect(queryOutbox.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tabla: 'ventas_pos', accion: 'UPDATE', registro_id: 'v3' }),
    );
  });
});

// ── reprocesarAuditoriaPendientes ────────────────────────────────────────
//
// Mismo patrón de claim atómico + lease + tope de reintentos que
// despacharPendientes/reclamarEventos (lib/eventos-dispatcher.js) — se
// prueba el mismo contrato: claim optimista vía update condicionado al
// estado leído, reintento del insert real, y dead-letter al agotar
// intentos.

describe('reprocesarAuditoriaPendientes', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // Arma un mock de `db` que soporta:
  //   - from('audit_log_pendientes').select(...).order(...).limit(...).or(...)  → candidatos
  //   - from('audit_log_pendientes').update(claim).eq(id).eq(estado).select().maybeSingle() → claim optimista
  //   - from('audit_log_pendientes').update(final).eq(id) → marca procesado/error
  //   - from('audit_log').insert(entrada) → según insertResultFn
  function mockDb({ filas, insertResultFn }) {
    const updates = [];

    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'audit_log') {
        return { insert: (entrada) => Promise.resolve(insertResultFn(entrada)) };
      }

      if (tabla === 'audit_log_pendientes') {
        return {
          select: () => ({
            order: () => ({
              limit: () => ({
                or: () => ({
                  then: (resolve) => resolve({ data: filas, error: null }),
                }),
              }),
            }),
          }),
          update: (cambios) => {
            if (cambios.estado === 'procesando') {
              // Rama de claim: dos .eq() encadenados + .select().maybeSingle().
              return {
                eq: (_c1, id) => ({
                  eq: (_c2, estadoLeido) => ({
                    select: () => ({
                      maybeSingle: () => {
                        const fila = filas.find(f => f.id === id);
                        if (!fila || fila.estado !== estadoLeido) {
                          return Promise.resolve({ data: null, error: null }); // perdió la carrera
                        }
                        Object.assign(fila, cambios);
                        updates.push({ id, cambios });
                        return Promise.resolve({ data: { ...fila }, error: null });
                      },
                    }),
                  }),
                }),
              };
            }
            // Rama de marcado final (procesado/error): un solo .eq(), awaited directo.
            return {
              eq: (_c, id) => {
                const fila = filas.find(f => f.id === id);
                if (fila) Object.assign(fila, cambios);
                updates.push({ id, cambios });
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }

      throw new Error(`tabla inesperada en el mock: ${tabla}`);
    });

    return { updates };
  }

  it('reintenta un pendiente y lo marca "procesado" (sin borrarlo) si el insert ahora funciona', async () => {
    const filas = [
      { id: 'p1', empresa_id: 'e1', usuario_id: 'u1', tabla: 'ventas_pos', accion: 'INSERT', registro_id: 'v1', datos_antes: null, datos_despues: { total: 100 }, estado: 'pendiente', intentos: 1 },
    ];
    const { updates } = mockDb({ filas, insertResultFn: () => ({ error: null }) });

    const resultado = await reprocesarAuditoriaPendientes({ limite: 10 });

    expect(resultado.ok).toBe(true);
    expect(resultado.procesados).toBe(1);
    expect(resultado.conError).toBe(0);
    expect(filas[0].estado).toBe('procesado');
    // No se borra la fila — se mantiene por trazabilidad (mismo criterio que eventos_negocio).
    expect(updates.some(u => u.cambios.estado === 'procesado')).toBe(true);
  });

  it('si el insert vuelve a fallar, marca "error" y guarda ultimo_error (sin agotar todavía)', async () => {
    const filas = [
      { id: 'p2', empresa_id: 'e1', usuario_id: 'u1', tabla: 'pagos_proveedor', accion: 'INSERT', registro_id: 'f1', datos_antes: null, datos_despues: {}, estado: 'pendiente', intentos: 2 },
    ];
    const { updates } = mockDb({ filas, insertResultFn: () => ({ error: { message: 'unique_violation' } }) });

    const resultado = await reprocesarAuditoriaPendientes({ limite: 10 });

    expect(resultado.ok).toBe(false);
    expect(resultado.conError).toBe(1);
    expect(resultado.agotados).toBe(0);
    expect(filas[0].estado).toBe('error');
    // Dos updates para el mismo id: el claim ('procesando') y el marcado
    // final ('error') — nos interesa el último.
    expect(updates.filter(u => u.id === 'p2').at(-1).cambios.ultimo_error).toBe('unique_violation');
  });

  it('cuenta como agotado (dead-letter) un pendiente que llega al tope de intentos en este reintento', async () => {
    // intentos en 4 antes de este reintento — el claim lo sube a 5
    // (AUDIT_MAX_INTENTOS), y como sigue fallando, agotados++ en vez de
    // conError++. Con intentos ya en 5 de entrada, reclamarPendientesAuditoria
    // ni siquiera lo reclama (dead-letter real, ver "no reclama..." abajo).
    const filas = [
      { id: 'p3', empresa_id: 'e1', usuario_id: null, tabla: 'cta_cte', accion: 'INSERT', registro_id: 'c1', datos_antes: null, datos_despues: {}, estado: 'error', intentos: 4 },
    ];
    const { updates } = mockDb({ filas, insertResultFn: () => ({ error: { message: 'sigue caído' } }) });

    const resultado = await reprocesarAuditoriaPendientes({ limite: 10, incluirErrores: true });

    expect(resultado.agotados).toBe(1);
    expect(updates.filter(u => u.id === 'p3').at(-1).cambios.ultimo_error).toBe('sigue caído');
  });

  it('no reclama un pendiente que ya agotó el tope de intentos (dead-letter real, queda quieto)', async () => {
    const filas = [
      { id: 'p4', empresa_id: 'e1', usuario_id: null, tabla: 'cta_cte', accion: 'INSERT', registro_id: 'c2', datos_antes: null, datos_despues: {}, estado: 'error', intentos: 5 },
    ];
    const insertSpy = vi.fn(() => ({ error: null }));
    mockDb({ filas, insertResultFn: insertSpy });

    const resultado = await reprocesarAuditoriaPendientes({ limite: 10, incluirErrores: true });

    expect(resultado.procesados).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(filas[0].estado).toBe('error'); // no se tocó
  });
});
