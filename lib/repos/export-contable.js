// lib/repos/export-contable.js
// Acceso a datos del export contable (Tango/Bejerman/Contabilium/CSV
// genérico, Etapa 6). Migrado desde lib/handlers/export-contable.js y
// lib/export-contable/index.js — mismo criterio que los demás repos: acá
// solo queda I/O contra Supabase (tabla `export_contable_config`,
// `export_contable_log`, las vistas de comprobantes contables y `cobros`
// para el caso especial de cobranzas). El armado del archivo (CSV/layouts
// por proveedor) no es acceso a base de datos y se queda donde está.

import { db } from './_db.js';

export async function obtenerConfigExportContable(empresa_id, campos = 'proveedor, plan_cuentas, separador_decimal, formato_fecha, activo') {
  return db
    .from('export_contable_config')
    .select(campos)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
}

export async function upsertConfigExportContable(empresa_id, cambios) {
  return db
    .from('export_contable_config')
    .upsert({ empresa_id, ...cambios }, { onConflict: 'empresa_id' })
    .select()
    .single();
}

export async function listarHistorialExportContable(empresa_id, limite = 50) {
  return db
    .from('export_contable_log')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(limite);
}

export async function insertarLogExportContable(fila) {
  return db.from('export_contable_log').insert(fila);
}

/**
 * Vista de comprobantes contables (ventas o compras) para el rango de
 * fechas. `vista` es el nombre de la vista SQL — resuelto por el handler
 * según `tipo` (v_comprobantes_contables_venta / _compra).
 */
export async function listarComprobantesContables(vista, empresa_id, desde, hasta) {
  return db
    .from(vista)
    .select('*')
    .eq('empresa_id', empresa_id)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha');
}

/**
 * Caso especial 'cobranzas': todavía no tiene vista SQL propia, se lee
 * `cobros` directo (ver TODO histórico en lib/export-contable/index.js).
 */
export async function listarCobrosParaExport(empresa_id, desde, hasta) {
  return db
    .from('cobros')
    .select('id, cliente_id, monto, medio, referencia, fecha, clientes(razon_social, cuit, codigo_contable)')
    .eq('empresa_id', empresa_id)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha');
}
