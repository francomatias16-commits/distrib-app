// lib/repos/scores.js
// Capa de acceso a datos para `scores_cliente`, `alertas_score`, `reglas_score`.
//
// Desacopla las queries de score del handler score.js (que tiene lógica de negocio
// como ofrecerPlanDePago, cooldowns, etc.).

import { db } from './_db.js';

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * Historial de scores de un cliente (últimos N).
 */
export async function historialScore(empresa_id, cliente_id, limit = 30) {
  const { data, error } = await db
    .from('scores_cliente')
    .select('score, score_pagos, score_frecuencia, score_deuda, score_devolucion, motivo_cambio, created_at')
    .eq('cliente_id', cliente_id)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`[ScoreRepo.historial] ${error.message}`);
  return data;
}

/**
 * Alertas de score no resueltas de una empresa.
 * Por defecto limita a un puñado de resultados (uso típico: widget del
 * dashboard). Pasar `limit: null` para traer todas (uso típico: página
 * dedicada con paginación propia).
 */
export async function alertasPendientes(empresa_id, { limit = 5 } = {}) {
  let query = db
    .from('alertas_score')
    .select(`
      id, cliente_id, score_anterior, score_nuevo, mensaje, created_at,
      clientes(razon_social, telefono, usuario_id)
    `)
    .eq('empresa_id', empresa_id)
    .eq('resuelta', false)
    .order('created_at', { ascending: false });

  if (limit != null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(`[ScoreRepo.alertasPendientes] ${error.message}`);
  return data;
}

/**
 * Cantidad total de alertas de score no resueltas (para mostrar
 * "Ver todas (N)" sin traer todas las filas).
 */
export async function contarAlertasPendientes(empresa_id) {
  const { count, error } = await db
    .from('alertas_score')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .eq('resuelta', false);

  if (error) throw new Error(`[ScoreRepo.contarAlertasPendientes] ${error.message}`);
  return count || 0;
}

/**
 * Reglas de score de una empresa (puede no existir → retorna null).
 */
export async function obtenerReglas(empresa_id) {
  const { data } = await db
    .from('reglas_score')
    .select('*')
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/**
 * Vista `v_cobranza_priorizada`: clientes ordenados por cobrabilidad para
 * priorizar el trabajo de cobranza (score.js: acción `cobranza-priorizada`).
 */
export async function cobranzaPriorizada(empresa_id, { prioridad } = {}) {
  let query = db
    .from('v_cobranza_priorizada')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('score_cobrabilidad', { ascending: true })
    .order('saldo_pendiente', { ascending: false });

  if (prioridad) query = query.eq('prioridad', prioridad);
  query = query.limit(500); // tope de seguridad

  const { data, error } = await query;
  if (error) throw new Error(`[ScoreRepo.cobranzaPriorizada] ${error.message}`);
  return data || [];
}

// ── RPC ───────────────────────────────────────────────────────────────────────

/**
 * Llama a la función SQL calcular_score_cliente.
 */
export async function calcularScore(empresa_id, cliente_id, motivo = 'recalculo') {
  const { data, error } = await db.rpc('calcular_score_cliente', {
    p_cliente_id: cliente_id,
    p_empresa_id: empresa_id,
    p_motivo:     motivo,
  });
  if (error) throw new Error(`[ScoreRepo.calcular] ${error.message}`);
  return data;
}

/**
 * Recalcula scores de todos los clientes activos de una empresa.
 * Retorna { actualizados, errores }.
 */
export async function recalcularTodos(empresa_id, motivo = 'recalculo_batch') {
  const { data: clientes } = await db
    .from('clientes')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('activo', true);

  let actualizados = 0;
  let errores = 0;

  for (const c of (clientes || [])) {
    try {
      await calcularScore(empresa_id, c.id, motivo);
      actualizados++;
    } catch (err) {
      console.error(`[ScoreRepo.recalcularTodos] cliente ${c.id}:`, err.message);
      errores++;
    }
  }

  return { actualizados, errores };
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * Upsert de reglas de score de una empresa.
 */
export async function guardarReglas(empresa_id, reglas) {
  const { data, error } = await db
    .from('reglas_score')
    .upsert({ empresa_id, ...reglas }, { onConflict: 'empresa_id' })
    .select()
    .single();

  if (error) throw new Error(`[ScoreRepo.guardarReglas] ${error.message}`);
  return data;
}

/**
 * Marca una alerta de score como resuelta.
 */
export async function resolverAlerta(empresa_id, alerta_id) {
  const { error } = await db
    .from('alertas_score')
    .update({ resuelta: true })
    .eq('id', alerta_id)
    .eq('empresa_id', empresa_id);

  if (error) throw new Error(`[ScoreRepo.resolverAlerta] ${error.message}`);
}
