// lib/calc/pedido-totales.js
//
// Plan de acción 3.2: "el corazón del negocio" — cálculo de subtotal, IVA y
// total de un pedido a partir de sus items. Antes vivía duplicado dentro de
// dos handlers gigantes (creación de pedido desde el portal del cliente y
// desde el admin), lo que ya causó divergencias tipo CONS-01/02/03 en
// auditorías anteriores. Se extrae acá como función pura para poder
// testearla sin mockear Supabase ni el request/response de Express.
//
// IMPORTANTE: esta función es un espejo en JS de la lógica que también corre
// server-side dentro de la RPC SQL `crear_pedido_cliente` (fuente de verdad
// real, transaccional). Este cálculo se usa para validaciones previas
// (límite de crédito) y para armar los items que se mandan a esa RPC — no
// reemplaza la aritmética que hace Postgres al persistir el pedido.
//
// `resolverPrecio(item)` se pasa como callback porque los dos call sites
// resuelven el precio del servidor de forma distinta (el del portal ya lo
// dejó cacheado en `item._precio_servidor`; el del admin lo busca en el
// mismo paso). No se unifica esa lógica acá para no cambiar comportamiento
// existente al extraer.

/**
 * Calcula subtotal, IVA total y total de un pedido, y arma el array de
 * items en el formato que espera la RPC `crear_pedido_cliente`.
 *
 * @param {Array<{producto_id: string, cantidad: number, descuento_pct?: number}>} items
 * @param {{ resolverPrecio: (item: object) => number, ivaMap: Record<string, number> }} opciones
 * @returns {{ subtotal: number, iva_total: number, total: number, itemsParaRpc: Array }}
 */
export function calcularTotalesPedido(items, { resolverPrecio, ivaMap }) {
  let subtotal = 0;
  let iva_total = 0;

  const itemsParaRpc = items.map(item => {
    const precio = resolverPrecio(item);
    const sub = precio * item.cantidad * (1 - (item.descuento_pct || 0) / 100);
    const iva = sub * ((ivaMap[item.producto_id] ?? 21) / 100);

    subtotal += sub;
    iva_total += iva;

    return {
      producto_id:     item.producto_id,
      cantidad:        item.cantidad,
      precio_unitario: precio,
      descuento_pct:   item.descuento_pct || 0,
      subtotal:        Math.round(sub * 100) / 100,
    };
  });

  const total = Math.round((subtotal + iva_total) * 100) / 100;

  return { subtotal, iva_total, total, itemsParaRpc };
}
