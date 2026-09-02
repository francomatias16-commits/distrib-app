// api/stock/index.js
// GET   /api/stock              → stock actual por producto/depósito
// POST  /api/stock              → ajuste manual de stock
// GET   /api/stock?movimientos  → historial de movimientos

import { rateLimit } from '../rate-limit.js';
import { notifAuto } from './_auto-push.js';
import { notificarOfertaRelampago } from './_push.js';
import { errorSeguro } from '../error-response.js';
import { cacheado } from '../cache.js';
import { buscarIdsProductos, perteneceProductoAEmpresa, obtenerProductosParaSugerencias } from '../repos/productos.js';
import { puede } from '../permisos-service.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { obtenerConfig, listarEmpresasActivas } from '../repos/empresas.js';
import {
  listarDepositosIds, existeDepositoEnEmpresa,
  obtenerCantidadStock, listarStockPorProducto, buscarStockPaginado,
  listarMovimientos,
  obtenerLotePorId, listarLotes, crearLote, obtenerLoteParaBaja, obtenerLoteCantidad,
  actualizarLote, eliminarLote, listarLotesFefo,
  obtenerPedidoEstado, listarItemsPedido, listarPedidosHistoricoCliente,
  limpiarSugerenciasExpiradas, guardarSugerencias,
  listarCategoriasConProductos,
  listarOfertasParaProductos, listarOfertasPorLotes, listarOfertasActivas,
  listarReglasVolumenCatalogo,
  obtenerReglas, guardarReglas,
} from '../repos/stock.js';

