// lib/repos/productos.js
// Capa de acceso a datos para `productos`.
//
// Fase 7, paso 3 del plan de migración (FASE7_PLAN_ARRANQUE.md). `productos`
// no tenía dueño único — dispersa en 11 handlers. Este primer lote cubre los
// 6 usos aislados y de bajo riesgo (lecturas simples, sin tocar el camino
// crítico de pedidos/pos/stock, que se dejan para cuando se migren esos
// módulos — así no se tocan dos veces). Quedan pendientes por volumen:
// migracion.js (5), auto-imagenes.js (3), stock.js (3), y pedidos.js/pos.js
// (7+7, para el paso 6 grande del plan).

import { db } from './_db.js';

/**
 * true si la empresa tiene al menos un producto cargado (checklist de
 * onboarding del panel admin).
 */
export async function existeProductoParaEmpresa(empresa_id) {
  const { data } = await db
    .from('productos')
    .select('id')
    .eq('empresa_id', empresa_id)
    .limit(1);
  return (data || []).length > 0;
}

/**
 * Productos activos que deben evaluarse contra el umbral de stock mínimo.
 * UI-005: ya no filtra por stock_minimo > 0 — se devuelven TODOS los productos
 * activos para que el motor de automatización pueda aplicar el umbral por
 * defecto (5 unidades) a los que no tengan stock_minimo configurado. Antes,
 * esos productos quedaban silenciados: la query los excluía y nunca
 * generaban alertas de quiebre, aunque su stock real fuera 0.
 */
export async function listarProductosConStockMinimo(empresa_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, nombre, unidad, stock_minimo')
    .eq('empresa_id', empresa_id)
    .eq('activo', true);

  if (error) throw new Error(`[ProductosRepo.listarConStockMinimo] ${error.message}`);
  return data || [];
}

/**
 * Búsqueda global (header admin) por código o nombre. `like` ya viene
 * armado por el caller (con el `%...%` y los caracteres reservados de
 * PostgREST escapados) para no duplicar esa lógica acá.
 */
export async function buscarProductos(empresa_id, { like, limit = 5 } = {}) {
  const { data, error } = await db
    .from('productos')
    .select('id, codigo, nombre, unidad')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .or(`codigo.ilike.${like},nombre.ilike.${like}`)
    .limit(limit);

  if (error) throw new Error(`[ProductosRepo.buscar] ${error.message}`);
  return data || [];
}

/**
 * Nombre + código por lote de IDs (detalle de recepción de OC en
 * proveedores.js — arma el historial legible de qué se recibió).
 */
export async function obtenerProductosPorIds(ids) {
  if (!ids?.length) return [];
  const { data, error } = await db
    .from('productos')
    .select('id, nombre, codigo')
    .in('id', ids);

  if (error) throw new Error(`[ProductosRepo.obtenerPorIds] ${error.message}`);
  return data || [];
}

/**
 * Costo + nombre por lote de IDs (motor de reposición automática de
 * stock-auto.js — arma las líneas de la OC sugerida).
 */
export async function obtenerCostosPorIds(ids) {
  if (!ids?.length) return [];
  const { data, error } = await db
    .from('productos')
    .select('id, costo, nombre')
    .in('id', ids);

  if (error) throw new Error(`[ProductosRepo.obtenerCostosPorIds] ${error.message}`);
  return data || [];
}

/**
 * Precio base + IVA por lote de IDs, filtrado por empresa_id (usado para
 * cotizar/validar pedidos — hoy solo el borrador de WhatsApp en notif.js).
 * El filtro por empresa_id es también la validación de "el producto
 * pertenece a esta empresa": el caller compara data.length contra la
 * cantidad de IDs pedidos.
 *
 * A diferencia del resto de las funciones de este repo, acá se devuelve
 * `data` crudo (puede ser null si hubo error) en vez de `[]` — el
 * comportamiento original en notif.js ignoraba `error` y dejaba que el
 * chequeo de longitud contra `productoIds` hiciera de guard; se replica
 * ese comportamiento tal cual (expand-contract, sin mejorarlo de paso).
 */
