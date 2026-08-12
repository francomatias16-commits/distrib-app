// lib/repos/auto-imagenes.js
// Acceso a datos del contador de uso de APIs externas de pago (por ahora,
// solo Serper.dev). Migrado desde lib/handlers/auto-imagenes.js — mismo
// criterio que los demás repos: acá solo queda I/O contra Supabase (tabla
// `contador_uso_apis` + RPC fn_incrementar_contador_api). El resto del
// handler (búsqueda por capas, Storage, normalización de imagen) no es
// acceso a base de datos y se queda donde está.

import { db } from './_db.js';

/**
 * Lee el contador acumulado de uso de un servicio externo (ej. 'serper').
 * Select directo (no RPC): este repo ya corre con service role (bypassa
 * RLS), no hace falta una función para lectura — solo para incrementar de
 * forma atómica (ver incrementarContadorUsoApi).
 */
export async function leerContadorUsoApi(servicio) {
  const { data } = await db
    .from('contador_uso_apis')
    .select('usados, actualizado_at')
    .eq('servicio', servicio)
    .maybeSingle();
  return data;
}

/**
 * Incrementa atómicamente (vía RPC, evita condiciones de carrera con
 * llamadas en paralelo del mismo lote) el contador de uso de un servicio.
 */
export async function incrementarContadorUsoApi(servicio) {
  return db.rpc('fn_incrementar_contador_api', { p_servicio: servicio });
}
