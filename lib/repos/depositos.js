// lib/repos/depositos.js
//
// Resolución del depósito/sucursal de un pedido en TODOS los canales
// (WhatsApp, admin, portal cliente). Antes de esto cada canal resolvía el
// pedido mirando únicamente el depósito marcado `es_principal` de la
// empresa, sin importar de qué sucursal era el cliente. Reemplazado por
// un único criterio de prioridad, igual al de la función SQL
// resolver_deposito_pedido() (ya aplicada en producción, ver
// supabase/migrations/550_multi_deposito_sucursal_cliente.sql):
//   1) override explícito, SI pertenece a la empresa y está activo
//      (ej. el vendedor elige sucursal en el admin)
//   2) sucursal fija del cliente (clientes.deposito_id), SI está activa
//   3) fallback: depósito marcado es_principal y activo de la empresa
//      (comportamiento histórico, para clientes sin sucursal asignada)
//
// Toda esta lógica vive acá una sola vez para que no se repita (y
// diverja) en whatsapp-bot.js / notif.js, crear-pedido.js,
// confirmar-pedido.js y presupuestos.js.

import { db } from './_db.js';

/**
 * Resuelve un único deposito_id según la prioridad de arriba — espejo en
 * JS de resolver_deposito_pedido() en SQL. Se usa donde hace falta el
 * deposito_id ANTES de llamar a la RPC de creación de pedido (para
 * validar stock disponible); la RPC vuelve a resolverlo ella misma con
 * el mismo criterio, así que un desfasaje acá nunca deja reservar contra
 * un depósito distinto al que valida stock.
 *
 * Devuelve `null` si la empresa no tiene ningún depósito activo
 * configurado (ni principal ni de cliente) — el caller debe tratarlo
 * como error de configuración, no como "sin stock".
 */
export async function resolverDepositoParaPedido({ empresaId, clienteDepositoId = null, depositoIdExplicito = null }) {
  if (depositoIdExplicito) {
    const { data } = await db
      .from('depositos')
      .select('id')
      .eq('id', depositoIdExplicito)
      .eq('empresa_id', empresaId)
      .eq('activa', true)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  if (clienteDepositoId) {
    const { data } = await db
      .from('depositos')
      .select('id')
      .eq('id', clienteDepositoId)
      .eq('empresa_id', empresaId)
      .eq('activa', true)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  const { data } = await db
    .from('depositos')
    .select('id')
    .eq('empresa_id', empresaId)
    .eq('es_principal', true)
    .eq('activa', true)
    .maybeSingle();
  return data?.id || null;
}

/**
 * Stock disponible por producto en UN depósito ya resuelto. Reemplaza al
 * patrón viejo (`depositos(es_principal)` y filtrar en JS que había en
 * notif.js, crear-pedido.js y confirmar-pedido.js) por una query que ya
 * filtra en el depósito correcto — así el bug de "mirar solo es_principal"
 * no puede reaparecer en un canal nuevo.
 */
export async function obtenerStockPorDeposito(productoIds, depositoId) {
  if (!productoIds.length) return {};
  const { data } = await db
    .from('stock')
    .select('producto_id, cantidad, cantidad_reservada')
    .eq('deposito_id', depositoId)
    .in('producto_id', productoIds);

  const stockMap = {};
  for (const s of (data || [])) {
    stockMap[s.producto_id] = Math.max(0, (s.cantidad || 0) - (s.cantidad_reservada || 0));
  }
  return stockMap;
}

/**
 * Variante de fila única, para presupuestos.js: acá el criterio histórico
 * de confirmar_pedido() no compara "disponible" en JS sino que trabaja
 * con la fila cruda de `stock` (cantidad/cantidad_reservada) tal como la
 * devolvía obtenerStockDepositoPrincipal — se mantiene esa forma para no
 * cambiar el resto de la lógica de aceptar presupuesto.
 */
export async function obtenerStockDeDeposito(depositoId, productoId) {
  const { data } = await db
    .from('stock')
    .select('id, deposito_id, cantidad, cantidad_reservada')
    .eq('deposito_id', depositoId)
    .eq('producto_id', productoId)
    .maybeSingle();
  return data || null;
}
