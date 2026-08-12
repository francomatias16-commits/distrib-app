// lib/repos/admin.js
// Capa de acceso a datos para `lib/handlers/admin.js` (Dashboard del administrador).
//
// Migración de admin.js (936 líneas, ~30 `.from()`/`.rpc()` directos) a la
// capa de repos, mismo criterio que el resto de la Fase 7
// (FASE7_PLAN_ARRANQUE.md): el handler pasa a orquestar (armar respuesta,
// combinar resultados, manejar Promise.allSettled) y este módulo concentra
// las consultas.
//
// Convención de retorno (para no romper el destructuring ya usado en el
// handler): las funciones de "detalle secundario" (listas que el handler ya
// consumía directo como array, sin chequear error) devuelven `data` pelado.
// Las que el handler necesita para decidir un error (`if (error) return
// errorSeguro(...)`) devuelven `{ data, error }` completo. `contarClientesScoreCritico`
// devuelve la respuesta completa de Supabase porque resumen-arranque lee
// tanto `.count` como `.data` de ella (ver uso con Promise.allSettled).

import { db } from './_db.js';

// ── Autenticación / perfil ─────────────────────────────────────────────────

/** Perfil del usuario autenticado (empresa_id, rol, nombre) para `autenticar()`. */
export async function obtenerPerfilAdmin(user_id) {
  const { data } = await db
    .from('usuarios')
    .select('empresa_id, rol, nombre')
    .eq('id', user_id)
    .single();
  return data;
}

// ── KPIs (handleKPIs + handleDashboardEjecutivo) ───────────────────────────

/** Intento principal de KPIs (agrega AFIP, riesgo de cheques y catálogo). */
export async function obtenerKpisDashboardV3Rpc(params) {
  return db.rpc('obtener_kpis_dashboard_v3', params);
}

/** Fallback si `_v3` no existe todavía (migración no corrida). */
export async function obtenerKpisDashboardV2Rpc(params) {
  return db.rpc('obtener_kpis_dashboard_v2', params);
}

/** Último fallback, versión original del RPC. */
export async function obtenerKpisDashboardV1Rpc(params) {
  return db.rpc('obtener_kpis_dashboard', params);
}

/** Resumen consolidado (cobranza + rentabilidad + stock) — Etapa 5, migración 243. */
export async function obtenerDashboardEjecutivoResumenRpc(params) {
  return db.rpc('obtener_dashboard_ejecutivo_resumen', params);
}

/** Serie diaria mes actual vs. mismo tramo del mes anterior — Etapa 5. */
export async function obtenerComparativaMensualRpc(empresa_id) {
  return db.rpc('obtener_comparativa_mensual', { p_empresa_id: empresa_id });
}

// ── Pedidos (handlePedidos) ─────────────────────────────────────────────────

