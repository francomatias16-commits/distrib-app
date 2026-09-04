// lib/repos/proveedores.js
// Capa de acceso a datos para la entidad `proveedores`.
//
// Arranque mínimo (Fase 7, paso migracion.js): todavía no hay handler
// `proveedores.js` migrado, así que este repo por ahora solo cubre lo que
// necesita `lib/handlers/migracion.js` — unifica 3 llamadas idénticas de
// dedupe contra la tabla real al mapear una sesión de proveedores.

import { db } from './_db.js';

/** Proveedores de la empresa para el dedupe de mapeo (por CUIT o nombre). */
export async function listarProveedoresParaDedupePorEmpresa(empresa_id) {
  const { data } = await db
    .from('proveedores')
    .select('id, cuit, razon_social, nombre_fantasia')
    .eq('empresa_id', empresa_id);
  return data;
}

// ══════════════════════════════════════════════════════════════════════════
// ── CRUD del handler principal (lib/handlers/proveedores.js) ────────────
// ══════════════════════════════════════════════════════════════════════════

/** Perfil (id, empresa_id, rol, nombre) para autorizar el handler de proveedores. */
export async function obtenerPerfilProveedores(user_id) {
  const { data } = await db
    .from('usuarios').select('id, empresa_id, rol, nombre').eq('id', user_id).single();
  return data;
}

/** Proveedor por id, acotado a la empresa. */
export async function obtenerProveedorPorId(id, empresa_id) {
  const { data, error } = await db
    .from('proveedores')
    .select('*')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Listado paginado con filtro de `activo` y búsqueda server-side por
 * razón social / nombre de fantasía / CUIT. `busquedaLike` ya viene armado
 * con el patrón `%...%` y los caracteres reservados de PostgREST escapados.
 */
export async function listarProveedoresFiltrados(empresa_id, { activo, busquedaLike, offset, limit }) {
  let q = db
    .from('proveedores')
    .select('*', { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .order('razon_social')
    .range(offset, offset + limit - 1);

  if (activo === 'true')  q = q.eq('activo', true);
  if (activo === 'false') q = q.eq('activo', false);

  if (busquedaLike) {
    q = q.or(`razon_social.ilike.${busquedaLike},nombre_fantasia.ilike.${busquedaLike},cuit.ilike.${busquedaLike}`);
  }

  const { data, error, count } = await q;
  return { data, error, count };
}

/** Crea un proveedor nuevo. */
export async function crearProveedor(campos) {
  const { data, error } = await db
    .from('proveedores')
    .insert(campos)
    .select()
    .single();
  return { data, error };
}

/** Snapshot "antes" para auditoría, previo a un UPDATE. */
export async function obtenerProveedorAntes(id, empresa_id) {
  const { data } = await db
    .from('proveedores')
    .select('*').eq('id', id).eq('empresa_id', empresa_id).single();
  return data;
}

/** Actualiza campos ya sanitizados/permitidos de un proveedor. */
export async function actualizarProveedorCampos(id, empresa_id, campos) {
  const { data, error } = await db
    .from('proveedores')
    .update(campos)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();
  return { data, error };
}

/** Soft-delete: marca el proveedor como inactivo. */
export async function desactivarProveedor(id, empresa_id) {
  const { error } = await db
    .from('proveedores')
    .update({ activo: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  return { error };
}

/** Valida que un proveedor exista y pertenezca a la empresa (para crear OC). */
export async function obtenerProveedorIdValido(empresa_id, proveedor_id) {
  const { data } = await db
    .from('proveedores')
    .select('id')
    .eq('id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}
