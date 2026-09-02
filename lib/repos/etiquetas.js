// lib/repos/etiquetas.js
// Acceso a datos de `config_etiquetas` (migración 543_config_etiquetas.sql).
// Config singleton por empresa del generador de etiquetas de precio/código
// de barras — ver PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md. Mismo patrón que
// lib/repos/empresas.js (obtenerConfig/actualizarConfig): la fila puede no
// existir todavía (empresa que nunca entró a Admin → Hardware → Etiquetas),
// así que "obtener" devuelve los defaults de la tabla sin escribir nada, y
// "guardar" hace upsert.

import { db } from './_db.js';

export const DEFAULTS_CONFIG_ETIQUETAS = {
  ancho_mm: 50,
  alto_mm: 25,
  columnas: 3,
  margen_mm: 2,
  formato_simbologia: 'auto',
  lista_precio_default_id: null,
  incluir_iva: true,
  mostrar_codigo_interno: true,
  mostrar_promociones: true, // Etapa 4 (543): default de empresa para el tachado promocional
};

const COLUMNAS = 'empresa_id, ancho_mm, alto_mm, columnas, margen_mm, formato_simbologia, lista_precio_default_id, incluir_iva, mostrar_codigo_interno, mostrar_promociones, updated_at';

/**
 * Devuelve la config de etiquetas de la empresa. Si nunca se guardó,
 * devuelve los defaults (sin crear fila — se crea recién en el primer
 * guardarConfigEtiquetas).
 */
export async function obtenerConfigEtiquetas(empresa_id) {
  const { data, error } = await db
    .from('config_etiquetas')
    .select(COLUMNAS)
    .eq('empresa_id', empresa_id)
    .maybeSingle();

  if (error) throw new Error(`[EtiquetasRepo.obtenerConfig] ${error.message}`);
  if (!data) return { empresa_id, ...DEFAULTS_CONFIG_ETIQUETAS };
  return data;
}

/**
 * Upsert de la config de etiquetas. `cambios` puede ser parcial: se
 * combina con la config actual (o los defaults, si es la primera vez)
 * antes de escribir, para no pisar campos que el caller no mandó.
 */
export async function guardarConfigEtiquetas(empresa_id, cambios) {
  const actual = await obtenerConfigEtiquetas(empresa_id);
  const fila = {
    empresa_id,
    ancho_mm: cambios.ancho_mm ?? actual.ancho_mm,
    alto_mm: cambios.alto_mm ?? actual.alto_mm,
    columnas: cambios.columnas ?? actual.columnas,
    margen_mm: cambios.margen_mm ?? actual.margen_mm,
    formato_simbologia: cambios.formato_simbologia ?? actual.formato_simbologia,
    lista_precio_default_id: cambios.lista_precio_default_id !== undefined
      ? cambios.lista_precio_default_id
      : actual.lista_precio_default_id,
    incluir_iva: cambios.incluir_iva ?? actual.incluir_iva,
    mostrar_codigo_interno: cambios.mostrar_codigo_interno ?? actual.mostrar_codigo_interno,
    mostrar_promociones: cambios.mostrar_promociones ?? actual.mostrar_promociones,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from('config_etiquetas')
    .upsert(fila, { onConflict: 'empresa_id' })
    .select(COLUMNAS)
    .single();

  if (error) throw new Error(`[EtiquetasRepo.guardarConfig] ${error.message}`);
  return data;
}

/**
 * Registra una generación de etiquetas (Etapa 8 — plan de comercialización,
 * migración 576). Es lo que cuenta chequear_limite_plan('etiquetas_generaciones')
 * para el tope de trial (1). Fire-and-forget del lado del caller: un error
 * acá no debe tumbar la respuesta real de productos ya resuelta — ver
 * lib/handlers/etiquetas.js.
 */
export async function registrarGeneracionEtiquetas(empresa_id, usuario_id, cantidad_productos) {
  const { error } = await db
    .from('etiquetas_generaciones')
    .insert({ empresa_id, usuario_id, cantidad_productos });

  if (error) throw new Error(`[EtiquetasRepo.registrarGeneracion] ${error.message}`);
}
