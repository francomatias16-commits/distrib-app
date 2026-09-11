// lib/repos/notif.js
// Capa de acceso a datos para `notif_log`, `dispositivos_push`, `email_log`.
//
// notif_log es la tercera tabla más accedida (13 veces en 6 handlers distintos).
// Centralizar acá evita duplicar el mismo insert de log en cada handler.
//
// Fase 7, paso 7 del plan de migración (FASE7_PLAN_ARRANQUE.md). `notif.js`
// (handler) es un router consolidado de 71 `.from()` directos que mezcla
// varios subsistemas (bot conversacional de WhatsApp, dispositivos push,
// alertas por cron, email transaccional) — se migra en lotes por concern,
// mismo criterio que se usó para no migrar `pedidos.js`/`pos.js` de una.
//
// Lote 1 (v582): alertas operativas por cron — token de WhatsApp vencido,
// cheques por vencer y deuda vencida. Agrega funciones sobre `usuarios`
// (solo lectura de admins/dueños), `cheques` y `clientes`, además de
// generalizar `ultimoEnvio` para los casos que no filtran por cliente_id.
//
// Lote 2 (v582): estado de cuenta + reintentar email. Agrega funciones sobre
// `usuarios`, `clientes`, `facturas`, `notif_log`, `empresas`, `pedidos`,
// `recepciones_mercaderia` y `ordenes_compra` para `handleEstadoCuenta`,
// `handleReintentarEmail` y sus 4 helpers `_reintentar*`. De paso corrige un
// hallazgo: `obtenerPerfilEstadoCuenta` ahora filtra `activo=true`, cosa que
// el handler original no hacía.
//
// Lote 3 (v582): dispositivos push + notificaciones de entrega. Agrega
// funciones sobre `rutas`, `entregas`, `pedidos`, `usuarios` y
// `dispositivos_push` para `entregaHandler` y sus 4 sub-manejadores
// (despacho/entrega confirmada/no entregada/proximidad), `pushInternoHandler`,
// `registrarDispositivo`, `desregistrarDispositivo` y `pushChoferHandler`.
// El insert de `notif_log` de `enviarNotifPedido` se migra reusando
// `registrarLog` (ya existía desde el lote 1) en vez de agregar una función
// nueva — mismo insert genérico, sin motivo para duplicarlo.
//
// Lote 4 (v582, cierre de la Fase 7 paso 7): el bot conversacional de
// WhatsApp NO se sumó acá — se evaluó que conceptualmente no es "notif" y
// terminó en su propio repo, lib/repos/whatsapp-bot.js (ver su cabecera).

import { db } from './_db.js';

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * Verifica si se envió una notificación de cierto tipo recientemente (cooldown).
 * Retorna la fecha del último envío, o null si no hay.
 */
