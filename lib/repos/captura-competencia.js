// lib/repos/captura-competencia.js
// Capa de acceso a datos de la Fase 1 (Capa 2 — MVP) de
// PLAN_CAPTURA_COMPETENCIA.md. Usada por lib/handlers/captura-competencia.js.
//
// Tablas: captura_competencia / captura_competencia_items (migración 551).
// Matching: fn_captura_matchear_producto (migración 552).
// Storage: bucket privado 'capturas-competencia' (migración 552) — mismo
// criterio post-SEC-05 que remitos/devoluciones: se guarda el PATH del
// objeto, nunca una URL pública (ver lib/utils/storage-urls.js).

import { db } from './_db.js';

// ── Storage ────────────────────────────────────────────────────────────

/** Sube la foto de una factura/remito de competencia al bucket privado. */
export async function subirFotoCapturaStorage(path, buffer, mime_type) {
  const { error } = await db.storage
    .from('capturas-competencia')
    .upload(path, buffer, { contentType: mime_type, upsert: false });
  return { error };
}

// ── captura_competencia ───────────────────────────────────────────────

export async function crearCaptura({ empresa_id, vendedor_id, imagen_path, proveedor_competencia_nombre }) {
  const { data, error } = await db
    .from('captura_competencia')
    .insert({
      empresa_id,
      vendedor_id,
      imagen_original_url: imagen_path,
      proveedor_competencia_nombre: proveedor_competencia_nombre || null,
      estado: 'pendiente_revision',
    })
    .select()
    .single();
  return { data, error };
}

/**
 * Detalle completo (captura + items) para la pantalla de revisión.
 * Los items traen embebido el producto matcheado (nombre/precio_base/costo/
 * unidad) — la pantalla de revisión necesita el nombre para mostrar contra
 * qué se está comparando cada renglón, y costo/precio_base para poder
 * previsualizar el margen en el cliente antes de mandar accion=cerrar.
 * `producto_id` puede ser null (sin match), en cuyo caso `productos` viene
 * null — no fuerza un embed inexistente.
 */
