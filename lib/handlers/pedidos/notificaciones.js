// lib/handlers/pedidos/notificaciones.js
// Notificaciones de pedido: WhatsApp/email de cambio de estado y de
// confirmación, acreditación de puntos de fidelización, y push. Extraído de
// lib/handlers/pedidos.js (25/08/2026).

import {
  enviarEmailConfirmacionPedido,
  enviarEmailDespacho,
} from '../../email.js';
import {
  insertarMovimientoPuntosFallback,
  insertarNotifLog,
  obtenerClienteEmailRazonSocial,
  obtenerClienteParaEmailDespacho,
  obtenerClienteScoreCategoria,
  obtenerClienteTelefonoRazonSocial,
  obtenerEmpresaContacto,
  obtenerItemsDePedido,
  obtenerPedidoCompletoParaEmailConfirmacion,
  obtenerPedidoNumeroYTotal,
  obtenerPedidoTotal,
  obtenerProgramaFidelizacionActivo,
  registrarMovimientoPuntosRpc,
  sumarSaldoPuntosFallbackRpc,
} from '../../repos/pedidos.js';
import {
  obtenerPreciosReferenciaCompetencia,
  registrarAhorroCompetenciaRpc,
} from '../../repos/captura-competencia.js';
import {
  enviarPush,
  notificarPuntosGanados,
} from '../_push.js';

