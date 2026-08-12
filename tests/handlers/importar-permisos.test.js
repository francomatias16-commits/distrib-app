// tests/handlers/importar-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_IMPORTAR original — un único gate ('cargar') para el handler
// entero, tanto para el modo upsert (CSV vía RPC) como para vision/OCR.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

const usuariosQueryMock = vi.hoisted(() => ({
  perfil: null, // { empresa_id, rol } — seteado por cada test
}));

const rpcMock = vi.hoisted(() =>
  vi.fn(async () => ({
    data: { ok: true, resumen: {}, lista_precio_id: 'lp1', errores_detalle: [] },
    error: null,
  }))
);

// FIX (post-migración a repos): importar.js ya no consulta `usuarios` ni
// llama al RPC vía supabase-lazy — delega en obtenerEmpresaYRolPorAuthId()
// (repos/usuarios.js) e importarProductosLoteRpc() (repos/importar.js),
// ambas sobre el cliente singleton de lib/repos/_db.js. supabase-lazy
// queda solo para auth.getUser().
vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => {
      if (tabla === 'usuarios') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: usuariosQueryMock.perfil, error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabla no mockeada en _db: ${tabla}`);
    },
    rpc: rpcMock,
  },
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    auth: authMock,
  }),
}));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

const { default: handler } = await import('../../lib/handlers/importar.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function reqCon({ body = {} } = {}) {
  return {
    method: 'POST',
    query: {},
    body,
    headers: { authorization: 'Bearer token-valido' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = null;
  rpcMock.mockResolvedValue({
    data: { ok: true, resumen: {}, lista_precio_id: 'lp1', errores_detalle: [] },
    error: null,
  });
});

describe('gate único de carga (ROLES_IMPORTAR original)', () => {
  it.each(['dueno', 'admin'])('%s puede cargar (sin 403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqCon({ body: { filas: [{ nombre: 'x' }] } }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(rpcMock).toHaveBeenCalled();
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede cargar (403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqCon({ body: { filas: [{ nombre: 'x' }] } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Solo administradores pueden importar productos',
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    const res = mockRes();
    const req = { method: 'POST', query: {}, body: {}, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
