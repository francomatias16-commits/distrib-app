// tests/handlers/usuarios.test.js
//
// No existía cobertura de tests para este handler. Foco: la migración a
// lib/repos/usuarios.js (Fase 7 del plan ERP) no debe cambiar el contrato
// observable — mismo comportamiento HTTP y las mismas reglas de negocio
// (gate dueno/admin, protección de pares admin/dueno, no dejar la empresa
// sin dueño, no autodesactivarse).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: { storage: {} } }));

vi.mock('../../lib/plan-limits.js', () => ({
  exigirLimitePlan: vi.fn(async () => {}),
  LimitePlanError: class LimitePlanError extends Error {},
}));

const repoMock = vi.hoisted(() => ({
  listarEquipo: vi.fn(async () => []),
  obtenerUsuarioParaEdicion: vi.fn(async () => null),
  obtenerRolYActivo: vi.fn(async () => null),
  contarDuenosActivos: vi.fn(async () => 2),
  insertarUsuario: vi.fn(async (u) => ({ id: 'nuevo-id', ...u })),
  actualizarUsuario: vi.fn(async (empresaId, id, cambios) => ({ id, ...cambios })),
  desactivarUsuario: vi.fn(async () => {}),
  crearUsuarioAuth: vi.fn(async () => ({ data: { user: { id: 'nuevo-id' } }, error: null })),
  eliminarUsuarioAuth: vi.fn(async () => {}),
  banearUsuarioAuth: vi.fn(async () => {}),
  desbanearUsuarioAuth: vi.fn(async () => {}),
  actualizarPasswordAuth: vi.fn(async () => ({ error: null })),
}));
vi.mock('../../lib/repos/usuarios.js', () => repoMock);

