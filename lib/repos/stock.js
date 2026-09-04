// lib/repos/stock.js
// Capa de acceso a datos para el módulo de stock: `stock`, `movimientos_stock`,
// `depositos`, `lotes`, `sugerencias_pedido`, `categorias`, `ofertas_liquidacion`,
// `reglas_liquidacion`, más un par de lecturas puntuales de `pedidos`/`pedido_items`
// que solo se usan desde acá (sugerencias FEFO / motor de sugerencias).
//
// Fase 7, paso 5 del plan de migración (FASE7_PLAN_ARRANQUE.md). `stock.js`
// es el handler más grande migrado hasta ahora (35 `.from()` directos, 1155
// líneas, 6 sub-rutas absorbidas: stock, lotes, lotes-fefo, sugerencias,
// cliente-categorias/productos, liquidación). Las 7 lecturas de `usuarios`
// que resolvían perfil/rol a mano se reemplazan por `verificarToken(req, db)`
// en el handler — no tienen función de repo acá, siguiendo el mismo patrón
// que empresa.js.
//
// Convención de manejo de error en este repo: cuando el handler original
// hacía `if (error) return errorSeguro(...)` o chequeaba `error` de forma
// explícita para responder distinto, la función acá devuelve `{ data, error }`
// (o `{ data, error, count }` en listados paginados) para no alterar esa
// rama. Cuando el original ignoraba el error (patrón `const { data } = await
// ...` sin chequeo), la función acá también lo ignora — mismo comportamiento
// observable, no se "mejora" de paso (checklist Fase 7, punto 2).

import { db } from './_db.js';

// ── Depósitos ─────────────────────────────────────────────────────────────────

/**
 * IDs de los depósitos de una empresa. Ignora error igual que el original
 * (si falla, devuelve lista vacía — el caller termina filtrando por nada).
 */
export async function listarDepositosIds(empresa_id) {
  const { data } = await db
    .from('depositos')
    .select('id')
    .eq('empresa_id', empresa_id);
  return (data || []).map(d => d.id);
}

/**
 * true si el depósito existe y pertenece a la empresa (Etapa 2, Hallazgo 2:
 * antes se validaba producto_id contra la empresa al crear un lote, pero no
 * deposito_id).
 */
export async function existeDepositoEnEmpresa(deposito_id, empresa_id) {
  const { data } = await db
    .from('depositos')
    .select('id')
    .eq('id', deposito_id)
    .eq('empresa_id', empresa_id)
    .single();
  return !!data;
}

// ── Stock ─────────────────────────────────────────────────────────────────────

/**
 * Cantidad actual de un producto en un depósito (usado por el ajuste tipo
 * 'ajuste', que necesita el valor absoluto anterior para calcular el delta).
 * Ignora error igual que el original.
 */
export async function obtenerCantidadStock(producto_id, deposito_id) {
  const { data } = await db
    .from('stock')
    .select('cantidad')
    .eq('producto_id', producto_id)
    .eq('deposito_id', deposito_id)
    .maybeSingle();
  return data?.cantidad ?? null;
}

/**
 * Todas las filas de stock (por depósito) de un producto — usado para
 * calcular disponibilidad real total en sugerencias FEFO. Sin filtro de
 * empresa (igual que el original: el producto_id ya viene validado contra
 * la empresa por el caller vía el pedido). Ignora error.
 */
export async function listarStockPorProducto(producto_id) {
  const { data } = await db
    .from('stock')
    .select('cantidad, cantidad_reservada, cantidad_disponible')
    .eq('producto_id', producto_id);
  return data || [];
}

/**
 * Listado paginado de stock actual con filtros server-side (búsqueda ya
 * resuelta a `ids` por el caller, categoría, depósito, estado por rango de
 * `cantidad_disponible`). Replica exacto el query original — misma
 * combinación de `.in()`/`.eq()` condicionales y el mismo orden de filtros.
 * Propaga error (el original lo maneja con errorSeguro).
 */
