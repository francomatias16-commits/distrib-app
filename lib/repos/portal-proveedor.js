// lib/repos/portal-proveedor.js
// Capa de acceso a datos para lib/handlers/portal_proveedor.js — Innovación
// #10, Autogestión de Proveedores ("Vidriera Inversa"). Cubre las dos
// superficies del handler: admin (autenticado) y público (token de URL).
//
// `migracion_plantillas_mapeo`. Los `.rpc('migracion_*', ...)` del handler
// Política de error: replica tal cual la del handler original — silenciosa
// donde el original no controlaba `error` (degrada en vez de romper),
// propagada (throw) donde sí había chequeo explícito.

import { db } from './_db.js';

// ── A) Admin ──────────────────────────────────────────────────────────

/** Proveedor por id+empresa, para armar el link. Silenciosa (puede ser null). */
export async function obtenerProveedorParaLink(empresa_id, proveedor_id) {
  const { data } = await db
    .from('proveedores')
    .select('id, razon_social')
    .eq('id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Inserta el token de portal. Handler propaga el error (throw). */
export async function insertarTokenPortal({ empresa_id, proveedor_id, token_hash, creado_por, expira_at }) {
  const { data, error } = await db
    .from('proveedor_portal_tokens')
    .insert({ empresa_id, proveedor_id, token_hash, creado_por, expira_at })
    .select('id, creado_at, expira_at')
    .single();
  if (error) throw error;
  return data;
}

/** Historial de links emitidos para un proveedor. Handler propaga el error (throw). */
export async function listarTokensPortal(empresa_id, proveedor_id) {
  const { data, error } = await db
    .from('proveedor_portal_tokens')
    .select('id, creado_at, expira_at, revocado_at, ultimo_uso_at, usos, usuarios(nombre)')
    .eq('proveedor_id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .order('creado_at', { ascending: false });
  if (error) throw error;
  return data;
}

/** Revoca un link (marca revocado_at). Handler propaga el error (throw). */
export async function revocarTokenPortal(empresa_id, token_id) {
  const { data, error } = await db
    .from('proveedor_portal_tokens')
    .update({ revocado_at: new Date().toISOString() })
    .eq('id', token_id)
    .eq('empresa_id', empresa_id)
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

// ── B) Público ────────────────────────────────────────────────────────

/** Envuelve la RPC de validación de token. Handler chequea el error explícitamente. */
export async function validarTokenPortalRpc(token_hash) {
  const { data, error } = await db
    .rpc('validar_token_portal_proveedor', { p_token_hash: token_hash })
    .single();
  return { data, error };
}

/** Historial de notif_log del proveedor (filtrado por payload->>proveedor_id). Handler propaga el error (throw). */
export async function listarNotificacionesProveedor(empresa_id, proveedor_id) {
  const { data, error } = await db
    .from('notif_log')
    .select('id, tipo, canal, email, message_id, entregada, motivo, payload, created_at')
    .eq('empresa_id', empresa_id)
    .eq('payload->>proveedor_id', proveedor_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

/**
 * Datos del proveedor para la portada pública. Silenciosa (puede ser null).
 * FIX (Fase 7, paso portal_proveedor): la versión original solo filtraba
 * por `id`, sin `empresa_id` — no explotaba porque `proveedor_id` ya llega
 * resuelto/validado por el token contra esa misma empresa vía la RPC
 * `validar_token_portal_proveedor`, pero rompe la regla de no confiar en
 * un solo id como barrera. Se agrega el filtro acá.
 */
export async function obtenerProveedorPortal(empresa_id, proveedor_id) {
  const { data } = await db
    .from('proveedores')
    .select('id, razon_social, nombre_fantasia, dias_pago')
    .eq('id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Nombre de la empresa, para la portada pública. Silenciosa (puede ser null). */
export async function obtenerNombreEmpresa(empresa_id) {
  const { data } = await db
    .from('empresas')
    .select('nombre')
    .eq('id', empresa_id)
    .single();
  return data?.nombre;
}

/** OCs del proveedor con sus ítems. Handler propaga el error (throw). */
export async function listarOrdenesCompraProveedor(empresa_id, proveedor_id) {
  const { data, error } = await db
    .from('ordenes_compra')
    .select(`
      id, numero, estado, total, subtotal, iva_total,
      fecha_pedido, fecha_esperada, fecha_recepcion, confirmada_por_proveedor,
      ordenes_compra_items ( id, descripcion, cantidad, precio_unitario, precio_costo, cantidad_recibida, productos(nombre) )
    `)
    .eq('proveedor_id', proveedor_id)
    .eq('empresa_id', empresa_id)
    // FIX F4-03 (auditoría de páginas, Fase 4): el link del portal es
    // persistente por proveedor — sin este filtro, el proveedor veía
    // automáticamente cualquier OC nueva que el admin arme para él,
    // incluso mientras todavía la está editando en borrador o esperando
    // aprobación interna (filtraba cantidades/precios que podían cambiar,
    // e inflaba el "total abierto" con compromisos no asumidos).
    .not('estado', 'in', '(borrador,pendiente_aprobacion)')
    .order('fecha_pedido', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

/** Facturas del proveedor, para la portada pública. Silenciosa (puede ser null). */
export async function listarFacturasProveedorPortal(empresa_id, proveedor_id) {
  const { data } = await db
    .from('facturas_proveedor')
    .select('id, orden_id, numero_factura, estado, total, total_pagado, fecha_factura, fecha_vencimiento, origen, archivo_url')
    .eq('proveedor_id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .order('fecha_factura', { ascending: false })
    .limit(50);
  return data;
}

/** OC puntual para validar antes de confirmar-entrega. Silenciosa (puede ser null). */
export async function obtenerOrdenCompraParaConfirmar(empresa_id, proveedor_id, orden_id) {
  const { data } = await db
    .from('ordenes_compra')
    .select('id, estado')
    .eq('id', orden_id)
    .eq('proveedor_id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Confirma la fecha esperada de una OC. Handler propaga el error (throw). */
export async function actualizarFechaEsperadaOrden({ empresa_id, proveedor_id, orden_id, fecha_esperada }) {
  const { data, error } = await db
    .from('ordenes_compra')
    .update({
      fecha_esperada,
      confirmada_por_proveedor: true,
      fecha_confirmacion_at: new Date().toISOString(),
    })
    .eq('id', orden_id)
    .eq('proveedor_id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .select('id, fecha_esperada, confirmada_por_proveedor')
    .single();
  if (error) throw error;
  return data;
}

/** OC puntual para validar antes de subir-factura. Silenciosa (puede ser null). */
export async function obtenerOrdenCompraParaFactura(empresa_id, proveedor_id, orden_id) {
  const { data } = await db
    .from('ordenes_compra')
    .select('id')
    .eq('id', orden_id)
    .eq('proveedor_id', proveedor_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Inserta la factura autocargada por el proveedor. Handler propaga el error (throw).
 *
 * IDEMPOTENCIA (Plan offline, Etapa 3, migración 448): si `campos` trae
 * offline_local_id, primero se busca una factura existente con ese mismo id
 * — si ya existe (el outbox reintentó una acción que en realidad ya se
 * había aplicado), se devuelve tal cual en vez de insertar de nuevo. Mismo
 * fast-path que ajustar_stock/registrar_conteo_stock (migración 443).
 *
 * Punto 5 (auditoría pre-lanzamiento 2026): el lookup ahora se acota por
 * `campos.empresa_id` (siempre viene seteado por el caller — ver
 * lib/handlers/portal_proveedor.js) — antes buscaba en toda la tabla, sin
 * distinguir de qué empresa era la factura encontrada. El índice único de
 * la migración 508 pasa a ser (empresa_id, offline_local_id).
 */
export async function insertarFacturaProveedorPortal(campos) {
  if (campos.offline_local_id) {
    const { data: existente } = await db
      .from('facturas_proveedor')
      .select('id, numero_factura, fecha_factura, total, estado, archivo_url')
      .eq('empresa_id', campos.empresa_id)
      .eq('offline_local_id', campos.offline_local_id)
      .maybeSingle();
    if (existente) return { ...existente, ya_existia: true };
  }

  const { data, error } = await db
    .from('facturas_proveedor')
    .insert(campos)
    .select('id, numero_factura, fecha_factura, total, estado, archivo_url')
    .single();
  if (error) throw error;
  return data;
}
