// lib/repos/facturas.js
// Capa de acceso a datos para Facturas / Configuración ARCA / Notas de
// Crédito / Comprobantes históricos. Migrado desde `lib/handlers/facturas.js`
// (mismo patrón que compras.js/proveedores.js — el handler concentra varios
// submódulos absorbidos para no superar el límite de 12 Serverless Functions
// del plan Hobby de Vercel).

import { db } from './_db.js';

// ── Perfil / usuario ────────────────────────────────────────────────────

/** Perfil mínimo (empresa_id, rol) — usado por el router principal, notas-credito y comprobantes-historicos. */
export async function obtenerPerfilFacturas(user_id) {
  const { data } = await db
    .from('usuarios')
    .select('empresa_id, rol')
    .eq('id', user_id)
    .eq('activo', true)
    .single();
  return data;
}

/** Perfil con id incluido — usado por anular/reintentar para validar rol contra la lista dueno/admin/contador. */
export async function obtenerUsuarioParaGestionFactura(user_id) {
  const { data } = await db
    .from('usuarios')
    .select('id, empresa_id, rol')
    .eq('id', user_id)
    .eq('activo', true)
    .single();
  return data;
}

// ── Facturas ─────────────────────────────────────────────────────────────

/** Datos mínimos de una factura para el chequeo de acceso antes de generar el PDF. */
export async function obtenerFacturaParaPdf(id, empresa_id) {
  const { data, error } = await db
    .from('facturas')
    .select('id, cliente_id, empresa_id, numero, pdf_url')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/** Detalle completo de una factura (con pedido y datos del cliente). */
export async function obtenerFacturaDetalle(id, empresa_id) {
  const { data, error } = await db
    .from('facturas')
    .select('*, pedidos(id), clientes(razon_social, cuit, condicion_iva)')
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/** Listado paginado de facturas con filtros opcionales de estado y cliente. */
export async function listarFacturasFiltradas(empresa_id, { estado, cliente_id, offset, limit }) {
  let q = db
    .from('facturas')
    .select('*, clientes(razon_social)', { count: 'exact' })
    .eq('empresa_id', empresa_id)
    // Regla "ítem modificado sube al tope" (2026-09): antes ordenaba por
    // fecha_emision, así que anular/reintentar/marcar error en una factura
    // vieja no la traía a la vista sin buscarla en toda la lista.
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (estado)      q = q.eq('estado', estado);
  if (cliente_id)  q = q.eq('cliente_id', cliente_id);

  const { data, error, count } = await q;
  return { data, error, count };
}

/** Pedido mínimo (id, empresa_id) para validar que el pedido a facturar pertenece a la empresa del usuario. */
export async function obtenerPedidoParaFactura(pedido_id) {
  const { data, error } = await db
    .from('pedidos')
    .select('id, empresa_id')
    .eq('id', pedido_id)
    .single();
  return { data, error };
}

/** Factura completa (usada por anularFacturaHandler antes de llamar anularFactura()). */
export async function obtenerFacturaCompleta(factura_id) {
  const { data, error } = await db
    .from('facturas')
    .select('*')
    .eq('id', factura_id)
    .single();
  return { data, error };
}

/** Factura mínima (usada por reintentarFacturaHandler). */
export async function obtenerFacturaParaReintentar(factura_id) {
  const { data, error } = await db
    .from('facturas')
    .select('id, empresa_id, pedido_id, estado')
    .eq('id', factura_id)
    .single();
  return { data, error };
}

/** Config activa mínima (punto_venta, homologacion) — chequeo previo a crear la fila de factura en emitirFactura(). */
export async function obtenerFacturacionConfigActiva(empresa_id) {
  const { data, error } = await db
    .from('facturacion_config')
    .select('punto_venta, homologacion')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .maybeSingle();
  return { data, error };
}

/** Última factura vinculada a un pedido (para reutilizar si ya existe pendiente/error_afip). */
export async function obtenerUltimaFacturaDePedido(pedido_id) {
  const { data } = await db
    .from('facturas')
    .select('*')
    .eq('pedido_id', pedido_id)
    .order('fecha_emision', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/** Última factura vinculada a una venta POS (misma lógica que la de pedido). */
export async function obtenerUltimaFacturaDeVentaPos(venta_pos_id) {
  const { data } = await db
    .from('facturas')
    .select('*')
    .eq('venta_pos_id', venta_pos_id)
    .order('fecha_emision', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/** Pedido + cliente + empresa + items, para armar el comprobante en emitirFactura(). */
export async function obtenerPedidoParaEmitirFactura(pedido_id) {
  const { data, error } = await db
    .from('pedidos')
    .select(`
      id, empresa_id, total, subtotal, iva_total, forma_pago,
      clientes(id, razon_social, cuit, condicion_iva, domicilio, dias_credito),
      empresas(id, cuit, nombre, config),
      pedido_items(cantidad, precio_unitario, subtotal, productos(nombre, iva))
    `)
    .eq('id', pedido_id)
    .single();
  return { data, error };
}

/** Venta POS + cliente + empresa + items + pagos, para armar el comprobante en emitirFactura(). */
export async function obtenerVentaPosParaEmitirFactura(venta_pos_id) {
  const { data, error } = await db
    .from('ventas_pos')
    .select(`
      id, empresa_id, total, subtotal, iva_total,
      clientes(id, razon_social, cuit, condicion_iva, domicilio, dias_credito),
      empresas(id, cuit, nombre, config),
      venta_pos_items(cantidad, precio_unitario, subtotal, productos(nombre, iva)),
      venta_pos_pagos(medio, monto)
    `)
    .eq('id', venta_pos_id)
    .single();
  return { data, error };
}

/** Inserta una fila en `facturas` (usado tanto para el registro 'pendiente' normal como el de error de configuración). */
export async function crearFactura(campos) {
  const { data, error } = await db.from('facturas').insert(campos).select().single();
  return { data, error };
}

/** Update genérico de una factura, devolviendo la fila actualizada. */
export async function actualizarFactura(factura_id, cambios) {
  const { data, error } = await db
    .from('facturas')
    .update(cambios)
    .eq('id', factura_id)
    .select()
    .single();
  return { data, error };
}

/** asentar_movimiento_cta_cte_factura() — registra el débito de la factura en la cta_cte del cliente. */
export async function asentarMovimientoCtaCteFacturaRpc(params) {
  const { data, error } = await db.rpc('asentar_movimiento_cta_cte_factura', params);
  return { data, error };
}

/**
 * Registra un pendiente financiero idempotente para que el cierre/admin pueda
 * reconciliarlo sin depender de logs efímeros.
 */
export async function encolarConciliacionFinanciera({ empresa_id, tipo, referencia_id, payload, error_msg }) {
  const { data, error } = await db
    .from('cola_financiera')
    .upsert({
      empresa_id,
      tipo,
      referencia_id,
      estado: 'pendiente',
      intentos: 0,
      proximo_intento: new Date().toISOString(),
      payload: payload || {},
      error_msg: error_msg || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'referencia_id,tipo,estado', ignoreDuplicates: false })
    .select('id, estado')
    .maybeSingle();
  return { data, error };
}

/** Deja la referencia factura_id en la venta POS de origen, con scope de empresa. */
export async function vincularFacturaAVentaPos(venta_pos_id, factura_id, empresa_id) {
  let query = db
    .from('ventas_pos')
    .update({ factura_id })
    .eq('id', venta_pos_id);
  if (empresa_id) query = query.eq('empresa_id', empresa_id);
  const { error } = await query;
  return { error };
}

// ── Clientes (lookups puntuales usados en este módulo) ──────────────────

/** Cliente por email — usado para resolver el cliente_id del usuario logueado con rol 'cliente'. */
export async function obtenerClientePorEmail(email, empresa_id) {
  const { data } = await db
    .from('clientes').select('id').eq('email', email).eq('empresa_id', empresa_id).maybeSingle();
  return data;
}

/** Cliente por id, validando que pertenece a la empresa (usado al crear una NC). */
export async function obtenerClientePorId(cliente_id, empresa_id) {
  const { data } = await db
    .from('clientes').select('id').eq('id', cliente_id).eq('empresa_id', empresa_id).single();
  return data;
}

// ── Configuración ARCA ───────────────────────────────────────────────────

/** get_facturacion_config() — RPC SECURITY DEFINER que nunca expone cert_pem/key_pem. */
export async function obtenerConfigFacturacionRpc() {
  const { data, error } = await db.rpc('get_facturacion_config');
  return { data, error };
}

/** cert_pem/key_pem existentes — para el upsert que no pisa credenciales si no vienen en el body. */
export async function obtenerCertKeyExistente(empresa_id) {
  const { data } = await db
    .from('facturacion_config')
    .select('cert_pem, key_pem')
    .eq('empresa_id', empresa_id)
    .maybeSingle();
  return data;
}

/** Upsert de la configuración de facturación ARCA de la empresa. */
export async function guardarConfigFacturacion(upsertData) {
  const { error } = await db
    .from('facturacion_config')
    .upsert(upsertData, { onConflict: 'empresa_id' });
  return { error };
}

/** Config ARCA activa (id, homologacion) — para decidir si una NC se emite contra ARCA o en modo manual. */
export async function obtenerConfigArcaActiva(empresa_id) {
  const { data } = await db
    .from('facturacion_config')
    .select('id, homologacion')
    .eq('empresa_id', empresa_id)
    .eq('activo', true)
    .maybeSingle();
  return data;
}

// ── Notas de Crédito ─────────────────────────────────────────────────────

/** Detalle completo de una NC (cliente, factura, items). */
export async function obtenerNotaCreditoDetalle(id, empresa_id) {
  const { data, error } = await db
    .from('notas_credito')
    .select(`
      *,
      clientes(razon_social, nombre_fantasia),
      facturas(numero),
      notas_credito_items(*)
    `)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/** Listado paginado de NC con filtros opcionales. */
export async function listarNotasCreditoFiltradas(empresa_id, { cliente_id, estado, desde, hasta, offset, limit }) {
  let q = db
    .from('notas_credito')
    .select(`
      id, tipo, numero, estado, motivo, total, fecha_emision, cae, pdf_url,
      clientes(razon_social, nombre_fantasia),
      facturas(numero)
    `, { count: 'exact' })
    .eq('empresa_id', empresa_id)
    // Regla "ítem modificado sube al tope" (2026-09): ver mismo comentario
    // en listarFacturasFiltradas.
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (cliente_id) q = q.eq('cliente_id', cliente_id);
  if (estado)     q = q.eq('estado', estado);
  if (desde)      q = q.gte('fecha_emision', desde);
  if (hasta)      q = q.lte('fecha_emision', hasta + 'T23:59:59');

  const { data, error, count } = await q;
  return { data, error, count };
}

/** NC con datos completos (cliente, factura original, items) para emitirla contra ARCA o en modo manual. */
export async function obtenerNotaCreditoParaEmitir(id, empresa_id) {
  // FIX (Etapa 7, Bloque 1 — v1049): se agregan `total, estado` de la
  // factura vinculada. handleNotasCredito (accion=emitir) los necesita para
  // detectar si la NC es PARCIAL (su total es menor al de la factura) antes
  // de decidir si puede pasar por emitirNotaCreditoARCA — esa función anula
  // la factura completa y pide el CAE por su total entero, sin importar el
  // monto real de la NC. Antes no venían y esa detección era imposible acá.
  const { data, error } = await db
    .from('notas_credito')
    .select(`*, clientes(*), facturas(numero, tipo, cae, total, estado), notas_credito_items(*)`)
    .eq('id', id)
    .eq('empresa_id', empresa_id)
    .single();
  return { data, error };
}

/** NC ya persistida, releída luego de aplicar el crédito en cta_cte (manual o ARCA). */
export async function obtenerNotaCreditoActualizada(id) {
  const { data } = await db
    .from('notas_credito').select('*').eq('id', id).single();
  return data;
}

/** Update genérico de campos de una NC (estado/notas_error tras emitir o fallar). */
export async function actualizarNotaCredito(id, campos) {
  const { error } = await db.from('notas_credito').update(campos).eq('id', id);
  return { error };
}

/** aplicar_nota_credito_cta_cte() — aplica el crédito de la NC en la cuenta corriente del cliente. */
export async function aplicarNotaCreditoCtaCteRpc(params) {
  const { error } = await db.rpc('aplicar_nota_credito_cta_cte', params);
  return { error };
}

/** crear_nota_credito() — crea la NC en estado pendiente junto con sus items. */
export async function crearNotaCreditoRpc(params) {
  const { data, error } = await db.rpc('crear_nota_credito', params);
  return { data, error };
}

// ── Comprobantes históricos (solo lectura, cargados vía migración) ──────

export async function listarComprobantesHistoricos(empresa_id, { cliente_id, tipo, desde, hasta, offset, limit }) {
  let q = db
    .from('comprobantes_historicos')
    .select(`
      id, tipo, numero_original, fecha, monto, moneda, observaciones, created_at,
      clientes(razon_social, nombre_fantasia)
    `)
    .eq('empresa_id', empresa_id)
    .order('fecha', { ascending: false })
    .range(offset, offset + limit - 1);

  if (cliente_id) q = q.eq('cliente_id', cliente_id);
  if (tipo)       q = q.eq('tipo', tipo);
  if (desde)      q = q.gte('fecha', desde);
  if (hasta)      q = q.lte('fecha', hasta);

  const { data, error } = await q;
  return { data, error };
}
