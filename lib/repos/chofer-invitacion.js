// lib/repos/chofer-invitacion.js
// Acceso a datos del flujo de invitación de choferes (alta de acceso vía
// link de WhatsApp). Migrado desde lib/handlers/chofer_invitacion.js —
// mismo criterio que maestros.js/reglas-precio.js: acá solo queda I/O
// contra Supabase (tabla `usuarios`, `chofer_invitaciones`, `audit_log` y
// la Admin API de Auth). La orquestación (validaciones, armado del link de
// WhatsApp, y el contrato {ok,status,error} que consumen tanto el handler
// HTTP como lib/asistente-tools.js) se queda en el handler — a diferencia
// de reglas-precio.js, ese contrato ya lo usa un segundo caller (asistente-
// tools) y moverlo rompería esa integración sin necesidad.

import { db } from './_db.js';

// ── usuarios ──────────────────────────────────────────────────────────

/**
 * Trae un usuario (chofer) de la empresa por id. Devuelve null tanto si no
 * existe como si hay error de query — el caller solo necesita distinguir
 * "está" de "no está" (mismo comportamiento que tenía el handler original,
 * que no distinguía error de "no encontrado" en estos puntos).
 */
export async function obtenerUsuarioChofer(empresa_id, usuario_id, campos = 'id, nombre, email, rol, activo') {
  const { data, error } = await db
    .from('usuarios').select(campos)
    .eq('id', usuario_id).eq('empresa_id', empresa_id).single();
  if (error || !data) return null;
  return data;
}

export async function insertarUsuarioChofer({ id, empresa_id, nombre, email, telefono, activo = true }) {
  const { error } = await db
    .from('usuarios')
    .insert({ id, empresa_id, nombre, email, telefono, rol: 'chofer', activo });
  if (error) throw new Error(`[ChoferInvitacionRepo.insertarUsuario] ${error.message}`);
}

export async function marcarUsuarioActivo(usuario_id, activo) {
  await db.from('usuarios').update({ activo }).eq('id', usuario_id);
}

// ── Supabase Auth Admin API ──────────────────────────────────────────

export async function crearUsuarioAuth({ email, password, email_confirm = true }) {
  return db.auth.admin.createUser({ email, password, email_confirm });
}

// Cleanup best-effort: si falla el rollback de un alta a medias, no debe
// tapar el error original que lo disparó (mismo .catch(() => {}) que tenía
// el handler en sus dos puntos de rollback).
export async function eliminarUsuarioAuth(usuario_id) {
  return db.auth.admin.deleteUser(usuario_id).catch(() => {});
}

export async function actualizarPasswordUsuarioAuth(usuario_id, { password, ban_duration }) {
  return db.auth.admin.updateUserById(usuario_id, { password, ban_duration });
}

export async function generarMagicLink({ email, redirectTo }) {
  return db.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });
}

// ── chofer_invitaciones ───────────────────────────────────────────────

export async function insertarInvitacion({ empresa_id, usuario_id, nombre, telefono, token_hash, creado_por, expira_at }) {
  const { data, error } = await db
    .from('chofer_invitaciones')
    .insert({ empresa_id, usuario_id, nombre, telefono, token_hash, creado_por, expira_at })
    .select('id, creado_at, expira_at')
    .single();
  if (error) throw new Error(`[ChoferInvitacionRepo.insertarInvitacion] ${error.message}`);
  return data;
}

export async function listarInvitacionesPorEmpresa(empresa_id, limite = 100) {
  const { data, error } = await db
    .from('chofer_invitaciones')
    .select('id, nombre, telefono, usuario_id, creado_at, expira_at, revocado_at, usado_at')
    .eq('empresa_id', empresa_id)
    .order('creado_at', { ascending: false })
    .limit(limite);
  if (error) throw new Error(`[ChoferInvitacionRepo.listar] ${error.message}`);
  return data || [];
}

export async function revocarInvitacion(empresa_id, invitacion_id) {
  const { data, error } = await db
    .from('chofer_invitaciones')
    .update({ revocado_at: new Date().toISOString() })
    .eq('id', invitacion_id).eq('empresa_id', empresa_id)
    .select('id')
    .single();
  if (error) throw new Error(`[ChoferInvitacionRepo.revocar] ${error.message}`);
  return data;
}

export async function marcarInvitacionUsada(invitacion_id) {
  await db.from('chofer_invitaciones').update({ usado_at: new Date().toISOString() }).eq('id', invitacion_id);
}

export async function validarTokenInvitacion(token_hash) {
  const { data, error } = await db
    .rpc('validar_token_invitacion_chofer', { p_token_hash: token_hash })
    .single();
  if (error) throw new Error(`[ChoferInvitacionRepo.validarToken] ${error.message}`);
  return data;
}

// ── audit_log ─────────────────────────────────────────────────────────

export async function registrarAuditoriaImpersonacion({ empresa_id, usuario_id, chofer_id, chofer_nombre }) {
  await db.from('audit_log').insert({
    empresa_id,
    usuario_id,
    tabla: 'usuarios',
    accion: 'IMPERSONAR_CHOFER',
    registro_id: String(chofer_id),
    datos_despues: { chofer_nombre },
  });
}