export async function ultimoEnvio(empresa_id, cliente_id, tipo) {
  const { data } = await db
    .from('notif_log')
    .select('created_at')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .eq('tipo', tipo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.created_at || null;
}

/**
 * Lista logs de notificaciones de una empresa.
 */
export async function listarLogs(empresa_id, opts = {}) {
  const { tipo, limite = 100, cliente_id } = opts;

  let q = db
    .from('notif_log')
    .select('id, tipo, canal, cliente_id, created_at, payload')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(limite);

  if (tipo)       q = q.eq('tipo', tipo);
  if (cliente_id) q = q.eq('cliente_id', cliente_id);

  const { data, error } = await q;
  if (error) throw new Error(`[NotifRepo.listarLogs] ${error.message}`);
  return data;
}

/**
 * Lista dispositivos push activos de una empresa.
 */
export async function listarDispositivos(empresa_id) {
  const { data } = await db
    .from('dispositivos_push')
    .select('id, endpoint, usuario_id, activo')
    .eq('empresa_id', empresa_id)
    .eq('activo', true);
  return data || [];
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * Registra un log de notificación enviada.
 * Nunca lanza: los logs de notif no deben cortar el flujo principal.
 */
export async function registrarLog(entrada) {
  try {
    await db.from('notif_log').insert(entrada);
  } catch (err) {
    console.error('[NotifRepo.registrarLog] Error silencioso:', err.message);
  }
}

/**
 * Versión batch: registra múltiples logs en una sola insert.
 */
export async function registrarLogs(entradas) {
  if (!entradas?.length) return;
  try {
    await db.from('notif_log').insert(entradas);
  } catch (err) {
    console.error('[NotifRepo.registrarLogs] Error silencioso:', err.message);
  }
}

/**
 * Registra un email enviado.
 */
export async function registrarEmail(datos) {
  try {
    await db.from('email_log').insert(datos);
  } catch (err) {
    console.error('[NotifRepo.registrarEmail]', err.message);
  }
}

// ── Lote 1 (v582) — alertas operativas por cron ─────────────────────────────

/**
 * Igual que `ultimoEnvio`, pero para los casos que no tienen cliente_id
 * (alertas globales: token de WhatsApp vencido, cheques por vencer). El
 * filtro por empresa_id es opcional porque `alertarTokenWhatsAppVencido`
 * lo aplica solo cuando la alerta es de un número propio de una empresa —
 * si es el número global compartido, el cooldown es entre todas.
 */
export async function ultimoEnvioPorTipo(tipo, { empresa_id } = {}) {
  let q = db.from('notif_log').select('created_at').eq('tipo', tipo);
  if (empresa_id) q = q.eq('empresa_id', empresa_id);
  const { data } = await q
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at || null;
}

/**
 * Igual que `ultimoEnvio`, pero sin empresa_id — usado en `handleDeudaCron`,
 * donde cliente_id ya identifica unívocamente la empresa (un cliente
 * pertenece a una sola empresa), así que el filtro extra sería redundante.
 * Se deja como función separada en vez de agregarle un default a
 * `ultimoEnvio` para no alterar el comportamiento de sus callers actuales.
 */
export async function ultimoEnvioPorCliente(cliente_id, tipo) {
  const { data } = await db
    .from('notif_log')
    .select('created_at')
    .eq('cliente_id', cliente_id)
    .eq('tipo', tipo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at || null;
}

/**
 * Lista usuarios con rol dueno/admin. Si se pasa empresa_id, se filtra a
 * esa empresa; si no, es la consulta global (usada por el aviso de token
 * vencido del número compartido, que avisa a admins de cualquier empresa).
 * `campos` permite pedir distintas columnas según el caller — mismos
 * selects que tenían los dos sitios originales (`id, empresa_id` vs.
 * `id, nombre, email, telefono`).
 */
export async function listarAdminsDueno(empresa_id, { campos = 'id, empresa_id' } = {}) {
  let q = db.from('usuarios').select(campos).in('rol', ['dueno', 'admin']);
  if (empresa_id) q = q.eq('empresa_id', empresa_id);
  const { data } = await q;
  return data || [];
}

/**
 * Lee cheques por id (para armar el resumen de `enviarAvisoChequesPorVencer`).
 * Devuelve `{ data, error }` tal cual — el handler original branchea sobre
 * el error para devolver un motivo legible en vez de tirar excepción.
 */
export async function listarChequesPorIds(ids) {
  const { data, error } = await db
    .from('cheques')
    .select('id, numero, monto, vencimiento, banco, empresa_id, clientes(id, razon_social, telefono)')
    .in('id', ids || []);
  return { data, error };
}

/**
 * Cheques pendientes que vencen entre `desde` y `hasta` (YYYY-MM-DD),
 * para el cron de `handleChequesCron`. Propaga el error (igual que el
 * original, que lo relanza dentro de su propio try/catch).
 */
export async function listarChequesPorVencer(desde, hasta) {
  const { data, error } = await db
    .from('cheques')
    .select('id, numero, monto, vencimiento, banco, empresa_id, clientes(id, razon_social, telefono)')
    .eq('estado', 'pendiente')
    .gte('vencimiento', desde)
    .lte('vencimiento', hasta);
  if (error) throw error;
  return data;
}

/**
 * Clientes activos con su cta_cte embebida, para calcular deuda vencida en
 * `handleDeudaCron`. Propaga el error igual que el original.
 */
export async function listarClientesActivosConCtaCte() {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, telefono, dias_credito, empresa_id, cta_cte(tipo, monto, fecha)')
    .eq('activo', true);
  if (error) throw error;
  return data;
}

/**
 * Marca (o desmarca) que el WhatsApp propio de una empresa necesita
 * reconexión. Nunca lanza — un fallo acá no debe cortar el flujo de alerta
 * que la está llamando.
 */
export async function actualizarNecesitaReconexionWhatsapp(empresa_id, necesita_reconexion) {
  try {
    await db.from('empresa_whatsapp').update({ necesita_reconexion }).eq('empresa_id', empresa_id);
  } catch (e) {
    console.error('[NotifRepo.actualizarNecesitaReconexionWhatsapp] Error silencioso:', e.message);
  }
}

// ── Lote 2 (v582) — estado de cuenta + reintentar email ─────────────────────

/**
 * Perfil del usuario autenticado, para `handleEstadoCuenta`. Filtra también
 * por `activo=true` — Hallazgo de esta migración: el handler original no lo
 * hacía, así que un usuario desactivado con un token todavía válido podía
 * seguir enviando estados de cuenta. Devuelve `{ data, error }` tal cual
 * (el handler responde 403 si falla o no hay perfil).
 */
export async function obtenerPerfilEstadoCuenta(user_id) {
  const { data, error } = await db
    .from('usuarios')
    .select('id, nombre, rol, empresa_id, empresas(id, nombre, email)')
    .eq('id', user_id)
    .eq('activo', true)
    .single();
  return { data, error };
}

/**
 * Cliente para el envío manual desde el panel — valida que pertenezca a la
 * empresa del usuario autenticado.
 */
export async function obtenerClienteEstadoCuenta(cliente_id, empresa_id) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, nombre_fantasia, email, cuit, saldo_deuda, limite_credito, localidad')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Igual que `obtenerClienteEstadoCuenta`, pero sin filtrar por empresa_id —
 * usada en `_reintentarEstadoCuenta`, donde el cliente_id ya viene de un
 * notif_log validado contra la empresa del usuario, así que el filtro extra
 * sería redundante.
 */
export async function obtenerClienteEstadoCuentaPorId(cliente_id) {
  const { data } = await db
    .from('clientes')
    .select('razon_social, nombre_fantasia, email, cuit, saldo_deuda, limite_credito, localidad')
    .eq('id', cliente_id)
    .single();
  return data;
}

/**
 * Facturas emitidas/parciales de un cliente, para calcular deuda total,
 * vencida y por vencer. Silencioso: si la query falla devuelve `undefined`
 * (mismo comportamiento que el original, que solo desestructuraba `data`
 * sin chequear `error`).
 */
export async function listarFacturasPendientes(empresa_id, cliente_id) {
  const { data } = await db
    .from('facturas')
    .select('id, numero, total, total_cobrado, vencimiento, fecha_emision, estado')
    .eq('empresa_id', empresa_id)
    .eq('cliente_id', cliente_id)
    .in('estado', ['emitida', 'parcial'])
    .order('vencimiento', { ascending: true })
    .limit(20);
  return data;
}

/**
 * Inserta un log de notificación y avisa por consola (sin lanzar) si falla.
 * `contexto` es el prefijo del log (p. ej. `'ESTADO-CUENTA'`,
 * `'REINTENTAR-EMAIL'`) — reemplaza el mismo `.then(({ error }) => ...)`
 * que `handleEstadoCuenta` y `handleReintentarEmail` repetían cada uno con
 * su propio prefijo.
 */
export async function registrarLogConAviso(entrada, contexto) {
  const { error } = await db.from('notif_log').insert(entrada);
  if (error) console.error(`[${contexto}] No se pudo loguear envío en notif_log:`, error.message);
}

/**
 * Registro de notif_log a reintentar, validado contra la empresa del
 * usuario autenticado. Devuelve `{ data, error }` tal cual — el handler
 * responde 404 si falla o no existe.
 */
export async function obtenerNotifLogPorId(id, empresa_id) {
  const { data, error } = await db
    .from('notif_log')
    .select('*')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Datos mínimos de la empresa para armar el remitente de un email —
 * reusada por los 4 helpers `_reintentar*`.
 */
export async function obtenerEmpresaParaEmail(empresa_id) {
  const { data } = await db
    .from('empresas')
    .select('id, nombre, email')
    .eq('id', empresa_id)
    .single();
  return data;
}

/**
 * Cliente para un reintento. `campos` varía según el email que se está
 * reconstruyendo (confirmación de pedido vs. despacho piden distinto shape).
 */
export async function obtenerClienteParaReintento(cliente_id, campos) {
  const { data } = await db
    .from('clientes')
    .select(campos)
    .eq('id', cliente_id)
    .single();
  return data;
}

/**
 * Pedido con sus items y productos embebidos, para reconstruir el email de
 * confirmación de pedido en un reintento.
 */
export async function obtenerPedidoConItemsParaReintento(pedido_id) {
  const { data } = await db
    .from('pedidos')
    .select('id, total, subtotal, iva_total, fecha_entrega, notas_cliente, pedido_items(cantidad, precio_unitario, descuento_pct, productos(nombre))')
    .eq('id', pedido_id)
    .single();
  return data;
}

/**
 * Igual que `obtenerPedidoConItemsParaReintento`, pero con el shape más
 * chico que necesita el email de despacho.
 */
export async function obtenerPedidoDespachoParaReintento(pedido_id) {
  const { data } = await db
    .from('pedidos')
    .select('id, total, fecha_entrega')
    .eq('id', pedido_id)
    .single();
  return data;
}

/**
 * Recepción de mercadería para reconstruir el email al proveedor en un
 * reintento.
 */
export async function obtenerRecepcionParaReintento(recepcion_id, empresa_id) {
  const { data } = await db
    .from('recepciones_mercaderia')
    .select('id, orden_id, estado, foto_url, created_at, confirmada_at, items_conciliados, discrepancias')
    .eq('id', recepcion_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Orden de compra con el proveedor embebido, para su email de contacto.
 */
export async function obtenerOrdenCompraConProveedor(orden_id, empresa_id) {
  const { data } = await db
    .from('ordenes_compra')
    .select('id, numero, proveedor_id, proveedores(id, razon_social, contacto, email)')
    .eq('id', orden_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

// ── Lote 3 (v582) — notificaciones de entrega + dispositivos push ──────────

/**
 * Ruta validada contra la empresa del caller (tenant-scoping). Reusada por
 * `manejarDespacho` y `pushChoferHandler` — mismo select en los dos sitios
 * originales (`id, empresa_id`).
 */
export async function obtenerRutaDeEmpresa(ruta_id, empresa_id) {
  const { data } = await db
    .from('rutas')
    .select('id, empresa_id')
    .eq('id', ruta_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Entregas de una ruta con el pedido y cliente embebidos, para armar los
 * avisos de despacho. Devuelve `{ data, error }` tal cual — el handler
 * relanza el error dentro de su propio try/catch.
 */
export async function listarEntregasDeRuta(ruta_id) {
  const { data, error } = await db
    .from('entregas')
    .select('pedido_id, pedidos(id, empresa_id, total, estado, clientes(id, razon_social, telefono))')
    .eq('ruta_id', ruta_id);
  return { data, error };
}

/**
 * Marca una ruta como en camino. Best-effort, igual que el original: no
 * chequea `error` ni lanza — un fallo acá no debe cortar el envío de los
 * avisos de despacho, que es lo que realmente importa del evento.
 */
export async function marcarRutaEnCamino(ruta_id) {
  await db.from('rutas').update({ estado: 'en_camino' }).eq('id', ruta_id);
}

/**
 * Pedido con cliente embebido para notificar un evento de entrega
 * (confirmada / no realizada / proximidad). Los 3 sub-manejadores de
 * `entregaHandler` usaban el mismo select exacto — se consolida acá.
 * Devuelve `{ data, error }`, validado contra la empresa del caller.
 */
export async function obtenerPedidoParaNotifEntrega(pedido_id, empresa_id) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, empresa_id, total, estado, clientes(id, razon_social, telefono)')
    .eq('id', pedido_id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Marca un pedido como entregado. Best-effort, igual que el original: no
 * chequea `error` ni lanza (el WhatsApp de confirmación ya se mandó, un
 * fallo acá no debe convertir el evento en un error 500).
 */
export async function marcarPedidoEntregado(pedido_id) {
  await db.from('pedidos').update({ estado: 'entregado' }).eq('id', pedido_id);
}

/**
 * Usuarios de una empresa con alguno de los roles dados — para
 * `pushInternoHandler`, que arma la lista de destinatarios de un push según
 * `ROLES_POR_TIPO`. Devuelve `{ data, error }` tal cual, el handler relanza
 * el error dentro de su propio try/catch.
 */
export async function listarUsuariosPorRoles(empresa_id, roles) {
  const { data, error } = await db
    .from('usuarios')
    .select('id')
    .eq('empresa_id', empresa_id)
    .in('rol', roles);
  return { data, error };
}

/**
 * Usuario validado contra la empresa del caller — usado por
 * `pushChoferHandler` para chequear que el chofer pertenezca a la empresa
 * de quien está pidiendo notificarlo.
 */
export async function obtenerUsuarioDeEmpresa(usuario_id, empresa_id) {
  const { data } = await db
    .from('usuarios')
    .select('id, empresa_id')
    .eq('id', usuario_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Alta/actualización de un dispositivo push (upsert por `token_push`).
 * Devuelve solo `{ error }` — el handler responde 500 con `errorSeguro` si
 * falla, o 200 `{ ok: true }` si no.
 */
export async function upsertDispositivoPush(datos) {
  const { error } = await db
    .from('dispositivos_push')
    .upsert(datos, { onConflict: 'token_push' });
  return { error };
}

/**
 * Baja lógica de un dispositivo push, filtrando por token Y usuario (FIX
 * auditoría Fase 2, hallazgo #4: antes solo filtraba por token, así que
 * conocer/adivinar un token ajeno alcanzaba para desregistrarlo).
 */
export async function desactivarDispositivoPush(token_push, usuario_id) {
  const { error } = await db
    .from('dispositivos_push')
    .update({ activo: false })
    .eq('token_push', token_push)
    .eq('usuario_id', usuario_id);
  return { error };
}

// ── Lote 5 (v595) — migración de notifAuto (_auto-push.js) ─────────────────

/**
 * Preferencia de notificaciones automáticas de una empresa para un `tipo`
 * puntual (ej. `stock_quiebre`). `notifAuto` solo necesita esa columna, no
 * la fila entera — se selecciona dinámicamente por nombre de columna, igual
 * que hacía el `.select(tipo)` original.
 */
export async function obtenerPrefsAuto(empresa_id, tipo) {
  const { data } = await db
    .from('notif_prefs_auto')
    .select(tipo)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/**
 * Tokens push activos de un conjunto de usuarios (admins/dueños de una
 * empresa), para el envío en batch de `notifAuto`. Mismo `.limit(30)` que
 * el original — tope defensivo de dispositivos por envío, no de usuarios.
 */
export async function listarTokensPushDeUsuarios(usuario_ids) {
  const { data } = await db
    .from('dispositivos_push')
    .select('endpoint, p256dh, auth')
    .in('usuario_id', usuario_ids)
    .eq('activo', true)
    .limit(30);
  return data || [];
}

/**
 * Baja lógica de un dispositivo push por `endpoint` (no por token+usuario:
 * acá no se conoce el usuario, solo el endpoint que rebotó al mandar el
 * webpush). Usada por `notifAuto` cuando un token expira (410/404).
 */
export async function desactivarDispositivoPushPorEndpoint(endpoint) {
  await db.from('dispositivos_push').update({ activo: false }).eq('endpoint', endpoint);
}

// ── Lote 6 (v596) — migración de enviarPush y notificadores (_push.js) ─────

/**
 * Tokens push activos (FCM) de un único usuario. Devuelve `{ data, error }`
 * tal cual — `enviarPush` distingue en el motivo del log si no había
 * dispositivos porque la query falló o porque simplemente no había ninguno.
 */
export async function obtenerTokensPushDeUsuario(usuario_id) {
  const { data, error } = await db
    .from('dispositivos_push')
    .select('token_push')
    .eq('usuario_id', usuario_id)
    .eq('activo', true);
  return { data, error };
}

/**
 * `empresa_id` de un usuario puntual. Usada por `enviarPush` para resolver
 * el `empresa_id` del log cuando `logMeta` no lo trae ya (2 sitios en el
 * original con el mismo `.select('empresa_id').eq('id', ...).single()`).
 */
export async function obtenerEmpresaIdDeUsuario(usuario_id) {
  const { data } = await db
    .from('usuarios')
    .select('empresa_id')
    .eq('id', usuario_id)
    .single();
  return data?.empresa_id || null;
}

/**
 * Usuarios de portal de clientes, activos, de una empresa — para
 * `notificarOfertaRelampago`. Devuelve `{ data, error }` tal cual, el
 * handler no manda nada si la query falla.
 */
export async function listarClientesActivosDeEmpresa(empresa_id) {
  const { data, error } = await db
    .from('usuarios')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('rol', 'cliente')
    .eq('activo', true);
  return { data, error };
}

/**
 * Usuario (con su empresa_id) a partir de un `cliente_id` — usada por los 4
 * notificadores dirigidos a un cliente puntual (deuda vencida, pedido
 * entregado, puntos ganados, pedido en camino), todos con el mismo select
 * exacto en el original.
 */
export async function obtenerUsuarioPorClienteId(cliente_id) {
  const { data } = await db
    .from('usuarios')
    .select('id, empresa_id')
    .eq('cliente_id', cliente_id)
    .single();
  return data;
}
