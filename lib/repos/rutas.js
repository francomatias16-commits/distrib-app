// lib/repos/rutas.js
// Capa de acceso a datos para `rutas` / `entregas` en vivo (tracking GPS,
// re-optimización, reportes de eficiencia) y las vistas de rentabilidad
// (zona/ruta, producto, vendedor). Migrado desde `lib/handlers/rutas-live.js`.
//
// NOTA: `rutas`/`entregas` también se acceden desde `lib/repos/pedidos.js`
// (armado de remitos, marcar entrega completada/no realizada) — ese repo es
// el dueño de las consultas del flujo de despacho/chofer. Este archivo cubre
// específicamente lo que necesita el tracking en vivo (rutas-live), que son
// queries distintas (columnas y filtros propios), no se unificaron para no
// alterar el contrato de cada una. `admin.js` y `automatizacion.js` también
// tocan `rutas` directo — quedan pendientes para cuando se migren esos
// handlers (ver FASE7_PLAN_ARRANQUE.md).

import { db } from './_db.js';

// ── Vistas de rentabilidad ───────────────────────────────────────────────

/**
 * v_rentabilidad_zona_ruta (069) — SIN security_invoker/RLS propio, el
 * filtro por empresa_id se hace siempre acá. Se reusa tanto para el GET
 * (?accion=rentabilidad-zona, con orden descendente) como para el cron
 * semanal (que siempre pasa desde/hasta) — el `.order()` es inocuo para el
 * cron porque solo suma filas en un Map, no depende del orden de llegada.
 */
export async function listarRentabilidadZonaRuta(empresa_id, { desde, hasta, zona_id } = {}) {
  let q = db.from('v_rentabilidad_zona_ruta')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('ruta_fecha', { ascending: false });

  if (desde)   q = q.gte('ruta_fecha', desde);
  if (hasta)   q = q.lte('ruta_fecha', hasta);
  if (zona_id) q = q.eq('zona_id', zona_id);

  const { data, error } = await q;
  return { data, error };
}

/** v_rentabilidad_producto (246) — mismo patrón de seguridad que la de zona/ruta. */
export async function listarRentabilidadProducto(empresa_id, { desde, hasta, producto_id, categoria_id } = {}) {
  let q = db.from('v_rentabilidad_producto')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('fecha', { ascending: false });

  if (desde)        q = q.gte('fecha', desde);
  if (hasta)        q = q.lte('fecha', hasta);
  if (producto_id)  q = q.eq('producto_id', producto_id);
  if (categoria_id) q = q.eq('categoria_id', categoria_id);

  const { data, error } = await q;
  return { data, error };
}

/** v_rentabilidad_vendedor (246) — mismo patrón de seguridad. */
export async function listarRentabilidadVendedor(empresa_id, { desde, hasta, vendedor_id } = {}) {
  let q = db.from('v_rentabilidad_vendedor')
    .select('*')
    .eq('empresa_id', empresa_id)
    .order('fecha', { ascending: false });

  if (desde)      q = q.gte('fecha', desde);
  if (hasta)      q = q.lte('fecha', hasta);
  if (vendedor_id) q = q.eq('vendedor_id', vendedor_id);

  const { data, error } = await q;
  return { data, error };
}

// ── Tracking en vivo (chofer) ────────────────────────────────────────────

/** Actualiza la posición GPS del chofer, acotado a la ruta que le pertenece. */
export async function actualizarPosicionChofer(ruta_id, chofer_id, { lat, lng }) {
  const { data, error } = await db.from('rutas').update({
    chofer_lat: lat,
    chofer_lng: lng,
    chofer_actualizado: new Date(),
  }).eq('id', ruta_id).eq('chofer_id', chofer_id)
    .select('id, empresa_id')
    .single();
  return { data, error };
}

// ── Re-optimización de ruta ──────────────────────────────────────────────

/** Ruta con posición del chofer, para validar pertenencia y usarla como origen del cálculo. */
export async function obtenerRutaParaReoptimizar(ruta_id) {
  const { data } = await db.from('rutas')
    .select('id, empresa_id, chofer_id, chofer_lat, chofer_lng')
    .eq('id', ruta_id)
    .single();
  return data;
}

/** Entregas pendientes/en camino de la ruta, con el domicilio del cliente para geolocalizar. */
export async function listarEntregasParaReoptimizar(ruta_id) {
  const { data } = await db.from('entregas')
    .select('id, orden, pedidos(clientes(lat, lng, domicilio, localidad))')
    .eq('ruta_id', ruta_id)
    .in('estado', ['pendiente', 'en_camino'])
    .order('orden');
  return data;
}

/** Persiste el nuevo orden de una entrega (llamada en loop, una por parada reordenada). */
export async function actualizarOrdenEntrega(entrega_id, orden) {
  await db.from('entregas').update({ orden }).eq('id', entrega_id);
}

// ── Agregar entrega urgente ──────────────────────────────────────────────

/** Ruta mínima (id + empresa) para validar pertenencia antes de agregar una entrega urgente. */
export async function obtenerRutaIdEmpresa(ruta_id) {
  const { data } = await db.from('rutas').select('id, empresa_id').eq('id', ruta_id).single();
  return data;
}

/** Pedido mínimo (id + empresa) para la misma validación de pertenencia. */
export async function obtenerPedidoIdEmpresa(pedido_id) {
  const { data } = await db.from('pedidos').select('id, empresa_id').eq('id', pedido_id).single();
  return data;
}

