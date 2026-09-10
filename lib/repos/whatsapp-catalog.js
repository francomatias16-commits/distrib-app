// lib/repos/whatsapp-catalog.js
// Capa de acceso a datos para la sincronización del catálogo de WhatsApp/
// Commerce Manager (migración 610). Mecanismo replicado del que ya
// funciona en el proyecto Trejo (Edge Functions de Supabase), adaptado acá
// al patrón handler/repo de distrib y a multi-tenant (todo scopeado por
// empresa_id).
//
// Separado de lib/repos/whatsapp-bot.js a propósito: ese repo es el motor
// conversacional (WABA/Cloud API — mensajes, pedidos por chat). Este es el
// catálogo de productos (Commerce Manager/Graph API) — comparten la fila
// de `empresa_whatsapp` (mismo dueño de cuenta de Meta) pero son permisos
// y flujos de Graph API completamente distintos (catalog_management vs.
// whatsapp_business_messaging).

import { db } from './_db.js';

// ── Credenciales del catálogo (columnas catalog_* de empresa_whatsapp) ──

/**
 * Credenciales + estado de conexión del catálogo de Meta de una empresa.
 * `catalog_access_token` viaja cifrado (ver lib/crypto-secrets.js) — el
 * caller (handler) es responsable de descifrarlo antes de usarlo contra
 * la Graph API, nunca se descifra acá adentro.
 */