export async function buscarStockPaginado({
  depIds, producto_id, deposito_id, categoria_id, ids, estado, offset, limitNum,
}) {
  let q = db
    .from('stock')
    .select(`
      id, producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio,
      productos!inner(id, codigo, nombre, unidad, activo, categoria_id, categorias(id, nombre)),
      depositos(id, nombre, es_principal)
    `, { count: 'exact' })
    .in('deposito_id', depIds)
    .eq('productos.activo', true)
    .order('productos(nombre)');

  if (producto_id)  q = q.eq('producto_id', producto_id);
  if (deposito_id)  q = q.eq('deposito_id', deposito_id);
  if (categoria_id) q = q.eq('productos.categoria_id', categoria_id);
  if (ids)          q = q.in('producto_id', ids);

  const UMBRAL_BAJO    = 5;
  const UMBRAL_CRITICO = 0;
  if (estado === 'critico') {
    q = q.lte('cantidad_disponible', UMBRAL_CRITICO);
  } else if (estado === 'bajo') {
    q = q.gt('cantidad_disponible', UMBRAL_CRITICO).lte('cantidad_disponible', UMBRAL_BAJO);
  } else if (estado === 'ok') {
    q = q.gt('cantidad_disponible', UMBRAL_BAJO);
  }

  const { data, error, count } = await q.range(offset, offset + limitNum - 1);
  return { data, error, count };
}

// ── Movimientos de stock ────────────────────────────────────────────────────

/**
 * Historial de movimientos de stock, paginado, con joins de producto/
 * depósito/usuario. Propaga error (el original lo maneja con errorSeguro).
 */
export async function listarMovimientos({ depIds, producto_id, offset, limitNum }) {
  let q = db
    .from('movimientos_stock')
    .select(`
      *, productos(nombre, codigo), depositos(nombre), usuarios(nombre)
    `, { count: 'exact' })
    .in('deposito_id', depIds)
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (producto_id) q = q.eq('producto_id', producto_id);

  const { data, error, count } = await q;
  return { data, error, count };
}

// ── Lotes ─────────────────────────────────────────────────────────────────────

/**
 * Un lote por id, scopeado a empresa, con joins de producto/depósito.
 * Devuelve `null` si no existe o no es de la empresa (el original solo
 * chequeaba `error` truthy → 404, sin distinguir el motivo).
 */
