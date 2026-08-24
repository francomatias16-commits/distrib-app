// lib/repos/combos.js
//
// Acceso a `combos`/`combo_items` para el checkout del portal cliente
// (confirmarPedidoHandler, lib/handlers/pedidos.js). El CRUD del admin
// (alta/edición/activar-desactivar) no pasa por Node: el panel admin llama
// directo a las RPCs fn_guardar_combo / fn_combo_set_activo vía supabase-js,
// mismo patrón que el resto de Productos.

import { db } from './_db.js';

/**
 * Combos por lote de IDs, con su composición (producto_id, cantidad,
 * precio_base e iva de cada componente) — usado por confirmarPedidoHandler
 * para: (a) nunca confiar en el precio del combo que mande el cliente,
 * (b) calcular cuánto stock de cada producto componente hace falta, y
 * (c) estimar un IVA ponderado del combo (ver calcularIvaPonderadoCombo en
 * lib/handlers/pedidos.js).
 */
export async function obtenerCombosParaValidarPedido(empresa_id, ids) {
  if (!ids?.length) return [];
  const { data, error } = await db
    .from('combos')
    .select(`
      id, nombre, precio, activo,
      combo_items(
        producto_id, cantidad,
        productos(precio_base, iva)
      )
    `)
    .in('id', ids)
    .eq('empresa_id', empresa_id);

  if (error || !data) return [];

  return data.map(c => ({
    id:     c.id,
    nombre: c.nombre,
    precio: +c.precio,
    activo: c.activo === true,
    items: (c.combo_items || []).map(ci => ({
      producto_id: ci.producto_id,
      cantidad:    +ci.cantidad,
      precio_base: +(ci.productos?.precio_base ?? 0),
      iva:         +(ci.productos?.iva ?? 21),
    })),
  }));
}
