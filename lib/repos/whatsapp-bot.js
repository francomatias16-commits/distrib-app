// lib/repos/whatsapp-bot.js
// Capa de acceso a datos para el bot conversacional de WhatsApp (Etapa 6 —
// webhook entrante, `whatsapp_conversaciones`, `whatsapp_mensajes` — y
// Etapa 7 — credenciales por empresa en `empresa_whatsapp`, Embedded Signup).
//
// Fase 7, paso 7 del plan de migración (FASE7_PLAN_ARRANQUE.md), lote 4 —
// último lote de `notif.js` (ver lib/repos/notif.js para lotes 1-3).
//
// Repo propio en vez de sumarse a `lib/repos/notif.js`, tal como quedó
// anotado al cerrar el lote 3: conceptualmente esto no es "notif" (no hay
// ningún envío de plantilla/push acá) sino el motor conversacional completo
// — matching teléfono→empresa/cliente, estado de la conversación, historial
// de mensajes, creación del pedido en firme y el flujo de alta de WhatsApp
// Business propio de una empresa. Es también el lote de mayor riesgo real
// (firma de Meta, estado de conversación, plata — crea pedidos) de los 4.
//
// Nota: `resolverEmpresaCliente`/`marcarDerivada` en el handler ya reusan
// `listarUsuariosPorRoles` de `lib/repos/notif.js` para el aviso a
// admins/vendedores — no se duplica acá.

import { db } from './_db.js';

// ── Credenciales por empresa (Etapa 7 — Embedded Signup) ────────────────

/**
 * Credenciales de WhatsApp propias de una empresa, si conectó su número vía
 * Embedded Signup. Devuelve `{ data, error }` tal cual — el caller
 * (`resolverCredencialesWhatsapp`) ya distingue "sin fila" de "error de
 * conexión" y en ambos casos cae al mismo fallback global, así que no hay
 * necesidad de tirar excepción acá.
 */