export async function obtenerCapturaDetalle(id, empresa_id) {
  const { data, error } = await db
    .from('captura_competencia')
    .select(`
      *,
      usuarios!vendedor_id(nombre),
      captura_competencia_items(*, productos(id, nombre, precio_base, costo, unidad))
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Capturas todavía accionables (no cerradas ni descartadas) de la empresa.
 * Si `vendedor_id` es null (dueño/admin viendo la bandeja completa para
 * auditar/revisar, ver permisos-service.js) trae las de todos los
 * vendedores; si se pasa, se filtra a las de ese vendedor puntual (caso
 * normal: el vendedor de campo viendo solo lo suyo).
 */
export async function listarCapturasPendientes(empresa_id, vendedor_id = null) {
  let query = db
    .from('captura_competencia')
    .select('id, cliente_id, proveedor_competencia_nombre, estado, fecha_captura, total_competencia, total_propio_cotizado, ahorro_absoluto, ahorro_porcentual, usuarios!vendedor_id(nombre)')
    .eq('empresa_id', empresa_id)
    .in('estado', ['pendiente_revision', 'revisado'])
    .order('fecha_captura', { ascending: false });
  if (vendedor_id) query = query.eq('vendedor_id', vendedor_id);
  const { data, error } = await query;
  return { data, error };
}

/** Totales + estado tras el cálculo de accionCerrar. */
export async function actualizarTotalesCaptura(id, { total_competencia, total_propio_cotizado, ahorro_absoluto, ahorro_porcentual, estado }) {
  const { error } = await db
    .from('captura_competencia')
    .update({ total_competencia, total_propio_cotizado, ahorro_absoluto, ahorro_porcentual, estado })
    .eq('id', id);
  return { error };
}

/**
 * Marca la captura como convertida, asociándola al cliente (y pedido, si se
 * pasa) que se crearon en accionConvertir. No se revierte si el marcado
 * falla después de crear el pedido: el pedido real ya existe y no se
 * deshace (ver comentario en el handler, accionConvertir).
 */
export async function marcarCapturaConvertida(id, clienteId, pedidoId = null) {
  const { error } = await db
    .from('captura_competencia')
    .update({
      estado: 'convertido_pedido',
      cliente_id: clienteId,
      pedido_id: pedidoId,
      // convertido_at (migración 553, plan 1.7): se fija acá, no en el
      // handler, para que quede escrito por la misma fila que pasa el
      // estado — necesario para la métrica de tiempo promedio foto→cierre.
      convertido_at: new Date().toISOString(),
    })
    .eq('id', id);
  return { error };
}

// Soft-delete de una captura completa (no confundir con el `descartado`
// por renglón de confirmarItemCaptura). El vendedor la usa para sacar de
// su bandeja una captura hecha por error (foto de más, comercio que no
// daba para nada) sin que quede pegada para siempre como
// 'pendiente_revision'. No se borra la fila — se conserva para auditoría
// y para que obtenerMetricasCaptura pueda seguir contando el total real
// de capturas creadas, excluyendo estas del denominador de conversión.
export async function marcarCapturaDescartada(id) {
  const { error } = await db
    .from('captura_competencia')
    .update({ estado: 'descartado' })
    .eq('id', id);
  return { error };
}

/**
 * Métricas de éxito del piloto (plan 1.7): a diferencia de
 * listarCapturasPendientes, trae TODOS los estados (incluidas
 * convertidas y descartadas) — la tasa de cierre necesita el
 * denominador real de capturas creadas, no solo las accionables. El
 * cálculo de % y tiempo promedio se hace en el handler (accionMetricas),
 * acá solo se trae lo mínimo para calcularlo.
 */
export async function obtenerMetricasCaptura(empresa_id, vendedor_id = null) {
  let query = db
    .from('captura_competencia')
    .select('estado, fecha_captura, convertido_at')
    .eq('empresa_id', empresa_id);
  if (vendedor_id) query = query.eq('vendedor_id', vendedor_id);
  const { data, error } = await query;
  return { data, error };
}

// ── captura_competencia_items ─────────────────────────────────────────

export async function insertarItemsCaptura(capturaId, items) {
  if (!items.length) return { error: null };
  const { error } = await db
    .from('captura_competencia_items')
    .insert(items.map((it) => ({ ...it, captura_id: capturaId })));
  return { error };
}

/**
 * Ajuste manual de un renglón desde la pantalla de revisión (plan 1.5):
 * cambiar el producto matcheado, corregir cantidad/precio, o descartar el
 * renglón. Marca `confirmado_manualmente` siempre que se llama — incluso
 * si el vendedor no tocó nada más que confirmar un match de confianza
 * alta, porque el paso de revisión es obligatorio (nunca se convierte a
 * pedido sin pasar por acá, ver plan 1.5).
 */
export async function confirmarItemCaptura(itemId, { producto_id, cantidad, precio_unitario_propio, descartado }) {
  const cambios = { confirmado_manualmente: true };
  if (producto_id !== undefined) cambios.producto_id = producto_id;
  if (cantidad !== undefined) cambios.cantidad = cantidad;
  if (precio_unitario_propio !== undefined) cambios.precio_unitario_propio = precio_unitario_propio;
  if (descartado !== undefined) cambios.descartado = descartado;

  const { error } = await db
    .from('captura_competencia_items')
    .update(cambios)
    .eq('id', itemId);
  return { error };
}

// ── Matching ───────────────────────────────────────────────────────────

/**
 * Matchea un renglón de texto crudo contra el catálogo propio
 * (fn_captura_matchear_producto, migración 552 — similitud pg_trgm).
 * Devuelve el mejor candidato o null si nada superó el umbral — nunca
 * fuerza un match falso sobre un renglón que no es un producto de
 * catálogo (ej. un flete).
 */
export async function matchearProducto(empresaId, textoOriginal) {
  const { data, error } = await db.rpc('fn_captura_matchear_producto', {
    p_empresa_id: empresaId,
    p_texto: textoOriginal,
  });
  if (error) {
    console.error('[captura-competencia] error en fn_captura_matchear_producto:', error.message);
    return null;
  }
  const fila = Array.isArray(data) ? data[0] : data;
  if (!fila) return null;
  return {
    producto_id: fila.producto_id,
    nombre: fila.nombre,
    precio_base: fila.precio_base,
    score: fila.score,
  };
}

// ── Fase 2 (Capa 3 — retención): ahorro acumulado ───────────────────────
// Tablas: cliente_ahorro_acumulado / ahorro_competencia_movimientos
// (migración 555). RPC atómica e idempotente: fn_registrar_ahorro_competencia.

/**
 * Precio de competencia congelado por producto, para un cliente puntual.
 * Devuelve un Map<producto_id, precio_unitario_competencia> a partir de la
 * captura de competencia CONVERTIDA que dio origen a este cliente (si hay
 * varias capturas convertidas para el mismo cliente, toma la más antigua —
 * la referencia es "contra lo que pagaba antes de cambiarse", no la última
 * captura que se le haya hecho). Solo considera items no descartados y con
 * producto_id matcheado.
 */
export async function obtenerPreciosReferenciaCompetencia(clienteId, empresaId) {
  const { data, error } = await db
    .from('captura_competencia')
    .select('id, fecha_captura, captura_competencia_items(producto_id, precio_unitario_competencia, descartado)')
    .eq('cliente_id', clienteId)
    .eq('empresa_id', empresaId)
    .eq('estado', 'convertido_pedido')
    .order('fecha_captura', { ascending: true })
    .limit(1);

  if (error) return { data: null, error };

  const captura = data?.[0];
  const referencias = new Map();
  if (captura) {
    for (const item of captura.captura_competencia_items || []) {
      if (item.descartado || !item.producto_id || item.precio_unitario_competencia == null) continue;
      if (!referencias.has(item.producto_id)) referencias.set(item.producto_id, item.precio_unitario_competencia);
    }
  }
  return { data: referencias, error: null };
}

/** Único camino de escritura de ahorro acumulado — ver fn_registrar_ahorro_competencia (migración 555). */
export async function registrarAhorroCompetenciaRpc({ p_pedido_id, p_cliente_id, p_empresa_id, p_ahorro_pedido, p_detalle }) {
  const { error } = await db.rpc('fn_registrar_ahorro_competencia', {
    p_pedido_id, p_cliente_id, p_empresa_id, p_ahorro_pedido, p_detalle,
  });
  return { error };
}

/** Ahorro acumulado de un cliente puntual — usado por el portal cliente (cuenta.html). */
export async function obtenerAhorroAcumuladoCliente(clienteId) {
  const { data, error } = await db
    .from('cliente_ahorro_acumulado')
    .select('ahorro_acumulado, pedidos_con_ahorro')
    .eq('cliente_id', clienteId)
    .maybeSingle();
  return { data, error };
}

/** Ranking de ahorro acumulado por cliente, para el reporte admin (plan 2.5). */
export async function listarAhorroAcumuladoEmpresa(empresaId) {
  const { data, error } = await db
    .from('cliente_ahorro_acumulado')
    .select('ahorro_acumulado, pedidos_con_ahorro, ultima_actualizacion, clientes!inner(razon_social)')
    .eq('empresa_id', empresaId)
    .order('ahorro_acumulado', { ascending: false });
  return { data, error };
}
