// lib/eventos.js
// Fase 1 del plan de sincronización ERP (PLAN_ERP_SINCRONIZACION_2026.md):
// tabla `eventos_negocio` (migración 431_fase1_eventos_negocio) + helpers
// mínimos para emitir eventos y para que la Fase 3 (despachador) sepa si
// una empresa ya migró de las llamadas directas al despachador.

import { AsyncLocalStorage } from 'node:async_hooks';
import { crearClienteSupabaseLazy } from './supabase-lazy.js';

const supabase = crearClienteSupabaseLazy(() => [
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
]);

// origenALS: contexto async para marcar de dónde vino la llamada sin tener
// que agregar un parámetro `origen` en cada uno de los ~20 tools de
// lib/asistente-tools/*.js. ejecutarTool()/resolverAccionPendiente() (en
// asistente-tools/index.js) envuelven tool.execute() con
// conOrigenAsistenteVoz(), así que cualquier emitirEvento() que ocurra
// dentro de ese execute() — sin importar cuántas capas de handler/repo
// atraviese — hereda `origen: 'asistente_voz'` automáticamente si el
// caller no pasó uno explícito. Fuera de ese contexto (UI normal, cron,
// webhooks) el valor es undefined y el comportamiento no cambia.
// Motivo: checklist §6 de PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md pide
// "datos de uso real (cuántas veces se usó la tool por voz vs. a mano)"
// para la Fase A, y sin este flag esa comparación es imposible de
// responder con una query — ninguna acción quedaba distinguida.
const origenALS = new AsyncLocalStorage();

export function conOrigenAsistenteVoz(fn) {
  return origenALS.run('asistente_voz', fn);
}

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
      origen: origen || origenALS.getStore() || null,
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
