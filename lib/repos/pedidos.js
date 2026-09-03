// lib/repos/pedidos.js
// Capa de acceso a datos para `lib/handlers/pedidos.js`.
//
// Fase 7, paso 6 del plan de migración (FASE7_PLAN_ARRANQUE.md). El propio
// plan advierte que `pedidos.js` (3164 líneas, 130 `.from()`) no se migra
// entero de una — se parte en sub-módulos, mismo criterio que evitó un PR
// gigante en `notif.js` (paso 7, 4 lotes). Este primer lote cubre
// **presupuestos** (`crearPresupuestoParaCliente` y `handlePresupuestos`):
// es el sub-módulo más autocontenido del archivo — usa `presupuestos` y
// `presupuesto_items` en exclusiva, y comparte `clientes`/`empresas`/
// `stock`/`pedidos`/`pedido_items`/`movimientos_stock` con el resto de
// pedidos.js sin que ningún otro concern dependa de este código.
//
// Reuso en vez de duplicar: `resolverPreciosClienteRpc` ya existe en
// lib/repos/whatsapp-bot.js (mismo RPC `resolver_precios_cliente` que ya
// usa el flujo de pedidos del portal/admin) — se importa desde ahí en vez
// de crear una copia acá. Se reexporta para que el handler no tenga que
// importar de dos repos distintos para este único módulo.

import { db } from './_db.js';
export { resolverPreciosClienteRpc, crearPedidoClienteRpc, obtenerNumeroPedido } from './whatsapp-bot.js';

// ── Alta de presupuesto (crearPresupuestoParaCliente + POST admin) ────────

/** Cliente a validar antes de armar el presupuesto (existe, activo, de esta empresa). */
export async function obtenerClienteParaPresupuesto(empresa_id, cliente_id) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, activo')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

/** Cantidad de presupuestos ya creados en la empresa — para el número correlativo PRES-XXXXX. */
export async function contarPresupuestosPorEmpresa(empresa_id) {
  const { count } = await db
    .from('presupuestos')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id);
  return count || 0;
}

/** Config de la empresa — usada por el POST admin para la vigencia por defecto en días. */
export async function obtenerConfigEmpresa(empresa_id) {
  const { data } = await db.from('empresas').select('config').eq('id', empresa_id).single();
  return data;
}

/** Inserta el presupuesto y devuelve la fila creada. */
export async function crearPresupuesto(payload) {
  const { data, error } = await db.from('presupuestos').insert(payload).select().single();
  return { data, error };
}

/** Crea cabecera e ítems con numeración y rollback transaccionales. */
export async function crearPresupuestoConItemsRpc(payload) {
  const { data, error } = await db.rpc('crear_presupuesto_con_items', payload);
  return { data, error };
}

/** Inserta los ítems del presupuesto (uno por producto/línea). */
export async function insertarItemsPresupuesto(items) {
  const { error } = await db.from('presupuesto_items').insert(items);
  return { error };
}

// ── Lectura (GET detalle / lista) ──────────────────────────────────────────

