// lib/repos/setup.js
// Acceso a datos de la inicialización del sistema (alta de la primera
// empresa + primer usuario dueño, y el diagnóstico de /api/health).
// Migrado desde lib/handlers/setup.js — mismo criterio que los demás repos:
// acá solo queda I/O contra Supabase (tabla `empresas`, RPC
// setup_inicial_empresa, y la Admin API de Auth). Las validaciones y el
// contrato HTTP se quedan en el handler.

import { db } from './_db.js';

/**
 * Consulta de prueba usada por /api/health para confirmar que la conexión
 * real a Supabase funciona (más allá de que las env vars estén presentes).
 */
export async function verificarConexionSupabase() {
  const { error } = await db
    .from('empresas')
    .select('*', { count: 'exact', head: true });
  return { ok: !error, error };
}

/**
 * Cuenta empresas existentes. Se usa como guarda de "sistema ya
 * inicializado" — tanto en /api/setup/status como como doble chequeo antes
 * de crear la primera empresa en /api/setup/init.
 */
export async function contarEmpresas() {
  const { count } = await db
    .from('empresas')
    .select('*', { count: 'exact', head: true });
  return count ?? 0;
}

// ── Supabase Auth Admin API ──────────────────────────────────────────

export async function crearUsuarioAuth({ email, password }) {
  return db.auth.admin.createUser({ email, password, email_confirm: true });
}

// Rollback best-effort: si falla el RPC de setup, no debe tapar el error
// original que lo disparó.
export async function eliminarUsuarioAuth(usuario_id) {
  return db.auth.admin.deleteUser(usuario_id).catch(() => {});
}

// ── RPC ───────────────────────────────────────────────────────────────

export async function ejecutarSetupInicialEmpresa(params) {
  return db.rpc('setup_inicial_empresa', params);
}