export async function listarPedidosRecientes(empresa_id, limit) {
  return db
    .from('pedidos')
    .select(`
      id, estado, total, created_at,
      clientes(razon_social, nombre_fantasia)
    `)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ── Stock (handleStockBajo + handleResumenArranque) ────────────────────────

/** Ids de depósitos de la empresa — reusado por stock-bajo y resumen-arranque. */
export async function obtenerDepositosIds(empresa_id) {
  const { data } = await db
    .from('depositos')
    .select('id')
    .eq('empresa_id', empresa_id);
  return data;
}

export async function obtenerStockConProductos(depIds) {
  return db
    .from('stock')
    .select(`
      producto_id, cantidad, cantidad_reservada,
      productos(id, nombre, codigo, activo, stock_minimo)
    `)
    .in('deposito_id', depIds);
}

/** Igual que `obtenerStockConProductos` pero con costo_promedio, para valorizar stock. */
export async function obtenerStockValorizado(depIds) {
  const { data } = await db
    .from('stock')
    .select('producto_id, cantidad, cantidad_reservada, costo_promedio, productos(activo, stock_minimo)')
    .in('deposito_id', depIds);
  return data;
}

// ── Resumen de arranque (rutas, bloqueos, score crítico) ───────────────────

export async function obtenerRutasDelDia(empresa_id, hoy) {
  const { data } = await db
    .from('rutas')
    .select('id, estado')
    .eq('empresa_id', empresa_id)
    .eq('fecha', hoy);
  return data;
}

export async function obtenerBloqueosDeudaVencida(empresa_id) {
  const { data } = await db
    .from('bloqueos_cliente')
    .select('deuda_monto')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .eq('motivo', 'deuda_vencida');
  return data;
}

/**
 * FIX (dashboard estados críticos): mismo criterio de score_categoria que
 * usa el Motor 5 de automatizacion.js (getEstadoScore) — evita comparar
 * contra valores 'critico'/'en_riesgo' que calcular_score_cliente() nunca
 * escribe. Devuelve la respuesta completa (el handler lee `.count` y
 * `.data` según si vino de Promise.allSettled).
 */
export async function contarClientesScoreCritico(empresa_id) {
  return db
    .from('clientes')
    .select('id, score_categoria', { count: 'exact' })
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .in('score_categoria', ['riesgo', 'bloqueado']);
}

export async function contarEntregasPorRutas(rutaIds) {
  const { count } = await db
    .from('entregas')
    .select('id', { count: 'exact', head: true })
    .in('ruta_id', rutaIds);
  return count;
}

// ── Ventas diarias (handleVentasDiarias) ────────────────────────────────────

export async function obtenerVentasPedidosPeriodo(empresa_id, desde, hasta) {
  return db
    .from('pedidos')
    .select('total, created_at')
    .eq('empresa_id', empresa_id)
    .in('estado', ['confirmado', 'preparando', 'despachado', 'entregado'])
    .gte('created_at', desde)
    .lte('created_at', hasta)
    .order('created_at', { ascending: true });
}

/** Canal mostrador (POS). 'anulada' se excluye — no es venta real. */
export async function obtenerVentasPosPeriodo(empresa_id, desde, hasta) {
  return db
    .from('ventas_pos')
    .select('total, created_at')
    .eq('empresa_id', empresa_id)
    .eq('estado', 'completada')
    .gte('created_at', desde)
    .lte('created_at', hasta)
    .order('created_at', { ascending: true });
}

// ── Alertas (handleAlertas) ──────────────────────────────────────────────────

export async function obtenerNotificacionesRecientes(empresa_id, limit) {
  const { data } = await db
    .from('notificaciones_push')
    .select('id, tipo, titulo, cuerpo, leida, created_at, datos_json')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data;
}

export async function obtenerPedidosDemorados(empresa_id, desdeISO, limit) {
  const { data } = await db
    .from('pedidos')
    .select('id, created_at')
    .eq('empresa_id', empresa_id)
    .in('estado', ['confirmado', 'preparando'])
    .lt('created_at', desdeISO)
    .limit(limit);
  return data;
}

export async function obtenerSesionesMigracionConError(empresa_id, limit) {
  const { data } = await db
    .from('migracion_sesiones')
    .select('id, entidad, nombre_archivo_original, filas_con_error, created_at')
    .eq('empresa_id', empresa_id)
    .eq('estado', 'completado')
    .gt('filas_con_error', 0)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data;
}

/**
 * Cheques en cartera vencidos sin gestionar. Se filtra/ordena por
 * `fecha_vto` (columna real, NOT NULL, con índice), no por `vencimiento`
 * (alias que solo mantiene sincronizado a mano cheques.js, sin trigger —
 * ver CHANGELOG_v262 para el bug que causó filtrar por la columna
 * equivocada).
 */
export async function obtenerChequesVencidos(empresa_id, hoyISO, limit) {
  const { data } = await db
    .from('cheques')
    .select('id, numero, monto, vencimiento, fecha_vto, cliente_id, clientes(nombre_fantasia, razon_social)')
    .eq('empresa_id', empresa_id)
    .eq('estado', 'en_cartera')
    .lt('fecha_vto', hoyISO)
    .order('fecha_vto', { ascending: true })
    .limit(limit);
  return data;
}

/** Igual filtro que `obtenerChequesVencidos` pero sin límite — para el resumen agregado (cantidad + monto total). */
export async function obtenerResumenChequesVencidos(empresa_id, hoyISO) {
  const { data } = await db
    .from('cheques')
    .select('monto')
    .eq('empresa_id', empresa_id)
    .eq('estado', 'en_cartera')
    .lt('fecha_vto', hoyISO);
  return data;
}

/** Clientes en score crítico (riesgo/bloqueado), en detalle — para el listado de alertas (distinto de `contarClientesScoreCritico`, que solo cuenta). */
export async function obtenerClientesScoreCritico(empresa_id, limit) {
  const { data } = await db
    .from('clientes')
    .select('id, razon_social, nombre_fantasia, score_actual, score_categoria, score_actualizado')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .in('score_categoria', ['riesgo', 'bloqueado'])
    .order('score_actual', { ascending: true })
    .limit(limit);
  return data;
}

/** Facturas de proveedor con diferencias sin resolver contra la OC (mismo criterio que el badge ⚠ Dif. de Cta. Cte. Proveedores). */
export async function obtenerFacturasProveedorConDiferencias(empresa_id, limit) {
  const { data } = await db
    .from('facturas_proveedor')
    .select('id, numero_factura, discrepancias, created_at, proveedores(nombre_fantasia, razon_social)')
    .eq('empresa_id', empresa_id)
    .eq('tiene_diferencias', true)
    .neq('estado', 'anulada')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data;
}

/**
 * Ids de anomalías ya marcadas como resueltas (tabla `anomalias_revisadas`,
 * migración 079, reusada también por auditoria.js). Genérica por
 * `tipo_anomalia` porque se usa igual para 'diferencia_caja' y
 * 'entrega_cobro_parcial'.
 */
export async function obtenerAnomaliasRevisadas(empresa_id, tipo_anomalia) {
  const { data } = await db
    .from('anomalias_revisadas')
    .select('entidad_id')
    .eq('empresa_id', empresa_id)
    .eq('tipo_anomalia', tipo_anomalia);
  return data;
}

/**
 * Turnos de caja cerrados con diferencia de arqueo (> $1, mismo umbral de
 * TOLERANCIA_REDONDEO_PAGO que el propio POS) en los últimos N días.
 * `usuarios!usuario_id` desambigua el FK — `turnos_caja` tiene dos FKs a
 * usuarios (usuario_id y cerrado_forzado_por), mismo bug que rompía el
 * Reporte Z (ver fix en pos.js).
 */
export async function obtenerTurnosConDiferencia(empresa_id, desdeISO, limit) {
  const { data } = await db
    .from('turnos_caja')
    .select(`
      id, diferencia, cerrado_at,
      cajas_pos!inner(nombre, empresa_id),
      usuarios!usuario_id(nombre)
    `)
    .eq('cajas_pos.empresa_id', empresa_id)
    .eq('estado', 'cerrado')
    .not('diferencia', 'is', null)
    .or('diferencia.gt.1,diferencia.lt.-1')
    .gte('cerrado_at', desdeISO)
    .order('cerrado_at', { ascending: false })
    .limit(limit);
  return data;
}

/** Entregas confirmadas con cobro registrado menor al total del pedido (cobro parcial sin ajuste posterior), últimos N días. */
export async function obtenerEntregasConCobroParcial(empresa_id, desdeISO, limit) {
  const { data } = await db
    .from('entregas')
    .select(`
      id, ruta_id, monto_cobrado, fecha_confirmacion,
      pedidos!inner(id, total, empresa_id, clientes(razon_social, nombre_fantasia)),
      rutas(fecha)
    `)
    .eq('estado', 'entregado')
    .not('monto_cobrado', 'is', null)
    .eq('pedidos.empresa_id', empresa_id)
    .gte('fecha_confirmacion', desdeISO)
    .order('fecha_confirmacion', { ascending: false })
    .limit(limit);
  return data;
}

// ── Onboarding (handleOnboarding) ────────────────────────────────────────────

export async function obtenerPedidosExistentes(empresa_id) {
  return db.from('pedidos').select('id').eq('empresa_id', empresa_id).limit(1);
}

export async function obtenerVentasPosExistentes(empresa_id) {
  return db.from('ventas_pos').select('id').eq('empresa_id', empresa_id).limit(1);
}

export async function obtenerEmpresaFechaAlta(empresa_id) {
  return db.from('empresas').select('created_at').eq('id', empresa_id).single();
}