export async function notificarEstado(pedido, empresaId) {
  const cliente = await obtenerClienteTelefonoRazonSocial(pedido.cliente_id);

  const numeroLabel = pedido.id.substring(0, 8).toUpperCase();
  const payloadBase = { numero_pedido: numeroLabel, total: pedido.total };

  if (!cliente?.telefono) {
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente?.id || pedido.cliente_id, pedidoId: pedido.id,
      canal: 'whatsapp', payload: payloadBase,
      entregada: false, motivo: 'sin_telefono',
    });
    return;
  }

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.APP_URL || 'http://localhost:3000';

  try {
    // FIX AUTOMATIZACION-003 (v960 rompió esta llamada server-to-server —
    // ver comentario completo en lib/handlers/notif.js): sin Authorization
    // el endpoint devolvía 401 en silencio y el aviso de despacho nunca
    // salía. Se manda CRON_SECRET + empresa_id explícito, único camino que
    // notif.js acepta sin sesión de usuario.
    const resp = await fetch(`${base}/api/notif/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
      },
      body: JSON.stringify({
        template: 'pedido_despachado',
        telefono: cliente.telefono,
        params: payloadBase,
        empresa_id: empresaId,
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.error(`[NOTIF] Error WA pedido_despachado ${pedido.id}:`, data.error);
      await _logNotif({
        tipo: 'pedido_despachado',
        empresaId, clienteId: cliente.id, pedidoId: pedido.id,
        canal: 'whatsapp', telefono: cliente.telefono,
        payload: { ...payloadBase, error: data.error || null },
        entregada: false, motivo: 'error_envio',
      });
      return;
    }

    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente.id, pedidoId: pedido.id,
      canal: 'whatsapp', telefono: cliente.telefono,
      messageId: data.message_id || null,
      payload: payloadBase,
      entregada: true,
    });
    console.log(`[NOTIF] WA pedido_despachado enviado a ${cliente.telefono} | pedido ${pedido.id}`);
  } catch (err) {
    console.error(`[NOTIF] Excepción WA pedido_despachado ${pedido.id}:`, err.message);
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente.id, pedidoId: pedido.id,
      canal: 'whatsapp', telefono: cliente.telefono,
      payload: { ...payloadBase, error: err.message },
      entregada: false, motivo: 'excepcion',
    });
  }
}

// FIX (Hallazgo 2, auditoría notificaciones — "reenvío manual de emails"):
// antes esta función llamaba a enviarEmailDespacho() y descartaba el
// resultado por completo (ni el `await` capturaba nada) — no había ningún
// rastro en notif_log ni de éxito ni de falla, a diferencia de
// notificarPedidoConfirmado()/_logNotif de más arriba. Un aviso de
// despacho que fallaba (ej: proveedor de email caído) desaparecía sin
// dejar huella, y no había nada que un futuro botón de "reintentar"
// pudiera reintentar.
export async function notificarDespachoPorEmail(pedido, empresaId) {
  const cliente = await obtenerClienteParaEmailDespacho(pedido.cliente_id);

  const payloadBase = {
    numero_pedido: pedido.id?.substring(0, 8).toUpperCase(),
    total: pedido.total,
  };

  if (!cliente?.email) {
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente?.id || pedido.cliente_id, pedidoId: pedido.id,
      canal: 'email', payload: payloadBase,
      entregada: false, motivo: 'sin_email',
    });
    return;
  }

  const empresa = await obtenerEmpresaContacto(empresaId);

  try {
    const resultado = await enviarEmailDespacho(pedido, cliente, empresa);
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente.id, pedidoId: pedido.id,
      canal: 'email', email: cliente.email,
      messageId: resultado?.id || null,
      payload: payloadBase,
      entregada: !!resultado?.ok,
      motivo: resultado?.ok ? null : (resultado?.razon || 'error_desconocido'),
    });
    if (!resultado?.ok) {
      console.error(`[EMAIL] Aviso de despacho no entregado para pedido ${pedido.id} — motivo: ${resultado?.razon}`);
    }
  } catch (err) {
    console.error(`[EMAIL] Error enviando aviso de despacho del pedido ${pedido.id}:`, err.message);
    await _logNotif({
      tipo: 'pedido_despachado',
      empresaId, clienteId: cliente.id, pedidoId: pedido.id,
      canal: 'email', email: cliente.email,
      payload: { ...payloadBase, error: err.message },
      entregada: false, motivo: 'error_inesperado',
    });
  }
}

async function _logNotif({ empresaId, clienteId, pedidoId, tipo, canal, telefono, email, messageId, payload, entregada, motivo }) {
  try {
    await insertarNotifLog({
      empresa_id: empresaId,
      cliente_id: clienteId,
      pedido_id:  pedidoId,
      tipo,
      canal,
      telefono:   telefono || null,
      email:      email || null,
      message_id: messageId || null,
      payload:    payload || null,
      entregada,
      motivo:     motivo || null,
    });
  } catch (err) {
    console.error(`[NOTIF] Error guardando notif_log (tipo ${tipo}, canal ${canal}, pedido ${pedidoId}):`, err.message);
  }
}

export async function notificarPedidoConfirmado(pedidoId, cliente, empresaId) {
  // FIX: pedidos.numero no existe — número se genera desde id.slice(0,8).toUpperCase()
  const pedido = await obtenerPedidoNumeroYTotal(pedidoId);

  if (!pedido) return;

  const numeroLabel = pedido.id.slice(-8).toUpperCase();

  // ── WhatsApp de confirmación ────────────────────────────────────────────
  // FIX: antes, si el cliente no tenía teléfono, la función retornaba temprano
  // y el email de confirmación de más abajo nunca se disparaba. Ahora cada
  // canal es independiente: la falta de teléfono solo omite el WhatsApp.
  if (!cliente.telefono) {
    console.log(`[NOTIF] Cliente ${cliente.id} sin teléfono — omitiendo WhatsApp`);
    await _logNotif({
      tipo: 'confirmacion_pedido',
      empresaId, clienteId: cliente.id, pedidoId,
      canal: 'whatsapp', entregada: false, motivo: 'sin_telefono',
    });
  } else {
    try {
      const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.APP_URL || 'http://localhost:3000';

      // FIX AUTOMATIZACION-003 — ver comentario en lib/handlers/notif.js.
      const resp = await fetch(`${base}/api/notif/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
        },
        body: JSON.stringify({
          template: 'confirmacion_pedido',
          telefono: cliente.telefono,
          params: {
            nombre_cliente: cliente.razon_social.split(/[\s,]+/)[0],
            numero_pedido:  numeroLabel,
            total:          pedido.total,
          },
          empresa_id: empresaId,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        console.error(`[NOTIF] Error WA pedido ${pedidoId}:`, data.error);
        await _logNotif({
          tipo: 'confirmacion_pedido',
          empresaId, clienteId: cliente.id, pedidoId,
          canal: 'whatsapp', telefono: cliente.telefono,
          payload: { numero_pedido: numeroLabel, total: pedido.total, error: data.error || null },
          entregada: false, motivo: 'error_envio',
        });
      } else {
        await _logNotif({
          tipo: 'confirmacion_pedido',
          empresaId, clienteId: cliente.id, pedidoId,
          canal: 'whatsapp', telefono: cliente.telefono,
          messageId: data.message_id || null,
          payload: { numero_pedido: numeroLabel, total: pedido.total },
          entregada: true,
        });
        console.log(`[NOTIF] WA confirmacion_pedido enviado a ${cliente.telefono} | pedido ${pedidoId}`);
      }
    } catch (err) {
      console.error(`[NOTIF] Error de red para pedido ${pedidoId}:`, err.message);
      await _logNotif({
        tipo: 'confirmacion_pedido',
        empresaId, clienteId: cliente.id, pedidoId,
        canal: 'whatsapp', telefono: cliente.telefono,
        payload: { numero_pedido: numeroLabel, total: pedido.total, error: err.message },
        entregada: false, motivo: 'error_red',
      });
    }
  }

  // ── Email de confirmación ──────────────────────────────────────────────
  try {
    // FIX: pedidos.numero no existe — se omite de SELECT
    const pedidoCompleto = await obtenerPedidoCompletoParaEmailConfirmacion(pedidoId);

    const clienteEmail = await obtenerClienteEmailRazonSocial(cliente.id);

    const empresa = await obtenerEmpresaContacto(empresaId);

    if (pedidoCompleto && clienteEmail) {
      const items = (pedidoCompleto.pedido_items || []).map(i => ({
        nombre:          i.productos?.nombre || '—',
        cantidad:        i.cantidad,
        precio_unitario: i.precio_unitario,
        descuento_pct:   i.descuento_pct || 0,
      }));
      const resultado = await enviarEmailConfirmacionPedido(pedidoCompleto, clienteEmail, empresa, items);

      await _logNotif({
        tipo: 'confirmacion_pedido',
        empresaId, clienteId: cliente.id, pedidoId,
        canal: 'email', email: clienteEmail.email,
        messageId: resultado?.id || null,
        payload: { numero_pedido: numeroLabel, total: pedido.total },
        entregada: !!resultado?.ok,
        motivo: resultado?.ok ? null : (resultado?.razon || 'error_desconocido'),
      });

      if (!resultado?.ok) {
        console.error(`[EMAIL] Confirmación no entregada para pedido ${pedidoId} — motivo: ${resultado?.razon}`);
      }
    } else {
      // Sin fila de cliente/email consultable — no hay a quién mandarle,
      // pero igual dejamos rastro (distinto de 'sin_email' del helper interno).
      await _logNotif({
        tipo: 'confirmacion_pedido',
        empresaId, clienteId: cliente.id, pedidoId,
        canal: 'email', entregada: false, motivo: 'cliente_no_encontrado',
      });
    }
  } catch (err) {
    console.error(`[EMAIL] Error enviando confirmación del pedido ${pedidoId}:`, err.message);
    await _logNotif({
      tipo: 'confirmacion_pedido',
      empresaId, clienteId: cliente.id, pedidoId,
      canal: 'email', payload: { error: err.message },
      entregada: false, motivo: 'error_inesperado',
    });
  }
}

