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

/**
 * FIX BUG-01 (auditoría 2026, hallazgo alto): antes este UPDATE era
 * incondicional — un check de `tx.estado === 'completado'` se hacía en el
 * handler ANTES de llamar acá, pero entre ese check y este UPDATE hay una
 * ventana de carrera real: dos webhooks del mismo pago (MP reintenta
 * notificaciones) o un webhook y un polling de verificarPago corriendo en
 * paralelo podían pasar los dos el check y los dos ejecutar el UPDATE y
 * luego el registro de cobro, duplicando el cobro/asiento en cta_cte
 * (`registrar_cobro_completo` solo dedupea por `offline_local_id`, y el
 * webhook no lo mandaba).
 *
 * `soloSiNoCompletada: true` agrega `.neq('estado', 'completado')` al
 * UPDATE y pide de vuelta las filas afectadas — así el UPDATE mismo actúa
 * como compare-and-swap: si otro caller ya lo puso en 'completado' un
 * instante antes, esta llamada actualiza 0 filas (en vez de pisar el
 * estado) y el caller puede detectarlo por `data.length === 0` y tratarlo
 * como "ya procesado por otro caller concurrente", igual que el resto del
 * flujo trata un duplicado. Se agrega `.select('id')` porque sin `select`
 * PostgREST no devuelve las filas afectadas y no se podría distinguir "se
 * actualizó" de "no había fila que matchee la condición".
 */
export async function actualizarTransaccionPorId(id, payload, { soloSiNoCompletada = false } = {}) {
  let query = db.from('transacciones_pago').update(payload).eq('id', id);
  if (soloSiNoCompletada) {
    query = query.neq('estado', 'completado');
  }
  return query.select('id');
}

/**
 * FIX MERCADOPAGO-AUDIT-01: reemplaza a obtenerTransaccionEmpresaPorReferencia
 * en el webhook. La transacción se busca por `pedido_id` (columna propia,
 * siempre confiable) en vez de por `referencia_externa`, que a esta altura
 * del webhook todavía tiene el preference_id, no el payment_id.
 *
 * FIX SEC-10 (auditoría 2026, hallazgo crítico): antes esta consulta
 * resolvía la transacción solo por `pedido_id`, sin exigir que perteneciera
 * a la misma empresa que la integración de MP resuelta por `mp_user_id`
 * (el webhook ya validaba mpUserId → integracion, pero después buscaba la
 * transacción/pedido sin volver a chequear ese tenant). Un evento con
 * `external_reference` apuntando al pedido de OTRA empresa —cobrado en una
 * cuenta de MP distinta a la que emitió ese pedido— podía terminar
 * confirmando el pedido de la empresa B con un pago acreditado en la cuenta
 * de MP de la empresa A. Ahora `empresa_id` es un filtro obligatorio de la
 * query, no una verificación posterior en el handler: si la transacción
 * existe pero es de otra empresa, esta función no la devuelve (mismo
 * resultado que "no encontrada"), y el handler la trata como tal.
 */
