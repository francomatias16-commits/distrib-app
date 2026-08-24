// lib/repos/migracion.js
// Capa de acceso a datos para `lib/handlers/migracion.js` (Fase 7).
//
// Cubre `migracion_sesiones`, `migracion_staging_rows` y
// `migracion_plantillas_mapeo`. Los `.rpc('migracion_*', ...)` del handler
// (31 en total: mapear_bulk, confirmar_*_lote, deshacer_sesion,
// precheck_advertencias) quedan fuera a propósito — encapsulan lógica del
// lado de la base, mismo criterio que en `cta-cte.js`. Los 2
// `.from('audit_log').insert(...)` que quedaban sin migrar ahora usan
// `AuditRepo.registrarAuditoria` (lib/repos/audit.js, Fase 7).
//
// Convención de manejo de error: cuando el handler original hacía
// `if (error) return errorSeguro(...)` la función acá devuelve
// `{ data, error }` para no alterar esa rama. Cuando el original ignoraba
// el error (`const { data } = await ...` sin chequeo), la función acá
// también lo ignora — mismo comportamiento observable, sin "mejorar" de
// paso (checklist Fase 7, punto 2). `obtenerLoteSinMapear` es la única
// excepción: el original SÍ hacía throw en caso de error, así que acá
// también.

import { db } from './_db.js';

// ─── migracion_plantillas_mapeo ────────────────────────────────────────────

export async function listarPlantillasMapeo(empresa_id, entidad) {
  let query = db
    .from('migracion_plantillas_mapeo')
    .select('id, entidad, nombre, mapeo_columnas, deposito_id, lista_precio_id, created_at')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });
  if (entidad) query = query.eq('entidad', entidad);

  return await query;
}

export async function crearPlantillaMapeo(campos) {
  return await db
    .from('migracion_plantillas_mapeo')
    .insert(campos)
    .select('id, entidad, nombre, mapeo_columnas, deposito_id, lista_precio_id, created_at')
    .single();
}

export async function borrarPlantillaMapeo(plantillaId, empresa_id) {
  return await db
    .from('migracion_plantillas_mapeo')
    .delete({ count: 'exact' })
    .eq('id', plantillaId)
    .eq('empresa_id', empresa_id);
}

// ─── migracion_sesiones ─────────────────────────────────────────────────────

/** Busca la sesión por id, sin filtrar empresa_id — el chequeo de pertenencia lo hace el llamador (cargarSesionPropia). */
export async function obtenerSesionPorId(sesionId) {
  const { data } = await db.from('migracion_sesiones').select('*').eq('id', sesionId).single();
  return data;
}

export async function listarSesionesPorEmpresa(empresa_id, { offset = 0, limit = 20 } = {}) {
  const inicio = Math.max(0, Number.parseInt(offset, 10) || 0);
  const cantidad = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
  return await db
    .from('migracion_sesiones')
    .select(
      'id, entidad, nombre_archivo_original, estado, total_filas, filas_validas, filas_con_error, created_at',
      { count: 'exact' }
    )
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .range(inicio, inicio + cantidad - 1);
}

export async function obtenerUltimaSesion(empresa_id) {
  return await db
    .from('migracion_sesiones')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function buscarSesionesDuplicadas(empresa_id, entidad, { hash_contenido, nombre_archivo, total_filas } = {}) {
  const noventaDiasAtras = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  let query = db
    .from('migracion_sesiones')
    .select('id, estado, created_at, total_filas, filas_validas')
    .eq('empresa_id', empresa_id)
    .eq('entidad', entidad)
    .in('estado', ['mapeado', 'validado', 'confirmando', 'completado', 'error'])
    .gte('created_at', noventaDiasAtras)
    .order('created_at', { ascending: false });

  query = hash_contenido
    ? query.eq('hash_contenido', hash_contenido)
    : query.eq('nombre_archivo_original', nombre_archivo).eq('total_filas', total_filas);

  const { data } = await query;
  return data;
}

export async function crearSesion(campos) {
  return await db.from('migracion_sesiones').insert(campos).select('*').single();
}

/** Update genérico por id, sin filtrar empresa_id (confía en cargarSesionPropia previo). */
export async function actualizarSesion(sesionId, cambios) {
  return await db.from('migracion_sesiones').update(cambios).eq('id', sesionId);
}

/** Solo la sesión ignorando el error, igual que hacía confirmarSesion/deshacerSesion con `resumen_advertencias`. */
export async function obtenerResumenAdvertenciasSesion(sesionId) {
  const { data } = await db.from('migracion_sesiones').select('resumen_advertencias').eq('id', sesionId).single();
  return data;
}

// ─── migracion_staging_rows ─────────────────────────────────────────────────

/** Propaga el error del insert (a diferencia de las lecturas silenciosas del repo). */
export async function insertarFilasStaging(lote) {
  const { error } = await db.from('migracion_staging_rows').insert(lote);
  return error || null;
}

export async function contarFilasStaging(sesionId) {
  const { count } = await db
    .from('migracion_staging_rows')
    .select('id', { count: 'exact', head: true })
    .eq('sesion_id', sesionId);
  return count || 0;
}

export async function obtenerFilasSesion(sesionId, { soloErrores = false, offset = 0, limit = 500 } = {}) {
  let query = db
    .from('migracion_staging_rows')
    .select('id, fila_numero, datos_mapeados, es_valida, errores, accion, entidad_existente_id')
    .eq('sesion_id', sesionId);
  if (soloErrores) query = query.eq('es_valida', false);

  return await query
    .order('fila_numero', { ascending: true })
    .range(offset, offset + limit - 1);
}

export async function obtenerFilasPorEntidadResultado(id) {
  return await db
    .from('migracion_staging_rows')
    .select('sesion_id, datos_originales')
    .eq('entidad_resultado_id', id);
}

export async function obtenerSesionOrigenEntreIds(sesionIds, entidad, empresa_id) {
  return await db
    .from('migracion_sesiones')
    .select('id, entidad, nombre_archivo_original, created_at, mapeo_columnas')
    .in('id', sesionIds)
    .eq('entidad', entidad)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });
}

