// lib/repos/fidelizacion.js
// Acceso a datos del programa de fidelización — mitad "cliente" (canje de
// recompensas desde el portal). Migrado desde lib/handlers/fidelizacion.js
// — mismo criterio que los demás repos: acá solo queda I/O contra Supabase
// (tablas `usuarios`, `clientes`, `recompensas`, `saldo_puntos` y el RPC
// canjear_recompensa). La resolución del contexto de sesión y el contrato
// HTTP se quedan en el handler.

import { db } from './_db.js';

export async function obtenerUsuarioPorAuthId(id) {
  return db
    .from('usuarios')
    .select('id, empresa_id, rol, email, cliente_id')
    .eq('id', id)
    .single();
}

export async function obtenerClientePorId(empresa_id, cliente_id) {
  return db
    .from('clientes')
    .select('id, activo')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
}

export async function obtenerClientePorEmail(empresa_id, email) {
  return db
    .from('clientes')
    .select('id, activo')
    .eq('empresa_id', empresa_id)
    .eq('email', email)
    .maybeSingle();
}

export async function listarRecompensasActivas(empresa_id, hoy) {
  return db
    .from('recompensas')
    .select('id, nombre, descripcion, puntos_requeridos, tipo, valor, cantidad_disponible, cantidad_canjeada, fecha_inicio, fecha_fin')
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .or(`fecha_inicio.is.null,fecha_inicio.lte.${hoy}`)
    .or(`fecha_fin.is.null,fecha_fin.gte.${hoy}`)
    .order('puntos_requeridos', { ascending: true });
}

export async function obtenerSaldoPuntos(empresa_id, cliente_id) {
  return db
    .from('saldo_puntos')
    .select('puntos_disponibles, puntos_totales')
    .eq('cliente_id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
}

export async function canjearRecompensaRpc({ empresa_id, cliente_id, recompensa_id }) {
  return db.rpc('canjear_recompensa', {
    p_empresa_id: empresa_id,
    p_cliente_id: cliente_id,
    p_recompensa_id: recompensa_id,
  });
}
