// lib/repos/pagos.js
// Capa de acceso a datos para `lib/handlers/pagos.js` (integración Mercado Pago).
//
// Migra las ~19 consultas directas del handler (crear preferencia, config
// manual de credenciales, verificación de pago por polling y webhook) a la
// capa de repos, mismo criterio que el resto de la Fase 7
// (FASE7_PLAN_ARRANQUE.md). No se toca `supabase.auth.getUser()` ni la lógica
// de HTTP contra la API de Mercado Pago (fetchMP/circuit breaker/retry) —
// eso se queda en el handler, acá solo va lo que pega contra Supabase.
//
// Convención de retorno: se preserva exactamente la forma que ya consumía
// cada call site (algunos destructuran `{ data, error }`, otros solo
// `data`) para que el diff del handler sea un mapeo 1 a 1, sin cambiar
// comportamiento.

import { db } from './_db.js';

// ── Perfil de usuario ───────────────────────────────────────────────────────

/** Perfil del usuario autenticado (empresa_id, cliente_id, rol) — crearPreferencia y verificarPago. */
export async function obtenerPerfilUsuarioPago(user_id) {
  const { data } = await db
    .from('usuarios')
    .select('id, empresa_id, cliente_id, rol')
    .eq('id', user_id)
    .single();
  return data;
}

/** Perfil para el guard de rol dueno/admin — autenticarAdmin (config MP). */
export async function obtenerPerfilAdminPago(user_id) {
  return db
    .from('usuarios')
    .select('id, empresa_id, rol')
    .eq('id', user_id)
    .single();
}

// ── Pedido ───────────────────────────────────────────────────────────────────

/** Pedido real desde la BD — el monto y los items de la preferencia se calculan solo a partir de esto. */
export async function obtenerPedidoParaPago(pedido_id) {
  return db
    .from('pedidos')
    .select('id, empresa_id, cliente_id, total, estado, clientes(email)')
    .eq('id', pedido_id)
    .single();
}

/** Items reales del pedido (no los que mande el cliente) para armar la preferencia de MP. */
export async function obtenerItemsPedido(pedido_id) {
  const { data } = await db
    .from('pedido_items')
    .select('cantidad, precio_unitario, productos(nombre)')
    .eq('pedido_id', pedido_id);
  return data;
}

/** Marca el pedido como confirmado tras un pago aprobado (webhook y polling comparten esta misma escritura). */
export async function confirmarPedidoPagado(pedido_id) {
  return db
    .from('pedidos')
    .update({ estado: 'confirmado' })
    .eq('id', pedido_id)
    .select('cliente_id, empresa_id')
    .maybeSingle();
}

// ── Transacciones de pago ────────────────────────────────────────────────────

/**
 * Transacción pendiente más reciente del pedido — idempotencia en
 * crearPreferencia: si ya tiene checkout_url vigente, se reusa en vez de
 * crear una preferencia nueva en MP en cada reintento.
 */