/** Entrega activa existente de un pedido — evita asignarlo dos veces a rutas distintas. */
export async function obtenerEntregaActivaParaValidarDuplicado(pedido_id) {
  const { data } = await db.from('entregas')
    .select('id, ruta_id')
    .eq('pedido_id', pedido_id)
    .in('estado', ['pendiente', 'en_camino'])
    .maybeSingle();
  return data;
}

/** Mayor `orden` ya asignado en la ruta, para agregar la nueva entrega al final. */
export async function obtenerMaxOrdenEntrega(ruta_id) {
  const { data } = await db.from('entregas')
    .select('orden')
    .eq('ruta_id', ruta_id)
    .order('orden', { ascending: false })
    .limit(1)
    .single();
  return data;
}

/** Crea la entrega urgente y devuelve la fila insertada. */
export async function crearEntregaUrgente(campos) {
  const { data, error } = await db.from('entregas').insert(campos).select().single();
  return { data, error };
}

// ── Cierre de ruta / reporte de eficiencia ───────────────────────────────

/** Ruta (empresa + chofer) para validar pertenencia/permiso antes de cerrar el reporte. */
export async function obtenerRutaParaCerrarReporte(ruta_id) {
  const { data } = await db.from('rutas').select('empresa_id, chofer_id').eq('id', ruta_id).single();
  return data;
}

/** Entregas de la ruta con los campos que alimentan las métricas del reporte. */
export async function listarEntregasParaReporte(ruta_id) {
  const { data } = await db.from('entregas')
    .select('estado, duracion_minutos, distancia_km')
    .eq('ruta_id', ruta_id);
  return data;
}

/** Upsert del reporte de eficiencia de la ruta (una fila por ruta, `onConflict: ruta_id`). */
export async function upsertReporteRuta(campos) {
  await db.from('reportes_ruta').upsert(campos, { onConflict: 'ruta_id' });
}

// ── Estado de ruta en vivo (panel admin) ─────────────────────────────────

/** Ruta con chofer, entregas y datos del cliente de cada entrega — para el mapa en vivo del admin. */
export async function obtenerRutaEstadoLive(ruta_id, empresa_id) {
  const { data, error } = await db.from('rutas')
    .select(`id, chofer_lat, chofer_lng, chofer_actualizado, estado,
      usuarios!chofer_id(nombre),
      entregas(id, orden, estado, pedidos(clientes(razon_social, domicilio, localidad, lat, lng)))`)
    .eq('id', ruta_id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

// ── Seguimiento en vivo (cliente) ────────────────────────────────────────

/** Pedido mínimo para validar existencia/ownership antes de exponer el tracking. */
export async function obtenerPedidoParaSeguimiento(pedido_id) {
  const { data, error } = await db.from('pedidos')
    .select('id, estado, cliente_id, empresa_id')
    .eq('id', pedido_id)
    .single();
  return { data, error };
}

/** Cliente vinculado a un usuario con rol 'cliente' (portal), para el chequeo de ownership. */
export async function obtenerClienteIdDeUsuario(usuario_id) {
  const { data } = await db.from('usuarios').select('clientes(id)').eq('id', usuario_id).single();
  return data;
}

/** Entrega activa (pendiente/en camino) de menor `orden` del pedido — la próxima parada. */
export async function obtenerEntregaActivaParaSeguimiento(pedido_id) {
  const { data } = await db.from('entregas')
    .select('id, estado, orden, ruta_id')
    .eq('pedido_id', pedido_id)
    .in('estado', ['pendiente', 'en_camino'])
    .order('orden', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Posición GPS actual del chofer de una ruta. */
export async function obtenerPosicionChoferDeRuta(ruta_id) {
  const { data } = await db.from('rutas')
    .select('chofer_lat, chofer_lng, chofer_actualizado')
    .eq('id', ruta_id)
    .single();
  return data;
}

/** Entregas pendientes/en camino con `orden` menor a la actual — paradas restantes antes de esta. */
export async function contarEntregasPreviasEnRuta(ruta_id, orden) {
  const { data } = await db.from('entregas')
    .select('id')
    .eq('ruta_id', ruta_id)
    .in('estado', ['pendiente', 'en_camino'])
    .lt('orden', orden);
  return data;
}

// ── Aviso automático de proximidad ("tu pedido está a ~15 min") ─────────

/** Entregas pendientes/en camino de la ruta, ordenadas — para ubicar la próxima parada. */
export async function listarEntregasPendientesOrdenadas(ruta_id) {
  const { data } = await db.from('entregas')
    .select('id, orden, pedido_id, aviso_proximidad_enviado')
    .eq('ruta_id', ruta_id)
    .in('estado', ['pendiente', 'en_camino'])
    .order('orden', { ascending: true });
  return data;
}

/** Marca una entrega puntual como ya avisada, para no repetir el aviso en el próximo ping. */
export async function marcarAvisoProximidadEnviado(entrega_id) {
  await db.from('entregas').update({ aviso_proximidad_enviado: true }).eq('id', entrega_id);
}

// ── Cron semanal de rentabilidad ─────────────────────────────────────────

/**
 * Solo `id` de empresas activas, sin chequeo de error (igual que el
 * original) — distinto de `EmpresaRepo.listarEmpresasActivas`, que hace
 * throw en error; acá el cron no debe caerse entero si esa lectura falla.
 */
export async function listarEmpresasActivasParaCron() {
  const { data } = await db.from('empresas').select('id').eq('activa', true);
  return data;
}
