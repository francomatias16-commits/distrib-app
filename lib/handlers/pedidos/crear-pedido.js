// lib/handlers/pedidos/crear-pedido.js
// Lógica de negocio compartida para crear un pedido (crearPedidoParaCliente,
// usada por el portal cliente y por el alta admin) y el handler HTTP de alta
// admin. Extraído de lib/handlers/pedidos.js (25/08/2026).

import { crearClienteSupabaseLazy } from '../../supabase-lazy.js';
import { getUserSeguro } from '../../auth-helpers.js';
import * as AuditRepo from '../../repos/audit.js';
import {
  calcularIvaPonderadoCombo,
  calcularTotalesPedido,
} from '../../calc/pedido-totales.js';
import { errorSeguro } from '../../error-response.js';
import {
  emitirEvento,
  usaDespachadorEventos,
} from '../../eventos.js';
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
  obtenerClienteParaPedido,
  obtenerPerfilParaCrearPedidoAdmin,
  resolverPreciosClienteRpc,
} from '../../repos/pedidos.js';
import {
  obtenerNombreProducto,
  obtenerProductosParaValidarPedido,
} from '../../repos/productos.js';
import { notificarPedidoConfirmado, acreditarPuntos, acreditarAhorroCompetencia } from './notificaciones.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export async function crearPedidoParaCliente({ empresaId, vendedorId, clienteId, items, notas, fechaEntrega, idempotencyKey = null, preview = false, depositoId: depositoIdExplicito = null }) {
  if (!clienteId) return { ok: false, status: 400, error: 'cliente_id requerido' };
  if (!Array.isArray(items) || !items.length)
    return { ok: false, status: 400, error: 'Agregá al menos un producto' };

  // v(combos): mismo criterio que confirmarPedidoHandler — cada renglón es
  // DE UN PRODUCTO o DE UN COMBO (ítem único, precio propio), nunca ambos
  // ni ninguno (constraint pedido_items_producto_o_combo, migración 530).
  for (const item of items) {
    const esCombo = !!item.combo_id;
    if (esCombo === !!item.producto_id) {
      return { ok: false, status: 400, error: 'Item inválido' };
    }
    if (!item.cantidad || item.cantidad <= 0)
      return { ok: false, status: 400, error: 'Item inválido' };
  }

  // Cliente debe pertenecer a la empresa
  const { data: clienteRow, error: cliError } = await obtenerClienteParaPedido(empresaId, clienteId);

  if (cliError || !clienteRow) return { ok: false, status: 404, error: 'Cliente no encontrado' };
  if (!clienteRow.activo) return { ok: false, status: 400, error: 'El cliente está inactivo' };

  const productoIdsDirectos = items.filter(i => i.producto_id).map(i => i.producto_id);
  const comboIds            = [...new Set(items.filter(i => i.combo_id).map(i => i.combo_id))];

  // Combos: cabecera (precio propio, SERVIDOR) + composición, para poder
  // descontar stock por componente — mismo criterio que confirmarPedidoHandler.
  const combosData = comboIds.length ? await obtenerCombosParaValidarPedido(empresaId, comboIds) : [];
  const comboMap = new Map(combosData.map(c => [c.id, c]));

  for (const comboId of comboIds) {
    const combo = comboMap.get(comboId);
    if (!combo || !combo.activo) {
      return { ok: false, status: 400, error: `Combo no disponible: ${comboId}`, combo_id: comboId };
    }
  }

  // ── Mismo chequeo de stock que confirmarPedidoHandler (directo + lo que
  // consume cada combo, acumulado por producto antes de comparar) ──
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

  // Multi-depósito (550): mismo criterio que el bot de WhatsApp y que
  // resolver_deposito_pedido() en SQL — override explícito (vendedor eligió
  // sucursal en el admin) > sucursal fija del cliente > depósito principal.
  const depositoId = await resolverDepositoParaPedido({
    empresaId,
    clienteDepositoId: clienteRow.deposito_id,
    depositoIdExplicito,
  });
  if (!depositoId) {
    return { ok: false, status: 400, error: 'La empresa no tiene ningún depósito activo configurado' };
  }

  const stockMap = await obtenerStockPorDeposito(productoIdsParaStock, depositoId);
  for (const [productoId, necesaria] of necesidadPorProducto) {
    const disponible = stockMap[productoId] ?? 0;
    if (necesaria > disponible) {
      const nombreProd = await obtenerNombreProducto(productoId);
      return {
        ok: false,
        status: 400,
        error: `Stock insuficiente para "${nombreProd || productoId}". Disponible: ${disponible}`,
        producto_id: productoId,
        disponible,
      };
    }
  }

  // ── Precios resueltos en servidor (misma RPC que usa el portal y el POS) ──
  // Nunca se confía en un precio_unitario que venga del frontend o del modelo.
  // Solo aplica a los renglones directos — los combos tienen precio propio
  // fijo (combo.precio), no pasan por reglas de precio de cliente/lista.
  const { data: preciosResueltos, error: errPrecios } = productoIdsDirectos.length
    ? await resolverPreciosClienteRpc({
        cliente_id:   clienteRow.id,
        producto_ids: productoIdsDirectos,
        empresa_id:   empresaId,
      })
    : { data: [], error: null };
  if (errPrecios) {
    console.error('[PEDIDO] error resolviendo precios:', errPrecios);
    return { ok: false, status: 500, error: 'No se pudieron resolver los precios' };
  }
  const precioMap = Object.fromEntries((preciosResueltos || []).map(p => [p.producto_id, p.precio]));

  const prodsData = productoIdsDirectos.length
    ? await obtenerProductosParaValidarPedido(empresaId, productoIdsDirectos)
    : [];

  if (!prodsData || prodsData.length !== productoIdsDirectos.length) {
    return { ok: false, status: 400, error: 'Uno o más productos no pertenecen a esta empresa' };
  }
  const nombreMap = Object.fromEntries(prodsData.map(p => [p.id, p.nombre]));
  const prodMap   = Object.fromEntries(prodsData.map(p => [p.id, p]));

  // Validar/cachear precio+IVA del servidor por renglón — mismo criterio
  // (y misma fórmula de IVA ponderado del combo) que confirmarPedidoHandler.
  for (const item of items) {
    if (item.producto_id) {
      item._precio_servidor = precioMap[item.producto_id] ?? prodMap[item.producto_id]?.precio_base ?? 0;
      item._iva_servidor    = prodMap[item.producto_id]?.iva ?? 21;
    } else {
      const combo = comboMap.get(item.combo_id);
      item._precio_servidor = combo.precio;
      item._iva_servidor    = calcularIvaPonderadoCombo(combo.items);
    }
  }

  const { subtotal, iva_total, total, itemsParaRpc } = calcularTotalesPedido(items, {
    resolverPrecio: item => item._precio_servidor,
    resolverIva:    item => item._iva_servidor,
  });

  // Límite de crédito — mismo criterio que confirmarPedidoHandler
  if (clienteRow.limite_credito > 0) {
    const saldoActual = clienteRow.saldo_deuda || 0;
    if (saldoActual + total > clienteRow.limite_credito) {
      return {
        ok: false,
        status: 400,
        tipo: 'limite_credito',
        error: `El cliente supera su límite de crédito ($${clienteRow.limite_credito.toLocaleString('es-AR')}). Saldo actual: $${saldoActual.toLocaleString('es-AR')}`,
      };
    }
  }

  // Plan: no permitir superar el cupo de pedidos mensuales del plan contratado
  try {
    await exigirLimitePlan(supabase, empresaId, 'pedidos_mes');
  } catch (err) {
    if (err instanceof LimitePlanError) {
      return { ok: false, tipo: 'limite_plan', error: err.message, code: err.code, info: err.info };
    }
    throw err;
  }

  const detalle = {
    cliente: clienteRow.razon_social,
    items: items.map(item => ({
      producto_id: item.producto_id ?? null,
      combo_id:    item.combo_id ?? null,
      producto:    item.producto_id
        ? (nombreMap[item.producto_id] || item.producto_id)
        : (comboMap.get(item.combo_id)?.nombre || item.combo_id),
      cantidad:    item.cantidad,
      precio:      item._precio_servidor,
    })),
    subtotal:  Math.round(subtotal  * 100) / 100,
    iva_total: Math.round(iva_total * 100) / 100,
    total:     Math.round(total * 100) / 100,
  };

  // Modo preview: ya validamos todo y calculamos los totales reales, pero
  // no se toca la base — usado por el asistente para armar el resumen que
  // el usuario confirma antes de que exista el pedido.
  if (preview) return { ok: true, preview: true, ...detalle };

  // ── Crear pedido + items + reservas en una sola transacción (misma RPC) ──
  const { data: rpcResult, error: rpcError } = await crearPedidoClienteRpc({
    p_empresa_id:    empresaId,
    p_cliente_id:    clienteRow.id,
    p_vendedor_id:   vendedorId,
    p_items:         itemsParaRpc,
    p_subtotal:      detalle.subtotal,
    p_iva_total:     detalle.iva_total,
    p_total:         detalle.total,
    p_notas_cliente: notas || null,
    p_fecha_entrega: fechaEntrega || null,
    // Plan offline — Etapa 3, ítem 1: misma idempotencia que ya usaba el
    // portal cliente (ver confirmarPedidoHandler) — necesaria acá para que
    // el modal "Nuevo pedido" del admin también pueda encolarse offline y
    // reintentar sin duplicar el pedido (ver migración 443).
    p_idempotency_key: idempotencyKey || null,
    p_deposito_id: depositoId,
  });

  if (rpcError) {
    console.error('[PEDIDO] Error en RPC crear_pedido_cliente:', rpcError);
    return { ok: false, status: 500, error: 'Error interno al crear el pedido. Intente nuevamente.' };
  }

  if (!rpcResult?.ok) {
    if (rpcResult?.tipo === 'stock_insuficiente') {
      return {
        ok: false,
        status: 409,
        tipo: 'stock_insuficiente',
        error: 'El stock de uno o más productos cambió mientras se armaba el pedido. Revisá los ítems.',
      };
    }
    console.error('[PEDIDO] RPC retornó error:', rpcResult?.error);
    return { ok: false, status: 500, error: rpcResult?.error || 'Error al crear el pedido.' };
  }

  const pedidoId = rpcResult.pedido_id;
  const yaExistia = !!rpcResult.ya_existia;

  // Auditoría: usuario_id = vendedorId, quien esté armando el pedido a
  // nombre del cliente (admin/vendedor desde el modal, o el usuarioId que
  // ya resuelve la tool `crear_pedido` del asistente antes de llegar acá)
  // — mismo punto único para las 2 formas de llegar a esta función.
  if (!yaExistia) {
    await AuditRepo.registrarAuditoriaSilenciosa(
      empresaId, vendedorId, 'pedidos', 'INSERT', pedidoId, null,
      { cliente_id: clienteRow.id, ...detalle }
    );
  }

  // Fase 1 (plan de sincronización ERP): se emite el evento de negocio
  // siempre, esté activo o no el despachador de Fase 3 — deja rastro en
  // eventos_negocio para trazabilidad aunque el camino directo (abajo)
  // sea el que efectivamente dispare los efectos para esta empresa.
  // Plan offline — Etapa 3: si el pedido ya existía (reintento/replay del
  // outbox), estos efectos ya corrieron para el intento original —
  // repetirlos duplicaría factura/puntos/notificación.
  if (!yaExistia) {
    emitirEvento({
      empresaId,
      tipoEvento: 'pedido_creado',
      payload: { pedido_id: pedidoId, cliente_id: clienteRow.id },
      origen: 'crearPedidoParaCliente',
    }).catch(err => console.error('[EVENTOS] error emitiendo pedido_creado:', err));
  }

  // Fase 3: expand-contract — nunca las dos rutas activas a la vez para
  // la misma empresa. Si no se pudo leer el flag, se cae al camino
  // directo (fail-safe) para no dejar un pedido sin sus efectos.
  let despachadorActivo = false;
  try {
    despachadorActivo = await usaDespachadorEventos(empresaId);
  } catch (err) {
    console.error('[EVENTOS] error chequeando flag fase3_despachador_eventos:', err);
  }

  if (!yaExistia) {
    if (despachadorActivo) {
      // Import dinámico: evita el ciclo estático pedidos.js → eventos-dispatcher.js
      // → eventos-listeners/pedido_creado.js → pedidos.js. Se resuelve en runtime,
      // cuando pedidos.js ya terminó de cargar, así que ESM lo maneja sin problema.
      // No "corregir" esto a un import estático sin leer esta nota primero.
      import('../eventos-dispatcher.js')
        .then(({ despacharPendientes }) => despacharPendientes({ empresaId }))
        .catch(err => console.error('[EVENTOS] error despachando eventos (Fase 3):', err));
    } else {
      // Efectos secundarios async — mismos que el flujo del portal cliente
      notificarPedidoConfirmado(pedidoId, clienteRow, empresaId).catch(console.error);

      emitirFactura(pedidoId).catch(err => {
        console.error('[PEDIDO] Error emitiendo factura automática:', err.message, { pedidoId });
      });

      acreditarPuntos(pedidoId, clienteRow, empresaId).catch(err => {
        console.error(`[PUNTOS] Error al acreditar puntos del pedido ${pedidoId}:`, err);
      });

      acreditarAhorroCompetencia(pedidoId, clienteRow, empresaId).catch(err => {
        console.error(`[AHORRO] Error al acreditar ahorro de competencia del pedido ${pedidoId}:`, err);
      });
    }
  }

  return {
    ok: true,
    pedido_id: pedidoId,
    numero: pedidoId?.slice(0, 8)?.toUpperCase(),
    ya_existia: yaExistia,
    ...detalle,
  };
}