/** Presupuesto completo con joins, para el detalle (`GET ?id=`). */
export async function obtenerPresupuestoConDetalle(empresa_id, id) {
  const { data, error } = await db
    .from('presupuestos')
    .select(`
      *,
      clientes(id, razon_social, nombre_fantasia, email, telefono, domicilio),
      usuarios!vendedor_id(id, nombre),
      presupuesto_items(
        id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal,
        productos(codigo, nombre, unidad)
      )
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Lista de presupuestos. `clienteId` ya viene resuelto por el handler (el
 * id del cliente logueado si `esCliente`, o el filtro admin de
 * `?cliente_id=` si corresponde) — mismo query builder condicional que el
 * original, solo que acá el "quién filtra" ya se decidió antes de llamar.
 */
export async function listarPresupuestos(empresa_id, { estado, clienteId } = {}) {
  let query = db
    .from('presupuestos')
    .select(`
      id, numero, estado, total, created_at, fecha_vencimiento, notas,
      clientes(id, razon_social, nombre_fantasia),
      usuarios!vendedor_id(nombre)
    `)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });

  if (clienteId) query = query.eq('cliente_id', clienteId);
  if (estado) query = query.eq('estado', estado);

  const { data, error } = await query.limit(200);
  return { data, error };
}

/**
 * Cliente vinculado al usuario logueado — usado en los 4 puntos donde
 * `handlePresupuestos` chequea "esCliente" (GET detalle, GET lista, PATCH y
 * la validación de propiedad del PATCH). Ignora error igual que el
 * original: devuelve `null` y el handler responde 403 o lista vacía según
 * el caso.
 */
export async function obtenerClientePorUsuarioId(empresa_id, usuario_id) {
  const { data } = await db
    .from('clientes')
    .select('id')
    .eq('usuario_id', usuario_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Perfil del usuario logueado para `handlePresupuestos` — mismo shape que
 * `obtenerPerfilChofer`. Quedó pendiente en el lote 1 (se migró el resto del
 * handler pero no este fetch); se cierra acá como función propia en vez de
 * reusar `obtenerPerfilChofer` porque son dos concerns con gates de permisos
 * independientes (`presupuestos` vs `pedidos_chofer`).
 */
export async function obtenerPerfilPresupuestos(usuario_id) {
  const { data } = await db
    .from('usuarios')
    .select('empresa_id, rol, nombre, id')
    .eq('id', usuario_id)
    .single();
  return data;
}

// ── PATCH (actualizar / aceptar / rechazar) ────────────────────────────────

/** Presupuesto mínimo para validar pertenencia antes de un PATCH. */
export async function obtenerPresupuestoParaPatch(empresa_id, id) {
  const { data } = await db
    .from('presupuestos')
    .select('id, estado, cliente_id, empresa_id')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/**
 * Lock optimista (v85): solo pasa a 'aceptado' si el estado actual sigue
 * siendo 'enviado' — evita que dos vendedores simultáneos generen dos
 * pedidos del mismo presupuesto. Si `data` viene null, otro proceso ya lo
 * convirtió primero.
 */
export async function bloquearPresupuestoAceptado(empresa_id, id) {
  const { data, error } = await db
    .from('presupuestos')
    .update({ estado: 'aceptado', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .eq('estado', 'enviado')
    .select('id')
    .single();
  return { data, error };
}

/** Presupuesto completo (con ítems) para convertirlo a pedido tras aceptar. */
export async function obtenerPresupuestoCompleto(id) {
  const { data } = await db.from('presupuestos').select('*, presupuesto_items(*)').eq('id', id).single();
  return data;
}

/** Crédito disponible del cliente, para el chequeo de límite al aceptar. */
export async function obtenerClienteCredito(cliente_id) {
  const { data } = await db
    .from('clientes')
    .select('limite_credito, saldo_deuda, deposito_id')
    .eq('id', cliente_id)
    .single();
  return data;
}

/**
 * Stock del depósito PRINCIPAL para un producto — primer intento al
 * reservar (réplica exacta de la lógica de `confirmar_pedido()`: siempre se
 * prueba el principal antes que cualquier otro depósito).
 */
export async function obtenerStockDepositoPrincipal(empresa_id, producto_id) {
  const { data } = await db
    .from('stock')
    .select('deposito_id, cantidad, cantidad_reservada, depositos!inner(empresa_id, es_principal)')
    .eq('producto_id', producto_id)
    .eq('depositos.empresa_id', empresa_id)
    .eq('depositos.es_principal', true)
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

/**
 * Fallback: cualquier depósito de la empresa con stock del producto, usado
 * solo si el principal no tiene registro. El handler elige el de mayor
 * disponible (`cantidad - cantidad_reservada`).
 */
export async function listarStockOtrosDepositos(empresa_id, producto_id) {
  const { data } = await db
    .from('stock')
    .select('deposito_id, cantidad, cantidad_reservada, depositos!inner(empresa_id)')
    .eq('producto_id', producto_id)
    .eq('depositos.empresa_id', empresa_id);
  return data || [];
}

/** Crea el pedido en firme, directo desde un presupuesto recién aceptado. */
export async function crearPedidoDesdePresupuesto(payload) {
  const { data, error } = await db.from('pedidos').insert(payload).select().single();
  return { data, error };
}

/** Inserta los ítems del pedido generado desde el presupuesto. */
export async function insertarItemsPedidoDesdePresupuesto(items) {
  const { error } = await db.from('pedido_items').insert(items);
  return { error };
}

/** RPC compartido con `confirmarPedidoHandler` — reserva stock atómicamente. */
export async function incrementarStockReservadoRpc({ producto_id, deposito_id, cantidad }) {
  const { error } = await db.rpc('incrementar_stock_reservado', {
    p_producto_id: producto_id, p_deposito_id: deposito_id, p_cantidad: cantidad,
  });
  return { error };
}

/** Contraparte de `incrementarStockReservadoRpc`, para revertir una reserva parcial. */
export async function liberarStockReservadoRpc({ producto_id, deposito_id, cantidad }) {
  const { error } = await db.rpc('liberar_stock_reservado', {
    p_producto_id: producto_id, p_deposito_id: deposito_id, p_cantidad: cantidad,
  });
  return { error };
}

/** Movimiento de stock por la reserva — mismo criterio que `confirmar_pedido()`. */
export async function registrarMovimientoStockReserva(payload) {
  await db.from('movimientos_stock').insert(payload);
}

/** Deshace el pedido creado desde un presupuesto, si algo falla después (items o reserva). */
export async function eliminarItemsPedido(pedido_id) {
  await db.from('pedido_items').delete().eq('pedido_id', pedido_id);
}

export async function eliminarPedido(pedido_id) {
  await db.from('pedidos').delete().eq('id', pedido_id);
}

/** Vuelve el presupuesto a 'enviado' — rollback del lock optimista si algo falla después. */
export async function revertirPresupuestoAEnviado(id) {
  await db.from('presupuestos')
    .update({ estado: 'enviado', updated_at: new Date().toISOString() })
    .eq('id', id);
}

/** Guarda la referencia al pedido generado, una vez que todo el flujo de aceptación salió bien. */
export async function vincularPresupuestoConPedido(id, pedido_id) {
  await db.from('presupuestos').update({ pedido_id }).eq('id', id);
}

/** PATCH genérico (notas / fecha_vencimiento / estado que no sea 'aceptado'). */
export async function actualizarPresupuesto(id, patch) {
  const { error } = await db.from('presupuestos').update(patch).eq('id', id);
  return { error };
}

// ── DELETE ──────────────────────────────────────────────────────────────

/** Presupuesto mínimo para el DELETE (solo necesita el estado). */
export async function obtenerPresupuestoParaEliminar(empresa_id, id) {
  const { data } = await db.from('presupuestos').select('estado').eq('id', id).eq('empresa_id', empresa_id).single();
  return data;
}

export async function eliminarItemsPresupuesto(id) {
  await db.from('presupuesto_items').delete().eq('presupuesto_id', id);
}

export async function eliminarPresupuesto(id) {
  const { error } = await db.from('presupuestos').delete().eq('id', id);
  return { error };
}

// ── Remito NRO (paso 8, lote 2) ────────────────────────────────────────────

/** Perfil mínimo para el gate de permisos de `handleRemitoNro`. */
export async function obtenerPerfilParaRemitoNro(usuario_id) {
  const { data } = await db.from('usuarios').select('empresa_id, rol').eq('id', usuario_id).single();
  return data;
}

/** Verifica que el pedido pertenezca a la empresa antes de reservar el número. */
export async function obtenerPedidoParaRemitoNro(empresa_id, pedido_id) {
  const { data } = await db
    .from('pedidos')
    .select('id, empresa_id')
    .eq('id', pedido_id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** RPC que maneja la numeración atómica del remito. */
export async function reservarRemitoNroRpc(empresa_id, pedido_id) {
  const { data, error } = await db.rpc('reservar_remito_nro', {
    p_empresa_id: empresa_id,
    p_pedido_id:  pedido_id,
  });
  return { data, error };
}

// ── Portal del chofer (paso 8, lote 2) ─────────────────────────────────────

/** Perfil del usuario logueado — mismo shape que usa el resto del archivo. */
export async function obtenerPerfilChofer(usuario_id) {
  const { data } = await db
    .from('usuarios')
    .select('empresa_id, rol, nombre, id')
    .eq('id', usuario_id)
    .single();
  return data;
}

/**
 * CHOFER-001 (auditoría 2026-07-26): la entrega ACTIVA (pendiente/en_camino)
 * de un pedido, con el chofer de su ruta — usada para validar que el pedido
 * consultado/operado pertenezca efectivamente a la ruta de ESTE chofer, no
 * a la de un colega. `pedidoEsDeEsteChofer()` en el handler sigue siendo
 * quien compara `data.rutas?.chofer_id === chofer_id` — acá solo se aísla
 * el acceso a datos.
 */
export async function obtenerEntregaActivaDelPedido(pedido_id) {
  const { data } = await db
    .from('entregas')
    .select('id, rutas(chofer_id)')
    .eq('pedido_id', pedido_id)
    .in('estado', ['pendiente', 'en_camino'])
    .limit(1)
    .maybeSingle();
  return data;
}

/** Detalle de un remito (pedido) puntual, para `GET /api/chofer/remitos?id=`. */
export async function obtenerRemitoDetalle(empresa_id, id) {
  const { data, error } = await db
    .from('pedidos')
    .select(`
      id, estado, total, notas_cliente, created_at, updated_at, empresa_id,
      forma_pago,
      clientes(id, razon_social, nombre_fantasia, domicilio, telefono, lat, lng),
      pedido_items(
        id, cantidad, precio_unitario, subtotal,
        productos(id, nombre, codigo, unidad)
      )
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Fast path de idempotencia offline (Plan offline, Etapa 3) — ver
 * migración 441. Si el reintento del outbox del chofer ya generó una fila
 * en `entregas` con este offline_local_id, el handler la usa para devolver
 * éxito sin reprocesar en vez de duplicar la entrega/cobro.
 *
 * Punto 5 (auditoría pre-lanzamiento 2026): el lookup ahora se acota por
 * `empresa_id` — antes buscaba en toda la tabla, así que una colisión de
 * offline_local_id entre dos empresas distintas (extremadamente
 * improbable, ya que lo genera el dispositivo con crypto.randomUUID(),
 * pero no imposible: bug de cliente, RNG degradado, dispositivo reusado
 * entre tenants) devolvía la entrega de OTRA empresa como "ya_existia".
 * El índice único de la migración 508 pasa a ser (empresa_id, offline_local_id).
 */
export async function buscarEntregaPorOfflineLocalId(empresa_id, offline_local_id) {
  const { data } = await db
    .from('entregas')
    .select('id, pedido_id, estado')
    .eq('empresa_id', empresa_id)
    .eq('offline_local_id', offline_local_id)
    .maybeSingle();
  return data;
}

/** Última entrega de un pedido (para completar ruta_id/monto/medio de cobro en el detalle). */
export async function obtenerUltimaEntregaDelPedido(pedido_id) {
  const { data } = await db
    .from('entregas')
    .select('ruta_id, monto_cobrado, medio_cobro')
    .eq('pedido_id', pedido_id)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/**
 * Rutas del día — filtradas por chofer solo si `chofer_id` viene definido
 * (admin ve todas las de la empresa, un chofer solo las propias). Mismo
 * query condicional que el original.
 */
export async function listarRutasDelDia(empresa_id, fecha, chofer_id = null) {
  let query = db.from('rutas').select('id').eq('empresa_id', empresa_id).eq('fecha', fecha);
  if (chofer_id) query = query.eq('chofer_id', chofer_id);
  const { data, error } = await query;
  return { data: data || [], error };
}

/** Entregas de un conjunto de rutas — trae pedido_id y ruta_id (usado por remitos y clientes). */
export async function listarEntregasPorRutas(ruta_ids) {
  const { data, error } = await db.from('entregas').select('pedido_id, ruta_id').in('ruta_id', ruta_ids);
  return { data: data || [], error };
}

/** Pedidos activos de un conjunto de ids, para armar la lista de remitos del día. */
export async function listarPedidosParaRemitos(empresa_id, pedido_ids) {
  const { data, error } = await db
    .from('pedidos')
    .select(`
      id, estado, total, created_at, forma_pago,
      clientes(id, razon_social, nombre_fantasia, domicilio, telefono, lat, lng)
    `)
    .eq('empresa_id', empresa_id)
    .in('id', pedido_ids)
    .in('estado', ['confirmado', 'preparando', 'despachado'])
    .order('created_at', { ascending: true });
  return { data: data || [], error };
}

/** Pedido a despachar/entregar — mismo select mínimo usado en varios puntos del flujo. */
export async function obtenerPedidoParaDespacho(empresa_id, id) {
  const { data } = await db
    .from('pedidos')
    .select('id, estado, empresa_id')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

/** Pedido con los campos que necesita el flujo de entrega/no-entrega (incluye cliente y numero_pedido). */
export async function obtenerPedidoParaEntrega(empresa_id, id) {
  const { data } = await db
    .from('pedidos')
    .select('id, estado, empresa_id, cliente_id, numero_pedido')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data;
}

export async function marcarPedidoDespachado(id, { notas_chofer }) {
  const { error } = await db
    .from('pedidos')
    .update({
      estado:         'despachado',
      fecha_despacho: new Date().toISOString(),
      notas_internas: notas_chofer ? `[Chofer] ${notas_chofer}` : null,
    })
    .eq('id', id);
  return { error };
}

/**
 * Actualiza la cantidad entregada de un ítem. El POST manual (`remitos`)
 * filtra también por `pedido_id`; el flujo de "entregar" no lo hacía en el
 * original — se preserva la diferencia con el parámetro opcional en vez de
 * unificar el comportamiento.
 */
export async function actualizarCantidadItemPedido(item_id, cantidad, { pedido_id } = {}) {
  let query = db.from('pedido_items').update({ cantidad }).eq('id', item_id);
  if (pedido_id) query = query.eq('pedido_id', pedido_id);
  return query;
}

export async function registrarCobroCompletoRpc(payload) {
  const { data, error } = await db.rpc('registrar_cobro_completo', payload);
  return { data, error };
}

export async function marcarPedidoEntregado(id, { notas_entrega }) {
  const { error } = await db
    .from('pedidos')
    .update({
      estado:         'entregado',
      fecha_entrega:  new Date().toISOString(),
      notas_internas: notas_entrega ? `[Entrega] ${notas_entrega}` : null,
    })
    .eq('id', id);
  return { error };
}

/**
 * Marca la entrega ACTIVA (pendiente/en_camino) como completada — mismo
 * filtro por estado que el fix de auditoría etapa 6 (no tocar entregas
 * históricas de reprogramaciones previas). Devuelve `ruta_id` para
 * sincronizar `rutas.estado`.
 */
export async function marcarEntregaCompletada(pedido_id, payload) {
  const { data, error } = await db
    .from('entregas')
    .update(payload)
    .eq('pedido_id', pedido_id)
    .in('estado', ['pendiente', 'en_camino'])
    .select('ruta_id');
  return { data, error };
}

/** Igual que marcarEntregaCompletada pero para el flujo "no se pudo entregar". */
export async function marcarEntregaNoRealizada(pedido_id, payload) {
  const { data, error } = await db
    .from('entregas')
    .update(payload)
    .eq('pedido_id', pedido_id)
    .in('estado', ['pendiente', 'en_camino'])
    .select('ruta_id');
  return { data, error };
}

/** Vuelve el pedido a 'confirmado' tras un "no se pudo entregar" — queda disponible para reprogramar. */
export async function revertirPedidoAConfirmado(id, { notas_internas }) {
  const { error } = await db.from('pedidos').update({ estado: 'confirmado', notas_internas }).eq('id', id);
  return { error };
}

/**
 * Clientes con pedidos activos hoy — `pedido_ids` acota a los de la ruta
 * del chofer (null = sin acotar, caso admin, mismo criterio que el
 * original).
 */
export async function listarClientesConPedidosActivos(empresa_id, hoy, pedido_ids = null) {
  let query = db
    .from('pedidos')
    .select('clientes(id, razon_social, nombre_fantasia, domicilio, telefono, lat, lng, zona_id)')
    .eq('empresa_id', empresa_id)
    .in('estado', ['confirmado', 'preparando', 'despachado'])
    .gte('created_at', `${hoy}T00:00:00.000Z`)
    .lte('created_at', `${hoy}T23:59:59.999Z`);
  if (pedido_ids) query = query.in('id', pedido_ids);
  const { data, error } = await query;
  return { data: data || [], error };
}

// ── Devoluciones (paso 8, lote 3) ──────────────────────────────────────────
// Cubre `crearDevolucionCore` (alta compartida chofer/admin) y
// `handleDevolucionesAdmin` (panel admin — Innovación #2).

/** cliente_id de un pedido, para resolverlo cuando la devolución no lo trae directo. */
export async function obtenerClienteIdDePedido(empresa_id, pedido_id) {
  const { data } = await db
    .from('pedidos').select('cliente_id').eq('id', pedido_id).eq('empresa_id', empresa_id).single();
  return data;
}

/**
 * Cantidad total comprada históricamente por el cliente, por producto — ver
 * FIX v800 (existencia) y FIX v805 (acá se amplía a cantidad real, ver abajo).
 * Devuelve Map<producto_id, cantidad_total_comprada>.
 */
export async function obtenerComprasPorProductoCliente(empresa_id, cliente_id) {
  const { data } = await db
    .from('pedido_items')
    .select('producto_id, cantidad, pedidos!inner(cliente_id, empresa_id)')
    .eq('pedidos.cliente_id', cliente_id)
    .eq('pedidos.empresa_id', empresa_id);
  const mapa = new Map();
  for (const r of (data || [])) {
    mapa.set(r.producto_id, (mapa.get(r.producto_id) || 0) + (+r.cantidad || 0));
  }
  return mapa;
}

/**
 * FIX v805: cantidad ya "reservada" en devoluciones no rechazadas (pendiente
 * o aprobada) del mismo cliente/producto — se descuenta del total comprado
 * para calcular cuánto le queda disponible para devolver. Sin esto, nada
 * impedía registrar la devolución del mismo producto una y otra vez hasta
 * agotar (o superar) el histórico de compras.
 * Devuelve Map<producto_id, cantidad_ya_reservada>.
 */
export async function obtenerDevueltoPorProductoCliente(empresa_id, cliente_id) {
  const { data } = await db
    .from('devolucion_items')
    .select('producto_id, cantidad, devoluciones!inner(cliente_id, empresa_id, estado)')
    .eq('devoluciones.cliente_id', cliente_id)
    .eq('devoluciones.empresa_id', empresa_id)
    .in('devoluciones.estado', ['pendiente', 'aprobada']);
  const mapa = new Map();
  for (const r of (data || [])) {
    mapa.set(r.producto_id, (mapa.get(r.producto_id) || 0) + (+r.cantidad || 0));
  }
  return mapa;
}

/**
 * FIX v805: ítems de un pedido puntual (producto_id, cantidad, precio_unitario
 * real facturado), para cuando la devolución viene vinculada a un pedido_id
 * específico. Antes nada chequeaba que el producto que se devuelve
 * perteneciera a ESE pedido — se podía vincular cualquier pedido del cliente
 * a una devolución de un producto que nunca estuvo en él.
 * Devuelve Map<producto_id, { cantidad, precio_unitario }>.
 */
export async function obtenerItemsDePedido(empresa_id, pedido_id) {
  const { data } = await db
    .from('pedido_items')
    .select('producto_id, cantidad, precio_unitario, pedidos!inner(empresa_id)')
    .eq('pedido_id', pedido_id)
    .eq('pedidos.empresa_id', empresa_id);
  const mapa = new Map();
  for (const r of (data || [])) {
    mapa.set(r.producto_id, { cantidad: +r.cantidad || 0, precio_unitario: +r.precio_unitario || 0 });
  }
  return mapa;
}

/**
 * FIX v805: precio_base actual del producto — fallback para calcular el
 * precio_unitario de la devolución server-side cuando no hay pedido_id
 * vinculado (alta manual sin pedido de referencia). Nunca se usa el
 * precio_unitario que manda el cliente en el body sin cruzarlo contra esto
 * o contra el pedido real (ver crearDevolucionCore).
 */
export async function obtenerPreciosBaseProductos(empresa_id, productoIds) {
  const { data } = await db
    .from('productos').select('id, precio_base')
    .eq('empresa_id', empresa_id).in('id', productoIds);
  const mapa = new Map();
  for (const r of (data || [])) mapa.set(r.id, +r.precio_base || 0);
  return mapa;
}

/** Inserta la devolución y devuelve la fila creada. */
export async function crearDevolucion(payload) {
  const { data, error } = await db.from('devoluciones').insert(payload).select().single();
  return { data, error };
}

/**
 * Migración 570 (Etapa 7, Bloque 1 — Devoluciones): reemplaza la validación
 * de "cantidad disponible para devolver" (que antes se hacía en 2 SELECTs
 * sueltos vía PostgREST, sin lock ni transacción — ver `obtenerComprasPorProductoCliente`
 * y `obtenerDevueltoPorProductoCliente`, ahora sin uso en `crearDevolucionCore`)
 * por una única RPC transaccional. La RPC serializa altas concurrentes del
 * mismo cliente con un advisory lock, cerrando la condición de carrera: dos
 * altas simultáneas del mismo cliente+producto (chofer + admin, o admin +
 * asistente de WhatsApp) ya no pueden leer el mismo "disponible" antes de
 * que la primera confirme. De paso, un fallo insertando los ítems revierte
 * la cabecera solo (ya no hace falta la "compensación" manual de antes).
 */
export async function crearDevolucionValidadaRpc(payload) {
  const { data, error } = await db.rpc('rpc_crear_devolucion_validada', payload);
  return { data, error };
}

/**
 * Fast path de idempotencia offline (Plan offline, Etapa 3) — ver
 * migración 441. Mismo criterio que `buscarEntregaPorOfflineLocalId`, pero
 * acá el reintento es más barato de detectar porque no hay chequeo de
 * estado previo que lo bloquee antes de llegar a `crearDevolucionCore`.
 *
 * Punto 5 (auditoría pre-lanzamiento 2026): mismo fix que
 * `buscarEntregaPorOfflineLocalId` — el lookup se acota por `empresa_id`.
 */
export async function buscarDevolucionPorOfflineLocalId(empresa_id, offline_local_id) {
  const { data } = await db
    .from('devoluciones')
    .select('id, pedido_id, cliente_id, chofer_id, motivo, notas, estado, foto_url, created_at')
    .eq('empresa_id', empresa_id)
    .eq('offline_local_id', offline_local_id)
    .maybeSingle();
  return data;
}

/** Inserta los ítems de la devolución. */
export async function insertarItemsDevolucion(items) {
  const { error } = await db.from('devolucion_items').insert(items);
  return { error };
}

/** Nota de débito automática a un proveedor (motivo producto_defectuoso), una por proveedor agrupado. */
export async function crearNotaDebitoProveedor(payload) {
  const { data } = await db.from('notas_debito_proveedor').insert(payload).select().single();
  return data;
}

/**
 * Recalcula el score del cliente — best-effort, fire-and-forget (el caller
 * encadena `.then()/.catch()` sin bloquear la respuesta, mismo criterio que
 * el original).
 */
export function calcularScoreClienteRpc(payload) {
  return db.rpc('calcular_score_cliente', payload);
}

/** Perfil mínimo para el gate de permisos del panel admin de devoluciones. Mismo shape que `obtenerPerfilParaRemitoNro`. */
export async function obtenerPerfilParaDevolucionesAdmin(usuario_id) {
  const { data } = await db.from('usuarios').select('empresa_id, rol').eq('id', usuario_id).single();
  return data;
}

/** Actualiza las notas de una devolución (editable en cualquier momento, no solo al revisar). */
export async function actualizarNotasDevolucion(empresa_id, id, notas) {
  const { data, error } = await db
    .from('devoluciones')
    .update({ notas: notas || null })
    .eq('id', id).eq('empresa_id', empresa_id)
    .select()
    .single();
  return { data, error };
}

/** Devolución mínima para validar el borrado (solo se puede borrar si sigue 'pendiente'). */
export async function obtenerDevolucionParaEliminar(empresa_id, id) {
  const { data } = await db
    .from('devoluciones').select('id, estado').eq('id', id).eq('empresa_id', empresa_id).single();
  return data;
}

/**
 * Anula las notas de débito vinculadas a una devolución — usado tanto al
 * eliminarla (quedarían huérfanas) como al rechazarla (el producto no
 * resultó defectuoso según revisión admin).
 */
export async function anularNotasDebitoDeDevolucion(devolucion_id) {
  const { error } = await db
    .from('notas_debito_proveedor').update({ estado: 'anulada' })
    .eq('devolucion_id', devolucion_id).neq('estado', 'anulada');
  return { error };
}

/** Borra la devolución (devolucion_items cae en cascada, ver 006_logistica.sql). */
export async function eliminarDevolucion(empresa_id, id) {
  const { error } = await db.from('devoluciones').delete().eq('id', id).eq('empresa_id', empresa_id);
  return { error };
}

/** Detalle completo de una devolución (items + cliente), para el panel admin. */
export async function obtenerDevolucionDetalle(empresa_id, id) {
  const { data, error } = await db
    .from('devoluciones')
    .select(`
      id, pedido_id, cliente_id, chofer_id, motivo, notas, estado, foto_url, created_at,
      clientes(razon_social, nombre_fantasia),
      devolucion_items(id, producto_id, cantidad, precio_unitario, productos(nombre, codigo))
    `)
    .eq('id', id).eq('empresa_id', empresa_id).single();
  return { data, error };
}

/** Notas de débito asociadas a una devolución, para completar el detalle. */
export async function listarNotasDebitoDeDevolucion(devolucion_id) {
  const { data } = await db
    .from('notas_debito_proveedor')
    .select('id, proveedor_id, monto, estado, motivo, created_at, proveedores(razon_social)')
    .eq('devolucion_id', devolucion_id);
  return data || [];
}

/** Conteo de devoluciones por estado, para los KPIs del panel (independiente del filtro/página). */
export async function contarDevolucionesPorEstado(empresa_id, estado) {
  const { count } = await db
    .from('devoluciones')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .eq('estado', estado);
  return count || 0;
}

/** Listado paginado y filtrado de devoluciones para el panel admin. */
export async function listarDevolucionesFiltradas({
  empresa_id, estado, motivo, busqueda, fecha_desde, fecha_hasta, desde, hasta, pedido_id,
}) {
  let q = db
    .from('devoluciones')
    .select(`
      id, pedido_id, cliente_id, motivo, estado, notas, foto_url, created_at,
      clientes!inner(razon_social, nombre_fantasia)
    `, { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });

  if (estado) q = q.eq('estado', estado);
  if (motivo) q = q.eq('motivo', motivo);
  if (fecha_desde) q = q.gte('created_at', fecha_desde);
  if (fecha_hasta) q = q.lte('created_at', fecha_hasta + 'T23:59:59');
  // v808: filtro directo por pedido_id — usado desde el chip "Con devolución"
  // en /admin/pedidos para saltar directo a la devolución del pedido, sin
  // que el admin tenga que cruzar el id manualmente.
  if (pedido_id) q = q.eq('pedido_id', pedido_id);
  if (busqueda) {
    q = q.or(`razon_social.ilike.%${busqueda}%,nombre_fantasia.ilike.%${busqueda}%`, { foreignTable: 'clientes' });
  }
  q = q.range(desde, hasta);

  const { data, error, count } = await q;
  return { data: data || [], error, count: count ?? 0 };
}

/** Cambia el estado de una devolución (aprobar/rechazar) y devuelve la fila actualizada. */
export async function actualizarEstadoDevolucion(empresa_id, id, estado) {
  // FIX v804: el UPDATE ahora exige `estado = 'pendiente'` como condición.
  // Antes pisaba el estado sin importar el valor actual, así que un reintento
  // sobre una devolución YA revisada (típicamente el front reintentando tras
  // un 500, ver v803) volvía a pasar por acá y el handler seguía de largo
  // reponiendo stock y generando nota de crédito por segunda/tercera vez
  // (bug real, corregido en Supabase el 2026-08-17: se duplicaron 4
  // movimientos_stock y 4 notas_credito por 3 devoluciones antes de este fix).
  // Con la condición, si ya estaba revisada no matchea ninguna fila y
  // `.maybeSingle()` devuelve data=null en vez de tirar error — el handler
  // usa eso para cortar y avisar "ya fue revisada" sin reprocesar nada.
  const { data, error } = await db
    .from('devoluciones')
    .update({ estado })
    .eq('id', id).eq('empresa_id', empresa_id).eq('estado', 'pendiente')
    .select()
    .maybeSingle();
  return { data, error };
}

/**
 * Ítems de una devolución a reponer en stock. Los ya repuestos se excluyen
 * para que un reintento no duplique el ingreso; `items_reponer` acota una
 * selección parcial enviada por el administrador.
 */
export async function listarItemsDevolucionParaReponer(devolucion_id, items_reponer = null) {
  let query = db
    .from('devolucion_items')
    .select('id, producto_id, cantidad, reposicion_at, reposicion_error')
    .eq('devolucion_id', devolucion_id)
    .is('reposicion_at', null);
  if (Array.isArray(items_reponer) && items_reponer.length) query = query.in('id', items_reponer);
  const { data } = await query;
  return data || [];
}

export async function marcarItemDevolucionRepuesto(item_id, deposito_id) {
  const { error } = await db
    .from('devolucion_items')
    .update({ reposicion_at: new Date().toISOString(), reposicion_error: null, reposicion_deposito_id: deposito_id })
    .eq('id', item_id)
    .is('reposicion_at', null);
  return { error };
}

export async function marcarItemDevolucionError(item_id, mensaje) {
  const { error } = await db
    .from('devolucion_items')
    .update({ reposicion_error: mensaje })
    .eq('id', item_id)
    .is('reposicion_at', null);
  return { error };
}

/** Depósito puntual de la empresa, elegido explícitamente por el admin al reponer stock. */
export async function obtenerDepositoPorId(empresa_id, deposito_id) {
  const { data } = await db
    .from('depositos').select('id').eq('id', deposito_id).eq('empresa_id', empresa_id).maybeSingle();
  return data;
}

/** Depósito principal de la empresa — fallback si el admin no eligió ninguno. */
export async function obtenerDepositoPrincipal(empresa_id) {
  const { data } = await db
    .from('depositos').select('id').eq('empresa_id', empresa_id).eq('es_principal', true).maybeSingle();
  return data;
}

/** RPC que ajusta stock (ingreso/egreso) con movimiento auditado. */
export async function ajustarStockRpc(payload) {
  const { data, error } = await db.rpc('ajustar_stock', payload);
  return { data, error };
}

/** Ítems de una devolución con el nombre del producto, para armar la nota de crédito. */
export async function listarItemsDevolucionConProducto(devolucion_id) {
  const { data } = await db
    .from('devolucion_items')
    .select('producto_id, cantidad, precio_unitario, productos(nombre)')
    .eq('devolucion_id', devolucion_id);
  return data || [];
}

/** Condición de IVA del cliente, para elegir el tipo de nota de crédito (A/B). */
export async function obtenerClienteCondicionIva(cliente_id) {
  const { data } = await db.from('clientes').select('condicion_iva').eq('id', cliente_id).single();
  return data;
}

/** Factura vigente más reciente de un pedido, para vincular la nota de crédito. */
export async function obtenerFacturaRecienteDePedido(pedido_id) {
  const { data } = await db
    .from('facturas').select('id')
    .eq('pedido_id', pedido_id)
    .in('estado', ['emitida', 'parcial'])
    .order('fecha_emision', { ascending: false })
    .limit(1).maybeSingle();
  return data;
}

/** RPC que emite la nota de crédito pendiente (misma que usa el panel de Notas de Crédito). */
export async function crearNotaCreditoRpc(payload) {
  const { data, error } = await db.rpc('crear_nota_credito', payload);
  return { data, error };
}

// ── Notificaciones y puntos (paso 8, lote 4 — sub-lote 1) ─────────────────
// Cubre `sincronizarEstadoRuta`, `notificarEstado`, `notificarDespachoPorEmail`,
// `_logNotif`, `notificarPedidoConfirmado`, `acreditarPuntos` y
// `notificarPushAdmin`. Deja afuera de este sub-lote `crearPedidoParaCliente`
// y `confirmarPedidoHandler` (reserva de stock con rollback) para el lote
// siguiente, por ser el núcleo compartido por 9 handlers.

/** Estado actual de una ruta, para decidir si `sincronizarEstadoRuta` debe tocarla. */
export async function obtenerEstadoRuta(ruta_id) {
  const { data } = await db.from('rutas').select('estado').eq('id', ruta_id).single();
  return data;
}

/** Estados de las entregas de una ruta, para calcular si ya está completa/en camino. */
export async function listarEstadosEntregasDeRuta(ruta_id) {
  const { data } = await db.from('entregas').select('estado').eq('ruta_id', ruta_id);
  return data;
}

/** Actualiza `rutas.estado` — fire-and-forget, mismo criterio que el original (sin chequear error). */
export async function actualizarEstadoRuta(ruta_id, estado) {
  const { error } = await db.from('rutas').update({ estado }).eq('id', ruta_id);
  return { error };
}

/** Teléfono/razón social del cliente, para el WhatsApp de "pedido despachado". */
export async function obtenerClienteTelefonoRazonSocial(cliente_id) {
  const { data } = await db.from('clientes').select('telefono, razon_social').eq('id', cliente_id).single();
  return data;
}

/** Cliente con email, para el aviso de despacho por correo. */
export async function obtenerClienteParaEmailDespacho(cliente_id) {
  const { data } = await db.from('clientes').select('id, email, razon_social').eq('id', cliente_id).single();
  return data;
}

/** Datos de contacto de la empresa — reusada por el email de despacho y el de confirmación de pedido. */
export async function obtenerEmpresaContacto(empresa_id) {
  const { data } = await db.from('empresas').select('id, nombre, email').eq('id', empresa_id).single();
  return data;
}

/** Inserta una fila de auditoría de notificación (WhatsApp/email/push, éxito o falla). */
export async function insertarNotifLog(payload) {
  const { error } = await db.from('notif_log').insert(payload);
  return { error };
}

/** Pedido mínimo (id + total) — reusada por `notificarPedidoConfirmado` y `notificarPushAdmin`. */
export async function obtenerPedidoNumeroYTotal(pedido_id) {
  const { data } = await db.from('pedidos').select('id, total').eq('id', pedido_id).single();
  return data;
}

/** Pedido completo con ítems, para armar el email de confirmación. */
export async function obtenerPedidoCompletoParaEmailConfirmacion(pedido_id) {
  const { data } = await db
    .from('pedidos')
    // FIX: pedidos.numero no existe — se omite de SELECT
    .select('id, total, subtotal, iva_total, fecha_entrega, notas_cliente, pedido_items(cantidad, precio_unitario, descuento_pct, productos(nombre))')
    .eq('id', pedido_id)
    .single();
  return data;
}

/** Cliente con email, para el email de confirmación de pedido. */
export async function obtenerClienteEmailRazonSocial(cliente_id) {
  const { data } = await db.from('clientes').select('email, razon_social').eq('id', cliente_id).single();
  return data;
}

/** Programa de fidelización activo de la empresa, si tiene uno configurado. */
export async function obtenerProgramaFidelizacionActivo(empresa_id) {
  const { data } = await db
    .from('programas_fidelizacion')
    .select('id, puntos_por_peso, bonus_pct_categoria')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .single();
  return data;
}

/** Total del pedido, para calcular los puntos a acreditar. */
export async function obtenerPedidoTotal(pedido_id) {
  const { data } = await db.from('pedidos').select('total').eq('id', pedido_id).single();
  return data;
}

/** Categoría de score del cliente, para el bonus por comportamiento de pago. */
export async function obtenerClienteScoreCategoria(cliente_id) {
  const { data } = await db.from('clientes').select('score_categoria').eq('id', cliente_id).single();
  return data;
}

/** RPC que acredita puntos de forma atómica (camino principal). */
export async function registrarMovimientoPuntosRpc(payload) {
  const { error } = await db.rpc('registrar_movimiento_puntos', payload);
  return { error };
}

/** Insert manual a movimientos_puntos — solo como fallback si el RPC principal falla. */
export async function insertarMovimientoPuntosFallback(payload) {
  const { error } = await db.from('movimientos_puntos').insert(payload);
  return { error };
}

/** RPC que suma (no pisa) el saldo de puntos — fallback atómico si el RPC principal falla. */
export async function sumarSaldoPuntosFallbackRpc(payload) {
  const { error } = await db.rpc('sumar_saldo_puntos_fallback', payload);
  return { error };
}

// ── Router principal: GET/PATCH/DELETE de /api/pedidos (paso 8, lote 4 — sub-lote 2) ──
// Cubre el `handler` exportado por defecto (GET detalle/lista, PATCH estado,
// DELETE eliminar/cancelar). Deja para el sub-lote siguiente
// `crearPedidoParaCliente`/`confirmarPedidoHandler` (alta de pedido con
// reserva de stock desde cero) y los handlers de "pedido sugerido".

/** Perfil del usuario logueado para el router principal — shape propio (incluye `cliente_id`, no `nombre`). */
export async function obtenerPerfilParaPedidos(usuario_id) {
  const { data } = await db
    .from('usuarios')
    .select('empresa_id, rol, cliente_id')
    .eq('id', usuario_id)
    .single();
  return data;
}

/** Detalle completo de un pedido (GET ?id=), con cliente/vendedor/items. */
export async function obtenerPedidoDetalleConItems(empresa_id, id) {
  const { data, error } = await db
    .from('pedidos')
    .select(`
      *,
      clientes(id, razon_social, nombre_fantasia, telefono, domicilio, email),
      usuarios!vendedor_id(nombre),
      pedido_items(*, productos(nombre, codigo, unidad))
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * v808: devoluciones vinculadas a un `pedido_id` puntual, para mostrar en
 * el detalle del pedido en /admin/pedidos (antes no había ningún indicador
 * de que un pedido entregado tuviera una devolución asociada — había que
 * ir a /admin/devoluciones y cruzar manualmente el pedido_id).
 */
export async function listarDevolucionesDePedido(empresa_id, pedido_id) {
  const { data } = await db
    .from('devoluciones')
    .select('id, estado, motivo, created_at')
    .eq('empresa_id', empresa_id)
    .eq('pedido_id', pedido_id)
    .order('created_at', { ascending: false });
  return data || [];
}

/**
 * v808: mismo indicador que `listarDevolucionesDePedido`, pero en batch
 * para una página completa de la lista de pedidos (un solo round-trip en
 * vez de N). Devuelve Map<pedido_id, estado> quedándose con la devolución
 * más reciente por pedido (si hay varias) — alcanza para pintar el chip
 * en la tabla; el detalle completo se ve en el modal del pedido.
 */
export async function obtenerEstadoDevolucionPorPedidos(empresa_id, pedidoIds) {
  const mapa = new Map();
  if (!pedidoIds?.length) return mapa;
  const { data } = await db
    .from('devoluciones')
    .select('pedido_id, estado, created_at')
    .eq('empresa_id', empresa_id)
    .in('pedido_id', pedidoIds)
    .order('created_at', { ascending: false });
  for (const r of (data || [])) {
    if (!mapa.has(r.pedido_id)) mapa.set(r.pedido_id, r.estado);
  }
  return mapa;
}


/** Resuelve el cliente_id del usuario logueado por email (fallback legacy cuando no hay `perfil.cliente_id`). */
export async function resolverClienteIdPorEmail(empresa_id, email) {
  const { data } = await db
    .from('clientes').select('id').eq('email', email).eq('empresa_id', empresa_id).maybeSingle();
  return data;
}

/** Lista paginada de pedidos (GET sin ?id=) con los mismos filtros dinámicos que el handler original. */
export async function listarPedidosFiltrados({
  empresa_id, esAdmin, cliId,
  estado, cliente_id, vendedor_id, zona_id, fecha_desde, fecha_hasta,
  sin_facturar, sin_despachar, page, limit,
}) {
  let query = db
    .from('pedidos')
    .select(`
      id, estado, total, subtotal, iva_total, fecha_pedido, fecha_entrega,
      factura_id, fecha_despacho,
      clientes(razon_social, nombre_fantasia),
      usuarios!vendedor_id(nombre)
    `, { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .order('fecha_pedido', { ascending: false })
    .range((+page - 1) * +limit, +page * +limit - 1);

  if (estado)     query = query.eq('estado', estado);
  if (cliente_id && esAdmin) query = query.eq('cliente_id', cliente_id);
  if (vendedor_id && esAdmin) query = query.eq('vendedor_id', vendedor_id);
  if (zona_id && esAdmin) query = query.eq('zona_id', zona_id);
  if (fecha_desde) query = query.gte('fecha_entrega', fecha_desde);
  if (fecha_hasta) query = query.lte('fecha_entrega', fecha_hasta);
  if (sin_facturar === '1' && esAdmin) query = query.is('factura_id', null).neq('estado', 'cancelado');
  if (sin_despachar === '1' && esAdmin) query = query.is('fecha_despacho', null).in('estado', ['confirmado', 'preparando']);

  if (!esAdmin && cliId) query = query.eq('cliente_id', cliId);

  const { data, error, count } = await query;
  return { data, error, count };
}

/** Actualiza estado/notas_internas/fecha_despacho de un pedido (PATCH admin) y devuelve la fila. */
export async function actualizarEstadoPedido(empresa_id, id, updates) {
  const { data, error } = await db
    .from('pedidos')
    .update(updates)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();
  return { data, error };
}

/** Estado actual de un pedido (id + estado), para validar antes de eliminar/cancelar. */
export async function obtenerPedidoIdEstado(empresa_id, id) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, estado')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

/** Todas las facturas vinculadas a un pedido, sin filtrar por estado (DELETE eliminar). */
export async function listarFacturasDePedido(pedido_id) {
  const { data } = await db
    .from('facturas')
    .select('id, estado')
    .eq('pedido_id', pedido_id);
  return data;
}

/** Borra las facturas huérfanas (sin CAE) vinculadas a un pedido, antes de borrar el pedido. */
export async function eliminarFacturasDePedido(pedido_id) {
  await db.from('facturas').delete().eq('pedido_id', pedido_id);
}

/** Borra las entregas (tracking logístico) vinculadas a un pedido, antes de borrarlo. */
export async function eliminarEntregasDePedido(pedido_id) {
  await db.from('entregas').delete().eq('pedido_id', pedido_id);
}

/** Borrado físico del pedido (DELETE ?accion=eliminar). */
export async function eliminarPedidoPorId(empresa_id, id) {
  const { error } = await db
    .from('pedidos')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  return { error };
}

/** Ítems del pedido a cancelar, para recorrerlos y liberar stock reservado uno por uno. */
export async function listarItemsPedidoParaCancelar(pedido_id) {
  const { data } = await db
    .from('pedido_items')
    .select('producto_id, cantidad')
    .eq('pedido_id', pedido_id);
  return data;
}

/** Depósito real donde se registró la reserva original, si existe. */
export async function obtenerDepositoRealReserva(empresa_id, pedido_id, producto_id) {
  const { data } = await db
    .from('movimientos_stock')
    .select('deposito_id, created_at')
    .eq('empresa_id', empresa_id)
    .eq('referencia_id', pedido_id)
    .eq('producto_id', producto_id)
    .eq('tipo', 'reserva')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.deposito_id || null;
}

/** Stock del producto por depósito (con flag de depósito principal), para elegir dónde liberar la reserva. */
export async function listarStockParaLiberarReserva(empresa_id, producto_id) {
  const { data } = await db
    .from('stock')
    .select('deposito_id, cantidad, cantidad_reservada, depositos!inner(es_principal, empresa_id)')
    .eq('producto_id', producto_id)
    .eq('depositos.empresa_id', empresa_id);
  return data;
}

/** Marca el pedido como cancelado y devuelve el error para no responder éxito falso. */
export async function marcarPedidoCancelado(empresa_id, id, motivo = null) {
  const { error } = await db.from('pedidos')
    .update({ estado: 'cancelado', ...(motivo ? { notas_internas: motivo } : {}) })
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  return { error };
}

/** RPC que revierte los puntos de fidelización ya acreditados por un pedido cancelado. */
export async function revertirPuntosPedidoCanceladoRpc(payload) {
  const { error } = await db.rpc('revertir_puntos_pedido_cancelado', payload);
  return { error };
}

/** Facturas pendientes/emitidas vinculadas a un pedido cancelado, para anularlas o emitir NC. */
export async function listarFacturasVinculadasParaCancelar(pedido_id) {
  const { data } = await db
    .from('facturas')
    .select('id, estado')
    .eq('pedido_id', pedido_id)
    .in('estado', ['pendiente', 'emitida']);
  return data;
}

/** Anula una factura sin CAE (estado 'pendiente') al cancelar su pedido. */
export async function anularFacturaPendiente(id) {
  const { error } = await db
    .from('facturas')
    .update({ estado: 'anulada' })
    .eq('id', id)
    .eq('estado', 'pendiente');
  return { error };
}

// ── Alta de pedido: pedido sugerido, crear/confirmar pedido (lote 4, sub-lote 3) ──
// Último bloque del paso 8: verPedidoSugeridoHandler, confirmarPedidoSugeridoHandler,
// crearPedidoParaCliente (+ crearPedidoAdminHandler) y confirmarPedidoHandler.
// `crearPedidoClienteRpc`, `resolverPreciosClienteRpc` y `obtenerNumeroPedido` se
// reusan desde lib/repos/whatsapp-bot.js (mismas RPC/query, ya reexportadas arriba)
// en vez de duplicarlas — mismo criterio que el resto del archivo.

/** Detalle del pedido sugerido para el link público de WhatsApp (sin login). */
export async function obtenerPedidoSugeridoDetalle(pedido_id) {
  const { data, error } = await db
    .from('pedidos')
    .select(`
      id, estado, total, fecha_pedido, numero_pedido, empresa_id,
      generado_automatico,
      clientes ( razon_social, nombre_fantasia ),
      pedido_items (
        cantidad, precio_unitario,
        productos ( nombre, unidad )
      )
    `)
    .eq('id', pedido_id)
    .maybeSingle();
  return { data, error };
}

/** Pedido sugerido a confirmar — solo lo mínimo para resolver empresa_id/cliente_id desde el propio pedido (service_role, nunca del body). */
export async function obtenerPedidoParaConfirmarSugerido(pedido_id) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, empresa_id, cliente_id, estado')
    .eq('id', pedido_id)
    .maybeSingle();
  return { data, error };
}

/**
 * Pedido resuelto para el link público de pago (checkout.html, sin login).
 * Etapa 5 offline (Mercado Pago) — Hallazgo: el botón "Pagar online" ya
 * existe en /cliente/pedidos.html pero exige sesión; el link público de
 * WhatsApp (pedido "sugerido") no tenía ningún equivalente. Se agrega
 * `generado_automatico` acá (no en obtenerPedidoParaPago, que es para el
 * flujo autenticado) porque es el campo que separa "pedido generado por el
 * piloto automático de WhatsApp" de cualquier otro — lo pone
 * exclusivamente `generar_pedido_sugerido_cliente()` al crear el pedido,
 * ningún alta manual del admin lo setea. (`canal` se probó como filtro
 * extra y se descartó: tiene DEFAULT 'web' en la DB, así que un pedido del
 * bot recién creado también sale con canal='web' — no discrimina nada
 * antes de la confirmación.) Es el único dato que blindea este endpoint
 * sin auth: no alcanza con conocer el UUID de CUALQUIER pedido, tiene que
 * ser uno que efectivamente salió por ese canal (ver guard en
 * crearPreferenciaPublicaHandler, lib/handlers/pagos.js).
 */
export async function obtenerPedidoParaPagoPublico(pedido_id) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, empresa_id, cliente_id, total, estado, generado_automatico, clientes(email)')
    .eq('id', pedido_id)
    .maybeSingle();
  return { data, error };
}

/** RPC que confirma un pedido sugerido (link público de WhatsApp). */
export async function confirmarPedidoSugeridoRpc(payload) {
  const { data, error } = await db.rpc('confirmar_pedido_sugerido', payload);
  return { data, error };
}

/** Cliente a validar antes de armar el pedido (existe, activo, de esta empresa) — crearPedidoParaCliente. */
export async function obtenerClienteParaPedido(empresa_id, cliente_id) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, limite_credito, saldo_deuda, activo, telefono, deposito_id')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

/** Stock por producto (con depósito principal), para validar disponibilidad al crear/confirmar un pedido. */
export async function listarStockParaValidarPedido(producto_ids) {
  const { data } = await db
    .from('stock')
    .select('producto_id, cantidad, cantidad_reservada, depositos(es_principal, id)')
    .in('producto_id', producto_ids);
  return data;
}

/** Perfil del admin/vendedor que crea el pedido desde el modal admin. */
export async function obtenerPerfilParaCrearPedidoAdmin(user_id) {
  const { data } = await db
    .from('usuarios')
    .select('id, empresa_id, rol')
    .eq('id', user_id)
    .single();
  return data;
}

/** Usuario que confirma su propio pedido desde el portal cliente. */
export async function obtenerUsuarioParaConfirmarPedido(user_id) {
  const { data, error } = await db
    .from('usuarios')
    .select('id, empresa_id, rol, email, cliente_id')
    .eq('id', user_id)
    .single();
  return { data, error };
}

/** Cliente asociado a la cuenta del portal, resuelto por cliente_id (usuarios nuevos). */
export async function obtenerClientePorIdParaConfirmar(empresa_id, cliente_id) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, telefono, limite_credito, dias_credito, activo, saldo_deuda, deposito_id')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

/** Cliente asociado a la cuenta del portal, resuelto por email (usuarios legacy sin cliente_id). */
export async function obtenerClientePorEmailParaConfirmar(empresa_id, email) {
  const { data, error } = await db
    .from('clientes')
    .select('id, razon_social, telefono, limite_credito, dias_credito, activo, saldo_deuda, deposito_id')
    .eq('empresa_id', empresa_id)
    .eq('email', email)
    .maybeSingle();
  return { data, error };
}

/** Vacía el carrito del cliente tras confirmar el pedido (fire-and-forget, mismo criterio del handler original). */
export async function vaciarCarritoCliente(cliente_id) {
  return db.from('carrito_items')
    .delete()
    .eq('cliente_id', cliente_id);
}