export async function acreditarPuntos(pedidoId, cliente, empresaId) {
  const programa = await obtenerProgramaFidelizacionActivo(empresaId);

  if (!programa) return;

  const pedido = await obtenerPedidoTotal(pedidoId);

  if (!pedido) return;

  // Bonus por comportamiento de pago (Innovación #8): el cliente gana puntos
  // extra según su categoría de score, no solo por el monto del pedido.
  const clienteScore = await obtenerClienteScoreCategoria(cliente.id);

  const categoria = clienteScore?.score_categoria || null;
  const bonusPct  = (categoria && programa.bonus_pct_categoria?.[categoria]) || 0;

  const puntosBase    = pedido.total * programa.puntos_por_peso;
  const puntosGanados = Math.floor(puntosBase * (1 + bonusPct / 100));
  if (puntosGanados <= 0) return;

  const motivo = bonusPct > 0
    ? `Pedido #${pedidoId.substring(0, 8).toUpperCase()} (+${bonusPct}% bonus por categoría "${categoria}")`
    : `Pedido #${pedidoId.substring(0, 8).toUpperCase()}`;

  // FIX: antes había un insert manual a movimientos_puntos acá ARRIBA del
  // registrar_movimiento_puntos() de abajo, que también inserta el mismo
  // movimiento -> cada pedido quedaba duplicado en el historial (el saldo
  // estaba bien porque solo el RPC toca saldo_puntos). Se deja un solo
  // camino: el RPC primero, y el insert manual + upsert de saldo solo como
  // fallback si el RPC falla.
  const { error: rpcError } = await registrarMovimientoPuntosRpc({
    p_cliente_id:    cliente.id,
    p_empresa_id:    empresaId,
    p_tipo:          'ganancia',
    p_cantidad:      puntosGanados,
    p_motivo:        motivo,
    p_referencia_id: pedidoId,
  });

  if (rpcError) {
    console.error(`[PUNTOS] RPC registrar_movimiento_puntos falló, usando fallback manual:`, rpcError.message);
    await insertarMovimientoPuntosFallback({
      cliente_id:    cliente.id,
      empresa_id:    empresaId,
      tipo:          'ganancia',
      cantidad:      puntosGanados,
      motivo,
      referencia_id: pedidoId,
    });
    // FIX (auditoría 2026, etapa 13, Hallazgo 3): el upsert de acá abajo
    // PISABA puntos_disponibles/puntos_totales con puntosGanados en vez de
    // sumarlos -- si el cliente ya tenía saldo acumulado y el RPC fallaba,
    // el fallback le resetaba el saldo al valor del último pedido. Ahora
    // usa sumar_saldo_puntos_fallback() (RPC atómica, ON CONFLICT DO
    // UPDATE ... = saldo_puntos.puntos_disponibles + p_cantidad).
    const { error: fallbackError } = await sumarSaldoPuntosFallbackRpc({
      p_cliente_id: cliente.id,
      p_empresa_id: empresaId,
      p_cantidad:   puntosGanados,
    });
    if (fallbackError) {
      console.error(`[PUNTOS] Fallback de saldo también falló:`, fallbackError.message);
    }
  }

  console.log(`[PUNTOS] ${puntosGanados} puntos acreditados al cliente ${cliente.id}${bonusPct > 0 ? ` (incluye bonus ${bonusPct}% por categoría "${categoria}")` : ''}`);

  // Cableado (auditoría notificaciones): la función existía en _push.js
  // desde antes pero nunca tenía caller — la acreditación ocurría en
  // silencio para el cliente. Best-effort, no bloquea el pedido si falla.
  notificarPuntosGanados(cliente.id, puntosGanados, motivo).catch(err =>
    console.error(`[PUNTOS] Error enviando push de puntos ganados:`, err.message));
}

