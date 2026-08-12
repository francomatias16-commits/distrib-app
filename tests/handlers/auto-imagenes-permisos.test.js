// tests/handlers/auto-imagenes-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_PERMITIDOS original — un único gate ('ejecutar') para todo el
// handler. Se ejercita vía GET (solo lee el contador de uso de Serper,
// no dispara ninguna búsqueda real) para no tener que mockear el flujo
// pesado de POST.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

const usuariosQueryMock = vi.hoisted(() => ({
  perfil: null, // { empresa_id, rol } — seteado por cada test
}));

// FIX (post-migración a repos): auto-imagenes.js ya no consulta `usuarios`
// ni `contador_uso_apis` vía supabase-lazy — delega en
// obtenerEmpresaYRolPorAuthId() (repos/usuarios.js) y leerContadorUsoApi()
// (repos/auto-imagenes.js), ambas sobre el cliente singleton de
// lib/repos/_db.js. supabase-lazy queda solo para auth.getUser().
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
      // contador_uso_apis — GET liviano de leerContadorUsoApi()
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
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

vi.mock('../../lib/repos/productos.js', () => ({
  listarProductosSinFoto: vi.fn(async () => []),
  actualizarFotoProducto: vi.fn(async () => ({})),
  contarProductosSinFoto: vi.fn(async () => 0),
}));

const { default: handler } = await import('../../lib/handlers/auto-imagenes.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function reqCon() {
  return { method: 'GET', query: {}, headers: { authorization: 'Bearer token-valido' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = null;
});

describe('gate único de ejecución (ROLES_PERMITIDOS original)', () => {
  it.each(['dueno', 'admin'])('%s puede ejecutar (sin 403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede ejecutar (403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Solo administradores pueden ejecutar esta acción',
    });
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    const res = mockRes();
    const req = { method: 'GET', query: {}, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
