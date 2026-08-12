// lib/repos/importar.js
// Acceso a datos de la importación de productos (upsert masivo vía RPC) y
// del OCR de remitos/facturas de proveedor. Migrado desde
// lib/handlers/importar.js — mismo criterio que los demás repos: acá solo
// queda I/O contra Supabase (RPCs importar_productos_lote y
// conciliar_recepcion, tabla `recepciones_mercaderia`). La llamada a la
// Vision API de Claude y el preprocesamiento de imagen no son acceso a
// base de datos y se quedan en el handler.

import { db } from './_db.js';

export async function importarProductosLoteRpc({ p_empresa_id, p_filas, p_lista_precio_id, p_lista_nombre, p_deposito_id }) {
  return db.rpc('importar_productos_lote', {
    p_empresa_id,
    p_filas,
    p_lista_precio_id,
    p_lista_nombre,
    p_deposito_id,
  });
}

export async function conciliarRecepcionRpc({ orden_id, datos_ocr, umbral_pct }) {
  return db.rpc('conciliar_recepcion', {
    p_orden_id:   orden_id,
    p_datos_ocr:  datos_ocr,
    p_umbral_pct: umbral_pct,
  });
}

export async function insertarRecepcionBorrador({ empresa_id, orden_id, datos_ocr, items_conciliados, discrepancias, estado }) {
  const { data } = await db
    .from('recepciones_mercaderia')
    .insert({ empresa_id, orden_id, datos_ocr, items_conciliados, discrepancias, estado })
    .select('id')
    .single();
  return data;
}
