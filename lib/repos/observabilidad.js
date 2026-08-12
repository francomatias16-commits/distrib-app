// lib/repos/observabilidad.js
// Capa de acceso a datos para la Fase 8 de PLAN_ERP_SINCRONIZACION_2026.md
// (observabilidad continua) — consumida por lib/handlers/admin.js
// (_svc=salud-eventos, _svc=metricas-negocio) y por handleAlertas (nueva
// categoría "evento_error_prolongado").
//
// No hay tabla nueva: todo se lee de eventos_negocio (Fase 1). La
// agregación (conteos por estado/tipo, tiempo promedio de procesamiento,
// pedidos por hora, tiempo pedido→facturación) se hace en JS sobre un
// recorte acotado de filas, no con funciones SQL — mismo criterio de "no
// sobre-diseñar antes de tener volumen real" que ya usa el resto de este
// módulo (ver el comentario sobre el límite de despacharPendientes en
// lib/handlers/notif.js). Si el volumen de eventos crece mucho, esto es lo
// primero que hay que revisar (ver LIMITE_FILAS_AGREGACION abajo).

import { db } from './_db.js';

// Tope de filas que se traen para agregar en memoria. Una empresa activa
// con el flujo piloto (Fase 3) emitiendo pedido_creado/pedido_facturado/
// cliente_en_mora/cheques_por_vencer no debería acercarse a esto en una
// ventana de 7 días; si lo satura, el síntoma correcto es que la respuesta
// queda incompleta (no un timeout), y vale la pena migrar a una función SQL
// de agregación en vez de subir el número a ciegas.
const LIMITE_FILAS_AGREGACION = 5000;

/** Eventos de una empresa en una ventana de tiempo, para armar el resumen de salud. */
export async function obtenerEventosParaResumen(empresa_id, desdeISO) {
  const { data, error } = await db
    .from('eventos_negocio')
    .select('tipo_evento, estado, creado_en, procesado_en')
    .eq('empresa_id', empresa_id)
    .gte('creado_en', desdeISO)
    .order('creado_en', { ascending: false })
    .limit(LIMITE_FILAS_AGREGACION);
  return { data, error };
}

/**
 * Eventos en estado 'error' cuyo último intento (procesado_en) fue hace más
 * de `umbralISO`. El cron de reproceso (handleEventosReprocesarCron,
 * lib/handlers/notif.js) los vuelve a intentar 1 vez por día — si siguen acá
 * es que ese reintento también está fallando, o que el cron no llegó a
 * correr todavía. `procesado_en` siempre está seteado cuando estado='error'
 * (lo pone despacharEvento() en lib/eventos-dispatcher.js), así que no hace
 * falta contemplar el caso NULL.
 */
export async function obtenerEventosEnErrorProlongado(empresa_id, umbralISO, limit) {
  const { data, error } = await db
    .from('eventos_negocio')
    .select('id, tipo_evento, payload, origen, creado_en, procesado_en')
    .eq('empresa_id', empresa_id)
    .eq('estado', 'error')
    .lt('procesado_en', umbralISO)
    .order('procesado_en', { ascending: true })
    .limit(limit);
  return { data, error };
}

/** pedido_creado + pedido_facturado de una empresa en una ventana, para las métricas de negocio. */
export async function obtenerEventosPedidoParaMetricas(empresa_id, desdeISO) {
  const { data, error } = await db
    .from('eventos_negocio')
    .select('tipo_evento, payload, creado_en')
    .eq('empresa_id', empresa_id)
    .in('tipo_evento', ['pedido_creado', 'pedido_facturado'])
    .gte('creado_en', desdeISO)
    .order('creado_en', { ascending: true })
    .limit(LIMITE_FILAS_AGREGACION);
  return { data, error };
}

export { LIMITE_FILAS_AGREGACION };
