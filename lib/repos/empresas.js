// lib/repos/empresas.js
// Capa de acceso a datos para `empresas`.
//
// `empresas` se accede en 21 queries distintas. Muchos handlers leen `config`
// o `nombre` de esta tabla en cada request. Centralizar evita repetición.

import { db } from './_db.js';

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * Obtiene una empresa por ID.
 */
export async function obtenerEmpresa(empresa_id) {
  const { data } = await db
    .from('empresas')
    .select('*')
    .eq('id', empresa_id)
    .single();
  return data;
}

/**
 * Obtiene solo la config de una empresa (la más usada en handlers).
 */
export async function obtenerConfig(empresa_id) {
  const { data } = await db
    .from('empresas')
    .select('config')
    .eq('id', empresa_id)
    .single();
  return data?.config || {};
}

/**
 * Config de una empresa junto con el `error` crudo de la query (a diferencia
 * de `obtenerConfig`, que devuelve `{}` y nunca expone el error — usado por
 * los pocos endpoints que sí necesitan responder 500 si falla la lectura,
 * en vez de tratar "no hay config" y "la query falló" como lo mismo).
 */
export async function obtenerConfigConError(empresa_id) {
  const { data, error } = await db
    .from('empresas')
    .select('config')
    .eq('id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Lista todas las empresas activas (usado por crons que iteran tenants).
 */
export async function listarEmpresasActivas() {
  const { data, error } = await db
    .from('empresas')
    .select('id, nombre, activa')
    .eq('activa', true)
    .order('nombre');

  if (error) throw new Error(`[EmpresaRepo.listarActivas] ${error.message}`);
  return data;
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * Actualiza la config de una empresa.
 */
export async function actualizarConfig(empresa_id, config) {
  const { error } = await db
    .from('empresas')
    .update({ config })
    .eq('id', empresa_id);

  if (error) throw new Error(`[EmpresaRepo.actualizarConfig] ${error.message}`);
}

/**
 * Solo el logo_url (usado por GET /api/empresa/icon, sin exponer el resto
 * de la fila para ese redirect de alta frecuencia).
 */
export async function obtenerLogoUrl(empresa_id) {
  const { data } = await db
    .from('empresas')
    .select('logo_url')
    .eq('id', empresa_id)
    .single();
  return data?.logo_url || null;
}

/**
 * Persiste la URL pública del logo tras subirlo a Storage. La subida en sí
 * (bucket 'logos') sigue en el handler — esto solo actualiza la fila.
 */
export async function actualizarLogoUrl(empresa_id, url) {
  const { error } = await db
    .from('empresas')
    .update({ logo_url: url })
    .eq('id', empresa_id);

  if (error) throw new Error(`[EmpresaRepo.actualizarLogoUrl] ${error.message}`);
}

/**
 * Datos editables del panel "Datos de la empresa" (incluye `config` crudo;
 * el handler decide qué aplanar/exponer).
 */
export async function obtenerDatosEditables(empresa_id) {
  const { data, error } = await db
    .from('empresas')
    .select('nombre, cuit, domicilio, telefono, email, logo_url, config')
    .eq('id', empresa_id)
    .single();

  if (error) throw new Error(`[EmpresaRepo.obtenerDatosEditables] ${error.message}`);
  return data;
}

/**
 * Actualiza los datos editables (nombre/cuit/domicilio/telefono/email) y
 * devuelve la fila actualizada. Propaga error.code para que el handler
 * distinga el 23505 (CUIT duplicado) del resto.
 */
export async function actualizarDatosEmpresa(empresa_id, datos) {
  const { data, error } = await db
    .from('empresas')
    .update(datos)
    .eq('id', empresa_id)
    .select('nombre, cuit, domicilio, telefono, email, logo_url')
    .single();

  if (error) {
    const e = new Error(`[EmpresaRepo.actualizarDatosEmpresa] ${error.message}`);
    e.code = error.code;
    throw e;
  }
  return data;
}

// NOTA: la subida en sí del logo (Storage, bucket 'logos') sigue en
// lib/handlers/empresa.js (POST /api/empresa/logo) — `.storage.from()` es
// una API de Storage, no de la tabla `empresas`, así que no aplica moverla
// a este repo. Lo que sí vive acá desde Fase 7 es la persistencia de la URL
// pública resultante (`actualizarLogoUrl`) y su lectura (`obtenerLogoUrl`).
//
// Existía acá una función `upsertLogo(empresa_id, datos)` que hacía
// `db.from('logos').upsert(...)`, es decir trataba 'logos' como una tabla
// de la base de datos en vez del bucket de Storage que realmente es. No la
// llamaba nadie (no hay ningún import de EmpresaRepo.upsertLogo en el
// proyecto), así que no estaba rompiendo nada en producción, pero era una
// trampa para el día que alguien la conectara. Se eliminó en la auditoría
// del 2026-06-30 en vez de "arreglarla".
