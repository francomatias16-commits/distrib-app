// lib/repos/cliente-direcciones.js
// Capa de acceso a datos para `cliente_direcciones`.
//
// NOTA (v199→v200): esta tabla existía en Supabase desde la migración
// 179_migracion_direcciones.sql (usada por el wizard de migración para
// bulk-insert), pero no tenía NINGÚN repo/handler/UI de administración.
// Un comentario en migracion.js afirmaba erróneamente que el CRUD ya
// existía acá — no era así. Este archivo lo implementa desde cero.
//
// Constraint relevante: UNIQUE (empresa_id, cliente_id, domicilio) — no se
// puede cargar dos veces la misma dirección textual para el mismo cliente.
// Además hay un ÍNDICE ÚNICO PARCIAL (idx_cliente_direcciones_principal_unica
// ON cliente_direcciones(cliente_id) WHERE es_principal) que garantiza a
// nivel DB una sola dirección principal por cliente — no lo tiene
// pg_constraint (no es un constraint declarado), así que no apareció en el
// primer chequeo de constraints y casi se pasa por alto. Es una restricción
// INMEDIATA (no diferible): hay que despriorizar las demás direcciones
// principales del cliente ANTES de insertar/actualizar una nueva, nunca
// después, o el insert/update mismo choca contra el índice.

import { db } from './_db.js';

/**
 * Lista global de direcciones (todas las de la empresa) con el cliente
 * embebido, para la vista admin "Direcciones".
 */
export async function listarDireccionesGlobal(empresa_id, opts = {}) {
  const { cliente_id, busqueda, limit = 300, offset = 0 } = opts;

  let q = db
    .from('cliente_direcciones')
    .select(`
      id, cliente_id, etiqueta, domicilio, localidad, provincia, lat, lng,
      es_principal, notas, created_at,
      clientes(razon_social, nombre_fantasia)
    `)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (cliente_id) q = q.eq('cliente_id', cliente_id);

  const { data, error } = await q;
  if (error) throw new Error(`[DireccionesRepo.listarGlobal] ${error.message}`);

  let rows = data || [];
  if (busqueda) {
    const b = busqueda.toLowerCase();
    rows = rows.filter(r =>
      (r.clientes?.razon_social || '').toLowerCase().includes(b) ||
      (r.clientes?.nombre_fantasia || '').toLowerCase().includes(b) ||
      (r.domicilio || '').toLowerCase().includes(b) ||
      (r.localidad || '').toLowerCase().includes(b)
    );
  }
  return rows;
}

/** Direcciones de un único cliente (para el selector de reparto, etc). */
export async function listarDireccionesPorCliente(empresa_id, cliente_id) {
  const { data, error } = await db
    .from('cliente_direcciones')
    .select('id, etiqueta, domicilio, localidad, provincia, lat, lng, es_principal, notas')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .order('es_principal', { ascending: false })
    .order('created_at');
  if (error) throw new Error(`[DireccionesRepo.listarPorCliente] ${error.message}`);
  return data || [];
}

/**
 * Si se marca es_principal=true, desmarca cualquier otra dirección principal
 * del mismo cliente primero (no hay constraint de DB que lo garantice).
 */
async function despriorizarOtras(empresa_id, cliente_id, exceptoId = null) {
  let q = db
    .from('cliente_direcciones')
    .update({ es_principal: false })
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id);
  if (exceptoId) q = q.neq('id', exceptoId);
  const { error } = await q;
  if (error) throw new Error(`[DireccionesRepo.despriorizar] ${error.message}`);
}

export async function crearDireccion(empresa_id, campos) {
  const { cliente_id, etiqueta, domicilio, localidad, provincia, lat, lng, es_principal, notas } = campos;
  if (!cliente_id) throw new Error('cliente_id requerido');
  if (!domicilio || !domicilio.trim()) throw new Error('domicilio requerido');

  // CLIENTES-002: mismo gap que en upsertPrecioCliente — cliente_id venía
  // del body sin confirmar que perteneciera a esta empresa.
  const { data: cliente } = await db
    .from('clientes').select('id').eq('id', cliente_id).eq('empresa_id', empresa_id).single();
  if (!cliente) throw new Error('Cliente no encontrado');

  // IMPORTANTE: hay un índice único parcial en DB
  // (idx_cliente_direcciones_principal_unica ON cliente_direcciones(cliente_id)
  // WHERE es_principal) que permite como máximo una fila con es_principal=true
  // por cliente. Si se va a insertar una nueva principal, hay que despriorizar
  // las existentes ANTES del insert, o el insert mismo choca contra el índice.
  if (es_principal) await despriorizarOtras(empresa_id, cliente_id);

  const { data, error } = await db
    .from('cliente_direcciones')
    .insert({
      empresa_id,
      cliente_id,
      etiqueta: etiqueta?.trim() || null,
      domicilio: domicilio.trim(),
      localidad: localidad?.trim() || null,
      provincia: provincia?.trim() || null,
      lat: lat ?? null,
      lng: lng ?? null,
      es_principal: !!es_principal,
      notas: notas?.trim() || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('Ese cliente ya tiene cargada esa misma dirección');
    throw new Error(`[DireccionesRepo.crear] ${error.message}`);
  }
  return data;
}

export async function actualizarDireccion(empresa_id, id, cambios) {
  const permitido = ['etiqueta', 'domicilio', 'localidad', 'provincia', 'lat', 'lng', 'es_principal', 'notas'];
  const updates = {};
  for (const k of permitido) if (k in cambios) updates[k] = cambios[k];
  if (typeof updates.domicilio === 'string') updates.domicilio = updates.domicilio.trim();

  // Mismo motivo que en crearDireccion: despriorizar ANTES de aplicar el
  // update, porque el índice único parcial es inmediato (no diferible).
  if (updates.es_principal === true) {
    const { data: actual, error: errActual } = await db
      .from('cliente_direcciones')
      .select('cliente_id')
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .single();
    if (errActual || !actual) throw new Error('Dirección no encontrada');
    await despriorizarOtras(empresa_id, actual.cliente_id, id);
  }

  const { data, error } = await db
    .from('cliente_direcciones')
    .update(updates)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('Ese cliente ya tiene cargada esa misma dirección');
    throw new Error(`[DireccionesRepo.actualizar] ${error.message}`);
  }
  if (!data) throw new Error('Dirección no encontrada');
  return data;
}

export async function eliminarDireccion(empresa_id, id) {
  const { error } = await db
    .from('cliente_direcciones')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`[DireccionesRepo.eliminar] ${error.message}`);
  return { ok: true };
}
