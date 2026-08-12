// lib/repos/pos.js
// Capa de acceso a datos para `lib/handlers/pos.js`.
//
// Fase 7, paso 9 del plan de migración (FASE7_PLAN_ARRANQUE.md). `pos.js`
// (2047 líneas, 76 `.from()`/`.rpc()` directos) es el módulo transaccional
// más sensible del proyecto — venta, caja, turno, arqueo — así que se migra
// en sub-lotes, mismo criterio que `pedidos.js` (paso 8, 4 lotes + 3
// sub-lotes) y `stock.js` (paso 5).
//
// Convención de manejo de error: cuando el handler original hacía
// `if (error) return errorSeguro(...)` la función acá devuelve
// `{ data, error }` para no alterar esa rama. Cuando el original ignoraba
// el error (`const { data } = await ...` sin chequeo), la función acá
// también lo ignora — mismo comportamiento observable, sin "mejorar" de
// paso (checklist Fase 7, punto 2).
//
// Reuso en vez de duplicar: `perteneceProductoAEmpresa`,
// `listarProductosActivosParaAlertaStock`, `buscarProductosPos`,
// `obtenerCategoriasDeProductos` ya existen en `lib/repos/productos.js` y
// se siguen importando desde ahí en el handler (no se tocan acá).
//
// Sub-lote 1 (catálogo/stock del POS) — cubre: `productosHandler`,
// `depositosHandler`, `transferenciasStockHandler`, `transferirStockHandler`,
// favoritos (`getFavoritosHandler`/`postFavoritoHandler`/
// `quitarFavoritoHandler`) y `stockAlertaHandler`.
//
// Sub-lote 4 (núcleo transaccional) — cubre: `registrarVentaHandler`,
// `anularVentaHandler`, `facturarVentaHandler`, `ticketHandler`,
// `ventasHandler`, `devolucionHandler`, `getDevolucionesHandler`. Cierra el
// paso 9: `grep -c "\.from(\|\.rpc(" lib/handlers/pos.js` → 1 (el lookup de
// `perfil` en el router de auth, identidad no dato de negocio, mismo
// criterio que la excepción de `clientes.js`). Tests nuevos:
// `tests/repos/pos.test.js` (18 casos, foco en aislamiento por
// `empresa_id` — no existía cobertura de repo para ningún sub-lote previo).

import { db } from './_db.js';
export { obtenerConfigEmpresa } from './pedidos.js';

// ── Cajas / depósitos (compartido entre productos, favoritos y alerta) ────

/**
 * Depósito asociado a una caja (con nombre del depósito incluido) — usado
 * por productosHandler, getFavoritosHandler y stockAlertaHandler para
 * resolver en qué depósito buscar stock.
 */
