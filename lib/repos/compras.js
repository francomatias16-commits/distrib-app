// lib/repos/compras.js
// Capa de acceso a datos para Órdenes de Compra / Recepciones de mercadería /
// Facturas de proveedor. Migrado desde `handleCompras` en
// `lib/handlers/proveedores.js` (Fase 7 — el submódulo "compras" vivía
// embebido ahí, absorbido en su momento desde api/compras/index.js).

import { db } from './_db.js';

/** Perfil mínimo (empresa_id, rol) para autorizar el submódulo de compras. */
export async function obtenerPerfilCompras(user_id) {
  const { data } = await db.from('usuarios').select('empresa_id, rol').eq('id', user_id).single();
  return data;
}

// ── Órdenes de compra ───────────────────────────────────────────────────

/** Detalle completo de una OC (proveedor + items con datos de producto). */
export async function obtenerOrdenCompraDetalle(id, empresa_id) {
  const { data, error } = await db
    .from('ordenes_compra')
    .select(`
      *,
      proveedores(id, razon_social, cuit, telefono, email),
      ordenes_compra_items(
        *, productos(nombre, codigo, unidad)
      )
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Listado paginado de OC con filtros. `excluirIds`, si viene, excluye esas
 * OC (usado por sin_facturar=1 para no ofrecer OC ya facturadas).
 */
export async function listarOrdenesCompraFiltradas(empresa_id, {
  proveedor_id, estado, desde, hasta, offset, limit, excluirIds,
}) {
  let q = db
    .from('ordenes_compra')
    .select(`
      id, numero, estado, fecha_pedido, fecha_esperada, total, notas, proveedor_id,
      proveedores(razon_social)
    `, { count: 'exact' })
    .eq('empresa_id', empresa_id)
    // Regla "ítem modificado sube al tope" (2026-09): antes ordenaba por
    // fecha_pedido, así que aprobar/despachar/recibir una OC vieja no la
    // traía a la vista.
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (proveedor_id) q = q.eq('proveedor_id', proveedor_id);
  if (estado)       q = q.eq('estado', estado);
  if (desde)        q = q.gte('fecha_pedido', desde);
  if (hasta)        q = q.lte('fecha_pedido', hasta);
  if (excluirIds?.length) q = q.not('id', 'in', `(${excluirIds.join(',')})`);

  const { data, error, count } = await q;
  return { data, error, count };
}

/**
 * IDs de OC ya vinculadas a una factura de proveedor no anulada — para el
 * selector "OC vinculada" al cargar/editar una factura (evita facturar dos
 * veces la misma compra). `excluir_factura_id` deja pasar la propia factura
 * que se está editando.
 */
export async function listarFacturasProveedorOrdenIds(empresa_id, excluir_factura_id) {
  let q = db
    .from('facturas_proveedor')
    .select('orden_id')
    .eq('empresa_id', empresa_id)
    .neq('estado', 'anulada')
    .not('orden_id', 'is', null);

  if (excluir_factura_id) q = q.neq('id', excluir_factura_id);

  const { data, error } = await q;
  return { data, error };
}

/** Crea una OC vía RPC (valida stock/proveedor y calcula totales server-side). */
export async function crearOrdenCompraRpc(params) {
  const { data, error } = await db.rpc('crear_orden_compra', params);
  return { data, error };
}

/** Cambia el estado de una OC (borrador/enviada/confirmada/cancelada). */
export async function actualizarEstadoOrdenCompra(id, empresa_id, campos) {
  const { data, error } = await db
    .from('ordenes_compra')
    .update(campos)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();
  return { data, error };
}

/** Estado + número, para decidir si una OC se puede borrar (nunca enviada). */
export async function obtenerOrdenCompraParaEliminar(id, empresa_id) {
  const { data } = await db
    .from('ordenes_compra')
    .select('id, numero, estado')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** true si ya existe una factura de proveedor vinculada a esta OC. */
export async function ordenTieneFacturaVinculada(orden_id) {
  const { count } = await db
    .from('facturas_proveedor')
    .select('id', { count: 'exact', head: true })
    .eq('orden_id', orden_id);
  return (count || 0) > 0;
}

/**
 * Borrado físico de una OC que nunca salió (borrador/pendiente_aprobacion).
 * ordenes_compra_items se borra en cascada (ON DELETE CASCADE, 063_fix_ordenes_compra_items_fk_huerfana.sql).
 * alertas_stock.orden_compra_id no tiene ON DELETE definido (RESTRICT por
 * default), así que se libera esa referencia antes de borrar para que no
 * rebote con un error de FK si alguna alerta llegó a apuntar a esta OC.
 */
export async function eliminarOrdenCompra(id, empresa_id) {
  await db.from('alertas_stock').update({ orden_compra_id: null }).eq('orden_compra_id', id);
  const { error } = await db
    .from('ordenes_compra')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  return { error };
}

// ── Comparador de precios entre proveedores ─────────────────────────────
// Lee de la migración 244_etapa2_comparador_precios_proveedores.sql. Ambas
// RPC solo consideran OCs con estado='recibida' (precio confirmado).

/** Detalle por proveedor de un producto puntual. */
export async function compararPreciosProveedoresRpc(params) {
  const { data, error } = await db.rpc('comparar_precios_proveedores', params);
  return { data, error };
}

/** Ranking de oportunidades de ahorro entre proveedores. */
export async function rankingAhorroProveedoresRpc(params) {
  const { data, error } = await db.rpc('ranking_ahorro_proveedores', params);
  return { data, error };
}

// ── Recepciones de mercadería ───────────────────────────────────────────

/**
 * Historial de recepciones (vista "compras" — sin `datos_ocr`, ver
 * `listarHistorialRecepcionesConOcr` para la variante con ese campo).
 */
export async function listarHistorialRecepciones(empresa_id, { orden_id, offset, limit }) {
  let q = db
    .from('recepciones_mercaderia')
    .select('id, orden_id, estado, foto_url, created_at, updated_at, confirmada_at, discrepancias, items_conciliados, notas, usuarios(nombre), ordenes_compra(numero)', { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (orden_id) q = q.eq('orden_id', orden_id);

  const { data, error, count } = await q;
  return { data, error, count };
}

/** Historial de recepciones incluyendo `datos_ocr` (usado por el sub-endpoint homónimo de handleCompras). */
export async function listarHistorialRecepcionesConOcr(empresa_id, { orden_id, offset, limit }) {
  let q = db
    .from('recepciones_mercaderia')
    .select('id, orden_id, estado, foto_url, created_at, updated_at, confirmada_at, discrepancias, datos_ocr, items_conciliados, notas, usuarios(nombre), ordenes_compra(numero)', { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (orden_id) q = q.eq('orden_id', orden_id);

  const { data, error, count } = await q;
  return { data, error, count };
}

/**
 * Recepciones confirmadas de esta OC en los últimos N segundos con el mismo
 * detalle de items — guard anti doble-submit antes de tocar stock.
 */
export async function buscarRecepcionRecienteDuplicada(empresa_id, orden_id, desde_iso) {
  const { data } = await db
    .from('recepciones_mercaderia')
    .select('id, items_conciliados')
    .eq('empresa_id', empresa_id)
    .eq('orden_id', orden_id)
    .eq('estado', 'confirmada')
    .gte('confirmada_at', desde_iso)
    .order('confirmada_at', { ascending: false })
    .limit(1);
  return data;
}

/** Recepciona una OC vía RPC (aplica stock, marca estado de la OC/items). */
export async function recepcionarOrdenCompraRpc(params) {
  const { data, error } = await db.rpc('recepcionar_orden_compra', params);
  return { data, error };
}

/** Confirma un borrador de recepción existente (flujo OCR) con el detalle final revisado por el usuario. */
export async function confirmarRecepcionExistente(recepcion_id, empresa_id, campos) {
  const { error } = await db
    .from('recepciones_mercaderia')
    .update(campos)
    .eq('id', recepcion_id)
    .eq('empresa_id', empresa_id);
  return { error };
}

/** Crea una recepción ya confirmada (flujo manual, sin escaneo previo). */
export async function crearRecepcionConfirmada(campos) {
  const { error } = await db.from('recepciones_mercaderia').insert(campos);
  return { error };
}

/** Valida que una recepción pertenece a la empresa (id mínimo, para upload-remito). */
export async function obtenerRecepcionIdValida(recepcion_id, empresa_id) {
  const { data } = await db
    .from('recepciones_mercaderia')
    .select('id')
    .eq('id', recepcion_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Recepción (id + estado) para validar que se puede descartar (solo en 'borrador'). */
export async function obtenerRecepcionParaDescartar(recepcion_id, empresa_id) {
  const { data } = await db
    .from('recepciones_mercaderia')
    .select('id, estado')
    .eq('id', recepcion_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Marca una recepción en borrador como descartada. */
export async function descartarRecepcion(recepcion_id, empresa_id, campos) {
  const { data, error } = await db
    .from('recepciones_mercaderia')
    .update(campos)
    .eq('id', recepcion_id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();
  return { data, error };
}

/** Actualiza la foto (remito escaneado) de una recepción, tras subirla a storage. */
export async function actualizarFotoRecepcion(recepcion_id, foto_url) {
  const { error } = await db
    .from('recepciones_mercaderia')
    .update({ foto_url })
    .eq('id', recepcion_id);
  return { error };
}

/** Recepción completa (items, discrepancias, etc.) para armar el email al proveedor. */
export async function obtenerRecepcionParaNotificar(recepcion_id, empresa_id) {
  const { data, error } = await db
    .from('recepciones_mercaderia')
    .select('id, orden_id, estado, foto_url, created_at, confirmada_at, items_conciliados, discrepancias')
    .eq('id', recepcion_id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/** OC + proveedor (para el email de notificación de recepción). */
export async function obtenerOrdenConProveedorParaNotificar(orden_id, empresa_id) {
  const { data } = await db
    .from('ordenes_compra')
    .select('id, numero, proveedor_id, proveedores(id, razon_social, contacto, email)')
    .eq('id', orden_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

// ── Storage (remitos escaneados) ────────────────────────────────────────

/** Sube la foto/PDF de un remito al bucket `remitos`. */
export async function subirRemitoStorage(path, buffer, mime_type) {
  const { error } = await db.storage
    .from('remitos')
    .upload(path, buffer, { contentType: mime_type, upsert: true });
  return { error };
}

// SEC-05: el bucket 'remitos' pasó a privado. Ya no existe "URL pública" —
// se guarda el `path` tal cual en foto_url y se firma recién al leer
// (ver lib/utils/storage-urls.js). Se quita `obtenerUrlPublicaRemito`;
// los llamadores ahora deben usar `path` directamente.
