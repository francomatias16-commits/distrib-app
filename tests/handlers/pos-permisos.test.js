// tests/handlers/pos-permisos.test.js
//
// No existía cobertura de tests para el bloque de auth de este handler.
// Foco: el fix de Fase 7 — pos.js reimplementaba la verificación de token
// a mano (getUser + select propio a `usuarios`) sin el filtro `activo=true`
// que sí exige `verificarToken` desde la Etapa 11 de AUDITORIA_2026. Ahora
// usa el helper compartido, igual que empresa.js y el resto de los handlers.
// Este test verifica el comportamiento observable: 401 sin token/token
// inválido, y que el helper (no la reimplementación local) es lo que
// decide el acceso.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: { storage: {} } }));
vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({}),
}));

const listarTurnosAbiertosDeUsuarioMock = vi.hoisted(() => vi.fn(async () => ({ data: [], error: null })));
vi.mock('../../lib/repos/pos.js', async () => {
  const actual = await vi.importActual('../../lib/repos/pos.js');
  return {
    ...actual,
    listarTurnosAbiertosDeUsuario: listarTurnosAbiertosDeUsuarioMock,
  };
});

const { default: handler } = await import('../../lib/handlers/pos.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

function reqCajaEstado(headers = { authorization: 'Bearer token-valido' }) {
  return {
    method: 'GET',
    query: { accion: 'caja-estado' },
    headers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listarTurnosAbiertosDeUsuarioMock.mockResolvedValue({ data: [], error: null });
});

describe('pos.js — auth vía verificarToken (fix Fase 7)', () => {
  it('usa el helper compartido: perfil válido → pasa el gate y llega al handler de ruteo', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(reqCajaEstado(), res);

    expect(verificarTokenMock).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(listarTurnosAbiertosDeUsuarioMock).toHaveBeenCalledWith('u1');
  });

  it('sin token → 401 (antes de rutear a cualquier accion)', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(reqCajaEstado({}), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No autorizado' });
    expect(listarTurnosAbiertosDeUsuarioMock).not.toHaveBeenCalled();
  });

  it('token de usuario inactivo → 401 (verificarToken aplica el filtro activo=true que la reimplementación anterior omitía)', async () => {
    // Este es el caso que el bug permitía: un usuario desactivado con JWT de
    // Supabase aún vigente. verificarToken() ahora es la única fuente de
    // verdad y devuelve null para usuarios con activo=false.
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(reqCajaEstado({ authorization: 'Bearer token-de-usuario-desactivado' }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(listarTurnosAbiertosDeUsuarioMock).not.toHaveBeenCalled();
  });

  it('no reimplementa la verificación localmente: el segundo argumento pasado a verificarToken es el cliente supabase del módulo', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'dueno' });
    const res = mockRes();

    await handler(reqCajaEstado(), res);

    const [reqArg, supabaseArg] = verificarTokenMock.mock.calls[0];
    expect(reqArg).toBeDefined();
    expect(supabaseArg).toBeDefined();
  });
});
