// lib/repos/automatizacion.js
// Capa de acceso a datos para el Panel de Control Centralizado
// (ver lib/handlers/automatizacion.js) — endpoints de push/prefs y los 6
// motores del panel (piloto, cierre, rutas, stock, score, auditoría).
//
// Política de error: igual criterio que el resto de Fase 7 — silenciosa
// donde el handler original no controlaba `error` (que es casi todo acá,
// el handler original solo chequeaba error en la RPC de auditoría),
// propagada donde sí. Los defaults (`|| []`, `|| 0`, `|| {}`) se dejaron
// en el handler tal cual estaban, así que estas funciones devuelven el
// dato "crudo" (puede ser null/undefined) salvo que se indique lo
// contrario.

import { db } from './_db.js';

// ── Push / preferencias ─────────────────────────────────────────────────

/** Alta/actualización de una suscripción Web Push. Silenciosa (fire-and-forget). */
export async function upsertDispositivoPush(payload) {
  await db.from('dispositivos_push').upsert(payload, { onConflict: 'endpoint' });
}

/** Desactiva un dispositivo push del usuario. Silenciosa (fire-and-forget). */
export async function desactivarDispositivoPush(endpoint, usuario_id) {
  await db.from('dispositivos_push')
    .update({ activo: false })
    .eq('endpoint', endpoint)
    .eq('usuario_id', usuario_id);
}

/** Preferencias de notificación automática de la empresa. Silenciosa. */
export async function obtenerPrefsAuto(empresa_id) {
  const { data } = await db.from('notif_prefs_auto').select('*').eq('empresa_id', empresa_id).maybeSingle();
  return data;
}

/** Actualiza una preferencia puntual (columna ya validada por whitelist en el handler). Silenciosa. */
export async function upsertPrefAuto(empresa_id, tipo, valor) {
  await db.from('notif_prefs_auto').upsert({ empresa_id, [tipo]: valor }, { onConflict: 'empresa_id' });
}

// ── Motor 1: Piloto Automático ──────────────────────────────────────────

/** Ciclos de compra próximos a vencer (≤ en7d), con cliente/producto. Silenciosa. */
export async function listarCiclosProximos(empresa_id, en7d) {
  const { data } = await db.from('ciclos_compra')
    .select('id, confianza, proximo_pedido, cantidad_promedio, clientes(razon_social), productos(nombre, unidad)')
    .eq('empresa_id', empresa_id).eq('activo', true)
    .lte('proximo_pedido', en7d)
    .order('proximo_pedido').limit(5);
  return data || [];
}

/** Cantidad total de ciclos de compra activos. Silenciosa. */
export async function contarCiclosActivos(empresa_id) {
  const { count } = await db.from('ciclos_compra')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id).eq('activo', true);
  return count || 0;
}

// ── Motor 2: Cierre Financiero ──────────────────────────────────────────

/** Facturas pendientes o con error AFIP, últimas 20. Silenciosa. */
export async function listarFacturasPendientesCierre(empresa_id) {
  const { data } = await db.from('facturas')
    .select('id, total, estado, fecha_emision')
    .eq('empresa_id', empresa_id)
    .in('estado', ['pendiente', 'error_afip'])
    .order('fecha_emision', { ascending: false }).limit(20);
  return data || [];
}

/** Cobros de los últimos `hace7d`, con cliente, últimos 5. Silenciosa. */
export async function listarCobrosRecientes(empresa_id, hace7d) {
  const { data } = await db.from('cobros')
    .select('id, monto, fecha, clientes(razon_social)')
    .eq('empresa_id', empresa_id)
    .gte('fecha', hace7d)
    .order('fecha', { ascending: false }).limit(5);
  return data || [];
}

/** Cantidad de clientes con bloqueo activo. Silenciosa. */
export async function contarBloqueosActivos(empresa_id) {
  const { count } = await db.from('bloqueos_cliente')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id).eq('activo', true);
  return count || 0;
}

// ── Motor 3: Rutas Dinámicas ─────────────────────────────────────────────

/** Rutas de hoy en adelante, con chofer y GPS. Silenciosa (puede devolver null). */
export async function listarRutasHoy(empresa_id, hoy) {
  const { data } = await db.from('rutas')
    .select('id, estado, fecha, chofer_lat, chofer_lng, chofer_actualizado, usuarios(nombre)')
    .eq('empresa_id', empresa_id).gte('fecha', hoy).order('fecha');
  return data;
}

/** Entregas de un conjunto de rutas. Silenciosa (puede devolver null). */
export async function listarEntregasPorRutas(rutaIds) {
  const { data } = await db.from('entregas')
    .select('id, estado, ruta_id').in('ruta_id', rutaIds);
  return data;
}

// ── Motor 4: Stock Autónomo ──────────────────────────────────────────────

/** Lotes por vencer dentro de en30d, con cantidad > 0. Silenciosa (puede devolver null). */
export async function listarLotesPorVencer(empresa_id, en30d) {
  // FIX (F3-03, auditoría de páginas Fase 3): mismo autocorrección de
  // lotes.estado que en listarLotes() (lib/repos/stock.js) — sin esto,
  // un lote ya vencido pero con estado='activo' desactualizado podía
  // filtrar acá como si estuviera "por vencer" en vez de vencido.
  try {
    await db.rpc('actualizar_estado_lotes', { p_empresa_id: empresa_id });
  } catch (_err) {
    // No crítico — ver mismo fix y comentario en lib/repos/stock.js::listarLotes.
  }

  const { data } = await db.from('lotes')
    .select('id, numero_lote, fecha_vencimiento, cantidad, productos(nombre, unidad)')
    .eq('empresa_id', empresa_id).eq('estado', 'activo')
    .lte('fecha_vencimiento', en30d).gt('cantidad', 0)
    .order('fecha_vencimiento').limit(5);
  return data;
}

/** Órdenes de compra en borrador/enviadas, últimas 3. Silenciosa (puede devolver null). */
export async function listarOrdenesCompraPendientes(empresa_id) {
  const { data } = await db.from('ordenes_compra')
    .select('id, numero, total, estado, created_at')
    .eq('empresa_id', empresa_id).in('estado', ['borrador', 'enviada'])
    .order('created_at', { ascending: false }).limit(3);
  return data;
}

/** Stock agregado (sin empresa_id — se filtra por producto_id ya acotado a la empresa). Silenciosa. */
export async function listarStockPorProductos(productoIds) {
  const { data } = await db.from('stock')
    .select('producto_id, cantidad')
    .in('producto_id', productoIds);
  return data;
}

// ── Motor 5: Score de Clientes ───────────────────────────────────────────

/** Clientes activos con su score. Silenciosa (puede devolver null). */
export async function listarClientesConScore(empresa_id) {
  const { data } = await db.from('clientes')
    .select('id, score_actual, score_categoria, score_actualizado, razon_social')
    .eq('empresa_id', empresa_id).eq('activo', true);
  return data;
}

// ── Motor 6: Auditoría Predictiva ────────────────────────────────────────

/** Envuelve la RPC de detección de anomalías. Handler propaga el error (throw). */
export async function detectarAnomaliasAuditoriaRpc(empresa_id, dias_lookback) {
  const { data, error } = await db.rpc('detectar_anomalias_auditoria', {
    p_empresa_id: empresa_id,
    p_dias_lookback: dias_lookback,
  });
  return { data, error };
}