const _limiterStock        = rateLimit({ max: 100, windowMs: 60_000 });
const _limiterLotes        = rateLimit({ max: 60,  windowMs: 60_000 });
const _limiterLotesFefo    = rateLimit({ max: 60,  windowMs: 60_000 });
const _limiterSugerencias  = rateLimit({ max: 60,  windowMs: 60_000 });
const _limiterCliente      = rateLimit({ max: 120, windowMs: 60_000 });
const _limiterLiquidacion  = rateLimit({ max: 20,  windowMs: 60_000 });
export default async function handler(req, res) {
  if (req.method !== 'OPTIONS' && await _limiterStock(req, res)) return;
  // ── Sub-router: lotes / fefo / sugerencias (absortos para reducir Serverless Functions) ─
    const _svc = req.query._svc;
    if (_svc === 'lotes')             return handleLotes(req, res);
    if (_svc === 'lotes-fefo')        return handleLotesFefo(req, res);
    if (_svc === 'sugerencias')       return handleSugerencias(req, res);
    if (_svc === 'cliente-categorias') return handleClienteCategorias(req, res);
    if (_svc === 'cliente-productos')  return handleClienteProductos(req, res);
    if (_svc === 'liquidacion')         return handleLiquidacion(req, res);

    const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  if (!puede(perfil, 'acceder', 'stock'))
    return res.status(403).json({ error: 'Sin permisos para ver stock' });

  const empresa_id = perfil.empresa_id;
  const user = { id: perfil.id };

  // ── GET stock ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { movimientos, producto_id, deposito_id, page: pageMov = '1', limit: limitMov = '100' } = req.query;

    if (movimientos !== undefined) {
      const depIdsMov = await getDepositosEmpresa(empresa_id);
      const { data, error, count } = await listarMovimientos({
        depIds: depIdsMov,
        producto_id,
        offset: (+pageMov - 1) * +limitMov,
        limitNum: +limitMov,
      });
      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
      return res.json({ data, total: count });
    }

    // Stock actual — paginado, con filtros server-side
    // Parámetros: page, limit, q (busqueda), deposito_id, categoria_id, estado
    const {
      q: busqueda,
      categoria_id,
      estado,
      page  = '1',
      limit = '50',
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, parseInt(limit, 10));
    const offset   = (pageNum - 1) * limitNum;

    const depIds = await getDepositosEmpresa(empresa_id);

    // Filtro de búsqueda: PostgREST no permite ilike en columnas embebidas,
    // así que se obtienen los IDs de productos coincidentes primero (query ligera)
    let ids = null;
    if (busqueda && busqueda.trim()) {
      const term = busqueda.trim();
      const matchIds = await buscarIdsProductos(empresa_id, term);
      ids = (matchIds || []).map(p => p.id);
      if (!ids.length) return res.json({ data: [], total: 0, page: pageNum, pages: 0 });
    }

    const { data, error, count } = await buscarStockPaginado({
      depIds, producto_id, deposito_id, categoria_id, ids, estado, offset, limitNum,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    const result = (data || []).map(s => ({
      ...s,
      disponible: Math.max(0, (s.cantidad_disponible != null ? +s.cantidad_disponible : +s.cantidad - +s.cantidad_reservada)),
    }));

    return res.json({
      data:  result,
      total: count || 0,
      page:  pageNum,
      pages: Math.ceil((count || 0) / limitNum),
    });
  }

  // ── POST: ajuste manual ──────────────────────────────────────────
  if (req.method === 'POST') {
    if (!['dueno', 'admin', 'depositero'].includes(perfil.rol))
      return res.status(403).json({ error: 'Solo depositero/admin puede ajustar stock' });

    const { producto_id, deposito_id, cantidad, tipo = 'ajuste', notas } = req.body;

    if (!producto_id || !deposito_id || cantidad === undefined)
      return res.status(400).json({ error: 'producto_id, deposito_id y cantidad son requeridos' });

    if (!['ingreso', 'egreso', 'ajuste'].includes(tipo))
      return res.status(400).json({ error: 'tipo debe ser: ingreso, egreso o ajuste' });

    if (!Number.isInteger(cantidad) || (tipo !== 'ajuste' && cantidad <= 0) || (tipo === 'ajuste' && cantidad < 0))
      return res.status(400).json({ error: 'cantidad debe ser un número entero' + (tipo === 'ajuste' ? ' (>= 0)' : ' positivo') });

    // Etapa 2, Hallazgo 1: antes esto se resolvía acá mismo con un
    // select + upsert manual, sin validar que producto_id/deposito_id
    // fueran de esta empresa (permitía tocar stock de otra empresa) y sin
    // lock atómico (dos ajustes concurrentes podían pisarse). Ahora se usa
    // ajustar_stock(), la misma RPC que ya usa el frontend para
    // transferencias entre depósitos, que sí valida empresa y lockea la
    // fila (FOR UPDATE) antes de escribir.
    const depIdsPropios = await getDepositosEmpresa(empresa_id);
    if (!depIdsPropios.includes(deposito_id))
      return res.status(404).json({ error: 'Depósito no encontrado' });

    let delta;
    if (tipo === 'ajuste') {
      // 'ajuste' fija un valor absoluto, no un delta: se necesita leer el
      // valor actual para calcularlo. Esa lectura no es atómica con la
      // escritura (igual que antes), pero el propio ajustar_stock() lockea
      // la fila antes de aplicar el delta resultante, así que dos ajustes
      // concurrentes ya no pueden perderse entre sí — en el peor caso, el
      // que llega segundo parte de una foto un instante vieja del valor
      // "absoluto" pretendido, que es una limitación inherente a pedir un
      // valor absoluto (no del delta) y no algo que este fix deba resolver.
      const cantidadActual = await obtenerCantidadStock(producto_id, deposito_id);
      delta = cantidad - (cantidadActual || 0);
    } else if (tipo === 'ingreso') {
      delta = cantidad;
    } else {
      delta = -cantidad;
    }

    const { data: rpcResult, error: rpcError } = await db.rpc('ajustar_stock', {
      p_producto_id: producto_id,
      p_deposito_id: deposito_id,
      p_delta: delta,
      p_tipo: tipo === 'ajuste' ? null : tipo,
      p_motivo: notas || `Ajuste manual (${tipo})`,
      p_notas: notas || null,
      p_usuario_id: user.id,
    });

    if (rpcError) return errorSeguro(res, rpcError, 500, 'No se pudo completar la operación.');
    if (!rpcResult?.ok) return res.status(400).json({ error: rpcResult?.error || 'No se pudo ajustar el stock' });

    return res.json({ ok: true, cantidad_nueva: rpcResult.stock_nuevo });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

async function getDepositosEmpresa(empresa_id) {
  return listarDepositosIds(empresa_id);
}



// ══════════════════════════════════════════════════════════════════════════
// ── Lotes (absorto desde api/lotes/index.js) ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════



async function handleLotes(req, res) {
  if (await _limiterLotes(req, res)) return;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  if (!puede(perfil, 'leer', 'stock_lotes'))
    return res.status(403).json({ error: 'Sin permisos' });

  const empresa_id = perfil.empresa_id;
  const esEscritor = puede(perfil, 'escribir', 'stock_lotes');
  const user = { id: perfil.id };

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const {
      id,
      producto_id,
      deposito_id,
      estado,          // 'activo' | 'por_vencer' | 'vencido' | 'agotado'
      vence_en_dias,   // número: lotes que vencen en N días o menos
      page  = '1',
      limit = '100',
    } = req.query;

    if (id) {
      const data = await obtenerLotePorId(id, empresa_id);
      if (!data) return res.status(404).json({ error: 'Lote no encontrado' });
      return res.json(data);
    }

    // Lista
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, parseInt(limit));
    const offset   = (pageNum - 1) * limitNum;

    const { data, error, count } = await listarLotes({
      empresa_id, producto_id, deposito_id, estado, vence_en_dias, offset, limitNum,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    return res.json({
      data: data || [],
      total: count || 0,
      page: pageNum,
      pages: Math.ceil((count || 0) / limitNum),
    });
  }

  // ── POST: crear lote ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!esEscritor) return res.status(403).json({ error: 'Sin permisos' });

    const {
      producto_id,
      deposito_id,
      numero_lote,
      cantidad,
      fecha_vencimiento,
      fecha_fabricacion,
      costo_unitario,
    } = req.body;

    if (!producto_id || !cantidad || cantidad <= 0)
      return res.status(400).json({ error: 'producto_id y cantidad > 0 son requeridos' });

    // Verificar que el producto pertenece a la empresa
    const existeProducto = await perteneceProductoAEmpresa(producto_id, empresa_id);

    if (!existeProducto) return res.status(404).json({ error: 'Producto no encontrado' });

    // Etapa 2, Hallazgo 2: se validaba producto_id contra la empresa pero
    // no deposito_id, permitiendo crear un lote que apunta al depósito de
    // otra empresa (dato inconsistente, aunque no movía stock ajeno).
    if (deposito_id) {
      const existeDep = await existeDepositoEnEmpresa(deposito_id, empresa_id);
      if (!existeDep) return res.status(404).json({ error: 'Depósito no encontrado' });
    }

    const { data: resultado, error } = await crearLote({
      empresa_id,
      producto_id,
      deposito_id:       deposito_id || null,
      numero_lote:       numero_lote || null,
      cantidad:          parseFloat(cantidad),
      fecha_vencimiento: fecha_vencimiento || null,
      fecha_fabricacion: fecha_fabricacion || null,
      costo_unitario:    costo_unitario ? parseFloat(costo_unitario) : null,
      estado:            'activo',
    }, user.id);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    // fn_lotes_crear (migración 472) sincroniza `stock` en la misma
    // transacción — stock_sincronizado es false solo si el lote quedó sin
    // depósito asignado (ni se pasó uno ni la empresa tiene depósito
    // principal), caso legado que ya se comportaba igual en el resto del
    // circuito de lotes.
    return res.status(201).json({
      ok: true,
      id: resultado.id,
      deposito_id: resultado.deposito_id,
      stock_sincronizado: resultado.stock_sincronizado,
    });
  }

  // ── PATCH ?accion=dar_de_baja: dar de baja un lote (ej: vencido) ───────────
  // Descuenta del stock real la cantidad restante del lote (vía
  // fn_lotes_dar_de_baja, en una sola transacción) y deja el lote en 0.
  // Antes esto solo se podía hacer editando la cantidad a mano en el modal,
  // lo cual NO tocaba el stock real — la tabla `lotes` es tracking manual,
  // desconectada de `stock`. Ver migración 352.
  if (req.method === 'PATCH' && req.query.accion === 'dar_de_baja') {
    if (!esEscritor) return res.status(403).json({ error: 'Sin permisos' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const lote = await obtenerLoteParaBaja(id, empresa_id);

    if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });

    const { data: resultado, error: rpcError } = await db.rpc('fn_lotes_dar_de_baja', {
      p_lote_id:    id,
      p_motivo:     `Baja de lote vencido (${lote.numero_lote || id.slice(0, 8)})`,
      p_usuario_id: user.id,
    });

    if (rpcError || resultado?.ok === false) {
      return res.status(400).json({ error: rpcError?.message || resultado?.error || 'No se pudo dar de baja el lote.' });
    }

    return res.json({ ok: true, ...resultado });
  }

  // ── PATCH: actualizar lote ────────────────────────────────────────────────
  // Etapa 3 del plan de robustecimiento (Problema 4): cambiar `cantidad`
  // ya NO es un UPDATE directo silencioso. Si viene `cantidad`, se exige
  // `motivo` y se enruta por fn_lotes_ajustar_cantidad (migración 470),
  // que sincroniza cantidad_disponible, la tabla `stock` agregada y deja
  // un movimientos_stock (+ detalle en movimientos_stock_lotes) — igual
  // que cualquier otro movimiento del sistema. El resto de los campos
  // (fecha_vencimiento, costo_unitario, numero_lote, estado) no impactan
  // stock y se siguen editando de forma directa.
  if (req.method === 'PATCH') {
    if (!esEscritor) return res.status(403).json({ error: 'Sin permisos' });

    const {
      id, cantidad, motivo, estado, fecha_vencimiento, fecha_fabricacion,
      costo_unitario, numero_lote, deposito_id,
    } = req.body;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const lote = await obtenerLoteCantidad(id, empresa_id);

    if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });

    // Bug preexistente (independiente del plan de lotes, pero encontrado
    // en el mismo handler): el frontend ya mandaba deposito_id acá — es
    // justamente el flujo que la ayuda de "dar de baja" le pide al
    // usuario usar para asignarle depósito a un lote legado — pero el
    // backend nunca lo tomaba en cuenta. Se valida contra la empresa
    // igual que en el alta (POST) antes de aplicarlo.
    if (deposito_id) {
      const existeDep = await existeDepositoEnEmpresa(deposito_id, empresa_id);
      if (!existeDep) return res.status(404).json({ error: 'Depósito no encontrado' });
    }

    if (cantidad !== undefined) {
      if (!motivo || !String(motivo).trim()) {
        return res.status(400).json({
          error: 'Para modificar la cantidad de un lote es obligatorio indicar un motivo (queda registrado como ajuste de stock).',
        });
      }

      const { data: resultado, error: rpcError } = await db.rpc('fn_lotes_ajustar_cantidad', {
        p_lote_id:        id,
        p_cantidad_nueva: parseFloat(cantidad),
        p_motivo:         motivo,
        p_usuario_id:     user.id,
      });

      if (rpcError || resultado?.ok === false) {
        return res.status(400).json({ error: rpcError?.message || resultado?.error || 'No se pudo ajustar la cantidad del lote.' });
      }
    }

    const patch = { updated_at: new Date().toISOString() };
    if (estado)                          patch.estado            = estado;
    if (fecha_vencimiento !== undefined) patch.fecha_vencimiento = fecha_vencimiento;
    if (fecha_fabricacion !== undefined) patch.fecha_fabricacion = fecha_fabricacion;
    if (costo_unitario !== undefined)    patch.costo_unitario    = parseFloat(costo_unitario);
    if (numero_lote !== undefined)       patch.numero_lote       = numero_lote;
    if (deposito_id !== undefined)       patch.deposito_id       = deposito_id;

    if (Object.keys(patch).length > 1) {
      const { error } = await actualizarLote(id, patch);
      if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    }

    return res.json({ ok: true });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!esEscritor) return res.status(403).json({ error: 'Sin permisos' });

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    const lote = await obtenerLoteCantidad(id, empresa_id);

    if (!lote) return res.status(404).json({ error: 'No encontrado' });
    if (lote.cantidad > 0)
      return res.status(400).json({ error: 'Solo se pueden eliminar lotes con cantidad 0' });

    const { error } = await eliminarLote(id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ══════════════════════════════════════════════════════════════════════════
// ── Lotes FEFO (absorto desde api/lotes/fefo.js) ────────────────────────
// ══════════════════════════════════════════════════════════════════════════

// (gate: 'stock' → 'acceder', mismo que el handler principal y liquidación)

async function handleLotesFefo(req, res) {
  if (await _limiterLotesFefo(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  if (!puede(perfil, 'acceder', 'stock')) {
    return res.status(403).json({ error: 'Sin permisos para consultar sugerencias FEFO' });
  }

  const empresa_id = perfil.empresa_id;

  // ── Validar parámetros ────────────────────────────────────────────────────
  const { pedido_id } = req.query;
  if (!pedido_id) {
    return res.status(400).json({ error: 'pedido_id requerido' });
  }

  // ── Obtener items del pedido ──────────────────────────────────────────────
  const { data: pedido, error: pedidoError } = await obtenerPedidoEstado(pedido_id, empresa_id);

  if (pedidoError || !pedido) {
    return res.status(404).json({ error: 'Pedido no encontrado' });
  }

  const { data: items, error: itemsError } = await listarItemsPedido(pedido_id);

  if (itemsError || !items?.length) {
    return res.status(404).json({ error: 'El pedido no tiene ítems' });
  }

  const hoy = new Date().toISOString().split('T')[0];
  const sugerencias = [];

  for (const item of items) {
    // Para cada producto, buscar lotes activos ordenados por vencimiento FEFO
    const lotes = await listarLotesFefo(empresa_id, item.producto_id, hoy);

    // Stock real disponible del producto (independiente de si tiene lote registrado).
    // `lotes` es un tracking manual de vencimientos, no se descuenta de `stock` —
    // por eso la cobertura de lotes NO equivale a disponibilidad real.
    const stockFilas = await listarStockPorProducto(item.producto_id);

    const stockDisponibleReal = (stockFilas || []).reduce((acc, s) => {
      const disp = s.cantidad_disponible != null
        ? +s.cantidad_disponible
        : (+s.cantidad - +s.cantidad_reservada);
      return acc + Math.max(0, disp);
    }, 0);

    // Calcular cuánto tomar de cada lote para cubrir la cantidad pedida
    let restante = item.cantidad;
    const lotesConCantidad = [];

    for (const lote of (lotes || [])) {
      if (restante <= 0) break;
      const disponible = Math.max(0, lote.cantidad);
      if (disponible <= 0) continue;

      const usar = Math.min(restante, disponible);
      lotesConCantidad.push({
        id:                 lote.id,
        numero_lote:        lote.numero_lote || '(sin número)',
        fecha_vencimiento:  lote.fecha_vencimiento,
        cantidad_disponible: disponible,
        deposito:           lote.depositos?.nombre || '—',
        usar_cantidad:      usar,
      });
      restante -= usar;
    }

    // `restante` es lo que los lotes con vencimiento registrado NO cubren.
    // De eso, lo que sí está cubierto por `stock` real es solo falta de
    // seguimiento (no hay lote para ese excedente, pero el producto existe
    // en depósito). Sólo es falta real lo que tampoco cubre el stock físico.
    const faltaReal      = Math.max(0, item.cantidad - stockDisponibleReal);
    const sinSeguimiento = Math.max(0, restante - faltaReal);

    sugerencias.push({
      producto_id:           item.producto_id,
      nombre:                item.productos?.nombre || '—',
      codigo:                item.productos?.codigo || '',
      cantidad_pedida:       item.cantidad,
      lotes:                 lotesConCantidad,
      stock_disponible_real: stockDisponibleReal,
      cobertura_total:       restante === 0,      // cobertura sólo por lotes (vencimiento)
      faltante:              faltaReal,           // falta real: ni lote ni stock cubren
      sin_seguimiento:       sinSeguimiento,       // hay stock pero sin lote/vencimiento registrado
    });
  }

  return res.json({ ok: true, pedido_id, sugerencias });
}

// ══════════════════════════════════════════════════════════════════════════
// ── Sugerencias (absorto desde api/sugerencias/generar.js) ─────────────
// ══════════════════════════════════════════════════════════════════════════

// ── Generar Sugerencias para un Cliente ────────────────────────────────────
async function handleSugerencias(req, res) {
  if (await _limiterSugerencias(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Autenticar la solicitud
  const perfilAuth = await verificarToken(req, db);
  if (!perfilAuth) return res.status(401).json({ error: 'No autorizado' });

  // SUGERENCIAS-001: antes se confiaba en el empresa_id que mandaba el body,
  // sin validar que fuera la empresa real del usuario autenticado. Como este
  // handler usa el cliente de Supabase con SERVICE_ROLE_KEY (bypassea RLS),
  // ese filtro manual era la única protección de tenant — y al venir del
  // cliente, cualquier usuario autenticado (de cualquier rol/empresa) podía
  // pasar un empresa_id + cliente_id ajenos y leer qué productos compra ese
  // cliente de otra empresa (con precios), además de insertarle sugerencias
  // en sugerencias_pedido. Ahora empresa_id sale siempre del perfil del
  // usuario autenticado, igual que en el resto de los handlers de este
  // archivo — el valor que venga en el body se ignora.
  const empresa_id = perfilAuth.empresa_id;

  try {
    const { cliente_id } = req.body;

    if (!cliente_id) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // 1. Obtener historial de compras del cliente (últimos 90 días)
    const hace90Dias = new Date();
    hace90Dias.setDate(hace90Dias.getDate() - 90);

    const { data: pedidosHistorico, error: errorPedidos } = await listarPedidosHistoricoCliente(
      empresa_id, cliente_id, hace90Dias.toISOString()
    );

    if (errorPedidos) {
      console.error('Error al obtener pedidos:', errorPedidos);
      return res.status(500).json({ error: 'Error al obtener historial' });
    }

    if (!pedidosHistorico || pedidosHistorico.length === 0) {
      return res.status(200).json({ sugerencias: [] });
    }

    // 2. Analizar productos comprados y frecuencia
    const productoFrequencia = {};
    const productoCantidadPromedio = {};
    const productoUltimaCompra = {};

    pedidosHistorico.forEach(pedido => {
      (pedido.pedido_items || []).forEach(item => {
        const prodId = item.producto_id;

        productoFrequencia[prodId] = (productoFrequencia[prodId] || 0) + 1;
        productoCantidadPromedio[prodId] = (productoCantidadPromedio[prodId] || 0) + item.cantidad;
        productoUltimaCompra[prodId] = new Date();
      });
    });

    // Calcular promedios
    Object.keys(productoCantidadPromedio).forEach(prodId => {
      productoCantidadPromedio[prodId] = Math.ceil(
        productoCantidadPromedio[prodId] / productoFrequencia[prodId]
      );
    });

    // 3. Obtener datos de los productos
    const productosIds = Object.keys(productoFrequencia);
    let productos;
    try {
      productos = await obtenerProductosParaSugerencias(empresa_id, productosIds);
    } catch (errorProductos) {
      console.error('Error al obtener productos:', errorProductos);
      return res.status(500).json({ error: 'Error al obtener productos' });
    }

    // 4. Generar sugerencias
    const sugerencias = [];

    productos.forEach(producto => {
      const frecuencia = productoFrequencia[producto.id];
      const cantidadPromedio = productoCantidadPromedio[producto.id];
      const diasDesdeUltimaCompra = Math.floor(
        (Date.now() - new Date(productoUltimaCompra[producto.id])) / (1000 * 60 * 60 * 24)
      );

      // Calcular score de relevancia (0.0 a 1.0)
      let score = 0;
      let razon = '';

      // Compra frecuente (más de 2 veces en 90 días)
      if (frecuencia >= 2) {
        score += 0.3;
        razon = 'compra_frecuente';
      }

      // Compra reciente (menos de 30 días)
      if (diasDesdeUltimaCompra < 30) {
        score += 0.2;
        razon = 'compra_reciente';
      }

      // Ciclo de compra estimado (si pasó el tiempo promedio)
      const diasPromedioBetweenPurchases = Math.floor(90 / frecuencia);
      if (diasDesdeUltimaCompra >= diasPromedioBetweenPurchases * 0.8) {
        score += 0.25;
        razon = 'ciclo_compra_estimado';
      }

      // FIX: stock_actual no existe en productos — omitir esta comprobación (stock viene de tabla stock)
      // El stock disponible no se incluye en este SELECT; la sugerencia se basa solo en historial

      // Solo sugerir si score es relevante
      if (score >= 0.5) {
        sugerencias.push({
          producto_id: producto.id,
          nombre: producto.nombre,
          cantidad_sugerida: cantidadPromedio,
          precio_unitario: producto.precio_base,
          razon: razon,
          score: parseFloat(score.toFixed(2)),
          frecuencia_compra: frecuencia,
          dias_desde_ultima_compra: diasDesdeUltimaCompra
        });
      }
    });

    // 5. Ordenar por score y limitar a top 5
    sugerencias.sort((a, b) => b.score - a.score);
    const top5 = sugerencias.slice(0, 5);

    // 6. Guardar sugerencias en BD
    const sugerenciasParaGuardar = top5.map(s => ({
      cliente_id,
      empresa_id,
      producto_id: s.producto_id,
      cantidad_sugerida: s.cantidad_sugerida,
      razon: s.razon,
      score_relevancia: s.score
    }));

    // Limpiar sugerencias antiguas primero (scopeado a la empresa del usuario)
    await limpiarSugerenciasExpiradas(empresa_id, cliente_id);

    const { error: errorInsert } = await guardarSugerencias(sugerenciasParaGuardar);

    if (errorInsert) {
      console.error('Error al guardar sugerencias:', errorInsert);
      return res.status(500).json({ error: 'Error al guardar sugerencias' });
    }

    res.status(200).json({
      success: true,
      sugerencias: top5,
      cantidad: top5.length
    });

  } catch (error) {
    console.error('Error en generar sugerencias:', error);
    errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  }
}

// ── Función auxiliar: Calcular días entre fechas ──────────────────────────
function diasEntre(fecha1, fecha2) {
  const diferencia = Math.abs(fecha2 - fecha1);
  return Math.floor(diferencia / (1000 * 60 * 60 * 24));
}


// ══════════════════════════════════════════════════════════════════════════
// ── /api/cliente/categorias — Portal cliente (catálogo-optimizado.js)   ──
// ══════════════════════════════════════════════════════════════════════════
//
// GET /api/cliente/categorias
// Devuelve categorías que tienen al menos 1 producto activo con stock.
// No requiere auth: portal público filtrado por empresa_id de sesión anon.

async function handleClienteCategorias(req, res) {
  if (await _limiterCliente(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  // Auth: puede ser cliente autenticado o consulta pública con empresa_id param
  const empresa_id = await resolverEmpresaCliente(req);
  if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });

  // Etapa 3 del plan de robustez/escalabilidad: catálogo de categorías es
  // 100% no-personalizado (solo empresa_id — sin cliente, sin precios), así
  // que se cachea la respuesta completa. TTL 60s: las categorías activas de
  // una empresa cambian con mucha menos frecuencia que el stock.
  const { data, error } = await cacheado(
    `categorias-cliente:${empresa_id}`,
    60_000,
    () => listarCategoriasConProductos(empresa_id),
  );

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  // Proyectar: quitar el array de productos (solo necesitamos saber que existe)
  const categorias = (data || []).map(({ productos: _p, ...c }) => c);

  return res.json({ categorias });
}

// ══════════════════════════════════════════════════════════════════════════
// ── /api/cliente/productos — Portal cliente (catálogo-optimizado.js)    ──
// ══════════════════════════════════════════════════════════════════════════
//
// GET /api/cliente/productos?categoria=UUID&q=texto&page=1&limit=24
// Devuelve productos activos con stock disponible, paginados.

async function handleClienteProductos(req, res) {
  if (await _limiterCliente(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  const empresa_id = await resolverEmpresaCliente(req);
  if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });

  const {
    categoria,
    q:      busqueda,
    page  = '1',
    limit = '24',
    destacados,
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, parseInt(limit, 10));
  const offset   = (pageNum - 1) * limitNum;
  // ?destacados=1 pide solo los productos destacados (migración 529) —
  // usado por la sección fija del catálogo, independiente de la
  // categoría/búsqueda/paginación que el visitante tenga activa en el
  // resto de la página (no comparte offset con el listado general).
  const soloDestacados = destacados === '1' || destacados === 'true';

  // Catálogo del portal cliente (Auditoría filtros v280, 6.1): antes esta
  // función traía la tabla `stock` completa de la empresa (todos los
  // depósitos, ~2000 filas) a memoria en cada búsqueda/page load para
  // calcular disponibilidad con un Map en JS. Ahora todo (agregación de
  // stock, filtro de categoría/búsqueda y paginación) corre en una sola
  // query SQL vía RPC — ver migración 255_etapa7_catalogo_cliente_stock_sql.
  //
  // Etapa 3 del plan de robustez/escalabilidad: esta RPC es la parte NO
  // personalizada del catálogo (precio_base de lista general, sin resolver
  // precio/ofertas/reglas de volumen por cliente todavía) — es idéntica para
  // cualquier visitante que pida la misma empresa/categoría/búsqueda/página,
  // así que es segura de cachear. La personalización (resolver_precios_cliente,
  // ofertas, reglas de volumen, más abajo) NUNCA se cachea — corre siempre
  // fresca por request, por cliente. TTL corto (15s, más corto que los 30s
  // del piloto de KPIs) porque el stock cambia con cada venta/POS y mostrar
  // "disponible" desestockeado por más tiempo es peor experiencia acá que en
  // un dashboard interno — igual la confirmación del pedido revalida stock
  // real server-side, así que el peor caso es un mensaje de "sin stock" al
  // confirmar, no una venta que se acepta sin stock real.
  const cacheKeyBase = `catalogo-cliente:${empresa_id}:${categoria || ''}:${busqueda || ''}:${limitNum}:${soloDestacados ? 0 : offset}:${soloDestacados ? 1 : 0}`;
  const { data: filas, error } = await cacheado(cacheKeyBase, 15_000, () =>
    db.rpc('cliente_productos_disponibles', {
      p_empresa_id:      empresa_id,
      p_categoria:       categoria || null,
      p_busqueda:        busqueda  || null,
      p_limit:           limitNum,
      p_offset:          soloDestacados ? 0 : offset, // la sección fija no pagina
      p_solo_destacados: soloDestacados,
    }),
  );
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  const count = filas?.[0]?.total_count ? +filas[0].total_count : 0;
  const productos = (filas || []).map(f => ({
    id:            f.id,
    codigo:        f.codigo,
    nombre:        f.nombre,
    descripcion:   f.descripcion,
    unidad:        f.unidad,
    precio_base:   f.precio_base,
    precio_lista:  f.precio_base,
    origen_precio: 'lista_general',
    foto_url:      f.foto_url,
    categoria_id:  f.categoria_id,
    categorias:    f.categoria_id ? { id: f.categoria_id, nombre: f.categoria_nombre } : null,
    destacado:     f.destacado === true,
    _stock_disponible: f.stock_disponible, // se adjunta abajo como stock_disponible
  }));

  // FIX F4-02 (auditoría de páginas, Fase 4): el catálogo mostraba siempre
  // precio_base crudo, ignorando precios especiales/reglas de volumen-zona-
  // temporada/lista asignada — recién se resolvían al confirmar el pedido,
  // así que el total del carrito no coincidía con lo que terminaba
  // cobrándose. Ahora se resuelve acá mismo con la misma RPC que usa
  // POS/confirmar pedido, cantidad=1 (el precio final por volumen real se
  // recalcula al confirmar, como ya hacía). Si falla o no hay cliente
  // logueado (visitante anónimo del catálogo público), se mantiene
  // precio_base como fallback — nunca bloquea el catálogo.
  const clienteId = await resolverClienteIdSiAutenticado(req);
  if (clienteId && productos.length > 0) {
    try {
      const { data: precios, error: errPrecios } = await db.rpc('resolver_precios_cliente', {
        p_cliente_id:   clienteId,
        p_producto_ids: productos.map(p => p.id),
        p_empresa_id:   empresa_id,
      });
      if (!errPrecios && precios) {
        const porProducto = new Map(precios.map(p => [p.producto_id, p]));
        for (const p of productos) {
          const resuelto = porProducto.get(p.id);
          if (resuelto && resuelto.precio != null) {
            p.precio_base   = resuelto.precio;
            p.origen_precio = resuelto.origen || 'lista_general';
          }
        }
      }
    } catch (errResolver) {
      console.error('[cliente-productos] No se pudieron resolver precios de cliente, se usa precio_base:', errResolver.message);
    }
  }

  // Adjuntar mejor oferta de liquidación activa por producto (Innovación #1)
  const idsResultado = (productos || []).map(p => p.id);
  const ofertasPorProducto = new Map();
  if (idsResultado.length > 0) {
    const ofertas = await listarOfertasParaProductos(empresa_id, idsResultado);

    for (const o of ofertas) {
      const actual = ofertasPorProducto.get(o.producto_id);
      // Si hay más de una oferta activa para el mismo producto (varios lotes),
      // nos quedamos con la de mayor descuento.
      if (!actual || +o.descuento_pct > +actual.descuento_pct) {
        ofertasPorProducto.set(o.producto_id, o);
      }
    }
  }

  // Adjuntar teaser de reglas de volumen (cantidad_minima > 1, migración 524):
  // no cambia el precio mostrado (eso lo resuelve resolver_precios_cliente
  // arriba, asumiendo cantidad=1), solo informa el próximo escalón
  // ("Desde 6 un.: 5% off") para incentivar compra por volumen.
  const reglasVolumenPorProducto = new Map();
  if (idsResultado.length > 0) {
    const reglas = await listarReglasVolumenCatalogo(clienteId, idsResultado, empresa_id);
    for (const r of reglas) reglasVolumenPorProducto.set(r.producto_id, r);
  }

  // Adjuntar stock disponible a cada producto
  const resultado = (productos || []).map(p => {
    const oferta = ofertasPorProducto.get(p.id);
    const reglaVolumen = reglasVolumenPorProducto.get(p.id);
    return {
      ...p,
      imagen_url:       p.foto_url || null,        // alias para frontend
      descripcion_corta: p.descripcion || null,    // alias para frontend
      stock_disponible: p._stock_disponible || 0,
      oferta_liquidacion: oferta ? {
        precio_oferta:   +oferta.precio_oferta,
        descuento_pct:   +oferta.descuento_pct,
        vence_oferta_at: oferta.vence_oferta_at,
      } : null,
      regla_volumen: reglaVolumen ? {
        cantidad_minima: +reglaVolumen.cantidad_minima,
        tipo_descuento:  reglaVolumen.tipo_descuento, // 'porcentaje' | 'precio_fijo'
        valor:           +reglaVolumen.valor,
      } : null,
    };
  });

  return res.json({
    productos: resultado,
    total:     count || 0,
    page:      pageNum,
    limit:     limitNum,
    pages:     Math.ceil((count || 0) / limitNum),
  });
}

// ─── Liquidación (Innovación #1): cron + gestión admin ─────────────────────
//
// Acciones:
//   POST ?accion=generar          → cron diario o disparo manual admin
//   GET  ?accion=listar           → ofertas activas (admin)
//   GET  ?accion=reglas           → reglas_liquidacion de la empresa
//   POST ?accion=guardar-reglas   → upsert reglas_liquidacion
async function handleLiquidacion(req, res) {
  if (await _limiterLiquidacion(req, res)) return;
  // CRON-001 (auditoría 2026-07-26): se sacó la confianza en el header
  // `x-vercel-cron` (cualquiera puede mandarlo en un request normal, no es
  // un mecanismo de seguridad documentado por Vercel) — ahora solo se acepta
  // el `CRON_SECRET` real. `esCron=true` habilitaba generar ofertas de
  // liquidación (mutación real de precios/stock) para TODAS las empresas.
  const esCron = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  const accion = req.query.accion || req.body?.accion;

  // ── Generar ofertas (cron diario GET, o disparo manual admin POST) ────────
  if (accion === 'generar') {
    let empresa_id_filtro = null;

    if (!esCron) {
      const perfilGenerar = await verificarToken(req, db);
      if (!perfilGenerar) return res.status(401).json({ error: 'No autorizado' });
      if (!['dueno', 'admin'].includes(perfilGenerar.rol))
        return res.status(403).json({ error: 'Sin permiso' });
      empresa_id_filtro = perfilGenerar.empresa_id;
    }

    // Empresas a procesar: todas (cron) o solo la del admin (disparo manual)
    let empresas;
    if (empresa_id_filtro) {
      empresas = [{ id: empresa_id_filtro }];
    } else {
      empresas = await listarEmpresasActivas();
    }

    const resultados = [];
    for (const e of empresas) {
      const { data, error } = await db.rpc('generar_ofertas_liquidacion', {
        p_empresa_id: e.id,
        p_dry_run: false,
      });
      if (error) {
        resultados.push({ empresa_id: e.id, ok: false, error: error.message });
        continue;
      }
      resultados.push({ empresa_id: e.id, ...data });

      // Notificar al admin si se crearon ofertas nuevas
      const creadas = data?.creadas?.length || 0;
      if (creadas > 0) {
        await notifAuto(e.id, {
          tipo: 'stock_orden_auto',
          titulo: 'Nuevas ofertas de liquidación',
          cuerpo: `Se generaron ${creadas} oferta(s) por vencimiento próximo. Revisalas en Vencimientos.`,
          link: '/admin/lotes',
        });

        // Cableado (auditoría notificaciones): notificarOfertaRelampago ya
        // existía en _push.js sin caller — la RPC solo avisaba al admin,
        // los clientes nunca se enteraban de la oferta. Se resuelven
        // descuento_pct/vence_oferta_at (la RPC no los devuelve, solo
        // lote_id/producto_id) y se manda un push por producto, best-effort
        // (no debe cortar el resto del batch si una empresa falla).
        const loteIds = (data.creadas || []).map(c => c.lote_id);
        if (loteIds.length) {
          const ofertas = await listarOfertasPorLotes(e.id, loteIds);

          for (const oferta of ofertas) {
            const minutosRestantes = Math.max(1, Math.round(
              (new Date(oferta.vence_oferta_at) - Date.now()) / 60000
            ));
            notificarOfertaRelampago(e.id, oferta.producto_id, oferta.descuento_pct, minutosRestantes)
              .catch(err => console.error('[stock-auto] Error enviando push de oferta relámpago:', err.message));
          }
        }
      }
    }

    return res.json({ ok: true, resultados });
  }

  // ── A partir de acá, todas las acciones requieren sesión admin ────────────
  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  if (!puede(perfil, 'acceder', 'stock'))
    return res.status(403).json({ error: 'Sin permisos' });
  const empresa_id = perfil.empresa_id;

  // ── Listar ofertas activas ─────────────────────────────────────────────
  if (req.method === 'GET' && (!accion || accion === 'listar')) {
    const { data, error } = await listarOfertasActivas(empresa_id);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ofertas: data || [] });
  }

  // ── Reglas: GET ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && accion === 'reglas') {
    const data = await obtenerReglas(empresa_id);

    return res.json({ reglas: data || {
      empresa_id, dias_alerta: 7, dias_nivel1: 3, pct_nivel1: 10,
      dias_nivel2: 1, pct_nivel2: 15, dias_nivel3: 0, pct_nivel3: 25,
      activo: true,
    } });
  }

  // ── Reglas: guardar (upsert) ───────────────────────────────────────────
  if (req.method === 'POST' && accion === 'guardar-reglas') {
    if (!['dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso para modificar reglas' });

    const body = req.body || {};
    const payload = {
      empresa_id,
      dias_alerta: body.dias_alerta,
      dias_nivel1: body.dias_nivel1,
      pct_nivel1:  body.pct_nivel1,
      dias_nivel2: body.dias_nivel2,
      pct_nivel2:  body.pct_nivel2,
      dias_nivel3: body.dias_nivel3,
      pct_nivel3:  body.pct_nivel3,
      activo: body.activo !== undefined ? !!body.activo : true,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await guardarReglas(payload);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true, reglas: data });
  }

  return res.status(405).json({ error: 'Acción no soportada' });
}

// ─── Helper: resolver empresa_id para endpoints del portal cliente ────────────
//
// Estrategia:
//   1. Si hay token Bearer → leerlo y obtener empresa_id del perfil
//   2. Si hay ?empresa_id en query → usar ese SOLO si la empresa habilitó
//      explícitamente el catálogo público (SEC-008, auditoría 2026 sesión 9).
//      Antes de este fix, cualquiera sin login podía pasar cualquier UUID
//      de empresa por query param y ver su catálogo completo (precios +
//      stock). Default seguro: deshabilitado. El mismo chequeo se agregó
//      también dentro de cliente_productos_disponibles (SQL) porque ese
//      RPC tiene GRANT EXECUTE directo a anon/authenticated y se puede
//      llamar sin pasar por este backend — ver migración
//      292_fix_sec008_gate_catalogo_publico.

async function resolverEmpresaCliente(req) {
  const perfil = await verificarToken(req, db);
  if (perfil?.empresa_id) return perfil.empresa_id;

  // Fallback: empresa_id en query param — solo si esa empresa habilitó
  // el catálogo público explícitamente.
  const empresaIdParam = req.query.empresa_id;
  if (!empresaIdParam) return null;

  const config = await obtenerConfig(empresaIdParam);
  if (config?.catalogo_publico_habilitado === true) {
    return empresaIdParam;
  }
  return null;
}

// FIX F4-02 (auditoría de páginas, Fase 4): cliente_id del usuario logueado,
// si lo hay — para poder resolver precios reales (especial/regla/lista) en
// el catálogo en vez de mostrar siempre precios_base crudo. `null` para
// visitantes anónimos del catálogo público (no logueados) — en ese caso se
// sigue mostrando el precio de lista, no hay cliente a quien resolverle nada.
async function resolverClienteIdSiAutenticado(req) {
  const perfil = await verificarToken(req, db);
  return perfil?.cliente_id || null;
}
