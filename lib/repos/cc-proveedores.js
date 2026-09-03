// lib/repos/cc-proveedores.js
// Capa de acceso a datos para lib/handlers/cc_proveedores.js — Etapa 8.5,
// Cuentas corrientes con proveedores.
//
// Política de error: replica tal cual la del handler original — silenciosa
// donde el original no controlaba `error`, propagada (throw) donde sí
// había chequeo explícito con errorSeguro().

import { db } from './_db.js';

/** Perfil (empresa_id, rol, nombre, id) para autorizar el handler. Silenciosa. */
export async function obtenerPerfilCCProveedores(user_id) {
  const { data } = await db
    .from('usuarios').select('empresa_id, rol, nombre, id').eq('id', user_id).single();
  return data;
}

/** Balance general o por proveedor (v_cc_proveedor). Handler propaga el error (throw). */
export async function listarBalanceProveedores({ empresa_id, proveedor_id }) {
  let q = db
    .from('v_cc_proveedor')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('saldo_pendiente', { ascending: false });

  if (proveedor_id) q = q.eq('proveedor_id', proveedor_id);
  q = q.limit(500); // tope de seguridad

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/** Cantidad de facturas con diferencias (KPI/badge/campanita). Silenciosa. */
export async function contarFacturasConDiferencias(empresa_id) {
  const { count } = await db
    .from('facturas_proveedor')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .eq('tiene_diferencias', true)
    .neq('estado', 'anulada');
  return count || 0;
}

/** Factura puntual con relaciones, para el lookup por ?id=. Handler propaga el error (throw). */
export async function obtenerFacturaProveedorDetalle({ empresa_id, id }) {
  const { data, error } = await db
    .from('facturas_proveedor')
    .select(`
      *,
      proveedores ( id, razon_social, nombre_fantasia ),
      ordenes_compra ( id, numero, fecha_pedido, total ),
      facturas_proveedor_items ( * )
    `)
    .eq('empresa_id', empresa_id)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Listado paginado de facturas con filtros. Handler propaga el error (throw). */
export async function listarFacturasProveedorFiltradas({
  empresa_id, proveedor_id, orden_id, estado, desde, hasta, soloDiferencias, offset, hasta_range,
}) {
  let q = db
    .from('facturas_proveedor')
    .select(`
      *,
      proveedores ( id, razon_social, nombre_fantasia ),
      ordenes_compra ( id, numero, fecha_pedido, total ),
      facturas_proveedor_items ( * )
    `, { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .order('updated_at', { ascending: false });

  if (proveedor_id) q = q.eq('proveedor_id', proveedor_id);
  if (orden_id)     q = q.eq('orden_id', orden_id);
  if (estado)       q = q.eq('estado', estado);
  if (desde)        q = q.gte('fecha_factura', desde);
  if (hasta)        q = q.lte('fecha_factura', hasta);
  if (soloDiferencias) q = q.eq('tiene_diferencias', true);
  q = q.range(offset, hasta_range);

  const { data, error, count } = await q;
  if (error) throw error;
  return { data: data || [], count: count ?? 0 };
}

/** Pagos de una factura. Handler propaga el error (throw). */
export async function listarPagosFactura({ empresa_id, factura_id }) {
  const { data, error } = await db
    .from('pagos_proveedor')
    .select('*, usuarios ( nombre )')
    .eq('factura_id', factura_id)
    .eq('empresa_id', empresa_id)
    .order('fecha_pago', { ascending: false });
  if (error) throw error;
  return data || [];
}

/** Verifica que el proveedor pertenezca a la empresa. Silenciosa (bool). */
export async function existeProveedorEnEmpresa(empresa_id, proveedor_id) {
  const { data } = await db
    .from('proveedores').select('id').eq('id', proveedor_id).eq('empresa_id', empresa_id).single();
  return !!data;
}

/** Verifica que la orden de compra pertenezca a la empresa (punto 2 auditoría, defensa en profundidad). Silenciosa (bool). */
export async function existeOrdenCompraEnEmpresa({ empresa_id, orden_id }) {
  const { data } = await db
    .from('ordenes_compra').select('id').eq('id', orden_id).eq('empresa_id', empresa_id).single();
  return !!data;
}

/** Inserta la cabecera de una factura. Handler propaga el error (throw). */
export async function insertarFacturaProveedorCC(campos) {
  const { data, error } = await db
    .from('facturas_proveedor')
    .insert(campos)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Inserta ítems de factura. Handler propaga el error (throw). */
export async function insertarItemsFacturaProveedorCC(filas) {
  const { error } = await db
    .from('facturas_proveedor_items')
    .insert(filas);
  if (error) throw error;
}

/** Borra los ítems existentes de una factura (previo a reemplazarlos). Handler propaga el error (throw). */
export async function eliminarItemsFacturaProveedorCC(factura_id) {
  const { error } = await db
    .from('facturas_proveedor_items')
    .delete()
    .eq('factura_id', factura_id);
  if (error) throw error;
}

/** Envuelve la RPC de conciliación OC↔factura. Handler chequea el error explícitamente.
 *  FIX (punto 2 auditoría): la RPC ahora exige p_empresa_id — si falta, se
 *  rechaza acá mismo sin llegar a llamar a la base. */
export async function conciliarOcFacturaRpc({ orden_id, factura_id, empresa_id, umbral_pct }) {
  if (!empresa_id) {
    return { data: { ok: false, codigo: 'EMPRESA_REQUERIDA', error: 'empresa requerida' }, error: null };
  }
  const { data, error } = await db.rpc('conciliar_oc_factura', {
    p_orden_id:   orden_id,
    p_factura_id: factura_id,
    p_empresa_id: empresa_id,
    p_umbral_pct: umbral_pct,
  });
  return { data, error };
}

/** Envuelve la RPC transaccional de alta de factura de proveedor (punto 3
 *  auditoría). Hace cabecera + ítems + conciliación + auditoría en una
 *  única transacción del lado de la base — reemplaza los inserts sueltos
 *  que hacía el handler antes. Handler chequea el error explícitamente. */
export async function altaFacturaProveedorRpc({
  empresa_id, proveedor_id, numero_factura, fecha_factura,
  orden_id, tipo, fecha_vencimiento, iva_pct, notas, items, umbral_pct, usuario_id,
}) {
  const { data, error } = await db.rpc('alta_factura_proveedor', {
    p_empresa_id:        empresa_id,
    p_proveedor_id:      proveedor_id,
    p_numero_factura:    numero_factura,
    p_fecha_factura:     fecha_factura,
    p_orden_id:          orden_id || null,
    p_tipo:              tipo || 'A',
    p_fecha_vencimiento: fecha_vencimiento || null,
    p_iva_pct:           iva_pct ?? 21,
    p_notas:             notas || null,
    p_items:             items || [],
    p_umbral_pct:        umbral_pct ?? 5,
    p_usuario_id:        usuario_id || null,
  });
  return { data, error };
}

/** Envuelve la RPC transaccional de edición de factura de proveedor (punto 4
 *  auditoría). Lock FOR UPDATE + control de versión (p_expected_updated_at)
 *  + validación de OC/ítems + reemplazo de ítems + reconciliación forzada si
 *  cambia orden_id + auditoría, todo en una única transacción del lado de la
 *  base — reemplaza el PATCH multi-paso que hacía el handler antes. Los
 *  flags `*_provisto` distinguen "no vino en el body" (no tocar ese campo)
 *  de "vino explícitamente null/[]" (ej. orden_id: null para desvincular la
 *  OC, o notas: '' para vaciarlas) — la RPC los necesita para diferenciar
 *  ambos casos, un simple `?? valorViejo` en JS no alcanza. Handler chequea
 *  el error explícitamente. */
export async function editarFacturaProveedorRpc({
  empresa_id, id, expected_updated_at,
  estado, notas, notas_provisto,
  fecha_vencimiento, numero_factura, tipo, fecha_factura, iva_pct,
  orden_id_provisto, orden_id,
  items_provisto, items,
  umbral_pct, usuario_id,
}) {
  const { data, error } = await db.rpc('editar_factura_proveedor', {
    p_empresa_id:          empresa_id,
    p_id:                  id,
    p_expected_updated_at: expected_updated_at || null,
    p_estado:              estado || null,
    p_notas:               notas ?? null,
    p_notas_provisto:      !!notas_provisto,
    p_fecha_vencimiento:   fecha_vencimiento || null,
    p_numero_factura:      numero_factura || null,
    p_tipo:                tipo || null,
    p_fecha_factura:       fecha_factura || null,
    p_iva_pct:             iva_pct ?? null,
    p_orden_id_provisto:   !!orden_id_provisto,
    p_orden_id:            orden_id || null,
    p_items_provisto:      !!items_provisto,
    p_items:               items || [],
    p_umbral_pct:          umbral_pct ?? 5,
    p_usuario_id:          usuario_id || null,
  });
  return { data, error };
}

/** Guarda el resultado de la conciliación en la factura. Silenciosa (fire-and-forget). */
export async function actualizarConciliacionFactura({ id, empresa_id, conciliacion, discrepancias }) {
  await db
    .from('facturas_proveedor')
    .update({ conciliacion, discrepancias })
    .eq('id', id)
    .eq('empresa_id', empresa_id);
}

/** Envuelve la RPC de registro de pago. Handler chequea el error explícitamente. */
export async function registrarPagoProveedorRpc(params) {
  const { data, error } = await db.rpc('registrar_pago_proveedor', params);
  return { data, error };
}

/** Estado y total_pagado actuales, para validar antes de un PATCH de cabecera. Silenciosa (puede ser null). */
export async function obtenerFacturaEstadoTotalPagado({ id, empresa_id }) {
  const { data } = await db
    .from('facturas_proveedor')
    .select('estado, total_pagado')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Actualiza una factura (PATCH de cabecera/estado). Handler propaga el error (throw). */
export async function actualizarFacturaProveedorCC({ id, empresa_id, upd }) {
  const { data, error } = await db
    .from('facturas_proveedor')
    .update(upd)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
