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
 * v(combos): se suma `resolverIva(item)`, un callback opcional análogo a
 * `resolverPrecio` — necesario porque un renglón de combo no tiene un solo
 * `producto_id` del que sacar el IVA de `ivaMap` (mezcla varios productos,
 * potencialmente con alícuotas distintas). Si no se pasa `resolverIva`, se
 * usa `ivaMap` tal cual como antes (retrocompatible con los call-sites que
 * todavía no soportan combos: notif.js y los flujos admin de pedidos.js).
 *
 * @param {Array<{producto_id?: string, combo_id?: string, cantidad: number, descuento_pct?: number}>} items
 * @param {{ resolverPrecio: (item: object) => number, ivaMap?: Record<string, number>, resolverIva?: (item: object) => number }} opciones
 * @returns {{ subtotal: number, iva_total: number, total: number, itemsParaRpc: Array }}
 */
export function calcularTotalesPedido(items, { resolverPrecio, ivaMap, resolverIva }) {
  let subtotal = 0;
  let iva_total = 0;

  const obtenerIva = resolverIva || (item => ivaMap?.[item.producto_id] ?? 21);

  const itemsParaRpc = items.map(item => {
    const precio = resolverPrecio(item);
    const sub = precio * item.cantidad * (1 - (item.descuento_pct || 0) / 100);
    const iva = sub * (obtenerIva(item) / 100);

    subtotal += sub;
    iva_total += iva;

    return {
      producto_id:     item.producto_id ?? null,
      combo_id:        item.combo_id ?? null,
      cantidad:        item.cantidad,
      precio_unitario: precio,
      descuento_pct:   item.descuento_pct || 0,
      subtotal:        Math.round(sub * 100) / 100,
    };
  });

  const total = Math.round((subtotal + iva_total) * 100) / 100;

  return { subtotal, iva_total, total, itemsParaRpc };
}

/**
 * v(combos): IVA ponderado por el peso (precio_base × cantidad) de cada
 * componente sobre el total de la composición — es una aproximación
 * razonable para un combo con productos de distinta alícuota, ya que no
 * existe una única alícuota "correcta" para un ítem que en rigor mezcla
 * varios productos bajo un solo precio. Fallback a 21% si por algún motivo
 * el combo no trae precio_base de referencia en sus componentes.
 *
 * Extraída acá (antes vivía como función anidada solo dentro de
 * confirmarPedidoHandler) para poder reusarla en los call-sites de
 * admin/asistente (crearPedidoParaCliente, crearPresupuestoParaCliente) y
 * WhatsApp (crearPedidoDesdeItemsWhatsapp) sin duplicar la fórmula.
 *
 * @param {Array<{precio_base: number, cantidad: number, iva: number}>} comboItems
 * @returns {number}
 */
export function calcularIvaPonderadoCombo(comboItems) {
  let pesoTotal = 0, ivaPonderado = 0;
  for (const ci of comboItems) {
    const peso = ci.precio_base * ci.cantidad;
    pesoTotal += peso;
    ivaPonderado += peso * ci.iva;
  }
  return pesoTotal > 0 ? ivaPonderado / pesoTotal : 21;
}