export async function obtenerCredencialesCatalogo(empresa_id) {
  const { data, error } = await db
    .from('empresa_whatsapp')
    .select('catalog_id, catalog_access_token, catalog_conectado_en, catalog_ultima_sync_en')
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

/**
 * Guarda (upsert parcial) las credenciales del catálogo. A diferencia de
 * guardarCredencialesWhatsapp (whatsapp-bot.js), acá NO hacemos upsert de
 * la fila completa — empresa_whatsapp puede ya existir por el Embedded
 * Signup de mensajería (migración 272) con columnas NOT NULL (waba_id,
 * phone_number_id, access_token) que este flujo no tiene por qué conocer.
 * Por eso este INSERT explícito solo corre si hace falta crear la fila
 * desde cero (empresa que solo quiere catálogo, sin mensajería propia).
 */
export async function guardarCredencialesCatalogo(empresa_id, { catalog_id, catalog_access_token, catalog_conectado_por }) {
  const patch = {
    catalog_id,
    catalog_access_token,
    catalog_conectado_por,
    catalog_conectado_en: new Date().toISOString(),
  };

  const { error: updateError, count } = await db
    .from('empresa_whatsapp')
    .update(patch, { count: 'exact' })
    .eq('empresa_id', empresa_id);

  if (updateError) return { error: updateError };
  if (count > 0) return { error: null };

  // No había fila (empresa sin WhatsApp de mensajería conectado todavía)
  // → se crea una fila "solo catálogo". waba_id/phone_number_id/
  // access_token quedan en blanco a propósito (NOT NULL en la migración
  // 272 original, se relajó para este caso en la 611... ver nota abajo).
  const { error: insertError } = await db
    .from('empresa_whatsapp')
    .insert({ empresa_id, ...patch });
  return { error: insertError };
}

export async function borrarCredencialesCatalogo(empresa_id) {
  const { error } = await db
    .from('empresa_whatsapp')
    .update({
      catalog_id: null,
      catalog_access_token: null,
      catalog_conectado_por: null,
      catalog_conectado_en: null,
      catalog_ultima_sync_en: null,
    })
    .eq('empresa_id', empresa_id);
  return { error };
}

export async function marcarUltimaSincronizacionCatalogo(empresa_id) {
  const { error } = await db
    .from('empresa_whatsapp')
    .update({ catalog_ultima_sync_en: new Date().toISOString() })
    .eq('empresa_id', empresa_id);
  return { error };
}

/**
 * Todas las empresas con catálogo conectado — usado por el cron
 * (_svc=whatsapp-catalog-sync-cron) para recorrerlas una por una, mismo
 * patrón que listarEmpresasActivas (repos/piloto.js).
 */
export async function listarEmpresasConCatalogoConectado() {
  const { data, error } = await db
    .from('empresa_whatsapp')
    .select('empresa_id')
    .not('catalog_id', 'is', null);
  return { data: data || [], error };
}

// ── Productos locales (fuente de verdad de precio/stock) ────────────────

/**
 * Productos activos de la empresa con los campos que le interesan al
 * catálogo (vidriera): nombre, descripción, imagen, precio de referencia.
 * No trae costo ni stock — eso nunca viaja hacia Meta.
 */
export async function listarProductosActivosParaCatalogo(empresa_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, nombre, descripcion, foto_url, precio_base, activo')
    .eq('empresa_id', empresa_id)
    .eq('activo', true);
  return { data: data || [], error };
}

// ── Estado de sincronización por producto (producto_whatsapp_catalog_map) ──

export async function obtenerMapaCatalogo(empresa_id) {
  const { data, error } = await db
    .from('producto_whatsapp_catalog_map')
    .select('producto_id, retailer_id, estado, precio_meta, precio_meta_raw, detalle, origen, ultima_sincronizacion')
    .eq('empresa_id', empresa_id);
  return { data: data || [], error };
}

/**
 * Upsert por lote del estado de sync — se llama una vez al final de cada
 * corrida de sincronizarCatalogoWhatsapp() con todas las filas tocadas,
 * en vez de un UPDATE por producto (evita N round-trips en catálogos
 * grandes). onConflict por `producto_id` (PK de la tabla).
 */
export async function upsertMapaCatalogo(filas) {
  if (!filas?.length) return { error: null };
  const { error } = await db
    .from('producto_whatsapp_catalog_map')
    .upsert(filas, { onConflict: 'producto_id' });
  return { error };
}

/**
 * Resumen para la tarjeta del panel (creados/actualizados/conflictos) —
 * cuenta filas por estado, separado por origen para poder distinguir
 * "conflicto de precio en un producto que ya matcheaba" de otros casos.
 */
export async function obtenerResumenCatalogo(empresa_id) {
  const { data, error } = await db
    .from('producto_whatsapp_catalog_map')
    .select('estado, origen')
    .eq('empresa_id', empresa_id);
  if (error) return { data: null, error };

  const resumen = { total: data.length, ok: 0, conflicto: 0, pendiente: 0, error: 0, importados: 0 };
  for (const fila of data) {
    resumen[fila.estado] = (resumen[fila.estado] || 0) + 1;
    if (fila.origen === 'import_meta') resumen.importados += 1;
  }
  return { data: resumen, error: null };
}

// ── Categoría de destino para productos importados desde Meta ───────────

const CATEGORIA_IMPORTADO_SLUG = 'importado-whatsapp';

/**
 * Devuelve el id de la categoría "Importado de WhatsApp" de la empresa,
 * creándola si hace falta (idempotente vía upsert por nombre+empresa_id).
 * Mismo criterio que sync-catalog-from-meta de Trejo (IMPORT_CATEGORY_SLUG),
 * adaptado a que acá `categorias` es por empresa, no global.
 */
export async function obtenerOCrearCategoriaImportado(empresa_id) {
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
  if (error) throw new Error(`[WhatsappCatalogRepo.obtenerOCrearCategoriaImportado] ${error.message}`);
  return creada.id;
}

/**
 * Crea un producto nuevo a partir de un item del catálogo de Meta que no
 * tenía match local. Queda en la categoría "Importado de WhatsApp" para
 * que el dueño le asigne la categoría real después (mismo flujo que
 * Trejo) y con `activo=true` salvo que Meta lo reporte "out of stock".
 */
export async function crearProductoImportadoDeCatalogo(empresa_id, { nombre, descripcion, foto_url, precio_base, activo, categoria_id }) {
  const { data, error } = await db
    .from('productos')
    .insert({
      empresa_id,
      nombre,
      descripcion: descripcion || null,
      foto_url: foto_url || null,
      precio_base: precio_base ?? 0,
      activo: activo ?? true,
      categoria_id,
    })
    .select('id')
    .single();
  if (error) throw new Error(`[WhatsappCatalogRepo.crearProductoImportadoDeCatalogo] ${error.message}`);
  return data.id;
}