export async function obtenerProductosParaCotizarPedido(empresa_id, ids) {
  const { data } = await db
    .from('productos')
    .select('id, precio_base, iva')
    .in('id', ids)
    .eq('empresa_id', empresa_id);
  return data;
}

// ── Lote 2 (migracion.js, auto-imagenes.js, stock.js) ──────────────────────

/**
 * id + código de todos los productos de una empresa — usado por
 * migracion.js para armar el Map código→id al mapear filas importadas
 * contra productos existentes. Las 5 apariciones en migracion.js eran
 * idénticas (mismo select, mismo filtro), se unifican en esta única función.
 */
export async function listarCodigosProductosPorEmpresa(empresa_id) {
  const { data, error } = await db
    .from('productos')
    .select('id, codigo')
    .eq('empresa_id', empresa_id);

  if (error) throw new Error(`[ProductosRepo.listarCodigosPorEmpresa] ${error.message}`);
  return data || [];
}

/**
 * Productos activos sin foto_url, para el próximo lote del auto-completado
 * de imágenes. `excluirIds` saca los que ya se intentaron en esta misma
 * corrida (ver nota histórica del bug de loop infinito en auto-imagenes.js).
 */
export async function listarProductosSinFoto(empresa_id, { limit, excluirIds = [] } = {}) {
  let query = db
    .from('productos')
    .select('id, codigo, nombre')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .is('foto_url', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (excluirIds.length > 0) {
    query = query.not('id', 'in', `(${excluirIds.join(',')})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`[ProductosRepo.listarSinFoto] ${error.message}`);
  return data || [];
}

/**
 * Persiste la foto resuelta automáticamente para un producto.
 */
export async function actualizarFotoProducto(producto_id, { foto_url, foto_fuente }) {
  const { error } = await db
    .from('productos')
    .update({ foto_url, foto_fuente: foto_fuente || null })
    .eq('id', producto_id);

  if (error) throw new Error(`[ProductosRepo.actualizarFoto] ${error.message}`);
}

/**
 * Cuenta cuántos productos activos de la empresa siguen sin foto (para el
 * contador "restantes" del loop del frontend de auto-imagenes).
 */
export async function contarProductosSinFoto(empresa_id) {
  const { count } = await db
    .from('productos')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .is('foto_url', null);
  return count || 0;
}

/**
 * IDs de productos que matchean un término de búsqueda libre (nombre o
 * código) — paso previo en stock.js para poder filtrar la vista de stock
 * por texto, ya que PostgREST no permite ilike sobre columnas embebidas.
 * A diferencia del resto de las funciones de este repo, ignora `error` y
 * devuelve `[]` en ese caso — mismo comportamiento que tenía el query
 * directo original (no se valida ahí, el caller ya trata "sin resultados"
 * y "error de conexión" igual: lista vacía).
 */
export async function buscarIdsProductos(empresa_id, term) {
  const { data } = await db
    .from('productos')
    .select('id')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .or(`nombre.ilike.%${term}%,codigo.ilike.%${term}%`);
  return data || [];
}

/**
 * true si el producto existe y pertenece a la empresa — guard de alta de
 * lotes de stock (evita cargar un lote a un producto de otra empresa).
 * Ignora error igual que el query original (ambos casos, error o 404 real,
 * el caller responde el mismo 404 genérico).
 */
export async function perteneceProductoAEmpresa(producto_id, empresa_id) {
  const { data } = await db
    .from('productos')
    .select('id')
    .eq('id', producto_id)
    .eq('empresa_id', empresa_id)
    .single();
  return !!data;
}

/**
 * id/nombre/precio_base por lote de IDs, para el motor de sugerencias de
 * reposición (handleSugerencias en stock.js). A diferencia de las otras
 * funciones "silenciosas" de este repo, acá sí se propaga el error crudo
 * (sin envolver en Error nuevo) porque el handler original loggeaba el
 * objeto de error completo y respondía un 500 con mensaje propio — se
 * replica ese comportamiento exacto dejando que el caller haga el
 * try/catch.
 */
export async function obtenerProductosParaSugerencias(empresa_id, ids) {
  const { data, error } = await db
    .from('productos')
    .select('id, nombre, precio_base')
    .in('id', ids)
    .eq('empresa_id', empresa_id)
    .eq('activo', true);
  if (error) throw error;
  return data;
}

// ── Lote 3 (pedidos.js, Fase 7 paso 6) ──────────────────────────────────────

/**
 * Nombre de un único producto — usado en los mensajes de error de "stock
 * insuficiente" de pedidos.js. Ignora `error` y devuelve `null` (no lanza):
 * el caller ya cae al fallback de mostrar el producto_id crudo en el
 * mensaje, mismo comportamiento que el `prod?.nombre` original.
 */
export async function obtenerNombreProducto(producto_id) {
  const { data } = await db
    .from('productos')
    .select('nombre')
    .eq('id', producto_id)
    .single();
  return data?.nombre ?? null;
}

/**
 * Precio base + IVA + nombre por lote de IDs, filtrado por empresa_id —
 * validación de alta de pedido (pedidos.js). El filtro por empresa_id es
 * también la validación de "el producto pertenece a esta empresa": el
 * caller compara data.length contra la cantidad de IDs pedidos. Se
 * devuelve `data` crudo (mismo criterio que obtenerProductosParaCotizarPedido)
 * en vez de `[]`, para no alterar ese chequeo de longitud.
 */
export async function obtenerProductosParaValidarPedido(empresa_id, ids) {
  const { data } = await db
    .from('productos')
    .select('id, nombre, precio_base, iva')
    .in('id', ids)
    .eq('empresa_id', empresa_id);
  return data;
}

/**
 * Precio base + IVA + costo por lote de IDs, filtrado por empresa_id —
 * cotización de pedido con costo (el `costo` se excluye de la respuesta al
 * cliente más arriba en el handler, acá solo se trae el dato crudo).
 * Ignora `error` y devuelve `[]`, ya que el handler original no
 * distinguía "sin resultados" de "error de conexión".
 */
export async function obtenerProductosParaCotizarConCosto(empresa_id, ids) {
  const { data } = await db
    .from('productos')
    .select('id, precio_base, iva, costo')
    .in('id', ids)
    .eq('empresa_id', empresa_id);
  return data || [];
}

/**
 * Catálogo simplificado para el picker de remitos manuales (chofer).
 * Filtra por empresa_id + activo, ordena por nombre y limita a 200 filas.
 * Si viene `busqueda`, agrega el `or()` de texto libre sobre nombre/código.
 * Propaga el error crudo (no lo envuelve) para que el handler responda
 * con `errorSeguro`.
 */
export async function buscarProductosParaRemito(empresa_id, { busqueda } = {}) {
  let query = db
    .from('productos')
    .select('id, codigo, nombre, unidad, precio_base')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .order('nombre')
    .limit(200);

  if (busqueda) {
    query = query.or(`nombre.ilike.%${busqueda}%,codigo.ilike.%${busqueda}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * id/nombre/proveedor_id_default por lote de IDs — resolución del
 * proveedor por defecto al armar notas de débito automáticas en
 * devoluciones de producto defectuoso. Ignora `error` y devuelve `[]`:
 * los ítems correspondientes caen al camino "sin proveedor por defecto",
 * ya manejado explícitamente por el caller.
 */
export async function obtenerProveedorDefaultPorProductos(ids) {
  const { data } = await db
    .from('productos')
    .select('id, nombre, proveedor_id_default')
    .in('id', ids);
  return data || [];
}

// ── Lote 4 (pos.js, Fase 7 paso 6) ──────────────────────────────────────────

/**
 * Búsqueda de productos del POS (GET /api/pos/productos). Cubre las 3
 * estrategias en cascada del handler (código de balanza → código exacto →
 * texto libre) con una única función parametrizada, ya que las 3 comparten
 * el mismo select y el mismo filtro base (empresa_id + activo); la cascada
 * en sí (probar una estrategia, caer a la siguiente si no hay resultados)
 * es lógica de negocio y se queda en el handler. Propaga el error crudo
 * para que el handler responda con `errorSeguro`, igual que el query
 * original.
 */
export async function buscarProductosPos(empresa_id, { codigo, vendidoPorPeso, textoLibre, limit } = {}) {
  const baseSelect = 'id, codigo, nombre, precio_base, iva, unidad, vendido_por_peso';

  const query = () => {
    let q = db.from('productos').select(baseSelect).eq('empresa_id', empresa_id).eq('activo', true);
    if (vendidoPorPeso) q = q.eq('vendido_por_peso', true);
    return q;
  };

  if (codigo) {
    let q = query().eq('codigo', codigo);
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  if (textoLibre) {
    // FIX (v787): antes se pedía `.or('codigo.ilike.%term%,nombre.ilike.%term%')`
    // con `.limit(N)` y sin ORDER BY — cuando había más matches que el
    // límite, Postgres devolvía un subconjunto arbitrario (orden físico de
    // la tabla, no relevancia), así que un producto recién creado con un
    // nombre corto y genérico (ej. "caramelo") podía quedar afuera del
    // resultado aunque matcheara perfecto, tapado por decenas de productos
    // más largos que también matcheaban el mismo texto (ej. "CARAMELOS
    // ARCOR..."). Ahora se rankea en 3 niveles — match exacto de nombre,
    // nombre que empieza con el texto, y el resto por substring — llenando
    // el `limit` en ese orden, así lo más relevante aparece primero y no
    // se pierde por el corte del límite.
    const term  = textoLibre.replace(/^%|%$/g, ''); // texto sin los % que arma el caller
    const tope  = limit || 20;
    const vistos = new Set();
    const resultado = [];

    const agregar = (filas) => {
      for (const fila of filas) {
        if (vistos.has(fila.id)) continue;
        vistos.add(fila.id);
        resultado.push(fila);
        if (resultado.length >= tope) return true;
      }
      return resultado.length >= tope;
    };

    // Nivel 1: código o nombre exactos (case-insensitive).
    let { data: exactos, error: errExactos } = await query()
      .or(`codigo.ilike.${term},nombre.ilike.${term}`)
      .limit(tope);
    if (errExactos) throw errExactos;
    if (agregar(exactos || [])) return resultado;

    // Nivel 2: código o nombre que empiezan con el texto.
    let { data: prefijo, error: errPrefijo } = await query()
      .or(`codigo.ilike.${term}%,nombre.ilike.${term}%`)
      .limit(tope);
    if (errPrefijo) throw errPrefijo;
    if (agregar(prefijo || [])) return resultado;

    // Nivel 3: el resto — contiene el texto en cualquier posición.
    let { data: contiene, error: errContiene } = await query()
      .or(`codigo.ilike.%${term}%,nombre.ilike.%${term}%`)
      .limit(tope);
    if (errContiene) throw errContiene;
    agregar(contiene || []);

    return resultado;
  }

  let q = query();
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/**
 * categoria_id por lote de IDs — usado en la búsqueda del POS para poder
 * matchear promociones vigentes por categoría. Ignora `error` (mismo
 * comportamiento que el query original: sin categorías, simplemente no
 * aplica ninguna promo por categoría).
 */
export async function obtenerCategoriasDeProductos(ids) {
  if (!ids?.length) return [];
  const { data } = await db
    .from('productos')
    .select('id, categoria_id')
    .in('id', ids);
  return data || [];
}

/**
 * nombre + precio_base + iva + activo por lote de IDs, filtrado por
 * empresa_id — validación de ítems al registrar una venta del POS. Ignora
 * `error` igual que el query original (el caller ya trata "no encontrado"
 * como 400 por cada item ausente del map resultante).
 */
export async function obtenerProductosParaVentaPos(empresa_id, ids) {
  const { data } = await db
    .from('productos')
    .select('id, nombre, precio_base, iva, activo')
    .eq('empresa_id', empresa_id)
    .in('id', ids);
  return data || [];
}

/**
 * Productos activos de la empresa (id/nombre/codigo), ordenados por
 * nombre y acotados a 500 — insumo de la alerta de stock del POS
 * (GET /api/pos/stock-alerta), que después cruza contra el stock del
 * depósito de la caja. Ignora `error` igual que el query original.
 */
export async function listarProductosActivosParaAlertaStock(empresa_id) {
  const { data } = await db
    .from('productos')
    .select('id, nombre, codigo')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .order('nombre')
    .limit(500);
  return data || [];
}

/**
 * Productos por lote de IDs con los campos que necesita el motor de
 * impresión de etiquetas (frontend/admin/js/etiquetas-print.js,
 * resolverCodigo()/precioConIva()) — generador de etiquetas de precio/
 * código de barras, Etapa 2 (543, ver PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md).
 * `fn_productos_lista` (el RPC que alimenta la grilla del listado) no trae
 * estos campos porque la tabla no los muestra — esta es la única función
 * de este repo pensada para alimentar la vista previa/impresión, no la
 * grilla en sí.
 *
 * Igual criterio que obtenerProductosParaCotizarPedido: filtrada por
 * empresa_id además de por id (evita que un usuario pida por ids de
 * productos de otra empresa), y el caller compara data.length contra la
 * cantidad de ids pedidos para avisar si alguno ya no existe/no
 * pertenece a la empresa — no es un error, es un caso esperado (producto
 * borrado entre que se tildó y se generó la etiqueta).
 */
export async function obtenerProductosParaEtiquetas(empresa_id, ids) {
  if (!ids?.length) return [];
  const { data, error } = await db
    .from('productos')
    .select('id, nombre, codigo, codigo_es_barras, precio_base, iva, vendido_por_peso, unidad')
    .eq('empresa_id', empresa_id)
    .in('id', ids);

  if (error) throw new Error(`[ProductosRepo.obtenerParaEtiquetas] ${error.message}`);
  const productos = data || [];
  if (!productos.length) return productos;

  // Etapa 4 (543): precio regular (vía lista_precio_default_id de
  // config_etiquetas, o precio_base si no hay lista configurada) +
  // precio promocional tachado si hay una reglas_precio general
  // vigente (ver resolver_precios_etiquetas, migración
  // 20260824060000_543_etiquetas_etapa4_promociones.sql). Se resuelve
  // acá y no en el frontend porque reglas_precio nunca se expone al
  // cliente sin filtrar (RLS de reglas_precio exige rol
  // dueño/admin/contador — un vendedor generando etiquetas no
  // necesariamente tiene ese rol, así que el frontend no podría leer
  // la tabla directo).
  //
  // Fallo del RPC (config_etiquetas sin fila todavía, o cualquier otro
  // problema): no corta la generación de etiquetas por esto — se
  // sigue con precio_base a secas, sin promoción, como venía
  // funcionando hasta la Etapa 3. El precio de venta real nunca sale
  // de acá — es solo el texto que se imprime en el cartel.
  const { data: precios, error: errPrecios } = await db.rpc('resolver_precios_etiquetas', {
    p_empresa_id: empresa_id,
    p_producto_ids: productos.map(p => p.id),
  });

  if (errPrecios) {
    console.warn('[ProductosRepo.obtenerParaEtiquetas] resolver_precios_etiquetas falló, se sigue sin promociones:', errPrecios.message);
    return productos;
  }

  const porId = new Map((precios || []).map(p => [p.producto_id, p]));
  return productos.map(p => {
    const resuelto = porId.get(p.id);
    return {
      ...p,
      precio_regular: resuelto?.precio_regular ?? p.precio_base,
      precio_promocional: resuelto?.precio_promocional ?? null,
      regla_nombre: resuelto?.regla_nombre ?? null,
    };
  });
}
