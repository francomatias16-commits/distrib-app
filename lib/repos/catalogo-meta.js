// lib/repos/catalogo-meta.js
// Capa de acceso a datos para la sincronización con el catálogo de Meta
// (WhatsApp Business / Commerce Manager), por empresa.
//
// Adaptado del prototipo de un solo negocio (Distribuciones Trejo —
// README_INTEGRACION_META.md, tabla singleton `meta_integration`) al
// modelo multi-tenant real de este proyecto: acá SÍ se busca por
// `empresa_id`, igual que ya hace `lib/repos/whatsapp-bot.js` con
// `empresa_whatsapp` para Embedded Signup.
//
// Migración: supabase/migrations/20260910000000_meta_catalog_sync.sql

import { db } from './_db.js';
import { cifrar, descifrar } from '../crypto-secrets.js';

// ── Credenciales por empresa ──────────────────────────────────────────────

/**
 * Credenciales de catálogo de una empresa, si conectó su catálogo de Meta.
 * Devuelve el token ya DESCIFRADO — el caller nunca ve el valor cifrado.
 */
export async function obtenerCredencialesCatalogo(empresa_id) {
  const { data, error } = await db
    .from('empresa_catalogo_meta')
    .select('catalog_id, catalog_access_token, connected_at, ultima_sync_push_at, ultima_sync_pull_at')
    .eq('empresa_id', empresa_id)
    .maybeSingle();

  if (error || !data) return { data: null, error };

  return {
    data: { ...data, catalog_access_token: descifrar(data.catalog_access_token) },
    error: null,
  };
}

/**
 * Guarda (upsert) el catalog_id + token de una empresa al terminar el login
 * de Facebook Login for Business (permiso catalog_management). El token se
 * cifra acá adentro — el handler nunca escribe el valor en texto plano.
 */
export async function guardarCredencialesCatalogo(empresa_id, { catalog_id, catalog_access_token }) {
  const { error } = await db.from('empresa_catalogo_meta').upsert(
    {
      empresa_id,
      catalog_id,
      catalog_access_token: cifrar(catalog_access_token),
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'empresa_id' }
  );
  return { error };
}

export async function marcarSyncPush(empresa_id) {
  await db
    .from('empresa_catalogo_meta')
    .update({ ultima_sync_push_at: new Date().toISOString() })
    .eq('empresa_id', empresa_id);
}

export async function marcarSyncPull(empresa_id) {
  await db
    .from('empresa_catalogo_meta')
    .update({ ultima_sync_pull_at: new Date().toISOString() })
    .eq('empresa_id', empresa_id);
}

export async function borrarCredencialesCatalogo(empresa_id) {
  const { error } = await db.from('empresa_catalogo_meta').delete().eq('empresa_id', empresa_id);
  return { error };
}

// ── Productos (lado panel → Meta) ─────────────────────────────────────────

/**
 * Todos los productos de la empresa con los campos que necesita el
 * catálogo de Meta. Se listan siempre (activos e inactivos): un producto
 * inactivo se manda igual, como "out of stock", en vez de omitirse — así
 * no queda "colgado" en el catálogo de Meta con el último estado que tuvo.
 */
export async function listarProductosParaCatalogoMeta(empresa_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, retailer_id, nombre, descripcion, precio_base, foto_url, activo')
    .eq('empresa_id', empresa_id);
  return { data: data || [], error };
}

export async function obtenerProductoPorRetailerId(empresa_id, retailer_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, retailer_id, precio_base, foto_url')
    .eq('empresa_id', empresa_id)
    .eq('retailer_id', retailer_id)
    .maybeSingle();
  return { data, error };
}

// ── Productos (lado Meta → panel) ─────────────────────────────────────────

export async function listarProductosConRetailerId(empresa_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, retailer_id, nombre, precio_base, foto_url')
    .eq('empresa_id', empresa_id);
  return { data: data || [], error };
}

/**
 * Un producto con los campos que necesita sincronizarProductoConMeta() —
 * v1068, sync puntual panel→Meta tras crear/editar un producto desde
 * lib/handlers/catalogo-meta.js (_svc=sync-producto). Filtrado por
 * empresa_id además de id: un caller nunca puede sincronizar un producto
 * de otra empresa aunque adivine el id.
 */
export async function obtenerProductoParaSync(empresa_id, producto_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, retailer_id, nombre, precio_base, foto_url, activo')
    .eq('empresa_id', empresa_id)
    .eq('id', producto_id)
    .maybeSingle();
  return { data, error };
}

/**
 * IDs de empresa con catálogo de Meta conectado — usado por el cron
 * periódico de importación (v1068, _svc=importar-cron) para recorrer
 * todas las empresas sin depender de un token de usuario logueado.
 */
export async function listarEmpresaIdsConCatalogoConectado() {
  const { data, error } = await db
    .from('empresa_catalogo_meta')
    .select('empresa_id')
    .not('catalog_id', 'is', null);
  return { data: (data || []).map(r => r.empresa_id), error };
}

/** Categoría "Importado de WhatsApp" — se crea sola si no existe. */
export async function obtenerOCrearCategoriaImportadoWhatsapp(empresa_id) {
  const { data: existente } = await db
    .from('categorias')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('nombre', 'Importado de WhatsApp')
    .maybeSingle();

  if (existente) return existente.id;

  const { data: creada, error } = await db
    .from('categorias')
    .insert({ empresa_id, nombre: 'Importado de WhatsApp' })
    .select('id')
    .single();

  if (error) throw error;
  return creada.id;
}

export async function crearProductoDesdeMeta(empresa_id, categoria_id, producto) {
  const { error } = await db.from('productos').insert({
    empresa_id,
    categoria_id,
    retailer_id: producto.retailer_id,
    nombre: producto.nombre,
    descripcion: producto.descripcion || '',
    precio_base: producto.precio_base ?? 0,
    foto_url: producto.foto_url || null,
    activo: producto.activo,
  });
  return { error };
}

export async function actualizarProductoDesdeMeta(producto_id, campos) {
  const { error } = await db.from('productos').update(campos).eq('id', producto_id);
  return { error };
}
