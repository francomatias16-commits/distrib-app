// lib/repos/cierre.js
// Capa de acceso a datos para `lib/handlers/cierre.js` (REQ-2: Cierre
// Financiero Encadenado Automático).
//
// El handler ya importaba `obtenerUltimoSaldo`, `insertarMovimiento` y
// `listarMovimientosPorCliente` desde `lib/repos/cta-cte.js` (ver cabecera
// de ese repo — cierre.js es uno de los dos únicos handlers con acceso
// directo a `cta_cte`). Este módulo cubre el resto: `cola_financiera`,
// `facturas` (lectura/campos propios de cierre, no el CRUD completo que ya
// vive en facturas.js), `clientes` y `bloqueos_cliente`.

import { db } from './_db.js';

// ── Cola financiera ─────────────────────────────────────────────────────────

/**
 * Tareas pendientes/error listas para reprocesar (ya vencido su
 * `proximo_intento`, con menos de 4 intentos). `empresa_id` es opcional:
 * el cron interno (CRON_SECRET) procesa todas las empresas; un dueño/admin
 * disparando manualmente, o `procesarColaFinancieraEmpresa`, siempre pasan
 * su propia empresa — mismo query, un solo `.eq()` condicional en vez de
 * duplicarlo en dos handlers.
 */
export async function obtenerTareasColaFinanciera(empresa_id = null) {
  let q = db
    .from('cola_financiera')
    .select('*')
    .in('estado', ['pendiente', 'error'])
    .lte('proximo_intento', new Date().toISOString())
    .lt('intentos', 4);

  if (empresa_id) q = q.eq('empresa_id', empresa_id);

  const { data } = await q.order('created_at').limit(20);
  return data;
}

export async function marcarTareaProcesando(tarea_id, intentos) {
  return db
    .from('cola_financiera')
    .update({ estado: 'procesando', intentos, updated_at: new Date() })
    .eq('id', tarea_id);
}

export async function marcarTareaCompletada(tarea_id) {
  return db
    .from('cola_financiera')
    .update({ estado: 'completado', updated_at: new Date() })
    .eq('id', tarea_id);
}

export async function marcarTareaConError(tarea_id, { estado, error_msg, proximo_intento }) {
  return db
    .from('cola_financiera')
    .update({ estado, error_msg, proximo_intento, updated_at: new Date() })
    .eq('id', tarea_id);
}

/** Encola una tarea `bloquear` para un cliente con deuda vencida (dedupe vía onConflict). */
export async function encolarTareaBloqueo(payload) {
  return db
    .from('cola_financiera')
    .upsert(payload, { onConflict: 'referencia_id,tipo,estado', ignoreDuplicates: true });
}

// ── Facturación (procesarFacturacion) ───────────────────────────────────────

/** Chequeo de idempotencia: ¿ya existe factura para este pedido? */
export async function obtenerFacturaPorPedido(pedido_id) {
  const { data } = await db.from('facturas').select('id').eq('pedido_id', pedido_id).maybeSingle();
  return data;
}

/** Pedido completo (cliente, items) para armar la factura y el email de aviso. */
export async function obtenerPedidoParaFacturacion(pedido_id) {
  const { data } = await db
    .from('pedidos')
    .select(`
      *, empresa_id,
      clientes(razon_social, cuit, condicion_iva, email),
      pedido_items(cantidad, precio_unitario, subtotal, productos(nombre))
    `)
    .eq('id', pedido_id)
    .single();
  return data;
}

/** ¿La empresa tiene facturación electrónica (ARCA/WSFEv1) activa? */
export async function obtenerFacturacionConfigActiva(empresa_id) {
  const { data } = await db
    .from('facturacion_config')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .maybeSingle();
  return data;
}

export async function actualizarFechaVencimientoFactura(factura_id, fecha_vencimiento) {
  return db.from('facturas').update({ fecha_vencimiento }).eq('id', factura_id);
}

// ── Notificación de vencimiento (procesarNotifVencimiento) ─────────────────

export async function obtenerClienteParaNotifVencimiento(cliente_id) {
  const { data } = await db
    .from('clientes')
    .select('razon_social, email, telefono')
    .eq('id', cliente_id)
    .single();
  return data;
}

// ── Detección de vencidos + bloqueo (detectarVencimientosYBloquear) ────────

/**
 * Facturas emitidas vencidas hace más de 7 días que todavía no dispararon
 * el aviso de los 15 días (barre TODAS las empresas — sin filtro de
 * empresa_id a propósito, ver nota en `procesarColaFinancieraEmpresa` del
 * handler sobre por qué esta función no se reusa desde ahí).
 */
export async function obtenerFacturasVencidasSinNotificar(cutoffISO) {
  const { data } = await db
    .from('facturas')
    .select(`
      id, pedido_id, empresa_id,
      pedidos(cliente_id, total, clientes(razon_social, email))
    `)
    .eq('estado', 'emitida')
    .lt('fecha_vencimiento', cutoffISO)
    .eq('notif_15d_enviada', false);
  return data;
}

export async function marcarFacturaNotif15dEnviada(factura_id) {
  return db.from('facturas').update({ notif_15d_enviada: true }).eq('id', factura_id);
}

// ── Bloqueo de cliente (procesarBloqueo) ────────────────────────────────────

export async function bloquearCliente(cliente_id, { bloqueado_motivo }) {
  return db
    .from('clientes')
    .update({ bloqueado: true, bloqueado_motivo })
    .eq('id', cliente_id);
}

export async function upsertBloqueoCliente(payload) {
  return db.from('bloqueos_cliente').upsert(payload, { onConflict: 'cliente_id' });
}
