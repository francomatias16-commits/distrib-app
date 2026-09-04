// lib/handlers/pedidos/confirmar-pedido.js
// Confirmar pedido desde el portal cliente (antes:
// api/pedidos/confirmar-pedido.js). Extraído de lib/handlers/pedidos.js
// (25/08/2026).

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import * as AuditRepo from '../../repos/audit.js';
import {
  calcularIvaPonderadoCombo,
  calcularTotalesPedido,
} from '../../calc/pedido-totales.js';
import { errorSeguro } from '../../error-response.js';
import { emitirFactura } from '../../facturas.js';
import { puede } from '../../permisos-service.js';
import {
  LimitePlanError,
  exigirLimitePlan,
} from '../../plan-limits.js';
import { obtenerCombosParaValidarPedido } from '../../repos/combos.js';
import { resolverDepositoParaPedido, obtenerStockPorDeposito } from '../../repos/depositos.js';
import {
  crearPedidoClienteRpc,
  obtenerClientePorEmailParaConfirmar,
  obtenerClientePorIdParaConfirmar,
  obtenerNumeroPedido,
  obtenerUsuarioParaConfirmarPedido,
  resolverPreciosClienteRpc,
  vaciarCarritoCliente,
} from '../../repos/pedidos.js';
import {
  obtenerNombreProducto,
  obtenerProductosParaCotizarConCosto,
} from '../../repos/productos.js';
import {
  notificarPedidoConfirmado,
  acreditarPuntos,
  acreditarAhorroCompetencia,
  notificarPushPedidoConfirmado,
  notificarPushAdmin,
} from './notificaciones.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export async function confirmarPedidoHandler(req, res) {
  // ── 1. Autenticar usuario ────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  // ── 2. Obtener datos del usuario y cliente ───────────
  const { data: usuarioData, error: usrError } = await obtenerUsuarioParaConfirmarPedido(user.id);

  if (usrError || !usuarioData) {
    return res.status(403).json({ error: 'Usuario no encontrado' });
  }

  if (usuarioData.rol !== 'cliente') {
    return res.status(403).json({ error: 'Solo los clientes pueden hacer pedidos' });
  }

  // ── 3. Validar body (movido antes del lookup de cliente: es validación
  // sincrónica de formato, no depende de I/O, y así el ID de combos/
  // productos queda listo para pedirlo en paralelo con el cliente abajo) ──
  const { items, notas_cliente, fecha_entrega, idempotency_key, forma_pago } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'El carrito está vacío' });
  }

  // Forma de pago: 'cuenta_corriente' (default, como siempre) o
  // 'pago_inmediato' (transferencia/efectivo a coordinar con el vendedor —
  // no genera deuda en la cta_cte del cliente, ver punto 5 más abajo y
  // emitirFactura() en lib/facturas.js). Cualquier valor no reconocido cae
  // al default seguro en vez de rechazar la confirmación.
  const formaPago = forma_pago === 'pago_inmediato' ? 'pago_inmediato' : 'cuenta_corriente';

  // Hallazgo 3 (Etapa 1, Pedidos): idempotency_key es opcional (compat con
  // clientes viejos que todavía no la mandan — nunca hace 400 por su
  // ausencia), pero si viene tiene que ser un UUID válido; cualquier otra
  // cosa se ignora en vez de romper la confirmación por un detalle de
  // formato.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idemKey = (typeof idempotency_key === 'string' && UUID_RE.test(idempotency_key))
    ? idempotency_key
    : null;

  // v(combos): cada renglón es DE UN PRODUCTO o DE UN COMBO (ítem único,
  // precio propio) — nunca ambos ni ninguno. Mismo criterio que la
  // constraint pedido_items_producto_o_combo (migración 530).
  for (const item of items) {
    const esCombo = !!item.combo_id;
    if (esCombo === !!item.producto_id) {
      return res.status(400).json({ error: 'Item inválido en el carrito' });
    }
    if (!item.cantidad || item.cantidad <= 0) {
      return res.status(400).json({ error: 'Item inválido en el carrito' });
    }
  }

  const productoIdsDirectos = items.filter(i => i.producto_id).map(i => i.producto_id);
  const comboIds            = [...new Set(items.filter(i => i.combo_id).map(i => i.combo_id))];

  // Perf (loadtest etapa4, p99 checkout > umbral): cliente, combos y
  // productos son tres lecturas independientes entre sí — las tres solo
  // necesitan usuarioData.empresa_id + ids ya conocidos del body, ninguna
  // depende del resultado de otra. Antes corrían en secuencia (una atrás
  // de otra); bajo carga eso encolaba round-trips innecesarios contra
  // Supabase. Se piden en paralelo con Promise.all — mismos datos, mismos
  // errores posibles, solo cambia CUÁNDO se disparan.
  const [
    { data: clienteRow, error: cliError },
    combosData,
    prodsData,
  ] = await Promise.all([
    usuarioData.cliente_id
      ? obtenerClientePorIdParaConfirmar(usuarioData.empresa_id, usuarioData.cliente_id)
      : obtenerClientePorEmailParaConfirmar(usuarioData.empresa_id, usuarioData.email),
    // Combos: se trae la cabecera (precio propio, SERVIDOR) + composición
    // (para poder descontar stock por componente) — nunca se confía en el
    // precio ni en la composición que pueda mandar el cliente.
    comboIds.length ? obtenerCombosParaValidarPedido(usuarioData.empresa_id, comboIds) : Promise.resolve([]),
    productoIdsDirectos.length ? obtenerProductosParaCotizarConCosto(usuarioData.empresa_id, productoIdsDirectos) : Promise.resolve([]),
  ]);

  if (cliError || !clienteRow) {
    return res.status(403).json({ error: 'No se encontró un cliente asociado a esta cuenta' });
  }

  if (!clienteRow.activo) {
    return res.status(403).json({ error: 'Cliente inactivo. Contacte a la distribuidora.' });
  }

  // REQ-2: Verificar si el cliente tiene deuda vencida (score_categoria = 'bloqueado')
  // Nota: columna 'bloqueado' se agrega en 047_sincronizacion_real_db.sql
  if (clienteRow.saldo_deuda > 0 && clienteRow.limite_credito > 0 &&
      clienteRow.saldo_deuda > clienteRow.limite_credito * 1.5) {
    return res.status(403).json({
      error: 'cliente_bloqueado',
      mensaje: 'Tu cuenta tiene deuda vencida. Contactá a tu vendedor para regularizar.',
      motivo: 'Deuda supera el límite de crédito'
    });
  }

  const comboMap = new Map(combosData.map(c => [c.id, c]));

  for (const comboId of comboIds) {
    const combo = comboMap.get(comboId);
    if (!combo || !combo.activo) {
      return res.status(400).json({ error: `Combo no disponible: ${comboId}`, combo_id: comboId });
    }
  }

  const prodMap = Object.fromEntries((prodsData || []).map(p => [p.id, p]));

  // ── 4. Verificar stock disponible (directo + lo que consume cada combo) ──
  // Un mismo producto puede necesitarse a la vez por un renglón directo y
  // por uno o más combos del carrito — se acumula la necesidad total por
  // producto ANTES de comparar contra el stock disponible, para no aprobar
  // dos renglones que individualmente "entran" pero juntos no alcanzan.
  const necesidadPorProducto = new Map();
  for (const item of items) {
    if (item.producto_id) {
      necesidadPorProducto.set(item.producto_id, (necesidadPorProducto.get(item.producto_id) || 0) + item.cantidad);
    } else {
      const combo = comboMap.get(item.combo_id);
      for (const ci of combo.items) {
        necesidadPorProducto.set(ci.producto_id, (necesidadPorProducto.get(ci.producto_id) || 0) + ci.cantidad * item.cantidad);
      }
    }
  }
  const productoIdsParaStock = [...necesidadPorProducto.keys()];

  // Perf (loadtest etapa4): resolver depósito y resolver precios son
  // independientes entre sí (ninguna necesita el resultado de la otra,
  // ambas solo necesitan clienteRow ya resuelto arriba) — se piden en
  // paralelo en vez de una atrás de la otra.
  const [depositoId, { data: preciosResueltos, error: errPrecios }] = await Promise.all([
    // Multi-depósito (550): portal cliente no tiene forma de elegir sucursal
    // (el cliente ya es quien es) — se resuelve por su deposito_id fijo, con
    // fallback al depósito principal, mismo criterio que WhatsApp y admin.
    resolverDepositoParaPedido({
      empresaId: usuarioData.empresa_id,
      clienteDepositoId: clienteRow.deposito_id,
    }),
    productoIdsDirectos.length
      ? resolverPreciosClienteRpc({
          cliente_id:   clienteRow.id,
          producto_ids: productoIdsDirectos,
          empresa_id:   usuarioData.empresa_id,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (!depositoId) {
    return res.status(400).json({ error: 'La empresa no tiene ningún depósito activo configurado' });
  }
  if (errPrecios) {
    console.error('[pedidos] error resolviendo precios:', errPrecios);
    return res.status(500).json({ error: 'No se pudieron resolver los precios' });
  }
  const precioMap = Object.fromEntries((preciosResueltos || []).map(p => [p.producto_id, p.precio]));

  const stockMap = await obtenerStockPorDeposito(productoIdsParaStock, depositoId);

  for (const [productoId, necesaria] of necesidadPorProducto) {
    const disponible = stockMap[productoId] ?? 0;
    if (necesaria > disponible) {
      const nombreProd = await obtenerNombreProducto(productoId);
      return res.status(400).json({
        error:       `Stock insuficiente para "${nombreProd || productoId}". Disponible: ${disponible}`,
        producto_id: productoId,
        disponible,
      });
    }
  }

  // ── 4b. v85: Resolver precios del servidor (NUNCA confiar en precio del cliente)
  // Previene manipulación de precios vía devtools. (Fetch de prodsData y
  // preciosResueltos ya resuelto más arriba, en paralelo con cliente/
  // combos y depósito respectivamente — ver comentarios de perf arriba.)
  // v176: antes esto traía CUALQUIER precio de CUALQUIER lista de la empresa
  // (primer match, sin filtrar por la lista asignada al cliente — bug real,
  // ver TODO viejo que decía "filtrar por lista asignada cuando se implemente").
  // Ahora se resuelve con resolver_precios_cliente(), que centraliza la
  // prioridad precio especial del cliente > precio de SU lista > precio_base,
  // y es el mismo punto que usa pos.js (migración 162). Solo aplica a los
  // renglones directos — los combos tienen precio propio fijo (combo.precio),
  // no pasan por reglas de precio de cliente/lista.

  // Validar que todos los productos/combos pertenezcan a la empresa del
  // cliente, y cachear precio/IVA del servidor por renglón.
  for (const item of items) {
    if (item.producto_id) {
      if (!prodMap[item.producto_id]) {
        return res.status(400).json({
          error: `Producto no disponible: ${item.producto_id}`,
          producto_id: item.producto_id,
        });
      }
      // Override del precio_unitario con el precio del servidor
      item._precio_servidor = precioMap[item.producto_id] ?? prodMap[item.producto_id].precio_base;
      item._iva_servidor    = prodMap[item.producto_id].iva ?? 21;
    } else {
      const combo = comboMap.get(item.combo_id);
      // Precio del combo: SIEMPRE el de la tabla `combos`, nunca el que
      // mande el cliente — ya se validó arriba que existe y está activo.
      item._precio_servidor = combo.precio;
      item._iva_servidor    = calcularIvaPonderadoCombo(combo.items);
    }
  }

  // ── 5. Verificar límite de crédito usando saldo_deuda (mantenido por trigger)
  // v85: saldo_deuda ahora se sincroniza automáticamente via trigger en cta_cte
  // v(forma_pago): si el cliente eligió 'pago_inmediato', este pedido nunca
  // va a generar un asiento en cta_cte (ver emitirFactura(), que solo debita
  // cuando forma_pago === 'cuenta_corriente' — mismo criterio que ya existía
  // para ventas POS con __monto_cta_cte_pos). No tiene sentido bloquearlo
  // contra un límite de deuda que este pedido no va a incrementar.
  if (formaPago === 'cuenta_corriente' && clienteRow.limite_credito > 0) {
    // Usar saldo_deuda del cliente (ya actualizado por trigger de cta_cte)
    const saldoActual = clienteRow.saldo_deuda || 0;
    // Calcular total del pedido con precios del servidor
    const totalPedido = items.reduce((s, i) => s + (i._precio_servidor * i.cantidad), 0);

    if (saldoActual + totalPedido > clienteRow.limite_credito) {
      return res.status(400).json({
        error: `Superás tu límite de crédito ($${clienteRow.limite_credito.toLocaleString('es-AR')}). Saldo actual: $${saldoActual.toLocaleString('es-AR')}`,
        tipo:  'limite_credito',
      });
    }
  }

  // ── 6. Calcular totales con IVA por producto ─────────
  // v85: usar precio del servidor (cacheado en _precio_servidor arriba),
  // ignorar precio_unitario que mandó el cliente. v(combos): el IVA
  // también viene cacheado por renglón (_iva_servidor) para poder usar el
  // ponderado de los combos — ver resolverIva más abajo.
  const { subtotal, iva_total, total, itemsParaRpc } = calcularTotalesPedido(items, {
    resolverPrecio: item => item._precio_servidor,
    resolverIva:    item => item._iva_servidor,
  });

  // Plan 3.3: no permitir superar el cupo de pedidos mensuales del plan contratado.
  try {
    await exigirLimitePlan(supabase, usuarioData.empresa_id, 'pedidos_mes');
  } catch (err) {
    if (err instanceof LimitePlanError) {
      return errorSeguro(res, err, 403, 'No se pudo completar la operación.', { code: err.code, info: err.info });
    }
    throw err;
  }

  // ── 7. Crear pedido + items + reservas en una sola transacción ──────────
  const { data: rpcResult, error: rpcError } = await crearPedidoClienteRpc({
    p_empresa_id:       usuarioData.empresa_id,
    p_cliente_id:       clienteRow.id,
    p_vendedor_id:      user.id,
    p_items:            itemsParaRpc,
    p_subtotal:         Math.round(subtotal  * 100) / 100,
    p_iva_total:        Math.round(iva_total * 100) / 100,
    p_total:            total,
    p_notas_cliente:    notas_cliente || null,
    p_fecha_entrega:    fecha_entrega || null,
    p_idempotency_key:  idemKey,
    p_forma_pago:       formaPago,
    p_deposito_id:      depositoId,
  });

  if (rpcError) {
    console.error('[PEDIDO] Error en RPC crear_pedido_cliente:', rpcError);
    return res.status(500).json({ error: 'Error interno al crear el pedido. Intente nuevamente.' });
  }

  if (!rpcResult?.ok) {
    if (rpcResult?.tipo === 'stock_insuficiente') {
      return res.status(409).json({
        error: 'El stock de uno o más productos cambió mientras confirmabas el pedido. Por favor, revisá el carrito.',
        tipo:  'stock_insuficiente',
      });
    }
    console.error('[PEDIDO] RPC retornó error:', rpcResult?.error);
    return res.status(500).json({ error: rpcResult?.error || 'Error al crear el pedido.' });
  }

  const pedidoId   = rpcResult.pedido_id;
  const yaExistia  = !!rpcResult.ya_existia;

  // Auditoría: usuario_id = el user.id autenticado del portal cliente (es
  // un humano real detrás, solo que "cliente" en vez de "admin"). Se omite
  // en el caso de idempotency_key duplicado (yaExistia) para no loguear
  // dos veces la misma creación real.
  // Perf (loadtest etapa4): registrarAuditoriaSilenciosa() está diseñada
  // para nunca lanzar y no reintentar (ver su propio comentario en
  // lib/repos/audit.js) — es exactamente el mismo contrato "seguro para no
  // esperar" que vaciarCarritoCliente() dos líneas más abajo. Antes estaba
  // `await`eada bloqueando la respuesta al cliente por un INSERT que ni
  // siquiera es crítico para el checkout; ahora es fire-and-forget como el
  // resto de los efectos secundarios de este handler.
  if (!yaExistia) {
    AuditRepo.registrarAuditoriaSilenciosa(
      usuarioData.empresa_id, user.id, 'pedidos', 'INSERT', pedidoId, null,
      { cliente_id: clienteRow.id, subtotal, iva_total, total, items: itemsParaRpc }
    ).catch(() => {}); // la función ya loguea sus propios errores internamente
  }

  // ── 8. Limpiar carrito del cliente (portal) ──────────────────────────────
  // Se hace antes de los efectos secundarios para liberar el carrito
  // incluso si alguna notificación falla.
  vaciarCarritoCliente(clienteRow.id)
    .then(() => {}) // fire-and-forget: el carrito también se limpia en el frontend
    .catch(err => console.error('[CARRITO] Error vaciando carrito:', err));

  // ── 9. Efectos secundarios async ─────────────────────────────────────────
  // Hallazgo 3: si `crear_pedido_cliente` devolvió un pedido YA EXISTENTE
  // (mismo idempotency_key — este request es un reintento del cliente tras
  // un timeout de red, no un pedido nuevo), estos efectos ya corrieron para
  // el intento original. Repetirlos duplicaría el WhatsApp/email/push de
  // confirmación, la factura y los puntos de fidelización — el fix de
  // duplicidad de PEDIDOS no debe convertirse en duplicidad de sus efectos.
  if (!yaExistia) {
    notificarPedidoConfirmado(pedidoId, clienteRow, usuarioData.empresa_id).catch(console.error);

    emitirFactura(pedidoId).catch(err => {
      console.error(`[FACTURACION] Error al emitir factura del pedido ${pedidoId}:`, err);
    });

    acreditarPuntos(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[PUNTOS] Error al acreditar puntos del pedido ${pedidoId}:`, err);
    });

    acreditarAhorroCompetencia(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[AHORRO] Error al acreditar ahorro de competencia del pedido ${pedidoId}:`, err);
    });

    // Push al cliente (confirmación de su propio pedido)
    notificarPushPedidoConfirmado(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[PUSH] Error al enviar push del pedido ${pedidoId}:`, err);
    });

    // Push a los administradores (nuevo pedido recibido)
    notificarPushAdmin(pedidoId, clienteRow, usuarioData.empresa_id).catch(err => {
      console.error(`[PUSH-ADMIN] Error al notificar admins del pedido ${pedidoId}:`, err);
    });
  } else {
    console.log(`[PEDIDO] Confirmación duplicada detectada por idempotency_key — pedido ${pedidoId} ya existía, se omiten efectos secundarios.`);
  }

  // ── 10. Responder ─────────────────────────────────────
  // Recuperar numero_pedido generado por el trigger de DB
  const pedidoNro = await obtenerNumeroPedido(pedidoId);

  return res.status(200).json({
    ok:             true,
    pedido_id:      pedidoId,
    numero_pedido:  pedidoNro?.numero_pedido || pedidoId.slice(-8).toUpperCase(),
    total,
    ya_existia:     yaExistia,
    mensaje:        'Pedido confirmado. Recibirás un WhatsApp con la confirmación.',
  });
}
