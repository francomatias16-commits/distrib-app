// lib/repos/ciclos.js
// Acceso a datos del Pedido Habitual por WhatsApp (REQ-07), visible desde
// la ficha de cliente. Migrado desde lib/handlers/ciclos.js — mismo
// criterio que los demás repos: acá solo queda I/O contra Supabase (tablas
// `ciclos_compra`, `pedidos`, `pedido_items`, `notif_log`, `clientes` y los
// RPCs generar_pedido_sugerido_cliente / registrar_notif_sugerencia). El
// armado del mensaje de WhatsApp y el contrato HTTP se quedan en el handler.

import { db } from './_db.js';

export async function listarCiclosActivosDeCliente(empresa_id, cliente_id) {
  return db
    .from('ciclos_compra')
    .select(`
      id, producto_id, cantidad_promedio, intervalo_dias,
      ultima_compra, proximo_pedido, confianza, activo,
      productos ( nombre, unidad )
    `)
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .eq('activo', true)
    .order('proximo_pedido', { ascending: true });
}

/**
 * Pedido sugerido pendiente para un cliente (generado automáticamente en
 * las últimas 36h). `desdeIso` se resuelve en el handler (Date.now() - 36h).
 */
export async function buscarPedidoSugeridoReciente(empresa_id, cliente_id, desdeIso) {
  const { data } = await db
    .from('pedidos')
    .select(`
      id, total, confianza_sugerencia, fecha_pedido, ciclo_referencia_id,
      pedido_items ( cantidad, precio_unitario, productos ( nombre, unidad ) )
    `)
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .eq('estado', 'sugerido')
    .eq('generado_automatico', true)
    .gte('fecha_pedido', desdeIso)
    .order('fecha_pedido', { ascending: false })
    .limit(1);
  return data;
}

export async function obtenerUltimaNotifSugerencia(empresa_id, cliente_id) {
  const { data } = await db
    .from('notif_log')
    .select('created_at')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .eq('tipo', 'piloto_sugerencia')
    .order('created_at', { ascending: false })
    .limit(1);
  return data;
}

export async function obtenerClienteParaSugerencia(empresa_id, cliente_id) {
  const { data } = await db
    .from('clientes')
    .select('id, razon_social, nombre_fantasia, telefono, bloqueado')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

export async function generarPedidoSugeridoClienteRpc(empresa_id, cliente_id) {
  return db.rpc('generar_pedido_sugerido_cliente', {
    p_empresa_id: empresa_id,
    p_cliente_id: cliente_id,
  }).single();
}

export async function listarItemsDePedido(pedido_id) {
  const { data } = await db
    .from('pedido_items')
    .select('cantidad, precio_unitario, productos ( nombre, unidad )')
    .eq('pedido_id', pedido_id);
  return data;
}

export async function registrarNotifSugerenciaRpc({ empresa_id, cliente_id, pedido_id, telefono, message_id, payload }) {
  return db.rpc('registrar_notif_sugerencia', {
    p_empresa_id: empresa_id,
    p_cliente_id: cliente_id,
    p_pedido_id:  pedido_id,
    p_telefono:   telefono,
    p_message_id: message_id,
    p_payload:    payload,
  });
}

export async function descartarPedidoSugerido(empresa_id, pedido_id) {
  return db
    .from('pedidos')
    .update({ estado: 'cancelado' })
    .eq('id', pedido_id)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'sugerido'); // solo se puede descartar si está sugerido
}
