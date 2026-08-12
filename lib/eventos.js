// lib/eventos.js
// Fase 1 del plan de sincronización ERP (PLAN_ERP_SINCRONIZACION_2026.md):
// tabla `eventos_negocio` (migración 431_fase1_eventos_negocio) + helpers
// mínimos para emitir eventos y para que la Fase 3 (despachador) sepa si
// una empresa ya migró de las llamadas directas al despachador.

import { crearClienteSupabaseLazy } from './supabase-lazy.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

// emitirEvento(): inserta una fila en eventos_negocio. No lanza — un fallo
// acá no debe frenar el flujo de negocio que lo dispara (ver callers, todos
// con .catch). Devuelve la fila creada o null si falló.
export async function emitirEvento({ empresaId, tipoEvento, payload, origen }) {
  const { data, error } = await supabase
    .from('eventos_negocio')
    .insert({
      empresa_id: empresaId,
      tipo_evento: tipoEvento,
      payload: payload || {},
      origen: origen || null,
    })
    .select()
    .single();

  if (error) {
    console.error(`[EVENTOS] error emitiendo evento "${tipoEvento}" (empresa ${empresaId}):`, error);
    return null;
  }
  return data;
}

// usaDespachadorEventos(): lee el flag `fase3_despachador_eventos` de
// empresas.config (jsonb). Fail-safe: cualquier error de lectura devuelve
// false, así el caller cae siempre al camino directo ya validado en vez de
// arriesgarse a un despachador mal leído.
export async function usaDespachadorEventos(empresaId) {
  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('config')
      .eq('id', empresaId)
      .maybeSingle();

    if (error || !data) return false;
    return data.config?.fase3_despachador_eventos === true;
  } catch (err) {
    console.error('[EVENTOS] error leyendo flag fase3_despachador_eventos:', err);
    return false;
  }
}