/** Lanza si hay error — a diferencia de las demás lecturas del repo, esta sí propagaba throw en el original. */
export async function obtenerLoteSinMapear(sesionId, limit) {
  const { data, error } = await db
    .from('migracion_staging_rows')
    .select('id, fila_numero, datos_originales')
    .eq('sesion_id', sesionId)
    .is('mapeado_en', null)
    .order('fila_numero', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

/** Claves de dedupe ya vistas en lotes anteriores de la sesión (mapeado_en IS NOT NULL). */
export async function obtenerDatosMapeadosDeSesion(sesionId) {
  const { data } = await db
    .from('migracion_staging_rows')
    .select('datos_mapeados')
    .eq('sesion_id', sesionId)
    .not('mapeado_en', 'is', null);
  return data;
}

/** Todas las filas de la sesión (mapeadas o no), para recalcular el resumen agregado. */
export async function obtenerFilasParaResumen(sesionId) {
  const { data } = await db
    .from('migracion_staging_rows')
    .select('es_valida, errores, accion, datos_mapeados')
    .eq('sesion_id', sesionId);
  return data;
}

/** Devuelve el error (no {error}) — el llamador (prepararPasadaDeMapeo) hace throw directo si viene algo. */
export async function resetearMapeoSesion(sesionId) {
  const { error } = await db
    .from('migracion_staging_rows')
    .update({ mapeado_en: null })
    .eq('sesion_id', sesionId);
  return error || null;
}

/** Busca la fila por id — el chequeo de pertenencia a la sesión/empresa lo hace el llamador. */
export async function obtenerFilaPorId(filaId) {
  return await db
    .from('migracion_staging_rows')
    .select('id, sesion_id, es_valida, entidad_existente_id')
    .eq('id', filaId)
    .single();
}

/** Devuelve el error (no {error}), igual criterio que resetearMapeoSesion. */
export async function actualizarAccionFila(filaId, accion) {
  const { error } = await db.from('migracion_staging_rows').update({ accion }).eq('id', filaId);
  return error || null;
}

export async function obtenerProgresoConfirmacion(sesionId) {
  const { data } = await db
    .from('migracion_staging_rows')
    .select('accion, entidad_resultado_id, error_ejecucion')
    .eq('sesion_id', sesionId)
    .eq('es_valida', true)
    .neq('accion', 'omitir')
    .not('procesado_en', 'is', null);
  return data;
}

export async function obtenerProgresoDeshacer(sesionId) {
  const { data } = await db
    .from('migracion_staging_rows')
    .select('accion, deshecho_error')
    .eq('sesion_id', sesionId)
    .not('entidad_resultado_id', 'is', null)
    .is('error_ejecucion', null)
    .neq('accion', 'omitir')
    .not('deshecho_en', 'is', null);
  return data;
}

/** Limpia procesado_en/error_ejecucion solo de las filas con error de esa sesión (reintentarFallidas). */
export async function reabrirFilasFallidas(sesionId) {
  return await db
    .from('migracion_staging_rows')
    .update({ procesado_en: null, error_ejecucion: null })
    .eq('sesion_id', sesionId)
    .not('error_ejecucion', 'is', null)
    .select('id');
}
