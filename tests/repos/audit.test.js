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

const { registrarAuditoria, registrarAuditoriaSilenciosa } = await import('../../lib/repos/audit.js');

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