export async function obtenerCajaConDeposito(caja_id, empresa_id) {
  const { data } = await db
    .from('cajas_pos')
    .select('deposito_id, depositos(nombre)')
    .eq('id', caja_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** Depósito principal de la empresa (fallback cuando la caja no tiene uno asignado). */
export async function obtenerDepositoPrincipal(empresa_id) {
  const { data } = await db
    .from('depositos')
    .select('id')
    .eq('empresa_id', empresa_id)
    .order('es_principal', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Asigna el depósito resuelto a la caja, best-effort (fire-and-forget en el original). */
/** Lista de depósitos para el selector de destino de migracion.js (productos/lotes), principal primero. */
export async function listarDepositosParaSelector(empresa_id) {
  const { data } = await db
    .from('depositos')
    .select('id, nombre, es_principal')
    .eq('empresa_id', empresa_id)
    .order('es_principal', { ascending: false })
    .order('nombre', { ascending: true });
  return data || [];
}

/** Lista de listas de precio para el selector de destino de migracion.js (productos), default primero. */
export async function listarListasPrecioParaSelector(empresa_id) {
  const { data } = await db
    .from('listas_precios')
    .select('id, nombre, es_default')
    .eq('empresa_id', empresa_id)
    .order('es_default', { ascending: false })
    .order('nombre', { ascending: true });
  return data || [];
}

/** Lista de precios puntual de la empresa, elegida explícitamente al mapear una sesión de productos. */
export async function obtenerListaPrecioPorId(empresa_id, lista_precio_id) {
  const { data } = await db
    .from('listas_precios').select('id').eq('id', lista_precio_id).eq('empresa_id', empresa_id).maybeSingle();
  return data;
}

/** Lista de precios default de la empresa — fallback si no se eligió ninguna. */
export async function obtenerListaPrecioDefault(empresa_id) {
  const { data } = await db
    .from('listas_precios').select('id').eq('empresa_id', empresa_id).eq('es_default', true).maybeSingle();
  return data;
}

export function asignarDepositoACaja(caja_id, deposito_id) {
  return db.from('cajas_pos').update({ deposito_id }).eq('id', caja_id).then(() => {});
}

/** Stock de una lista de productos en un depósito puntual. */
export async function obtenerStockPorProductos(deposito_id, productoIds) {
  const { data } = await db
    .from('stock')
    .select('producto_id, cantidad')
    .eq('deposito_id', deposito_id)
    .in('producto_id', productoIds);
  return data || [];
}

// ── productosHandler (búsqueda rápida por código/balanza/texto) ───────────

/** Precios de lista de una lista de productos, para una lista de precios puntual. */
export async function obtenerPreciosPorLista(lista_precio_id, productoIds) {
  const { data } = await db
    .from('precios_items')
    .select('producto_id, precio')
    .eq('lista_id', lista_precio_id)
    .in('producto_id', productoIds);
  return data || [];
}

/** Promociones vigentes de la empresa a una fecha dada (para adjuntar al resultado de búsqueda). */
export async function listarPromocionesVigentes(empresa_id, hoy) {
  const { data } = await db
    .from('promociones')
    .select('id, tipo, n_cantidad, m_paga, descuento_pct, producto_id, categoria_id, nombre')
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .or(`fecha_hasta.is.null,fecha_hasta.gte.${hoy}`)
    .or(`fecha_desde.is.null,fecha_desde.lte.${hoy}`);
  return data || [];
}

// ── depositosHandler ────────────────────────────────────────────────────

/** Depósitos de la empresa con nombre, para el selector de transferencias. */
export async function listarDepositosConNombre(empresa_id) {
  const { data, error } = await db
    .from('depositos')
    .select('id, nombre')
    .eq('empresa_id', empresa_id)
    .order('nombre');
  return { data, error };
}

// ── transferenciasStockHandler ─────────────────────────────────────────

/** Últimas transferencias de stock entre depósitos de la empresa (historial). */
export async function listarTransferenciasStock(depIds) {
  const { data, error } = await db
    .from('movimientos_stock')
    .select('id, cantidad, created_at, notas, productos(nombre), depositos(nombre)')
    .eq('tipo', 'transferencia')
    .gt('cantidad', 0)
    .in('deposito_id', depIds)
    .order('created_at', { ascending: false })
    .limit(30);
  return { data, error };
}

// ── transferirStockHandler ─────────────────────────────────────────────

/** Cuenta cuántos de los depósitos dados pertenecen a la empresa (valida origen+destino en una sola query). */
export async function contarDepositosDeEmpresa(empresa_id, depositoIds) {
  const { data } = await db
    .from('depositos')
    .select('id')
    .eq('empresa_id', empresa_id)
    .in('id', depositoIds);
  return (data || []).length;
}

/** RPC atómica que mueve stock entre depósitos (valida existencia/cantidad server-side). */
export async function transferirStockEntreDepositosRpc({ producto_id, deposito_origen, deposito_destino, cantidad, usuario_id, notas }) {
  const { data, error } = await db.rpc('transferir_stock_entre_depositos', {
    p_producto_id:      producto_id,
    p_deposito_origen:  deposito_origen,
    p_deposito_destino: deposito_destino,
    p_cantidad:         cantidad,
    p_usuario_id:       usuario_id,
    p_notas:            notas || null,
  });
  return { data, error };
}

// ── Favoritos (getFavoritosHandler / postFavoritoHandler / quitarFavoritoHandler) ──

/** Grilla de favoritos de la empresa, con datos del producto embebidos. */
export async function listarFavoritosPos(empresa_id) {
  const { data, error } = await db
    .from('pos_favoritos')
    .select('id, producto_id, etiqueta, color, orden, productos(nombre, codigo, precio_base, iva, unidad)')
    .eq('empresa_id', empresa_id)
    .order('orden')
    .order('created_at');
  return { data, error };
}

/** Alta/edición de un favorito (upsert por empresa+producto). */
export async function upsertFavoritoPos({ empresa_id, producto_id, etiqueta, color, orden }) {
  const { data, error } = await db
    .from('pos_favoritos')
    .upsert(
      {
        empresa_id,
        producto_id,
        etiqueta: etiqueta || null,
        color:    color    || '#28a745',
        orden:    orden    ?? 0,
      },
      { onConflict: 'empresa_id,producto_id', ignoreDuplicates: false }
    )
    .select()
    .single();
  return { data, error };
}

/** Elimina un favorito, scopeado a la empresa (multi-tenant). */
export async function eliminarFavoritoPos(id, empresa_id) {
  const { error } = await db
    .from('pos_favoritos')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  return { error };
}

// ══════════════════════════════════════════════════════════════════════════
// Sub-lote 2 (config varios) — cliente rápido, hardware, PIN de supervisor,
// promociones.
// ══════════════════════════════════════════════════════════════════════════

// ── clienteRapidoHandler ───────────────────────────────────────────────

/** Cliente existente con ese CUIT/DNI en la empresa (chequeo de duplicado antes del alta). */
export async function buscarClientePorCuit(empresa_id, cuit) {
  const { data } = await db
    .from('clientes')
    .select('id, razon_social')
    .eq('empresa_id', empresa_id)
    .eq('cuit', cuit)
    .maybeSingle();
  return data;
}

/** Alta mínima de cliente desde la caja (sin el chequeo de cupo de plan que sí aplica ClienteRepo.crearCliente). */
export async function crearClienteRapido(campos) {
  const { data, error } = await db
    .from('clientes')
    .insert(campos)
    .select('id, razon_social, cuit, lista_precio_id')
    .single();
  return { data, error };
}

// ── config-hardware ─────────────────────────────────────────────────────

/** Datos de la empresa + config de hardware POS guardada (para inicializar impresora/terminal). */
export async function obtenerEmpresaParaHardware(empresa_id) {
  const { data, error } = await db
    .from('empresas')
    .select('nombre, cuit, domicilio, telefono, config')
    .eq('id', empresa_id)
    .single();
  return { data, error };
}

/** Guarda el objeto `config` completo de la empresa (usado tras mergear pos_hardware). */
export async function actualizarConfigEmpresa(empresa_id, config) {
  const { error } = await db
    .from('empresas')
    .update({ config })
    .eq('id', empresa_id);
  return { error };
}

// ── configPinHandler (PIN de supervisor) ──────────────────────────────

/** Guarda (o borra, pasando null) el hash del PIN de supervisor de la empresa. */
export async function actualizarPinSupervisor(empresa_id, pinHash) {
  const { error } = await db
    .from('empresas')
    .update({ supervisor_pin: pinHash })
    .eq('id', empresa_id);
  return { error };
}

// ── promociones (getPromocionesHandler / postPromocionesHandler) ──────

/** Promociones de la empresa (activas e inactivas), con nombre de producto/categoría. */
export async function listarPromocionesAdmin(empresa_id, soloActivas) {
  let query = db
    .from('promociones')
    .select('id, nombre, tipo, n_cantidad, m_paga, descuento_pct, producto_id, categoria_id, activa, fecha_desde, fecha_hasta, productos(nombre), categorias(nombre)')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });

  if (soloActivas) query = query.eq('activa', true);

  const { data, error } = await query;
  return { data, error };
}

/** Crea una promoción. */
export async function crearPromocion(campos) {
  const { data, error } = await db.from('promociones').insert(campos).select().single();
  return { data, error };
}

/** Edita una promoción existente, scopeada a la empresa. */
export async function actualizarPromocion(id, empresa_id, campos) {
  const { data, error } = await db
    .from('promociones')
    .update(campos)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .select()
    .single();
  return { data, error };
}

/** Elimina una promoción, scopeada a la empresa. */
export async function eliminarPromocion(id, empresa_id) {
  const { error } = await db
    .from('promociones')
    .delete()
    .eq('id', id)
    .eq('empresa_id', empresa_id);
  return { error };
}

/** Estado `activa` actual de una promoción (para el toggle). */
export async function obtenerEstadoActivaPromocion(id, empresa_id) {
  const { data } = await db
    .from('promociones')
    .select('activa')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** Invierte el estado `activa` de una promoción. */
export async function togglePromocion(id, activaNueva) {
  const { error } = await db.from('promociones').update({ activa: activaNueva }).eq('id', id);
  return { error };
}

// ══════════════════════════════════════════════════════════════════════════
// Sub-lote 3 (caja y turno) — apertura/cierre, arqueo, movimientos de caja,
// PIN de supervisor, reporte Z, historial, administración de cajas.
// ══════════════════════════════════════════════════════════════════════════

// ── cajaEstadoHandler ──────────────────────────────────────────────────

/** Turnos abiertos del usuario actual (normalmente 0 o 1, pero no hay constraint que lo garantice). */
export async function listarTurnosAbiertosDeUsuario(usuario_id) {
  const { data, error } = await db
    .from('turnos_caja')
    .select('id, caja_id, monto_inicial, abierto_at, cajas_pos(nombre, deposito_id)')
    .eq('usuario_id', usuario_id)
    .eq('estado', 'abierto');
  return { data, error };
}

// ── Turno + empresa (reusado por resumen-turno y cerrar-turno) ────────

/** Turno con el empresa_id de su caja embebido — para validar pertenencia multi-tenant. */
export async function obtenerTurnoConEmpresa(turno_id) {
  const { data } = await db
    .from('turnos_caja')
    .select('id, cajas_pos!inner(empresa_id)')
    .eq('id', turno_id)
    .maybeSingle();
  return data;
}

/** Igual que `obtenerTurnoConEmpresa` pero con `estado` incluido (forzar-cierre, movimiento-caja). */
export async function obtenerTurnoConEstadoYEmpresa(turno_id) {
  const { data } = await db
    .from('turnos_caja')
    .select('id, estado, cajas_pos!inner(empresa_id)')
    .eq('id', turno_id)
    .maybeSingle();
  return data;
}

/** RPC que calcula el resumen de un turno abierto (desglose por medio de pago, sin cerrar). */
export async function resumenTurnoCajaRpc(turno_id) {
  const { data, error } = await db.rpc('resumen_turno_caja', { p_turno_id: turno_id });
  return { data, error };
}

// ── cajasHandler ────────────────────────────────────────────────────────

/** Cajas activas de la empresa, para el selector del POS. */
export async function listarCajasActivas(empresa_id) {
  const { data, error } = await db
    .from('cajas_pos')
    .select('id, nombre, deposito_id, activa')
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .order('nombre');
  return { data, error };
}

// ── abrirTurnoHandler ──────────────────────────────────────────────────

/**
 * Caja a abrir turno — replica el `select` original (`id, activa`, sin
 * `deposito_id`): el chequeo de `caja.deposito_id` más abajo en el handler
 * siempre da `undefined`, así que la asignación automática de depósito
 * corre en cada apertura. Bug preexistente que este paso no corrige
 * (checklist Fase 7, punto 2: mover acceso a datos, no lógica).
 */
export async function obtenerCajaParaAbrirTurno(caja_id, empresa_id) {
  const { data } = await db
    .from('cajas_pos')
    .select('id, activa')
    .eq('id', caja_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** Abre un turno nuevo en una caja. Falla con 23505 si ya hay uno abierto (constraint único). */
export async function insertarTurnoCaja({ caja_id, usuario_id, monto_inicial }) {
  const { data, error } = await db
    .from('turnos_caja')
    .insert({ caja_id, usuario_id, monto_inicial })
    .select()
    .single();
  return { data, error };
}

/**
 * Turno abierto de una caja (con quién y desde cuándo) — usado tanto para
 * el mensaje de conflicto al abrir turno como para bloquear la desactivación
 * de una caja con turno abierto.
 */
export async function obtenerTurnoAbiertoDeCaja(caja_id) {
  const { data } = await db
    .from('turnos_caja')
    // usuarios!usuario_id: turnos_caja tiene DOS FKs a usuarios (usuario_id
    // y cerrado_forzado_por desde forzar_cierre_turno_caja_huerfano) — sin
    // el hint, PostgREST no sabe cuál usar y esta consulta fallaba en
    // silencio (solo se destructura `data`, el error se descarta).
    .select('id, abierto_at, usuarios!usuario_id(nombre)')
    .eq('caja_id', caja_id)
    .eq('estado', 'abierto')
    .maybeSingle();
  return data;
}

// ── forzarCierreTurnoHandler ───────────────────────────────────────────

/** RPC que cierra administrativamente un turno huérfano (auditoría, sin arqueo físico). */
export async function forzarCierreTurnoCajaRpc(turno_id, usuario_id, motivo) {
  const { data, error } = await db.rpc('forzar_cierre_turno_caja', {
    p_turno_id: turno_id,
    p_usuario_id: usuario_id,
    p_motivo: motivo || null,
  });
  return { data, error };
}

// ── cerrarTurnoHandler ─────────────────────────────────────────────────

/** RPC que cierra el turno con arqueo automático (compara declarado vs calculado). */
export async function cerrarTurnoCajaRpc(turno_id, monto_final_declarado) {
  const { data, error } = await db.rpc('cerrar_turno_caja', {
    p_turno_id: turno_id,
    p_monto_final_declarado: monto_final_declarado,
  });
  return { data, error };
}

// ── movimientoCajaHandler ──────────────────────────────────────────────

/** Registra sangría / refuerzo / retiro final del turno activo. */
export async function insertarMovimientoCaja(payload) {
  const { data, error } = await db
    .from('movimientos_caja')
    .insert(payload)
    .select()
    .single();
  return { data, error };
}

// ── verificarPinHandler ────────────────────────────────────────────────

/** Hash (o texto plano legacy) del PIN de supervisor de la empresa. */
export async function obtenerPinSupervisor(empresa_id) {
  const { data, error } = await db
    .from('empresas')
    .select('supervisor_pin')
    .eq('id', empresa_id)
    .single();
  return { data, error };
}

// ── reporteZHandler ────────────────────────────────────────────────────

/** Turno completo con caja, empresa y vendedor embebidos — cabecera del reporte Z. */
export async function obtenerTurnoParaReporteZ(turno_id) {
  const { data, error } = await db
    .from('turnos_caja')
    .select(`
      id, monto_inicial, abierto_at, cerrado_at, monto_final_declarado,
      monto_final_calculado, diferencia, estado,
      cajas_pos!inner(nombre, empresa_id, empresas(nombre)),
      usuarios!usuario_id(nombre)
    `)
    .eq('id', turno_id)
    .maybeSingle();
  return { data, error };
}

/** Ventas de un turno, con cliente y pagos embebidos (para el desglose por medio de pago). */
export async function listarVentasDelTurno(turno_id) {
  const { data } = await db
    .from('ventas_pos')
    .select(`
      id, numero, total, estado, created_at,
      clientes(razon_social),
      venta_pos_pagos(medio, monto)
    `)
    .eq('turno_id', turno_id)
    .order('created_at');
  return data || [];
}

/** Movimientos de caja de un turno (sangrías/refuerzos/retiros), para el arqueo. */
export async function listarMovimientosDelTurno(turno_id) {
  const { data } = await db
    .from('movimientos_caja')
    .select('id, tipo, monto, concepto, created_at')
    .eq('turno_id', turno_id)
    .order('created_at');
  return data || [];
}

// ── historialTurnosHandler ─────────────────────────────────────────────

/** Turnos cerrados de la empresa, paginado, con filtros dinámicos (caja, rango de fechas, diferencia de arqueo). */
export async function listarHistorialTurnos({ empresa_id, caja_id, desde, hasta, solo_con_diferencia, offset, limit }) {
  let q = db
    .from('turnos_caja')
    .select(`
      id, abierto_at, cerrado_at, monto_inicial, monto_final_declarado,
      monto_final_calculado, diferencia,
      cajas_pos!inner(id, nombre, empresa_id),
      usuarios!usuario_id(nombre)
    `, { count: 'exact' })
    .eq('cajas_pos.empresa_id', empresa_id)
    .eq('estado', 'cerrado')
    .order('cerrado_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (caja_id) q = q.eq('caja_id', caja_id);
  if (desde)   q = q.gte('cerrado_at', desde);
  if (hasta)   q = q.lte('cerrado_at', hasta);
  // Umbral de $1 para no marcar como "diferencia" redondeos de centavos
  if (solo_con_diferencia === '1') q = q.or('diferencia.gt.1,diferencia.lt.-1');

  const { data, error, count } = await q;
  return { data, error, count };
}

// ── cajasAdminGetHandler / cajasAdminPostHandler ───────────────────────

/** Todas las cajas de la empresa (activas e inactivas) con su turno abierto, si lo hay. */
export async function listarCajasAdminConTurno(empresa_id) {
  const { data, error } = await db
    .from('cajas_pos')
    // usuarios!usuario_id: turnos_caja tiene DOS FKs a usuarios (usuario_id
    // y cerrado_forzado_por) — sin el hint, PostgREST tira 500 por
    // ambigüedad de embed ("more than one relationship was found").
    .select(`
      id, nombre, deposito_id, activa, created_at,
      turnos_caja ( id, abierto_at, usuario_id, usuarios!usuario_id(nombre) )
    `)
    .eq('empresa_id', empresa_id)
    .eq('turnos_caja.estado', 'abierto')
    .order('nombre');
  return { data, error };
}

/** Caja con ese nombre en la empresa (chequeo de duplicado al crear). */
export async function buscarCajaPorNombre(empresa_id, nombre) {
  const { data } = await db
    .from('cajas_pos')
    .select('id')
    .eq('empresa_id', empresa_id)
    .ilike('nombre', nombre)
    .maybeSingle();
  return data;
}

/** Igual que `buscarCajaPorNombre` pero excluyendo la propia caja (chequeo de duplicado al editar). */
export async function buscarOtraCajaConNombre(empresa_id, nombre, excluirId) {
  const { data } = await db
    .from('cajas_pos')
    .select('id')
    .eq('empresa_id', empresa_id)
    .ilike('nombre', nombre)
    .neq('id', excluirId)
    .maybeSingle();
  return data;
}

/** Crea una caja nueva. */
export async function crearCajaPos({ empresa_id, deposito_id, nombre }) {
  const { data, error } = await db
    .from('cajas_pos')
    .insert({ empresa_id, deposito_id, nombre, activa: true })
    .select('id, nombre, deposito_id, activa')
    .single();
  return { data, error };
}

/** Caja existente por id, scopeada a la empresa (para editar/activar/desactivar). */
export async function obtenerCajaPosPorId(id, empresa_id) {
  const { data } = await db
    .from('cajas_pos')
    .select('id, nombre, activa')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** Edita nombre/depósito de una caja. */
export async function actualizarCajaPos(id, { nombre, deposito_id }) {
  const { data, error } = await db
    .from('cajas_pos')
    .update({ nombre, deposito_id })
    .eq('id', id)
    .select('id, nombre, deposito_id, activa')
    .single();
  return { data, error };
}

/** Reactiva una caja dada de baja. */
export async function activarCajaPos(id) {
  const { error } = await db.from('cajas_pos').update({ activa: true }).eq('id', id);
  return { error };
}

/** Da de baja una caja (el caller ya validó que no tiene turno abierto). */
export async function desactivarCajaPos(id) {
  const { error } = await db.from('cajas_pos').update({ activa: false }).eq('id', id);
  return { error };
}

// ── movimientosCajaLogHandler ──────────────────────────────────────────

/** Log auditable de movimientos de caja de toda la empresa, en un rango de fechas opcional. */
export async function listarMovimientosCajaLog({ empresa_id, desde, hasta }) {
  let q = db
    .from('movimientos_caja')
    .select('id, tipo, monto, concepto, created_at, turno_id, usuarios(nombre), turnos_caja(cajas_pos(nombre))')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .limit(500);

  if (desde) q = q.gte('created_at', `${desde}T00:00:00`);
  if (hasta) q = q.lte('created_at', `${hasta}T23:59:59`);

  const { data, error } = await q;
  return { data, error };
}

// ── umbralCajeroGetHandler / umbralCajeroPostHandler ───────────────────

/** Cajeros/vendedores activos de la empresa con su umbral de descuento configurado. */
export async function listarUsuariosParaUmbral(empresa_id) {
  const { data, error } = await db
    .from('usuarios')
    .select('id, nombre, rol, supervisor_umbral_descuento_pct')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .in('rol', ['cajero', 'vendedor', 'admin', 'dueno'])
    .order('nombre');
  return { data, error };
}

/** true si el usuario existe y pertenece a la empresa (scope multi-tenant antes de tocar su umbral). */
export async function existeUsuarioEnEmpresa(usuario_id, empresa_id) {
  const { data } = await db
    .from('usuarios')
    .select('id')
    .eq('id', usuario_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return !!data;
}

/** Guarda el umbral de descuento sin supervisor de un cajero/vendedor puntual. */
export async function actualizarUmbralUsuario(usuario_id, umbral_pct) {
  const { error } = await db
    .from('usuarios')
    .update({ supervisor_umbral_descuento_pct: umbral_pct })
    .eq('id', usuario_id);
  return { error };
}

// ══════════════════════════════════════════════════════════════════════════
// Sub-lote 4 (núcleo transaccional) — registrar/anular/facturar venta,
// ticket, listado de ventas, devoluciones. El bloque más sensible del
// módulo: stock, pagos, facturación AFIP.
// ══════════════════════════════════════════════════════════════════════════

// Reuso en vez de duplicar: mismo RPC que usa el flujo de pedidos del
// portal/admin (`lib/repos/whatsapp-bot.js`, reexportado también por
// `lib/repos/pedidos.js` con el mismo criterio).
export { resolverPreciosClienteRpc } from './whatsapp-bot.js';

// ── registrarVentaHandler ──────────────────────────────────────────────

/** Umbral de descuento sin PIN de un cajero/vendedor puntual (fallback 15% si no está seteado, resuelto en el handler). */
export async function obtenerUmbralDescuentoUsuario(usuario_id) {
  const { data } = await db
    .from('usuarios')
    .select('supervisor_umbral_descuento_pct')
    .eq('id', usuario_id)
    .single();
  return data;
}

/** Caja para registrar una venta — a diferencia de `obtenerCajaParaAbrirTurno`, necesita `deposito_id` (de dónde sale el stock). */
export async function obtenerCajaParaVenta(caja_id, empresa_id) {
  const { data } = await db
    .from('cajas_pos')
    .select('id, deposito_id, activa')
    .eq('id', caja_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** Cliente activo de la empresa (venta a cuenta corriente / con cliente asociado). */
export async function obtenerClienteActivoParaVenta(cliente_id, empresa_id) {
  const { data } = await db
    .from('clientes')
    .select('id, activo')
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** RPC transaccional que registra la venta completa (ítems, pagos, stock, cta_cte si corresponde). Idempotente vía `offline_local_id`. */
export async function registrarVentaPosRpc(payload) {
  const { data, error } = await db.rpc('registrar_venta_pos', payload);
  return { data, error };
}

// ── anularVentaHandler ─────────────────────────────────────────────────

/** Venta con ítems, pagos y depósito de la caja embebidos — todo lo que necesita la RPC de anulación y sus validaciones previas (factura con CAE, estado). */
export async function obtenerVentaParaAnular(venta_pos_id, empresa_id) {
  const { data } = await db
    .from('ventas_pos')
    .select(`
      id, empresa_id, estado, cliente_id, numero, total, factura_id,
      venta_pos_items(producto_id, cantidad),
      venta_pos_pagos(medio, monto),
      cajas_pos(deposito_id)
    `)
    .eq('id', venta_pos_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** RPC transaccional e idempotente: repone stock, acredita cta_cte si corresponde, marca la venta anulada. */
export async function anularVentaPosRpc(venta_pos_id, usuario_id, motivo) {
  const { data, error } = await db.rpc('anular_venta_pos', {
    p_venta_pos_id: venta_pos_id,
    p_usuario_id:   usuario_id,
    p_motivo:       motivo || null,
  });
  return { data, error };
}

// ── facturarVentaHandler ───────────────────────────────────────────────

/** Venta a facturar — lo mínimo para validar estado y si ya tiene factura, antes de delegar en `emitirFactura`. */
export async function obtenerVentaParaFacturar(venta_pos_id, empresa_id) {
  const { data } = await db
    .from('ventas_pos')
    .select('id, empresa_id, estado, factura_id')
    .eq('id', venta_pos_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

// ── ticketHandler ──────────────────────────────────────────────────────

/** Venta completa para imprimir/mostrar el ticket: ítems, pagos, cliente, vendedor. */
export async function obtenerVentaParaTicket(venta_id, empresa_id) {
  const { data, error } = await db
    .from('ventas_pos')
    .select(`
      id, numero, subtotal, descuento, iva_total, total, descuento_global_pct, estado, created_at,
      clientes(razon_social, cuit),
      usuarios(nombre),
      venta_pos_items(cantidad, precio_unitario, descuento_pct, subtotal, productos(nombre, unidad)),
      venta_pos_pagos(medio, monto, referencia)
    `)
    .eq('id', venta_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return { data, error };
}

// ── ventasHandler ──────────────────────────────────────────────────────

/** Listado paginado de ventas de la empresa, con filtros dinámicos (para el panel de anulación). */
export async function listarVentasPos({ empresa_id, q, estado, desde, hasta, limit, offset }) {
  let query = db
    .from('ventas_pos')
    .select('id, numero, total, estado, created_at, descuento_global_pct, factura_id, cajas_pos(nombre), clientes(razon_social)')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (estado) query = query.eq('estado', estado);
  if (q && q.trim()) query = query.ilike('numero', `%${q.trim()}%`);
  if (desde) query = query.gte('created_at', `${desde}T00:00:00`);
  if (hasta) query = query.lte('created_at', `${hasta}T23:59:59`);

  const { data, error } = await query;
  return { data, error };
}

// ── getDevolucionesHandler ─────────────────────────────────────────────

/** Devoluciones registradas de una venta puntual, con ítems y producto embebidos. */
export async function listarDevolucionesDeVenta(venta_id, empresa_id) {
  const { data, error } = await db
    .from('devoluciones_pos')
    .select(`
      id, motivo, monto_total, created_at,
      usuarios(nombre),
      devoluciones_pos_items(cantidad_devuelta, monto, productos(nombre))
    `)
    .eq('venta_pos_id', venta_id)
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });
  return { data, error };
}

// ── devolucionHandler ──────────────────────────────────────────────────

/** Venta a la que se le va a registrar una devolución — solo lo necesario para validar pertenencia y estado. */
export async function obtenerVentaParaDevolucion(venta_pos_id, empresa_id) {
  const { data } = await db
    .from('ventas_pos')
    .select('id, empresa_id, estado, numero')
    .eq('id', venta_pos_id)
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** RPC que valida cantidades, repone stock y registra la devolución (parcial o total). */
export async function registrarDevolucionPosRpc({ venta_pos_id, items, motivo, usuario_id }) {
  const { data, error } = await db.rpc('rpc_registrar_devolucion_pos', {
    p_venta_pos_id: venta_pos_id,
    p_items:        JSON.stringify(items),
    p_motivo:       motivo?.trim() || null,
    p_usuario_id:   usuario_id,
  });
  return { data, error };
}