export async function obtenerTransaccionPorPedido(pedido_id, empresa_id) {
  return db
    .from('transacciones_pago')
    .select('id, estado, empresa_id, pedido_id, cliente_id, monto, proveedor, referencia_externa')
    .eq('pedido_id', pedido_id)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
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
/**
 * FIX MERCADOPAGO-AUDIT-01: resuelve la empresa dueña del pago a partir del
 * `user_id` que Mercado Pago manda en el body de cada notificación de
 * webhook (cuenta de MP que recibió el cobro) — no depende de nada que
 * hayamos guardado nosotros sobre el payment_id/preference_id. Requiere que
 * guardarConfigMP y posQrSetupHandler hayan persistido `mp_user_id`.
 */
export async function obtenerIntegracionMPPorMpUserId(mp_user_id) {
  return db
    .from('integraciones_pago')
    .select('*')
    .eq('mp_user_id', mp_user_id)
    .eq('proveedor', 'mercado_pago')
    .eq('activa', true)
    .maybeSingle();
}

/**
 * FIX (soporte OAuth): antes solo traía `access_token`. verificarPago
 * necesita también empresa_id/refresh_token/token_expires_at/conectado_via
 * para poder pasar la fila por obtenerAccessTokenMPValido() (refresco
 * automático si el token OAuth está por vencer) — antes de este fix, un
 * pago verificado vía polling con una cuenta conectada por OAuth podía
 * fallar silenciosamente contra MP una vez vencido el token de ~180 días,
 * sin ningún camino para refrescarlo.
 */
export async function obtenerIntegracionMPAccessToken(empresa_id) {
  const { data } = await db
    .from('integraciones_pago')
    .select('empresa_id, access_token, refresh_token, token_expires_at, conectado_via')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago')
    .eq('activa', true)
    .single();
  return data;
}

/**
 * Actualiza el access_token/refresh_token/token_expires_at tras un refresco
 * OAuth exitoso (ver refrescarTokenOAuthMP en lib/handlers/pagos.js). No
 * toca conectado_via ni ninguna otra columna.
 */
export async function actualizarTokensOAuthMP(empresa_id, { access_token, refresh_token, token_expires_at }) {
  return db
    .from('integraciones_pago')
    .update({ access_token, refresh_token, token_expires_at, updated_at: new Date().toISOString() })
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago');
}

export async function upsertIntegracionMP(payload) {
  return db
    .from('integraciones_pago')
    .upsert(payload, { onConflict: 'empresa_id,proveedor' });
}

export async function obtenerConfigIntegracionMP(empresa_id, proveedor) {
  return db
    .from('integraciones_pago')
    .select('public_key, activa, created_at, updated_at, conectado_via')
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

// ── QR de Mercado Pago (cobro presencial en el POS) ─────────────────────────

/**
 * Integración completa (incluye access_token cifrado, mp_user_id, store_id,
 * pos_id) — usada por los 4 endpoints de pos-qr-*. Distinta de
 * obtenerIntegracionMPActiva solo en el nombre, para que quede claro en el
 * handler qué endpoints tocan credenciales sensibles.
 */
export async function obtenerIntegracionMPParaQr(empresa_id) {
  return db
    .from('integraciones_pago')
    .select('*')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago')
    .eq('activa', true)
    .maybeSingle();
}

/**
 * Guarda store_id/pos_id/mp_user_id/qr_image una vez que se crearon (o
 * confirmaron) contra la API de MP. Todos los campos son opcionales: se
 * guarda solo lo que venga en `datos`, sin pisar el resto con null (setup
 * de Store y de POS son dos llamadas separadas, ver pos-qr-setup en
 * lib/handlers/pagos.js).
 */
export async function guardarStoreYPosQr(empresa_id, datos) {
  return db
    .from('integraciones_pago')
    .update({ ...datos, updated_at: new Date().toISOString() })
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'mercado_pago');
}

// ── Cobros QR (POS) ──────────────────────────────────────────────────────
// Tabla `cobros_qr_pos`: puente para que el POS se entere por Realtime de
// que un QR se pagó, sin depender solo del polling (ver pos-qr-cobrar y el
// branch `type === 'order'` del webhook de MP, ambos en lib/handlers/pagos.js).

/** Fila inicial al generar la orden QR — pos-qr-cobrar (best-effort, ver call site). */
export async function crearCobroQrPendiente(payload) {
  return db.from('cobros_qr_pos').insert({ ...payload, estado: 'pendiente' });
}

/** El webhook de MP la marca pagada/cancelada apenas confirma la orden. */
export async function actualizarCobroQrPorOrderId(order_id, payload) {
  return db.from('cobros_qr_pos').update(payload).eq('order_id', order_id);
}

// ── Terminal de pago Prisma (Paystore terminals) ─────────────────────────
// Mismo `integraciones_pago` genérico (columna `proveedor`), sin tabla
// nueva — ver migración 481. `upsertIntegracionMP`/`desactivarIntegracionMP`
// de arriba ya son genéricas por proveedor y se reusan tal cual.

/** Config sin credenciales (cuit_cuil sí, token no) — usada por obtenerConfigPrisma. */
export async function obtenerConfigIntegracionPrisma(empresa_id) {
  return db
    .from('integraciones_pago')
    .select('cuit_cuil, activa, created_at, updated_at')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'prisma')
    .maybeSingle();
}

/** Fila completa (incluye access_token cifrado + cuit_cuil) — usada por prisma-cobrar/verificar/cancelar. */
export async function obtenerIntegracionPrismaActiva(empresa_id) {
  return db
    .from('integraciones_pago')
    .select('*')
    .eq('empresa_id', empresa_id)
    .eq('proveedor', 'prisma')
    .eq('activa', true)
    .maybeSingle();
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
