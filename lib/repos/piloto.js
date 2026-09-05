// lib/repos/piloto.js
// Acceso a datos del Motor de Decisión Autónomo de Pedidos ("Piloto
// Automático", REQ-1). Migrado desde lib/handlers/piloto.js — mismo
// criterio que los demás repos: acá solo queda I/O contra Supabase (tablas
// `empresas`, `pedidos`, `ciclos_compra`, `notif_log` y los RPCs
// generar_pedidos_sugeridos / obtener_sugeridos_para_whatsapp). La
// orquestación (cron, envío de WhatsApp, notificaciones push) se queda en
// el handler.

import { db } from './_db.js';

export async function listarEmpresasActivas({ excluirDemo = false } = {}) {
  let query = db.from('empresas').select('id, nombre').eq('activa', true);
  if (excluirDemo) query = query.eq('es_demo', false);
  const { data } = await query;
  return data || [];
}

export async function generarPedidosSugeridosRpc(empresa_id) {
  return db.rpc('generar_pedidos_sugeridos', { p_empresa_id: empresa_id });
}

// Motor real de detección de ciclos (migración 032): analiza pedidos +
// pedido_items de los últimos 6 meses y hace upsert en ciclos_compra por
// cliente/producto (ON CONFLICT cliente_id+producto_id) cuando hay al
// menos 3 compras del mismo producto por el mismo cliente con intervalo
// positivo. Hallazgo v1063: esta función nunca se llamaba desde ningún
// handler/cron — ciclos_compra estaba en cero para TODOS los tenants
// reales (no solo el demo), así que ni el Piloto Automático de Pedidos
// ni "Clientes en fuga" tenían de dónde leer. RETURNS void — no hay
// conteo que devolver, solo éxito/error por empresa.
export async function calcularCiclosClienteRpc(empresa_id) {
  return db.rpc('calcular_ciclos_cliente', { p_empresa_id: empresa_id });
}

export async function obtenerSugeridosParaWhatsappRpc(empresa_id) {
  return db.rpc('obtener_sugeridos_para_whatsapp', { p_empresa_id: empresa_id });
}

export async function listarPedidosSugeridos(empresa_id, limit) {
  let query = db.from('pedidos')
    .select(`id, total, confianza_sugerencia, created_at,
      clientes(razon_social, telefono),
      pedido_items(cantidad, precio_unitario, productos(nombre, unidad))`)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'sugerido')
    .eq('generado_automatico', true)
    .order('confianza_sugerencia', { ascending: false });
  if (limit != null) query = query.limit(limit);
  return query;
}

export async function contarPedidosSugeridos(empresa_id) {
  return db.from('pedidos').select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .eq('estado', 'sugerido')
    .eq('generado_automatico', true);
}

export async function confirmarPedidoSugerido(empresa_id, pedido_id) {
  return db.from('pedidos')
    .update({ estado: 'confirmado' })
    .eq('id', pedido_id)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'sugerido');
}

export async function descartarPedidoSugerido(empresa_id, pedido_id) {
  return db.from('pedidos')
    .delete()
    .eq('id', pedido_id)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'sugerido');
}

export async function listarCiclosCompraActivos(empresa_id) {
  return db.from('ciclos_compra')
    .select(`id, cantidad_promedio, intervalo_dias, ultima_compra, proximo_pedido, confianza, activo,
      clientes(razon_social), productos(nombre, unidad)`)
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .order('proximo_pedido', { ascending: true });
}

export async function insertarNotifLogWhatsapp({ empresa_id, cliente_id, pedido_id, canal, telefono, message_id, payload }) {
  return db.from('notif_log').insert({
    empresa_id,
    cliente_id,
    pedido_id,
    tipo: 'piloto_sugerencia',
    canal,
    telefono,
    message_id,
    payload,
  });
}
