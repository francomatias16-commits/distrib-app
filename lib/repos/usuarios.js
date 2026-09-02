// lib/repos/usuarios.js
// Acceso a datos del equipo interno de la empresa (dueno/admin/vendedor/
// depositero/chofer/contador — el rol 'cliente' queda fuera, se gestiona
// desde repos/clientes.js). Migrado desde lib/handlers/usuarios.js — mismo
// criterio que chofer-invitacion.js: acá solo queda I/O contra Supabase
// (tabla `usuarios` + Admin API de Auth). Las reglas de negocio (quién
// puede tocar a quién, límite de plan, no dejar la empresa sin dueño)
// se quedan en el handler.

import { db } from './_db.js';

const CAMPOS_USUARIO = 'id, nombre, email, rol, telefono, activo, created_at';

export async function listarEquipo(empresa_id) {
  const { data, error } = await db
    .from('usuarios')
    .select(CAMPOS_USUARIO)
    .eq('empresa_id', empresa_id)
    .neq('rol', 'cliente')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`[UsuariosRepo.listarEquipo] ${error.message}`);
  return data || [];
}

/**
 * empresa_id + rol de un usuario por su id de Supabase Auth, sin filtrar por
 * empresa (todavía no se conoce — es justo lo que resuelve esta consulta).
 * Fase 7: usada por handlers que validan el token de Auth y necesitan el
 * perfil antes de aplicar `puede()` (ej. auto-imagenes.js, busqueda.js).
 */
export async function obtenerEmpresaYRolPorAuthId(id) {
  const { data } = await db.from('usuarios').select('empresa_id, rol').eq('id', id).single();
  return data;
}

/**
 * Perfil + nombre de la empresa (join), por id de Supabase Auth. Fase 7:
 * usada por saas.js para el gate de superadmin/dueño de la empresa raíz
 * (necesita `empresas(nombre)`, a diferencia de obtenerEmpresaYRolPorAuthId
 * que solo trae empresa_id/rol).
 */
export async function obtenerPerfilConEmpresa(id) {
  const { data } = await db
    .from('usuarios')
    .select('id, rol, empresa_id, empresas(nombre)')
    .eq('id', id)
    .single();
  return data;
}

export async function obtenerUsuarioParaEdicion(empresa_id, id) {
  const { data, error } = await db
    .from('usuarios')
    .select('id, rol, empresa_id, activo')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  if (error || !data) return null;
  return data;
}

export async function obtenerRolYActivo(empresa_id, id) {
  const { data, error } = await db
    .from('usuarios')
    .select('rol, activo')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  if (error || !data) return null;
  return data;
}

export async function contarDuenosActivos(empresa_id) {
  const { count } = await db
    .from('usuarios')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .eq('rol', 'dueno')
    .eq('activo', true);
  return count || 0;
}

export async function insertarUsuario({ id, empresa_id, nombre, email, rol, telefono, activo = true }) {
  const { data, error } = await db
    .from('usuarios')
    .insert({ id, empresa_id, nombre, email, rol, telefono, activo })
    .select(CAMPOS_USUARIO)
    .single();
  if (error) throw new Error(`[UsuariosRepo.insertarUsuario] ${error.message}`);
  return data;
}

export async function actualizarUsuario(empresa_id, id, cambios) {
  const { data, error } = await db
    .from('usuarios')
    .update(cambios)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select(CAMPOS_USUARIO)
    .single();
  if (error) throw new Error(`[UsuariosRepo.actualizarUsuario] ${error.message}`);
  return data;
}

export async function desactivarUsuario(empresa_id, id) {
  const { error } = await db
    .from('usuarios')
    .update({ activo: false })
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`[UsuariosRepo.desactivarUsuario] ${error.message}`);
}

// ── Supabase Auth Admin API ──────────────────────────────────────────

export async function crearUsuarioAuth({ email, password, email_confirm = true }) {
  return db.auth.admin.createUser({ email, password, email_confirm });
}

// Cleanup best-effort: si falla el rollback de un alta a medias, no debe
// tapar el error original que lo disparó (mismo .catch(() => {}) que tenía
// el handler).
export async function eliminarUsuarioAuth(id) {
  return db.auth.admin.deleteUser(id).catch(() => {});
}

export async function banearUsuarioAuth(id) {
  return db.auth.admin.updateUserById(id, { ban_duration: '87600h' }).catch(() => {});
}

export async function desbanearUsuarioAuth(id) {
  return db.auth.admin.updateUserById(id, { ban_duration: 'none' }).catch(() => {});
}

// Restablecimiento de contraseña por el dueño/admin (no hay email de reset
// propio para usuarios internos — ver comentario en el handler PATCH).
export async function actualizarPasswordAuth(id, password) {
  return db.auth.admin.updateUserById(id, { password });
}

// FIX v957 (misma variante del hallazgo Etapa 2b de auth.js): cuando un
// dueño/admin resetea la contraseña de OTRO usuario desde este handler
// (PATCH con password), tampoco se revocaban sus refresh_tokens — un
// refresh token robado seguía siendo válido hasta 7 días aunque el
// dueño/admin "solucionara" el problema resetéandole la clave al empleado.
// Mismo mecanismo que revocarSesionesUsuario() en auth.js (única tabla
// refresh_tokens del proyecto, no hay sesiones nativas de Supabase Auth acá
// porque el login del equipo interno usa el JWT/cookie propio). Falla en
// silencio con log — no debe tumbar la respuesta 200 de un reset de
// contraseña que ya se aplicó correctamente en Auth.
export async function revocarSesionesRefreshTokens(usuarioId) {
  try {
    await db.from('refresh_tokens').update({ revocado: true })
      .eq('usuario_id', usuarioId).eq('revocado', false);
  } catch (err) {
    console.error('[UsuariosRepo] Error revocando sesiones tras reset de contraseña:', err.message);
  }
}
