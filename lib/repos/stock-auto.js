// lib/repos/stock-auto.js
// Capa de acceso a datos para lib/handlers/stock-auto.js — REQ-4: Stock
// Vivo con Reposición Autónoma (análisis de stock, generación automática
// de órdenes de compra, alertas).
//
// Política de error: igual criterio que el resto de Fase 7 — silenciosa
// donde el handler original no controlaba `error` (la mayoría acá),
// propagada donde sí había chequeo explícito (vista-previa vía RPC, y el
// insert de la orden de compra que el handler valida con `if (errOC ||
// !orden)`).
//
// `notifAuto` (lib/handlers/_auto-push.js) sigue recibiendo `sb` (cliente
// Supabase directo) tal cual — es un helper compartido por ~10 handlers
// distintos de automatización, no propio de stock-auto.js; migrarlo queda
// fuera de alcance de este paso (mismo criterio que el bucket de Storage
// en portal_proveedor.js).

import { db } from './_db.js';

/** Empresas activas, para el análisis batch del cron. Silenciosa. */
export async function listarEmpresasActivas() {
  const { data } = await db.from('empresas').select('id').eq('activa', true);
  return data || [];
}

/** Envuelve la RPC de análisis de stock autónomo. Handler decide si propaga el error. */
export async function analizarStockAutonomoRpc(empresa_id) {
  const { data, error } = await db.rpc('analizar_stock_autonomo', { p_empresa_id: empresa_id });
  return { data, error };
}

/** Alertas de stock activas (no resueltas) de la empresa. Handler propaga el error (throw). */
export async function listarAlertasStockActivas(empresa_id) {
  const { data, error } = await db.from('alertas_stock')
    .select('id, tipo, dias_restantes, resuelta, created_at, producto_id, productos(nombre, unidad)')
    .eq('empresa_id', empresa_id)
    .eq('resuelta', false)
    .order('dias_restantes', { ascending: true });
  if (error) throw error;
  return data;
}

/** Marca una alerta como resuelta manualmente. Silenciosa (fire-and-forget). */
export async function resolverAlertaStock(alerta_id, empresa_id) {
  await db.from('alertas_stock')
    .update({ resuelta: true })
    .eq('id', alerta_id)
    .eq('empresa_id', empresa_id);
}

/** Chequeo de idempotencia: orden reciente ya en curso para ese proveedor. Silenciosa (puede ser null). */
export async function buscarOrdenRecienteProveedor(empresa_id, proveedor_id, desde) {
  const { data } = await db.from('ordenes_compra')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('proveedor_id', proveedor_id)
    .in('estado', ['borrador', 'pendiente_aprobacion', 'enviada'])
    .gte('created_at', desde)
    .maybeSingle();
  return data;
}

/** Inserta la orden auto-generada. Handler chequea `errOC || !orden` explícitamente. */
export async function insertarOrdenCompraAuto(campos) {
  const { data, error } = await db.from('ordenes_compra').insert(campos).select().single();
  return { data, error };
}

/** Inserta los ítems de una orden. Silenciosa (fire-and-forget). */
export async function insertarItemsOrdenCompra(filas) {
  await db.from('ordenes_compra_items').insert(filas);
}

/** Upsert de alertas de stock (idempotente por producto_id,tipo,resuelta). Silenciosa. Compartida entre el flujo con proveedor y `alertarSinProveedor`. */
export async function upsertAlertasStock(filas) {
  await db.from('alertas_stock')
    .upsert(filas, { onConflict: 'producto_id,tipo,resuelta', ignoreDuplicates: true });
}

/** Orden con datos de empresa/proveedor, para armar el email de envío. Silenciosa (puede ser null). */
export async function obtenerOrdenParaEnviar(orden_id, empresa_id) {
  const { data } = await db.from('ordenes_compra').select(`
    *, empresa:empresas(nombre, email),
    proveedor:proveedores(razon_social, email)
  `).eq('id', orden_id).eq('empresa_id', empresa_id).single();
  return data;
}

/** Ítems de una orden, para el detalle del email. Silenciosa (puede ser null). */
export async function listarItemsOrdenCompra(orden_id) {
  const { data } = await db.from('ordenes_compra_items')
    .select('cantidad, precio_unitario, subtotal, descripcion, productos(nombre)')
    .eq('orden_id', orden_id);
  return data;
}

/** Marca la orden como enviada. Silenciosa (fire-and-forget). */
export async function marcarOrdenEnviada(orden_id) {
  await db.from('ordenes_compra').update({ estado: 'enviada' }).eq('id', orden_id);
}

/** Marca resueltas las alertas asociadas a una orden. Silenciosa (fire-and-forget). */
export async function marcarAlertasResueltasPorOrden(orden_id) {
  await db.from('alertas_stock').update({ resuelta: true }).eq('orden_compra_id', orden_id);
}
