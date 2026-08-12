// lib/repos/cta-cte.js
// Capa de acceso a datos para `cta_cte`.
//
// Fase 7, paso 4 del plan de migración (FASE7_PLAN_ARRANQUE.md). El plan
// original asumía 9 handlers tocando `cta_cte` directo (pedidos, pos,
// pagos, facturas, cierre, cc_proveedores, migracion, notif, auditoria).
// Al relevar el código real, la mayoría de esas menciones son comentarios
// o referencias a RPCs (`crear_pedido_cliente`, `aplicar_nota_credito_cta_cte`,
// `migracion_confirmar_cta_cte_lote`) que ya encapsulan el acceso a la
// tabla del lado de la base — no hay `.from('cta_cte')` suelto en
// pedidos.js, pos.js, pagos.js, facturas.js, cc_proveedores.js, auditoria.js
// ni en migracion.js. Los únicos accesos directos reales están en
// `cierre.js` (4) y `notif.js` (2, ya con `empresa_id` filtrado en ambos).
// Este repo cubre esos dos handlers — no queda pendiente ningún otro para
// esta tabla.

import { db } from './_db.js';

/**
 * Último saldo registrado para un cliente (el modelo es de saldo corrido:
 * cada fila de cta_cte ya trae el saldo acumulado a esa fecha, no hay que
 * sumar histórico). Usado tanto para calcular el próximo saldo al insertar
 * un movimiento como para chequear la deuda actual.
 *
 * OBSERVACIÓN (no corregida en este paso, fuera de alcance de "sin cambiar
 * comportamiento observable"): igual que el query original, ignora `error`
 * y devuelve 0 si la consulta falla. Para insertarMovimiento eso significa
 * que un timeout acá podría hacer que el próximo movimiento se inserte con
 * saldo mal calculado (arrancando de 0 en vez del saldo real). Ya era así
 * en el código pre-Fase-7 — se deja anotado para un futuro hallazgo de
 * auditoría, no se resuelve de paso.
 */
export async function obtenerUltimoSaldo(empresa_id, cliente_id) {
  const { data } = await db
    .from('cta_cte')
    .select('saldo')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .order('fecha', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.saldo || 0;
}

/**
 * Inserta un movimiento de cta_cte. A diferencia de obtenerUltimoSaldo, acá
 * sí se propaga el error (ya lo hacía el código original — un insert
 * fallido en silencio dejaba la tarea de cola_financiera marcada como
 * 'completado' sin haber asentado la deuda real).
 */
export async function insertarMovimiento({ empresa_id, cliente_id, tipo, monto, factura_id, saldo, fecha }) {
  const { error } = await db
    .from('cta_cte')
    .insert({ empresa_id, cliente_id, tipo, monto, factura_id, saldo, fecha });

  if (error) throw new Error(`[CtaCteRepo.insertarMovimiento] ${error.message}`);
}

/**
 * Todos los movimientos (monto, tipo) de un cliente — para calcular la
 * deuda total sumando débitos y restando créditos.
 *
 * HALLAZGO (corregido acá, mismo criterio que el filtro `activo` agregado
 * en la migración de `empresa.js`): el query original en
 * detectarVencimientosYBloquear() no filtraba por `empresa_id`, solo por
 * `cliente_id` — no explotaba porque `cliente_id` ya es único por sí solo,
 * pero rompe la regla no-negociable del checklist de Fase 7 ("siempre
 * recibiendo empresa_id como primer parámetro, nunca confiar en RLS como
 * única barrera"). Se agrega el filtro acá. El error sigue ignorándose
 * (devuelve `[]`) porque este repo se llama dentro de un `for` sin
 * try/catch por iteración en el cron de cierre — lanzar cortaría el batch
 * completo por un timeout puntual en un cliente, en vez de saltear solo
 * ese cliente (que es lo que hacía el código original).
 */
export async function listarMovimientosPorCliente(empresa_id, cliente_id) {
  const { data } = await db
    .from('cta_cte')
    .select('monto, tipo')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id);
  return data || [];
}

/**
 * Últimos N movimientos (fecha, monto, tipo) para el detalle del estado de
 * cuenta enviado por email — usado por notif.js. Ignora error igual que el
 * query original: si falla, el email de estado de cuenta se manda igual
 * pero sin el detalle de movimientos (mejor eso que no mandar nada).
 */
export async function listarUltimosMovimientos(empresa_id, cliente_id, { limit = 10 } = {}) {
  const { data } = await db
    .from('cta_cte')
    .select('fecha, monto, tipo')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .order('fecha', { ascending: false })
    .limit(limit);
  return data || [];
}