export async function crearPedidoAdminHandler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await getUserSeguro(supabase, token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await obtenerPerfilParaCrearPedidoAdmin(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'pedidos'))
    return res.status(403).json({ error: 'Sin permisos para crear pedidos' });

  const { cliente_id, items, notas, fecha_entrega, idempotency_key, deposito_id } = req.body || {};

  // Plan offline — Etapa 3: mismo formato que ya usa el portal cliente
  // (UUID válido o se ignora, nunca 400 por un detalle de formato — ver
  // confirmarPedidoHandler más abajo).
  const UUID_RE_ADMIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idemKeyAdmin = (typeof idempotency_key === 'string' && UUID_RE_ADMIN.test(idempotency_key))
    ? idempotency_key
    : null;
  // Multi-depósito (550): override opcional para cuando el vendedor arma el
  // pedido explícitamente desde otra sucursal. El frontend todavía no tiene
  // un selector para esto (queda para cuando se necesite) — sin este campo,
  // se resuelve solo por sucursal del cliente / depósito principal.
  const depositoIdAdmin = (typeof deposito_id === 'string' && UUID_RE_ADMIN.test(deposito_id))
    ? deposito_id
    : null;

  const resultado = await crearPedidoParaCliente({
    empresaId:   perfil.empresa_id,
    vendedorId:  perfil.id,
    clienteId:   cliente_id,
    items,
    notas,
    fechaEntrega: fecha_entrega,
    idempotencyKey: idemKeyAdmin,
    depositoId: depositoIdAdmin,
  });

  if (!resultado.ok) {
    if (resultado.tipo === 'limite_plan') {
      return errorSeguro(res, new Error(resultado.error), 403, 'No se pudo completar la operación.', { code: resultado.code, info: resultado.info });
    }
    const body = { error: resultado.error };
    if (resultado.tipo) body.tipo = resultado.tipo;
    if (resultado.producto_id) body.producto_id = resultado.producto_id;
    if (resultado.disponible !== undefined) body.disponible = resultado.disponible;
    return res.status(resultado.status || 400).json(body);
  }

  return res.status(201).json({
    ok:     true,
    id:     resultado.pedido_id,
    numero: resultado.numero,
    ya_existia: resultado.ya_existia || false,
  });
}
