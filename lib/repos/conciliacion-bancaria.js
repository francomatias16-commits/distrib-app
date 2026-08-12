// lib/repos/conciliacion-bancaria.js
// Acceso a datos de conciliación bancaria (migración 248_etapa3_conciliacion_bancaria.sql).
// Este repo hace el CRUD de lotes/movimientos y llama a las RPC de matching
// (conciliacion_buscar_candidatos / confirmar_match / deshacer_match /
// auto_matchear_lote); la lógica de scoring vive en SQL, no acá.

import { db } from './_db.js';

const SELECT_MOVIMIENTO = `
  id, empresa_id, lote_id, fecha, descripcion, monto, tipo, estado,
  cobro_id, conciliado_en, conciliado_por, created_at, updated_at,
  cobros(id, monto, fecha, medio, clientes(razon_social))
`;

/**
 * Crea un lote de importación + sus movimientos en una sola operación.
 * `movimientos` ya viene parseado y validado desde el handler (filas del CSV).
 */
export async function crearLoteConMovimientos(empresa_id, usuario_id, nombre_archivo, movimientos) {
  if (!Array.isArray(movimientos) || !movimientos.length) {
    throw new Error('El archivo no tiene movimientos para importar');
  }

  const { data: lote, error: errLote } = await db
    .from('conciliacion_bancaria_lotes')
    .insert({
      empresa_id,
      nombre_archivo: nombre_archivo || 'extracto.csv',
      cantidad_movimientos: movimientos.length,
      usuario_id,
    })
    .select('id, empresa_id, nombre_archivo, cantidad_movimientos, cantidad_conciliados, created_at')
    .single();
  if (errLote) throw new Error(`[ConciliacionRepo.crearLote] ${errLote.message}`);

  const filas = movimientos.map(m => ({
    empresa_id,
    lote_id: lote.id,
    fecha: m.fecha,
    descripcion: m.descripcion || null,
    monto: m.monto,
    tipo: m.tipo,
  }));

  const { error: errMov } = await db.from('conciliacion_bancaria_movimientos').insert(filas);
  if (errMov) {
    // Si falló la carga de movimientos, no dejar un lote vacío huérfano.
    await db.from('conciliacion_bancaria_lotes').delete().eq('id', lote.id);
    throw new Error(`[ConciliacionRepo.crearMovimientos] ${errMov.message}`);
  }

  return lote;
}

export async function listarLotes(empresa_id) {
  const { data, error } = await db
    .from('conciliacion_bancaria_lotes')
    .select('id, empresa_id, nombre_archivo, cantidad_movimientos, cantidad_conciliados, created_at')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(500); // tope de seguridad explícito (antes sin cota) — un lote es una importación manual, no crece por evento automático
  if (error) throw new Error(`[ConciliacionRepo.listarLotes] ${error.message}`);
  return data || [];
}

export async function eliminarLote(empresa_id, lote_id) {
  const { error } = await db
    .from('conciliacion_bancaria_lotes')
    .delete()
    .eq('id', lote_id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`[ConciliacionRepo.eliminarLote] ${error.message}`);
  return { ok: true };
}

/**
 * Lista los movimientos de un lote, y para cada uno pendiente le agrega
 * sus candidatos de match (para no tener que ir a buscarlos uno por uno
 * desde el frontend).
 *
 * FIX (continuación AUDITORIA_FILTROS_v280 §5): la query no tenía NINGÚN
 * límite —ni siquiera un tope de seguridad fijo—, igual que reglas_precio
 * antes de su fix. Se agrega un límite explícito generoso: un lote es un
 * extracto bancario importado de una sola vez (CSV), no una tabla que
 * crece indefinidamente por evento, así que no hace falta paginación de
 * UI, pero sí una cota explícita en vez de ninguna.
 *
 * NOTA (no resuelta en esta tanda, documentada a propósito): por cada
 * movimiento pendiente se dispara una llamada RPC individual a
 * conciliacion_buscar_candidatos (patrón N+1). Con el tope de abajo queda
 * acotado a como mucho unos cientos de llamadas paralelas por carga de
 * pantalla — no es el mismo riesgo que una tabla sin cota, pero si en el
 * futuro los extractos importados crecen en volumen, lo correcto sería
 * una RPC que reciba la lista de movimiento_ids y resuelva los candidatos
 * de todos en una sola consulta (requiere tocar el motor de matching en
 * SQL, fuera del alcance de este fix — no se tocó a ciegas sin ver cómo
 * se usa el scoring en producción).
 */
