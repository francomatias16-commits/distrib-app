// lib/repos/webhooks.js
// Capa de datos para webhooks_recibidos (577_webhooks_recibidos.sql).
//
// Motor de Integraciones — generalización del log/dedupe/reintentos que
// antes vivía por separado (y de forma parcial) en pagos.js y notif.js.
// Ver la cabecera de la migración para el contexto completo de por qué
// existe esta capa además de la idempotencia de negocio de cada
// integración (payment_id, wa_message_id).

import { db } from './_db.js';

/**
 * Registra la llegada de un webhook ANTES de procesarlo. Es la primera
 * llamada del handler, apenas se validó la firma.
 *
 * Devuelve { id, yaProcesado }. Si yaProcesado === true, el handler debe
 * cortar acá y responder 200 sin reprocesar — el proveedor (Meta/MP) ya
 * mandó este mismo evento antes (reintento propio del proveedor, no
 * nuestro).
 */
export async function registrarWebhookEntrante({
  integracion,
  eventoExternoId,
  tipo = null,
  empresaId = null,
  payload,
  headers = null,
  firmaValida = true,
}) {
  const { data, error } = await db
    .from('webhooks_recibidos')
    .insert({
      integracion,
      evento_externo_id: eventoExternoId,
      tipo,
      empresa_id: empresaId,
      payload,
      headers,
      firma_valida: firmaValida,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation → ya lo habíamos recibido antes (dedupe).
    if (error.code === '23505') {
      return { id: null, yaProcesado: true };
    }
    // Cualquier otro error de escritura: no bloquea el procesamiento del
    // webhook (el log es observabilidad, no el camino crítico) — se loguea
    // y se sigue de largo como si no hubiera log disponible esta vez.
    console.error('[webhooks-log] No se pudo registrar el webhook entrante:', error.message);
    return { id: null, yaProcesado: false };
  }

  return { id: data.id, yaProcesado: false };
}

/**
 * Marca un webhook ya registrado como fallido en el procesamiento
 * posterior a la firma, e incrementa el contador de intentos. Pensado
 * para llamarse desde el catch del handler.
 */
export async function marcarWebhookError(id, errorMensaje) {
  if (!id) return; // el registro inicial pudo haber fallado (best-effort)
  const { error } = await db.rpc('fn_webhook_marcar_error', {
    p_id: id,
    p_error: String(errorMensaje).slice(0, 2000),
  });
  if (error) {
    console.error('[webhooks-log] No se pudo marcar error en webhook', id, ':', error.message);
  }
}

/**
 * Devuelve los webhooks en estado 'error' listos para reintentar (hasta
 * maxIntentos), más viejo primero. Usado por el endpoint/cron de reintento.
 */
export async function listarWebhooksParaReintentar({ integracion = null, maxIntentos = 5, limite = 20 } = {}) {
  let query = db
    .from('webhooks_recibidos')
    .select('id, integracion, evento_externo_id, tipo, payload, headers, intentos')
    .eq('estado', 'error')
    .lt('intentos', maxIntentos)
    .order('recibido_at', { ascending: true })
    .limit(limite);

  if (integracion) query = query.eq('integracion', integracion);

  const { data, error } = await query;
  if (error) {
    console.error('[webhooks-log] No se pudo listar webhooks para reintentar:', error.message);
    return [];
  }
  return data || [];
}