export async function obtenerCredencialesWhatsapp(empresa_id) {
  const { data, error } = await db
    .from('empresa_whatsapp')
    .select('phone_number_id, access_token, envios_habilitados')
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

/**
 * Guarda (upsert) las credenciales de WhatsApp Business propio de una
 * empresa al terminar el flujo de Embedded Signup. `onConflict: 'empresa_id'`
 * permite reconectar si la empresa repite el flujo (ej. cambió de número).
 */
export async function guardarCredencialesWhatsapp(payload) {
  const { error } = await db
    .from('empresa_whatsapp')
    .upsert(payload, { onConflict: 'empresa_id' });
  return { error };
}

// ── Matching teléfono → empresa/cliente ──────────────────────────────────

/**
 * Conversación abierta (no cerrada) para un teléfono, si existe — se
 * respeta la empresa/cliente de esa conversación en curso en vez de
 * volver a resolver desde cero (decisión #1 de la migración 246).
 */
export async function buscarConversacionAbiertaPorTelefono(telefono) {
  const { data } = await db
    .from('whatsapp_conversaciones')
    .select('empresa_id, cliente_id')
    .eq('telefono', telefono)
    .neq('estado', 'cerrada')
    .maybeSingle();
  return data;
}

/**
 * Empresa dueña de un `phone_number_id` (Etapa 7 — número propio conectado
 * por Embedded Signup). `null` si el mensaje llegó al número global de
 * prueba (sin fila en `empresa_whatsapp`).
 */
export async function obtenerEmpresaPorPhoneNumberId(phone_number_id) {
  const { data } = await db
    .from('empresa_whatsapp')
    .select('empresa_id')
    .eq('phone_number_id', phone_number_id)
    .maybeSingle();
  return data;
}

/**
 * Empresa dueña de un `waba_id` (Coexistencia — migración 436). Los
 * webhooks de `account_update`/`account_offboarded`/`account_reconnected`
 * identifican la cuenta solo por `entry.id` (el WABA_ID), sin
 * `phone_number_id`, así que hace falta este segundo camino de matching
 * además de `obtenerEmpresaPorPhoneNumberId`.
 */
export async function obtenerEmpresaPorWabaId(waba_id) {
  const { data } = await db
    .from('empresa_whatsapp')
    .select('empresa_id, phone_number_id')
    .eq('waba_id', waba_id)
    .maybeSingle();
  return data;
}

/**
 * Refleja en la fila de la empresa lo que Meta avisó por webhook sobre
 * el estado de la conexión de Coexistencia (migración 436):
 *   - PARTNER_REMOVED / ACCOUNT_OFFBOARDED → el dueño desconectó el
 *     número desde la app de WhatsApp Business (`desconectado_en` +
 *     `necesita_reconexion=true`, mismo flag que usa el panel para
 *     mostrar "Reconectar mi WhatsApp").
 *   - ACCOUNT_RECONNECTED → se limpia todo, vuelve a "conectado".
 */
export async function actualizarEstadoConexionWhatsapp(empresa_id, { desconectado }) {
  const patch = desconectado
    ? { desconectado_en: new Date().toISOString(), necesita_reconexion: true }
    : { desconectado_en: null, necesita_reconexion: false };
  const { error } = await db.from('empresa_whatsapp').update(patch).eq('empresa_id', empresa_id);
  return { error };
}

/**
 * Marca que ya se pidió (Meta responde 200 a la solicitud, no que ya
 * terminó — eso llega asincrónico vía los webhooks `smb_app_state_sync`/
 * `history`) la sincronización de contactos + historial tras un alta por
 * Coexistencia. Solo se puede pedir una vez por alta.
 */
export async function marcarHistorialSincronizado(empresa_id) {
  const { error } = await db
    .from('empresa_whatsapp')
    .update({ historial_sincronizado: true })
    .eq('empresa_id', empresa_id);
  return { error };
}

/**
 * Cliente de una empresa por teléfono, acotado a `empresa_id` (usado una
 * vez que Embedded Signup ya resolvió la empresa sin ambigüedad).
 */
export async function buscarClientePorTelefonoEnEmpresa(empresa_id, telefono) {
  const { data } = await db
    .from('clientes')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('telefono', telefono)
    .maybeSingle();
  return data;
}

/**
 * Matching genérico teléfono → empresa/cliente (fallback para el número
 * global de prueba, Etapas 0-6). Devuelve `{ data, error }` porque el
 * caller loguea el mensaje de error en vez de lanzar (el webhook siempre
 * responde 200 a Meta, ver comentario en `whatsappWebhookHandler`).
 */
export async function resolverClientePorTelefonoRpc(telefono) {
  const { data, error } = await db.rpc('resolver_cliente_por_telefono', { p_telefono: telefono });
  return { data, error };
}

// ── Conversación ──────────────────────────────────────────────────────────

/**
 * Id de la conversación abierta (no cerrada) de un teléfono, si existe.
 */
export async function buscarConversacionAbiertaId(telefono) {
  const { data } = await db
    .from('whatsapp_conversaciones')
    .select('id')
    .eq('telefono', telefono)
    .neq('estado', 'cerrada')
    .maybeSingle();
  return data;
}

/**
 * Crea una conversación nueva en estado 'activa' con borrador de pedido
 * vacío. Lanza si falla — sin conversación no hay dónde registrar el
 * mensaje entrante, no tiene sentido seguir el flujo silenciosamente.
 */
export async function crearConversacion({ telefono, empresa_id, cliente_id }) {
  const { data, error } = await db
    .from('whatsapp_conversaciones')
    .insert({
      telefono, empresa_id, cliente_id, estado: 'activa', pedido_borrador: { items: [] },
      turno_desde: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`[WhatsappBotRepo.crearConversacion] ${error.message}`);
  return data.id;
}

/**
 * Estado y borrador de pedido de una conversación — punto de partida de
 * `procesarMensajeTexto` para decidir por qué rama del flujo sigue.
 */
export async function obtenerEstadoYBorrador(conversacionId) {
  const { data } = await db
    .from('whatsapp_conversaciones')
    .select('estado, pedido_borrador, ultima_interaccion, turno_desde')
    .eq('id', conversacionId)
    .single();
  return data;
}

/**
 * Actualiza solo `ultima_interaccion`, sin tocar estado ni borrador — usado
 * cuando llega un mensaje nuevo en una conversación ya 'derivada_humano',
 * para poder medir cuánto pasó desde el último mensaje del cliente y
 * decidir si corresponde re-avisar (ver manejarMensajeEnConversacionDerivada
 * en notif.js).
 */
export async function actualizarUltimaInteraccion(conversacionId) {
  await db
    .from('whatsapp_conversaciones')
    .update({ ultima_interaccion: new Date().toISOString() })
    .eq('id', conversacionId);
}

/**
 * Vuelve la conversación a 'activa' sin tocar el borrador — usado cuando
 * un mensaje en medio de una confirmación pendiente no es ni confirmación
 * ni cancelación clara (se reintenta el flujo normal del asistente), y al
 * salir de `confirmarPedidoWhatsapp` en los dos casos que no cierran la
 * conversación (sin ítems / error creando el pedido).
 */
export async function marcarConversacionActiva(conversacionId) {
  // FIX (2026-08-04): turno_desde se reinicia acá — ver comentario de la
  // columna en la migración. Si no se resetea, el corte
  // MAX_TURNOS_SIN_CONFIRMAR sigue contando mensajes de rondas anteriores
  // ya cerradas/derivadas, y una conversación vieja puede derivarse de
  // nuevo en el primer mensaje de una ronda nueva.
  await db
    .from('whatsapp_conversaciones')
    .update({ estado: 'activa', turno_desde: new Date().toISOString() })
    .eq('id', conversacionId);
}

/**
 * Cancela el borrador en curso: vuelve a 'activa' con `pedido_borrador`
 * vacío, para que el cliente pueda arrancar un pedido nuevo desde cero.
 */
export async function reiniciarBorradorConversacion(conversacionId) {
  // FIX (2026-08-04): mismo motivo que marcarConversacionActiva — cancelar
  // un borrador y arrancar de cero también debería resetear el contador
  // de turnos, no solo el estado/borrador.
  const ahora = new Date().toISOString();
  await db
    .from('whatsapp_conversaciones')
    .update({ estado: 'activa', pedido_borrador: { items: [] }, ultima_interaccion: ahora, turno_desde: ahora })
    .eq('id', conversacionId);
}

/**
 * Cierra la conversación tras confirmar el pedido en firme — único punto
 * de escritura que deja una conversación en estado 'cerrada'.
 */
export async function cerrarConversacionConPedido(conversacionId, pedidoId) {
  await db
    .from('whatsapp_conversaciones')
    .update({ estado: 'cerrada', pedido_creado_id: pedidoId, ultima_interaccion: new Date().toISOString() })
    .eq('id', conversacionId);
}

/**
 * Marca la conversación como derivada a un humano (el bot deja de
 * intervenir hasta que alguien la libere desde el panel admin).
 */
export async function marcarConversacionDerivada(conversacionId, motivo) {
  await db
    .from('whatsapp_conversaciones')
    .update({ estado: 'derivada_humano', motivo_derivacion: motivo, ultima_interaccion: new Date().toISOString() })
    .eq('id', conversacionId);
}

/**
 * `empresa_id`/`telefono` de una conversación — usado por `marcarDerivada`
 * para armar el aviso a admins/vendedores (a quién avisar y de qué charla).
 */
export async function obtenerConversacionEmpresaTelefono(conversacionId) {
  const { data } = await db
    .from('whatsapp_conversaciones')
    .select('empresa_id, telefono')
    .eq('id', conversacionId)
    .single();
  return data;
}

/**
 * Conversación con los campos que necesita el panel admin (Etapa 5) para
 * validar ownership por empresa y el estado de "tomada_por" antes de
 * tomar/liberar. Devuelve `{ data, error }` porque el handler distingue
 * "no encontrada" (404) del resto.
 */
export async function obtenerConversacionParaAccion(conversacionId) {
  const { data, error } = await db
    .from('whatsapp_conversaciones')
    .select('id, empresa_id, estado, tomada_por')
    .eq('id', conversacionId)
    .single();
  return { data, error };
}

/**
 * Asigna la conversación a un usuario del panel admin.
 */
export async function tomarConversacion(conversacionId, usuario_id) {
  const { error } = await db
    .from('whatsapp_conversaciones')
    .update({ tomada_por: usuario_id, tomada_en: new Date().toISOString() })
    .eq('id', conversacionId);
  return { error };
}

/**
 * Libera una conversación tomada (vuelve a quedar disponible para
 * cualquier admin/vendedor).
 */
export async function liberarConversacion(conversacionId) {
  const { error } = await db
    .from('whatsapp_conversaciones')
    .update({ tomada_por: null, tomada_en: null })
    .eq('id', conversacionId);
  return { error };
}

// ── Mensajes ──────────────────────────────────────────────────────────────

/**
 * Registra un mensaje (entrante o saliente) de la conversación. Devuelve
 * `{ error }` tal cual — el caller necesita inspeccionar `error.code` para
 * distinguir un conflicto de `wa_message_id` (23505 = reintento de Meta,
 * ya procesado) de un error real, así que no puede resolverse acá adentro.
 */
export async function registrarMensajeWhatsapp({ conversacion_id, direccion, wa_message_id, texto, tipo, metadata }) {
  const { error } = await db.from('whatsapp_mensajes').insert({
    conversacion_id,
    direccion,
    wa_message_id: wa_message_id || null,
    texto,
    tipo: tipo || 'text',
    metadata: metadata || null,
  });
  return { error };
}

// ── Outbox de salientes (Etapa 5 offline, punto 3 del plan) ────────────────
// enviarTextoWhatsApp (lib/handlers/notif.js) ya reintenta en el momento
// ante fallas transitorias; lo que sigue es para lo que ESE reintento
// inline no resuelve (Meta caído más de unos segundos, token vencido que
// recién se corrige más tarde, etc.). En vez de perder el mensaje,
// responderYRegistrar lo deja grabado con metadata.estado_envio='pendiente'
// y el cron diario (_svc=whatsapp-salientes-reprocesar-cron) lo reintenta
// hasta MAX_INTENTOS_SALIENTE. No hay columna nueva — se reusa
// whatsapp_mensajes.metadata (jsonb, ya existía) para no necesitar
// migración.

export const MAX_INTENTOS_SALIENTE = 10;

/**
 * Salientes pendientes de reintento, con el telefono/empresa_id de su
 * conversación (necesarios para poder reintentar el envío) — de más
 * viejo a más nuevo, para no dejar sistemáticamente atrás al primero que
 * quedó pendiente si el cron corta por el límite.
 */
export async function obtenerSalientesPendientes(limite = 200) {
  const { data, error } = await db
    .from('whatsapp_mensajes')
    .select('id, texto, metadata, conversacion_id, whatsapp_conversaciones!inner(telefono, empresa_id)')
    .eq('direccion', 'out')
    .eq('metadata->>estado_envio', 'pendiente')
    .order('created_at', { ascending: true })
    .limit(limite);
  return { data: data || [], error };
}

/** Reintento exitoso: guarda el wa_message_id real y cierra el pendiente. */
export async function marcarSalienteEnviado(id, wa_message_id) {
  await db.from('whatsapp_mensajes')
    .update({ wa_message_id: wa_message_id || null, metadata: { estado_envio: 'enviado' } })
    .eq('id', id);
}

/**
 * Reintento fallido: suma el intento y, recién al llegar a
 * MAX_INTENTOS_SALIENTE, pasa a 'agotado' para que el cron deje de
 * insistir con algo que evidentemente no va a salir solo (mismo criterio
 * que el resto del proyecto: que se note en los logs en vez de reintentar
 * en loop silencioso para siempre).
 */
export async function marcarSalienteFallido(id, intentosPrevios, ultimoError) {
  const intentos = (intentosPrevios || 0) + 1;
  const estado_envio = intentos >= MAX_INTENTOS_SALIENTE ? 'agotado' : 'pendiente';
  await db.from('whatsapp_mensajes')
    .update({ metadata: { estado_envio, intentos, ultimo_error: ultimoError || null } })
    .eq('id', id);
}

/**
 * Últimos mensajes de texto de la conversación, más recientes primero —
 * el caller los da vuelta para armar el historial que se manda al
 * asistente de IA.
 */
export async function obtenerHistorialMensajes(conversacionId, { limite = 10 } = {}) {
  const { data } = await db
    .from('whatsapp_mensajes')
    .select('direccion, texto')
    .eq('conversacion_id', conversacionId)
    .not('texto', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limite);
  return data || [];
}

/**
 * Cantidad de mensajes entrantes de la conversación — corte defensivo de
 * costo/loop (`MAX_TURNOS_SIN_CONFIRMAR`).
 */
/**
 * Cuenta mensajes entrantes para el corte MAX_TURNOS_SIN_CONFIRMAR.
 *
 * FIX (2026-08-04): antes contaba TODOS los mensajes entrantes de la
 * conversación desde que se creó, sin ventana de tiempo — una conversación
 * que en algún momento se derivó a un vendedor quedaba con un conteo que
 * nunca bajaba, así que el mismo cliente podía volver a derivarse en su
 * primer mensaje de una charla completamente nueva, semanas después.
 * `turnoDesde` (la columna `turno_desde`, reseteada cada vez que la
 * conversación vuelve a 'activa') acota el conteo a la ronda actual.
 */
export async function contarMensajesEntrantes(conversacionId, turnoDesde) {
  let query = db
    .from('whatsapp_mensajes')
    .select('id', { count: 'exact', head: true })
    .eq('conversacion_id', conversacionId)
    .eq('direccion', 'in');
  if (turnoDesde) query = query.gte('created_at', turnoDesde);
  const { count } = await query;
  return count || 0;
}

// ── Creación de pedido desde el bot ──────────────────────────────────────

/**
 * Cliente para validar antes de crear el pedido (activo, límite de
 * crédito, deuda). Devuelve `{ data, error }` — `crearPedidoDesdeItemsWhatsapp`
 * distingue "no encontrado" de "inactivo" con mensajes distintos.
 */
export async function obtenerClienteParaPedidoWhatsapp(cliente_id, empresa_id) {
  const { data, error } = await db
    .from('clientes')
    .select('id, activo, limite_credito, saldo_deuda')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Stock de los productos del borrador, con el depósito embebido para que
 * el caller pueda quedarse solo con el depósito principal (mismo criterio
 * que el resto del sistema).
 */
export async function obtenerStockParaPedidoWhatsapp(productoIds) {
  const { data } = await db
    .from('stock')
    .select('producto_id, cantidad, cantidad_reservada, depositos(es_principal)')
    .in('producto_id', productoIds);
  return data || [];
}

/**
 * Precios resueltos para el cliente (listas especiales, reglas de precio,
 * etc.) — mismo RPC que usa el flujo de pedidos del portal/admin.
 */
export async function resolverPreciosClienteRpc({ cliente_id, producto_ids, empresa_id }) {
  const { data, error } = await db.rpc('resolver_precios_cliente', {
    p_cliente_id: cliente_id, p_producto_ids: producto_ids, p_empresa_id: empresa_id,
  });
  return { data, error };
}

/**
 * Crea el pedido en firme — mismo RPC que `confirmarPedidoHandler`
 * (lib/handlers/pedidos.js), con `p_canal: 'whatsapp'` y `p_vendedor_id`
 * null (sin vendedor asignado, es el bot).
 */
export async function crearPedidoClienteRpc(payload) {
  const { data, error } = await db.rpc('crear_pedido_cliente', payload);
  return { data, error };
}

/**
 * Número de pedido legible para el mensaje de confirmación al cliente.
 */
export async function obtenerNumeroPedido(pedidoId) {
  const { data } = await db
    .from('pedidos')
    .select('numero_pedido')
    .eq('id', pedidoId)
    .maybeSingle();
  return data;
}