const { default: handler, listarUsuariosEquipo } = await import('../../lib/handlers/usuarios.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

const PERFIL_ADMIN = { id: 'admin-1', empresa_id: 'e1', rol: 'admin' };
const PERFIL_DUENO = { id: 'dueno-1', empresa_id: 'e1', rol: 'dueno' };

beforeEach(() => {
  vi.clearAllMocks();
  repoMock.listarEquipo.mockResolvedValue([]);
  repoMock.obtenerUsuarioParaEdicion.mockResolvedValue(null);
  repoMock.obtenerRolYActivo.mockResolvedValue(null);
  repoMock.contarDuenosActivos.mockResolvedValue(2);
  repoMock.crearUsuarioAuth.mockResolvedValue({ data: { user: { id: 'nuevo-id' } }, error: null });
  repoMock.actualizarPasswordAuth.mockResolvedValue({ error: null });
});

describe('GET /api/usuarios — listado (vía repo)', () => {
  it('delega en listarEquipo() del repo, no hace queries propias', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_ADMIN);
    repoMock.listarEquipo.mockResolvedValue([{ id: 'u1', rol: 'vendedor' }]);
    const res = mockRes();

    await handler({ method: 'GET', query: {}, headers: {} }, res);

    expect(repoMock.listarEquipo).toHaveBeenCalledWith('e1');
    expect(res.json).toHaveBeenCalledWith([{ id: 'u1', rol: 'vendedor' }]);
  });

  it('sin token → 401; con token pero rol no gestor → 403', async () => {
    verificarTokenMock.mockResolvedValue(null);
    let res = mockRes();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);

    verificarTokenMock.mockResolvedValue({ id: 'v1', empresa_id: 'e1', rol: 'vendedor' });
    res = mockRes();
    await handler({ method: 'GET', query: {}, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('listarUsuariosEquipo() (usado por asistente-tools.js) mantiene su contrato {ok, usuarios}', async () => {
    repoMock.listarEquipo.mockResolvedValue([{ id: 'u1' }]);
    const resultado = await listarUsuariosEquipo({ empresa_id: 'e1' });
    expect(resultado).toEqual({ ok: true, usuarios: [{ id: 'u1' }] });
  });

  it('listarUsuariosEquipo() traduce un error del repo a {ok:false, status:500}', async () => {
    repoMock.listarEquipo.mockRejectedValue(new Error('boom'));
    const resultado = await listarUsuariosEquipo({ empresa_id: 'e1' });
    expect(resultado.ok).toBe(false);
    expect(resultado.status).toBe(500);
  });
});

describe('POST /api/usuarios — alta', () => {
  function reqAlta(body) {
    return { method: 'POST', query: {}, headers: {}, body };
  }

  it('admin no puede crear otro admin (403), dueno sí puede', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_ADMIN);
    const res = mockRes();
    await handler(reqAlta({ nombre: 'Ana', email: 'ana@x.com', password: 'password1', rol: 'admin' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(repoMock.crearUsuarioAuth).not.toHaveBeenCalled();
  });

  it('alta válida por dueno → inserta vía repo y devuelve 201', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
    const res = mockRes();
    await handler(reqAlta({ nombre: 'Ana', email: 'ana@x.com', password: 'password1', rol: 'vendedor' }), res);

    expect(repoMock.crearUsuarioAuth).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@x.com' })
    );
    expect(repoMock.insertarUsuario).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nuevo-id', empresa_id: 'e1', rol: 'vendedor' })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('si insertarUsuario() falla, hace rollback en Auth (eliminarUsuarioAuth)', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
    repoMock.insertarUsuario.mockRejectedValue(new Error('insert falló'));
    const res = mockRes();
    await handler(reqAlta({ nombre: 'Ana', email: 'ana@x.com', password: 'password1', rol: 'vendedor' }), res);

    expect(repoMock.eliminarUsuarioAuth).toHaveBeenCalledWith('nuevo-id');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('PATCH /api/usuarios — edición', () => {
  function reqPatch(body) {
    return { method: 'PATCH', query: {}, headers: {}, body };
  }

  it('404 si obtenerUsuarioParaEdicion() no encuentra al usuario', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_ADMIN);
    repoMock.obtenerUsuarioParaEdicion.mockResolvedValue(null);
    const res = mockRes();
    await handler(reqPatch({ id: 'u1', nombre: 'X' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('no deja desactivar al último dueño activo (consulta contarDuenosActivos)', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
    repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'd1', rol: 'dueno', empresa_id: 'e1', activo: true });
    repoMock.contarDuenosActivos.mockResolvedValue(1);
    const res = mockRes();

    await handler(reqPatch({ id: 'd1', activo: false }), res);

    expect(repoMock.contarDuenosActivos).toHaveBeenCalledWith('e1');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(repoMock.actualizarUsuario).not.toHaveBeenCalled();
  });

  it('al desactivar, banea en Auth vía el repo (no llamada directa a supabase)', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
    repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'v1', rol: 'vendedor', empresa_id: 'e1', activo: true });
    const res = mockRes();

    await handler(reqPatch({ id: 'v1', activo: false }), res);

    expect(repoMock.actualizarUsuario).toHaveBeenCalledWith('e1', 'v1', { activo: false });
    expect(repoMock.banearUsuarioAuth).toHaveBeenCalledWith('v1');
    expect(repoMock.desbanearUsuarioAuth).not.toHaveBeenCalled();
  });

  describe('restablecer contraseña', () => {
    it('con solo password (sin otros cambios) llama actualizarPasswordAuth y no actualizarUsuario', async () => {
      verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
      repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'v1', rol: 'vendedor', empresa_id: 'e1', activo: true });
      const res = mockRes();

      await handler(reqPatch({ id: 'v1', password: 'nueva1234' }), res);

      expect(repoMock.actualizarUsuario).not.toHaveBeenCalled();
      expect(repoMock.actualizarPasswordAuth).toHaveBeenCalledWith('v1', 'nueva1234');
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it('password de menos de 8 caracteres → 400, no llama actualizarPasswordAuth', async () => {
      verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
      repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'v1', rol: 'vendedor', empresa_id: 'e1', activo: true });
      const res = mockRes();

      await handler(reqPatch({ id: 'v1', password: '1234' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(repoMock.actualizarPasswordAuth).not.toHaveBeenCalled();
    });

    it('admin no puede resetear la contraseña de otro admin/dueño (403)', async () => {
      verificarTokenMock.mockResolvedValue(PERFIL_ADMIN);
      repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'admin-2', rol: 'admin', empresa_id: 'e1', activo: true });
      const res = mockRes();

      await handler(reqPatch({ id: 'admin-2', password: 'nueva1234' }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(repoMock.actualizarPasswordAuth).not.toHaveBeenCalled();
    });

    it('si actualizarPasswordAuth devuelve error → 500', async () => {
      verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
      repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'v1', rol: 'vendedor', empresa_id: 'e1', activo: true });
      repoMock.actualizarPasswordAuth.mockResolvedValue({ error: new Error('fallo supabase') });
      const res = mockRes();

      await handler(reqPatch({ id: 'v1', password: 'nueva1234' }), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('password junto con otros cambios: llama a ambos repos y devuelve el usuario actualizado', async () => {
      verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
      repoMock.obtenerUsuarioParaEdicion.mockResolvedValue({ id: 'v1', rol: 'vendedor', empresa_id: 'e1', activo: true });
      const res = mockRes();

      await handler(reqPatch({ id: 'v1', nombre: 'Nuevo Nombre', password: 'nueva1234' }), res);

      expect(repoMock.actualizarUsuario).toHaveBeenCalledWith('e1', 'v1', { nombre: 'Nuevo Nombre' });
      expect(repoMock.actualizarPasswordAuth).toHaveBeenCalledWith('v1', 'nueva1234');
      expect(res.json).toHaveBeenCalledWith({ id: 'v1', nombre: 'Nuevo Nombre' });
    });
  });
});

describe('DELETE /api/usuarios?id= — alias de desactivar', () => {
  function reqDelete(id) {
    return { method: 'DELETE', query: { id }, headers: {} };
  }

  it('no permite autodesactivarse', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_ADMIN);
    const res = mockRes();
    await handler(reqDelete('admin-1'), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(repoMock.desactivarUsuario).not.toHaveBeenCalled();
  });

  it('admin no puede desactivar a otro admin/dueno (403)', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_ADMIN);
    repoMock.obtenerRolYActivo.mockResolvedValue({ rol: 'dueno', activo: true });
    const res = mockRes();
    await handler(reqDelete('dueno-1'), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(repoMock.desactivarUsuario).not.toHaveBeenCalled();
  });

  it('desactivación válida → llama desactivarUsuario() del repo y banea en Auth', async () => {
    verificarTokenMock.mockResolvedValue(PERFIL_DUENO);
    repoMock.obtenerRolYActivo.mockResolvedValue({ rol: 'vendedor', activo: true });
    const res = mockRes();

    await handler(reqDelete('v1'), res);

    expect(repoMock.desactivarUsuario).toHaveBeenCalledWith('e1', 'v1');
    expect(repoMock.banearUsuarioAuth).toHaveBeenCalledWith('v1');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