export async function listarMovimientos(empresa_id, lote_id, { estado } = {}) {
  let q = db
    .from('conciliacion_bancaria_movimientos')
    .select(SELECT_MOVIMIENTO)
    .eq('empresa_id', empresa_id)
    .eq('lote_id', lote_id)
    .order('fecha', { ascending: true })
    .limit(2000);

  if (estado) q = q.eq('estado', estado);

  const { data, error } = await q;
  if (error) throw new Error(`[ConciliacionRepo.listarMovimientos] ${error.message}`);

  const movimientos = data || [];
  const pendientes = movimientos.filter(m => m.estado === 'pendiente');

  const candidatosPorMov = await Promise.all(
    pendientes.map(m => buscarCandidatos(empresa_id, m.id))
  );

  const mapaCandidatos = new Map(pendientes.map((m, i) => [m.id, candidatosPorMov[i]]));
  return movimientos.map(m => ({
    ...m,
    candidatos: m.estado === 'pendiente' ? (mapaCandidatos.get(m.id) || []) : [],
  }));
}

export async function buscarCandidatos(empresa_id, movimiento_id, opts = {}) {
  const { tolerancia_dias = 3, tolerancia_monto = 1 } = opts;
  const { data, error } = await db.rpc('conciliacion_buscar_candidatos', {
    p_movimiento_id: movimiento_id,
    p_empresa_id: empresa_id,
    p_tolerancia_dias: tolerancia_dias,
    p_tolerancia_monto: tolerancia_monto,
  });
  if (error) throw new Error(`[ConciliacionRepo.buscarCandidatos] ${error.message}`);
  return data || [];
}

export async function confirmarMatch(empresa_id, movimiento_id, cobro_id, usuario_id) {
  const { data, error } = await db.rpc('conciliacion_confirmar_match', {
    p_movimiento_id: movimiento_id,
    p_cobro_id: cobro_id,
    p_empresa_id: empresa_id,
    p_usuario_id: usuario_id || null,
  });
  if (error) throw new Error(`[ConciliacionRepo.confirmarMatch] ${error.message}`);
  return data;
}

export async function deshacerMatch(empresa_id, movimiento_id) {
  const { data, error } = await db.rpc('conciliacion_deshacer_match', {
    p_movimiento_id: movimiento_id,
    p_empresa_id: empresa_id,
  });
  if (error) throw new Error(`[ConciliacionRepo.deshacerMatch] ${error.message}`);
  return data;
}

export async function autoMatchearLote(empresa_id, lote_id, usuario_id, opts = {}) {
  const { tolerancia_dias = 1, tolerancia_monto = 0.5 } = opts;
  const { data, error } = await db.rpc('conciliacion_auto_matchear_lote', {
    p_lote_id: lote_id,
    p_empresa_id: empresa_id,
    p_usuario_id: usuario_id || null,
    p_tolerancia_dias: tolerancia_dias,
    p_tolerancia_monto: tolerancia_monto,
  });
  if (error) throw new Error(`[ConciliacionRepo.autoMatchear] ${error.message}`);
  return { conciliados: data ?? 0 };
}

export async function descartarMovimiento(empresa_id, movimiento_id) {
  const { data, error } = await db
    .from('conciliacion_bancaria_movimientos')
    .update({ estado: 'descartado' })
    .eq('id', movimiento_id)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'pendiente')
    .select('id, estado')
    .single();
  if (error) throw new Error(`[ConciliacionRepo.descartar] ${error.message}`);
  if (!data) throw new Error('Movimiento no encontrado o no está pendiente');
  return data;
}