export async function obtenerTransaccionPendientePorPedido(pedido_id) {
  const { data } = await db
    .from('transacciones_pago')
    .select('id, referencia_externa, respuesta_json')
    .eq('pedido_id', pedido_id)
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function crearTransaccionPago(payload) {
  return db.from('transacciones_pago').insert(payload);
}

/** Transacción completa por referencia externa (payment_id de MP) — usada por verificarPago. */
export async function obtenerTransaccionParaVerificar(payment_id) {
  return db
    .from('transacciones_pago')
    .select('id, estado, empresa_id, pedido_id, cliente_id, monto, proveedor, referencia_externa')
    .eq('referencia_externa', payment_id)
    .maybeSingle();
}

/** Chequeo de idempotencia del webhook: ¿esta transacción ya fue procesada? */
export async function obtenerTransaccionEstadoPorReferencia(payment_id) {
  return db
    .from('transacciones_pago')
    .select('id, estado')
    .eq('referencia_externa', payment_id)
    .maybeSingle();
}

/**
 * FIX multi-tenant: la integración de MP es por empresa, no global. El
 * webhook necesita resolver primero a qué empresa pertenece el pago (vía la
 * transacción registrada en crearPreferencia) antes de buscar credenciales
 * — sin esto, con 2+ empresas activas, un `.single()` sobre todas las
 * integraciones rompe o devuelve credenciales de otra empresa.
 */
export async function obtenerTransaccionEmpresaPorReferencia(payment_id) {
  return db
    .from('transacciones_pago')
    .select('empresa_id')
    .eq('referencia_externa', payment_id)
    .maybeSingle();
}

export async function actualizarTransaccionPorReferencia(payment_id, payload) {
  return db
    .from('transacciones_pago')
    .update(payload)
    .eq('referencia_externa', payment_id);
}

export async function actualizarTransaccionPorId(id, payload) {
  return db.from('transacciones_pago').update(payload).eq('id', id);
}

// ── Integración Mercado Pago (config por empresa) ───────────────────────────

/** Credenciales completas de la integración activa — usada para llamar a la API de MP (crearPreferencia y webhook). */
export async function obtenerIntegracionMPActiva(empresa_id) {
  return db
    .from('integraciones_pago')
    .select('*')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago')
    .eq('activa', true)
    .single();
}

/**
 * Solo existencia (bool), sin traer credenciales — usada por
 * verPedidoSugeridoHandler (lib/handlers/pedidos.js) para decidir si
 * mostrar el botón "Pagar con Mercado Pago" en el checkout público, sin
 * necesidad de importar el módulo de pagos completo ahí.
 */
export async function existeIntegracionMPActiva(empresa_id) {
  const { data } = await db
    .from('integraciones_pago')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago')
    .eq('activa', true)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Único guard de "este pedido salió de verdad del piloto de WhatsApp" —
 * usado tanto por crearPreferenciaPublicaHandler (para autorizar el pago)
 * como por verPedidoSugeridoHandler (para decidir si mostrar el botón).
 * No existe una columna `origen`. Verificado contra la DB real: `canal`
 * tiene DEFAULT 'web' (nunca NULL), así que un pedido recién generado por
 * generar_pedido_sugerido_cliente() (generado_automatico=true, todavía sin
 * confirmar) también sale con canal='web' — `canal` no discrimina nada acá
 * antes de la confirmación, solo pasa a 'whatsapp' después, vía
 * confirmar_pedido_sugerido(). La única señal suficiente y correcta es
 * `generado_automatico=true`: lo pone exclusivamente
 * generar_pedido_sugerido_cliente() al crear el pedido, y ningún alta
 * manual del admin la setea.
 */
export function esPedidoPilotoWhatsApp(pedido) {
  return pedido.generado_automatico === true;
}

/** Solo el access_token cifrado — usada por verificarPago, que no necesita el resto de la fila. */
export async function obtenerIntegracionMPAccessToken(empresa_id) {
  const { data } = await db
    .from('integraciones_pago')
    .select('access_token')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago')
    .eq('activa', true)
    .single();
  return data;
}

export async function upsertIntegracionMP(payload) {
  return db
    .from('integraciones_pago')
    .upsert(payload, { onConflict: 'empresa_id,proveedor' });
}

export async function obtenerConfigIntegracionMP(empresa_id, proveedor) {
  return db
    .from('integraciones_pago')
    .select('public_key, activa, created_at, updated_at')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', proveedor)
    .maybeSingle();
}

export async function desactivarIntegracionMP(empresa_id, proveedor) {
  return db
    .from('integraciones_pago')
    .update({ activa: false, updated_at: new Date().toISOString() })
    .eq('empresa_id', empresa_id)
    .eq('proveedor', proveedor);
}

// ── Cta. cte. (acreditación del cobro tras pago aprobado) ───────────────────

/**
 * Registra el cobro en cta_cte tras un pago online aprobado (mismo RPC que
 * usa admin/cobranzas para el cobro manual). El desbloqueo del cliente por
 * saldo lo resuelve el propio RPC — no se recalcula en JS.
 */
export async function registrarCobroCompletoRpc(params) {
  return db.rpc('registrar_cobro_completo', params);
}