export async function obtenerLotePorId(id, empresa_id) {
  const { data } = await db
    .from('lotes')
    .select(`
      *,
      productos(id, codigo, nombre, unidad),
      depositos(id, nombre)
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data || null;
}

/**
 * Listado paginado de lotes con los mismos filtros semánticos de estado
 * (vencido/agotado/por_vencer/activo) y `vence_en_dias` del original.
 * Propaga error.
 */
export async function listarLotes({
  empresa_id, producto_id, deposito_id, estado, vence_en_dias, offset, limitNum,
}) {
  // FIX (F3-03, auditoría de páginas Fase 3): lotes.estado es una columna
  // que se supone se autoactualiza (vencido/agotado) pero la función que
  // lo hacía nunca se llamaba desde ningún lado y además quedó rota tras
  // un cambio de constraint — el badge mostraba "Activo" para lotes ya
  // vencidos o agotados. Se autocorrige acá mismo antes de leer.
  try {
    await db.rpc('actualizar_estado_lotes', { p_empresa_id: empresa_id });
  } catch (_err) {
    // No crítico: seguimos con la lectura aunque falle la autocorrección
    // de estado (ver comentario arriba). No usar .catch() encadenado acá:
    // el builder de postgrest-js es "thenable" (implementa .then) pero NO
    // una Promise nativa, no tiene método .catch() propio — encadenarlo
    // tira "TypeError: ...catch is not a function" (hallazgo real en prod,
    // Vercel runtime errors, correlation_id ee3a14bc-aa81-477e-90f2-836c4f7a3e6a).
  }

  let query = db
    .from('lotes')
    .select(`
      id, numero_lote, cantidad, fecha_vencimiento,
      fecha_fabricacion, estado, costo_unitario, created_at,
      productos(id, codigo, nombre, unidad),
      depositos(id, nombre)
    `, { count: 'exact' })
    .eq('empresa_id', empresa_id)
    // Los lotes dados de baja lógica (soft-delete, migración 470) no se
    // listan por defecto — siguen en la base para auditoría/historial
    // pero no deben aparecer en la grilla de "Lotes y vencimientos".
    .neq('estado', 'eliminado')
    .order('fecha_vencimiento', { ascending: true, nullsFirst: false });

  if (producto_id)  query = query.eq('producto_id', producto_id);
  if (deposito_id)  query = query.eq('deposito_id', deposito_id);

  const hoy = new Date();
  if (estado === 'vencido') {
    query = query.lt('fecha_vencimiento', hoy.toISOString()).gt('cantidad', 0);
  } else if (estado === 'agotado') {
    query = query.eq('cantidad', 0);
  } else if (estado === 'por_vencer') {
    const diasNum = parseInt(vence_en_dias || '7');
    const limite  = new Date(hoy.getTime() + diasNum * 86_400_000);
    query = query
      .gte('fecha_vencimiento', hoy.toISOString())
      .lte('fecha_vencimiento', limite.toISOString())
      .gt('cantidad', 0);
  } else if (estado === 'activo') {
    query = query.gt('fecha_vencimiento', hoy.toISOString()).gt('cantidad', 0);
  }

  if (vence_en_dias && !estado) {
    const diasNum = parseInt(vence_en_dias);
    const limite  = new Date(hoy.getTime() + diasNum * 86_400_000);
    query = query
      .lte('fecha_vencimiento', limite.toISOString())
      .gt('cantidad', 0);
  }

  const { data, error, count } = await query.range(offset, offset + limitNum - 1);
  return { data, error, count };
}

/**
 * Crea un lote. Propaga error (el original lo maneja con errorSeguro).
 */
/**
 * Crea un lote vía RPC fn_lotes_crear (migración 472), que en la misma
 * transacción inserta el lote, suma a `stock` (upsert) y deja constancia
 * en movimientos_stock / movimientos_stock_lotes — mismo patrón atómico
 * que fn_lotes_ajustar_cantidad (mig. 470) y fn_lotes_dar_de_baja (mig. 352).
 * Antes esto era un INSERT plano que nunca tocaba stock ni movimientos.
 */
export async function crearLote(payload, usuario_id) {
  const { data, error } = await db.rpc('fn_lotes_crear', {
    p_empresa_id:        payload.empresa_id,
    p_producto_id:       payload.producto_id,
    p_cantidad:          payload.cantidad,
    p_deposito_id:       payload.deposito_id ?? null,
    p_numero_lote:       payload.numero_lote ?? null,
    p_costo_unitario:    payload.costo_unitario ?? null,
    p_fecha_fabricacion: payload.fecha_fabricacion ?? null,
    p_fecha_vencimiento: payload.fecha_vencimiento ?? null,
    p_estado:            payload.estado ?? 'activo',
    p_usuario_id:        usuario_id ?? null,
  });

  if (error) return { data: null, error };
  if (data?.ok === false) return { data: null, error: { message: data.error } };

  return { data, error: null };
}

/**
 * Lote mínimo (id, numero_lote) para la baja por vencimiento — solo para
 * armar el motivo de la RPC `fn_lotes_dar_de_baja` y confirmar pertenencia
 * a la empresa.
 */
export async function obtenerLoteParaBaja(id, empresa_id) {
  const { data } = await db
    .from('lotes')
    .select('id, numero_lote')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data || null;
}

/**
 * Lote mínimo (id, cantidad) — usado tanto en PATCH (validar antes de
 * actualizar) como en DELETE (validar que cantidad sea 0 antes de borrar).
 */
export async function obtenerLoteCantidad(id, empresa_id) {
  const { data } = await db
    .from('lotes')
    .select('id, cantidad')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return data || null;
}

/**
 * Actualiza un lote. Propaga error.
 */
export async function actualizarLote(id, patch) {
  const { error } = await db.from('lotes').update(patch).eq('id', id);
  return { error };
}

/**
 * Da de baja lógica (soft-delete) un lote: en vez de DELETE físico, marca
 * estado = 'eliminado'. El lote ya tiene cantidad 0 al llegar acá (lo
 * valida el handler antes de llamar), así que no hace falta tocar stock
 * ni movimientos — solo se preserva el registro (numero_lote, fechas,
 * costo) en vez de perderlo para siempre. Ver migración 470 / Problema 3.
 */
export async function eliminarLote(id) {
  const { error } = await db
    .from('lotes')
    .update({ estado: 'eliminado', updated_at: new Date().toISOString() })
    .eq('id', id);
  return { error };
}

/**
 * Lotes activos de un producto, ordenados FEFO (vencimiento ascendente),
 * excluyendo vencidos/sin vencimiento/agotados — insumo de las sugerencias
 * FEFO por pedido. Ignora error igual que el original.
 */
export async function listarLotesFefo(empresa_id, producto_id, hoy) {
  const { data } = await db
    .from('lotes')
    .select(`
      id, numero_lote, fecha_vencimiento, cantidad,
      depositos(nombre)
    `)
    .eq('empresa_id', empresa_id)
    .eq('producto_id', producto_id)
    .gt('cantidad', 0)
    .not('fecha_vencimiento', 'is', null)
    .gte('fecha_vencimiento', hoy)
    .not('estado', 'eq', 'agotado')
    .order('fecha_vencimiento', { ascending: true });
  return data || [];
}

// ── Pedidos / pedido_items (lecturas puntuales usadas solo desde stock.js) ──

/**
 * Estado básico de un pedido, scopeado a empresa (sugerencias FEFO).
 */
export async function obtenerPedidoEstado(pedido_id, empresa_id) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, estado')
    .eq('id', pedido_id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/**
 * Ítems de un pedido con nombre/código de producto (sugerencias FEFO).
 */
export async function listarItemsPedido(pedido_id) {
  const { data, error } = await db
    .from('pedido_items')
    .select('producto_id, cantidad, productos(nombre, codigo)')
    .eq('pedido_id', pedido_id);
  return { data, error };
}

/**
 * Pedidos entregados de un cliente en los últimos N días, con sus ítems —
 * insumo del motor de sugerencias. Devuelve `{ data, error }` tal cual (el
 * handler distingue este error con un mensaje propio, no errorSeguro
 * genérico).
 */
export async function listarPedidosHistoricoCliente(empresa_id, cliente_id, desde) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, pedido_items(producto_id, cantidad, precio_unitario)')
    .eq('cliente_id', cliente_id)
    .eq('empresa_id', empresa_id)
    .gte('created_at', desde)
    .eq('estado', 'entregado');
  return { data, error };
}

// ── Sugerencias de pedido ────────────────────────────────────────────────────

/**
 * Borra sugerencias vencidas de un cliente (housekeeping previo a guardar
 * las nuevas). Ignora error igual que el original.
 */
export async function limpiarSugerenciasExpiradas(empresa_id, cliente_id) {
  await db
    .from('sugerencias_pedido')
    .delete()
    .eq('cliente_id', cliente_id)
    .eq('empresa_id', empresa_id)
    .lt('expira_at', new Date().toISOString());
}

/**
 * Inserta las sugerencias generadas. Devuelve `{ error }` tal cual (el
 * handler tiene su propio mensaje de error, no errorSeguro genérico).
 */
export async function guardarSugerencias(rows) {
  const { error } = await db.from('sugerencias_pedido').insert(rows);
  return { error };
}

// ── Categorías ────────────────────────────────────────────────────────────────

/**
 * Categorías activas con al menos un producto activo — portal cliente.
 * Propaga error.
 */
export async function listarCategoriasConProductos(empresa_id) {
  const { data, error } = await db
    .from('categorias')
    .select(`
      id, nombre, descripcion, orden,
      productos!inner(id)
    `)
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .eq('productos.activo', true)
    .order('orden', { ascending: true, nullsFirst: false })
    .order('nombre');
  return { data, error };
}

// ── Ofertas de liquidación ───────────────────────────────────────────────────

/**
 * Mejor oferta activa (no vencida) por producto, para un lote de IDs —
 * portal cliente. Ignora error igual que el original.
 */
export async function listarOfertasParaProductos(empresa_id, ids) {
  const { data } = await db
    .from('ofertas_liquidacion')
    .select('producto_id, precio_oferta, descuento_pct, vence_oferta_at, cantidad_snapshot')
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .gt('vence_oferta_at', new Date().toISOString())
    .in('producto_id', ids);
  return data || [];
}

/**
 * Ofertas activas para un lote de `lote_id` recién creados — usado para
 * armar el push de "oferta relámpago" tras el cron de liquidación. Ignora
 * error igual que el original.
 */
export async function listarOfertasPorLotes(empresa_id, loteIds) {
  const { data } = await db
    .from('ofertas_liquidacion')
    .select('producto_id, descuento_pct, vence_oferta_at')
    .in('lote_id', loteIds)
    .eq('empresa_id', empresa_id)
    .eq('activa', true);
  return data || [];
}

/**
 * Todas las ofertas activas de la empresa, con datos de producto/lote —
 * panel admin. Propaga error.
 */
export async function listarOfertasActivas(empresa_id) {
  const { data, error } = await db
    .from('ofertas_liquidacion')
    .select(`
      id, lote_id, producto_id, precio_oferta, descuento_pct,
      cantidad_snapshot, dias_restantes_al_crear, vence_oferta_at, created_at,
      productos(nombre, codigo, precio_base, foto_url),
      lotes(numero_lote, fecha_vencimiento)
    `)
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .order('vence_oferta_at', { ascending: true });
  return { data, error };
}

// ── Reglas de volumen (reglas_precio, migración 526) ─────────────────────────

/**
 * Teaser de reglas de volumen para el catálogo del portal cliente: por cada
 * producto de `producto_ids`, elige la regla activa y vigente con
 * cantidad_minima > 1 más específica (producto > categoría; entre empatadas,
 * mayor prioridad; entre empatadas, el escalón de cantidad más bajo, que es
 * el "próximo descuento" para el visitante). No resuelve el precio final
 * (eso lo sigue haciendo resolver_precios_cliente al armar el carrito con la
 * cantidad real) — es solo informativo. Ignora error igual que el resto de
 * las funciones de este archivo: si algo falla, el catálogo sigue sin teaser.
 */
export async function listarReglasVolumenCatalogo(cliente_id, producto_ids, empresa_id) {
  if (!producto_ids?.length) return [];

  const { data: productosInfo } = await db
    .from('productos')
    .select('id, categoria_id')
    .in('id', producto_ids);
  const categoriaPorProducto = new Map((productosInfo || []).map(p => [p.id, p.categoria_id]));
  const categoriaIds = [...new Set((productosInfo || []).map(p => p.categoria_id).filter(Boolean))];

  let zonaClienteId = null;
  if (cliente_id) {
    const { data: cliente } = await db
      .from('clientes')
      .select('zona_id')
      .eq('id', cliente_id)
      .maybeSingle();
    zonaClienteId = cliente?.zona_id || null;
  }

  let query = db
    .from('reglas_precio')
    .select('producto_id, categoria_id, zona_id, cantidad_minima, tipo_descuento, valor, fecha_desde, fecha_hasta, prioridad')
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .gt('cantidad_minima', 1);

  const filtroAlcance = categoriaIds.length
    ? `producto_id.in.(${producto_ids.join(',')}),categoria_id.in.(${categoriaIds.join(',')})`
    : `producto_id.in.(${producto_ids.join(',')})`;
  query = query.or(filtroAlcance);

  const { data: reglas, error } = await query;
  if (error || !reglas) return [];

  const hoy = new Date().toISOString().slice(0, 10);
  const vigentes = reglas.filter(r =>
    (!r.fecha_desde || r.fecha_desde <= hoy) &&
    (!r.fecha_hasta || r.fecha_hasta >= hoy) &&
    (!r.zona_id || r.zona_id === zonaClienteId)
  );

  const resultado = [];
  for (const pid of producto_ids) {
    const catId = categoriaPorProducto.get(pid);
    const candidatas = vigentes.filter(r =>
      r.producto_id === pid || (!r.producto_id && r.categoria_id && r.categoria_id === catId)
    );
    if (!candidatas.length) continue;

    candidatas.sort((a, b) => {
      const especificidadA = a.producto_id ? 1 : 0;
      const especificidadB = b.producto_id ? 1 : 0;
      if (especificidadA !== especificidadB) return especificidadB - especificidadA;
      if (a.prioridad !== b.prioridad) return b.prioridad - a.prioridad;
      return +a.cantidad_minima - +b.cantidad_minima;
    });

    const elegida = candidatas[0];
    resultado.push({
      producto_id:     pid,
      cantidad_minima: elegida.cantidad_minima,
      tipo_descuento:  elegida.tipo_descuento,
      valor:           elegida.valor,
    });
  }
  return resultado;
}

// ── Reglas de liquidación ────────────────────────────────────────────────────

/**
 * Reglas de liquidación de la empresa (o `null` si nunca configuró). Ignora
 * error igual que el original.
 */
export async function obtenerReglas(empresa_id) {
  const { data } = await db
    .from('reglas_liquidacion')
    .select('*')
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data || null;
}

/**
 * Upsert de reglas de liquidación (onConflict empresa_id). Propaga error.
 */
export async function guardarReglas(payload) {
  const { data, error } = await db
    .from('reglas_liquidacion')
    .upsert(payload, { onConflict: 'empresa_id' })
    .select()
    .single();
  return { data, error };
}