/**
 * Fase 2 de PLAN_CAPTURA_COMPETENCIA.md (Capa 3 — retención): por cada
 * pedido de un cliente que tiene al menos un producto con precio de
 * referencia de competencia (o sea, llegó vía captura_competencia
 * convertida — migración 551/554), calcula cuánto ahorró ESTE pedido
 * contra ese precio congelado y lo acredita al acumulado del cliente.
 *
 * Mismo lugar de llamada que acreditarPuntos (crear-pedido.js,
 * confirmar-pedido.js y el listener pedido_creado) — mismo criterio de
 * "efecto secundario best-effort, no bloquea el pedido si falla".
 *
 * A diferencia de acreditarPuntos, acá NO hay un fallback manual de dos
 * pasos: fn_registrar_ahorro_competencia (migración 555) ya es una sola
 * transacción atómica e idempotente por pedido_id — el bug de doble
 * inserción que tuvo puntos no tiene forma de repetirse acá.
 */
export async function acreditarAhorroCompetencia(pedidoId, cliente, empresaId) {
  const { data: referencias, error: errorRef } = await obtenerPreciosReferenciaCompetencia(cliente.id, empresaId);
  if (errorRef) {
    console.error(`[AHORRO] Error obteniendo precios de referencia de competencia:`, errorRef.message);
    return;
  }
  if (!referencias || referencias.size === 0) return; // cliente sin captura de competencia convertida — nada que acreditar

  const itemsPedido = await obtenerItemsDePedido(empresaId, pedidoId);
  if (!itemsPedido || itemsPedido.size === 0) return;

  let ahorroPedido = 0;
  const detalle = [];
  for (const [productoId, item] of itemsPedido) {
    const precioReferencia = referencias.get(productoId);
    if (precioReferencia == null) continue; // este producto del pedido no tiene referencia de competencia para este cliente

    const ahorroItem = (precioReferencia - item.precio_unitario) * item.cantidad;
    // Solo suma si hoy el cliente paga menos que la referencia congelada.
    // Si el precio propio subió por encima de esa referencia (pudo pasar
    // por inflación desde la captura), no se resta del acumulado — el
    // acumulado es "cuánto ahorró en total", nunca retrocede.
    if (ahorroItem <= 0) continue;

    ahorroPedido += ahorroItem;
    detalle.push({
      producto_id: productoId,
      cantidad: item.cantidad,
      precio_competencia_referencia: precioReferencia,
      precio_propio: item.precio_unitario,
      ahorro: Math.round(ahorroItem * 100) / 100,
    });
  }

  if (ahorroPedido <= 0) return;
  ahorroPedido = Math.round(ahorroPedido * 100) / 100;

  const { error } = await registrarAhorroCompetenciaRpc({
    p_pedido_id:     pedidoId,
    p_cliente_id:    cliente.id,
    p_empresa_id:    empresaId,
    p_ahorro_pedido: ahorroPedido,
    p_detalle:       detalle,
  });

  if (error) {
    console.error(`[AHORRO] Error acreditando ahorro de competencia del pedido ${pedidoId}:`, error.message);
    return;
  }

  console.log(`[AHORRO] $${ahorroPedido} de ahorro acreditados al cliente ${cliente.id} (pedido ${pedidoId})`);
}

export async function notificarPushPedidoConfirmado(pedidoId, cliente, empresaId) {
  // FIX (Hallazgo 2, auditoría notificaciones): esta función le pegaba a
  // POST /api/notif/push, que es el endpoint de alta/baja de dispositivo
  // (espera { usuario_id, token_push }), no un endpoint de envío. El body
  // real que se mandaba ({ tokens, titulo, cuerpo, ... }) no matchea esa
  // forma, así que la llamada devolvía 400 siempre — y como no había check
  // de resp.ok ni catch, la falla era 100% silenciosa. El push de "pedido
  // confirmado" al cliente nunca se entregó desde que existe esta función.
  // Ahora se llama directo a enviarPush() (mismo helper que ya usa
  // push-interno), evitando el round-trip HTTP roto y logueando en
  // notif_log automáticamente (éxito y falla).
  const { enviadas, razon } = await enviarPush(
    cliente.id,
    'Pedido confirmado',
    `Tu pedido #${pedidoId.substring(0, 8).toUpperCase()} fue recibido.`,
    { link: '/cliente/pedidos.html', pedido_id: pedidoId },
    { empresa_id: empresaId, cliente_id: cliente.id, pedido_id: pedidoId, tipo: 'confirmacion_pedido' }
  );

  if (enviadas > 0) {
    console.log(`[PUSH] Notificación enviada a ${enviadas} dispositivo(s) del cliente ${cliente.id}`);
  } else {
    console.log(`[PUSH] Sin entrega para cliente ${cliente.id} en pedido ${pedidoId} — motivo: ${razon || 'sin_dispositivos'}`);
  }
}

// ── Push a administradores cuando llega un pedido nuevo ───────────────────────
//
// Obtiene todos los usuarios de la empresa con rol dueno/admin/vendedor que
// tengan al menos un dispositivo push activo y los notifica vía el endpoint
// push-interno. Se usa el header interno "x-trigger: supabase" ya existente
// — el llamado es server-to-server, nunca expuesto al cliente.
//
export async function notificarPushAdmin(pedidoId, cliente, empresaId) {
  // 1. Obtener datos del pedido para armar el cuerpo de la notificación
  // FIX Bug-28: pedidos no tiene columna 'numero'; se genera desde id post-fetch
  const pedido = await obtenerPedidoNumeroYTotal(pedidoId);

  if (!pedido) return;

  // numero_pedido generado desde id (pedidos.numero no existe como columna)
  const numero = pedido.id.slice(-8).toUpperCase();
  const total  = Math.round(pedido.total || 0).toLocaleString('es-AR');
  const nombre = (cliente.razon_social || '').split(/[\s,]+/)[0] || 'Cliente';

  // 2. Llamar al endpoint push-interno (server-to-server)
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : (process.env.API_URL || 'http://localhost:3000');

  const resp = await fetch(`${base}/api/notif/push-interno`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-trigger':    'supabase',          // cabecera interna requerida por el handler
    },
    body: JSON.stringify({
      empresa_id: empresaId,
      tipo:       'nuevo_pedido',
      titulo:     `Nuevo pedido de ${nombre}`,
      cuerpo:     `Pedido #${numero} · $${total}`,
      datos: {
        pedido_id: pedidoId,
        link:      '/admin/pedidos.html',
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.warn(`[PUSH-ADMIN] push-interno devolvió ${resp.status}: ${body}`);
    return;
  }

  const result = await resp.json();
  console.log(`[PUSH-ADMIN] Notificación enviada a ${result.enviadas ?? 0} dispositivo(s) de admins — pedido ${pedidoId}`);
}
