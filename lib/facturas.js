// lib/facturas.js
// Helper compartido por emitir, reintentar y anular.
// No es un endpoint HTTP — se importa desde los handlers HTTP.
//
// v2: reemplaza la integración con FacturAPI por comunicación directa
// con ARCA (WSFEv1) a través de lib/arca/wsfev1.js.
// La lógica de negocio (pedidos, items, cta_cte) no cambia.

import { emitirComprobanteARCA, emitirNotaCreditoARCA } from './arca/wsfev1.js';
import { generarPDFComprobante } from './arca/comprobante-pdf.js';
import { emitirEvento } from './eventos.js';
import * as FacturasRepo from './repos/facturas.js';
import { registrarAuditoriaSilenciosa } from './repos/audit.js';

// ── Emitir un comprobante para un pedido o una venta POS ─────────────────
// Acepta dos formas de llamado, por compatibilidad:
//   emitirFactura(pedidoId)                      → equivalente a { pedido_id }
//   emitirFactura({ pedido_id })                 → factura de un pedido
//   emitirFactura({ venta_pos_id })               → factura de venta mostrador
// Exactamente uno de los dos debe estar presente.
//
// - Si el origen ya tiene una factura (pendiente o error_afip), la reutiliza.
// - Si no tiene ninguna, crea el registro en `facturas` con estado 'pendiente'
//   y luego intenta emitirlo.
// `usuarioId` (opcional, segundo parámetro posicional): quién pidió la
// emisión, para dejar rastro en audit_log — dueno/admin/contador clickeando
// "Generar/Reintentar Comprobante" en pedidos.html, o el mismo usuario
// dictándolo por voz (emitir_factura_asistente). Se deja en null en los
// callers donde no hay un usuario humano detrás (listener pedido_creado,
// cierre automático, auto-facturación al confirmar pedido) — null en
// audit_log.usuario_id representa correctamente "lo disparó el sistema",
// no "no se sabe quién fue".
//
// Devuelve { ok, factura, error }.
export async function emitirFactura(origen, usuarioId = null) {
  const { pedido_id, venta_pos_id } =
    typeof origen === 'string' ? { pedido_id: origen, venta_pos_id: undefined } : (origen || {});

  if (!pedido_id && !venta_pos_id) {
    return { ok: false, error: 'Se requiere pedido_id o venta_pos_id' };
  }
  if (pedido_id && venta_pos_id) {
    return { ok: false, error: 'No se puede facturar con pedido_id y venta_pos_id a la vez' };
  }

  // 1. Traer el origen (pedido o venta POS) + cliente + empresa + items,
  //    normalizado a una misma forma para el resto de la función.
  const origenData = pedido_id
    ? await traerOrigenPedido(pedido_id)
    : await traerOrigenVentaPos(venta_pos_id);

  if (!origenData) {
    return { ok: false, error: pedido_id ? 'Pedido no encontrado' : 'Venta no encontrada' };
  }

  const pedido = origenData; // se mantiene el nombre `pedido` para no tocar el resto de la función

  // Verificar que la empresa tenga facturacion_config activa antes de crear la fila.
  // La lectura real del certificado la hace wsfev1.js; acá solo chequeamos existencia.
  const { data: facturacionConfig, error: cfgError } = await FacturasRepo.obtenerFacturacionConfigActiva(pedido.empresa_id);

  if (cfgError || !facturacionConfig) {
    await guardarFacturaPendiente(pedido, 'Falta configurar la facturación ARCA de la empresa (facturacion_config).');
    return {
      ok: false,
      codigo: 'sin_configuracion_facturacion',
      error: 'Todavía no configuraste la facturación electrónica (ARCA/AFIP) de esta empresa.',
    };
  }

  // 2. Buscar o crear el registro de factura asociado al origen
  let factura = pedido_id
    ? await obtenerFacturaDePedido(pedido.id)
    : await obtenerFacturaDeVentaPos(pedido.id);
  if (!factura) {
    factura = await crearFacturaPendiente(pedido, facturacionConfig);
  }

  // 3. Llamar a ARCA (WSFEv1) directamente para emitir el comprobante
  try {
    const resultado = await emitirComprobanteARCA(factura.id);

    if (!resultado.ok) {
      // wsfev1 ya marcó la factura como error_afip en la BD
      return { ok: false, error: resultado.error };
    }

    // 4. wsfev1 ya actualizó cae/cae_vto/numero/estado en la BD.
    //    Solo releer la fila actualizada para devolverla al llamador.
    const actualizada = (await FacturasRepo.obtenerFacturaCompleta(factura.id)).data;

    // Generar el PDF en background (no bloquea la respuesta al usuario).
    // El botón "Facturar" responde de inmediato con el CAE; el PDF aparece
    // en facturas.pdf_url unos segundos después.
    generarPDFComprobante(factura.id).catch(err =>
      console.error('[facturas] Error generando PDF (no crítico):', err.message)
    );

    // Registrar el débito en la cuenta corriente del cliente.
    // FIX (auditoría pedido→factura→cta_cte→cobro): antes esto era un
    // INSERT suelto desde Node que podía perderse en silencio si fallaba
    // (solo se logueaba, sin reintento ni alerta). Ahora se delega a una
    // RPC (asentar_movimiento_cta_cte_factura) que valida la factura,
    // es idempotente (no duplica si ya se registró) y devuelve un error
    // explícito que sí se loguea con el detalle de la factura afectada.
    //
    // FIX (bug "Cobrar habilitado en venta ya pagada en efectivo"): para
    // ventas POS, la deuda real es solo la parte que quedó a cuenta
    // corriente (__monto_cta_cte_pos) — no el total de la factura. Lo demás
    // ya se cobró en el momento y crearFacturaPendiente ya lo precargó en
    // total_cobrado. Si no hubo nada a cuenta corriente (venta 100%
    // efectivo/tarjeta), no hay deuda que asentar.
    const montoADebitar = pedido.__venta_pos_id
      ? (pedido.__monto_cta_cte_pos ?? factura.total)
      : factura.total;

    let asiento = { ok: true };
    let asientoErr = null;
    if (montoADebitar > 0) {
      ({ data: asiento, error: asientoErr } = await FacturasRepo.asentarMovimientoCtaCteFacturaRpc({
        p_factura_id: factura.id,
        p_tipo: 'debito',
        p_monto: montoADebitar,
        p_descripcion: 'Factura ' + (actualizada?.numero || factura.numero || factura.id),
      }));
    }

    if (asientoErr || !asiento?.ok) {
      console.error(
        '[facturas] Factura emitida pero falló el asiento en cta_cte (RECUPERACIÓN MANUAL):',
        asientoErr?.message || asiento?.error,
        { facturaId: factura.id, clienteId: factura.cliente_id, monto: montoADebitar }
      );
    }

    // Si el origen es una venta POS, dejar la referencia factura_id en
    // ventas_pos (columna prevista desde 072_pos.sql, sin usar hasta ahora).
    if (pedido.__venta_pos_id) {
      await FacturasRepo.vincularFacturaAVentaPos(pedido.__venta_pos_id, factura.id);
    }

    // Fase 4 (plan ERP de sincronización): pedido_facturado estaba
    // declarado en el despachador desde la Fase 1 pero ningún caller lo
    // emitía todavía (REGISTRO_LISTENERS lo tenía en [] por eso). Se
    // emite acá, siempre, para dejar rastro en eventos_negocio — sin
    // listeners registrados hoy, no cambia ningún comportamiento
    // existente (mismo criterio que pedido_creado en Fase 1: emitir
    // primero, migrar listeners después si aparece algo real que
    // reaccione a esto).
    emitirEvento({
      empresaId: factura.empresa_id,
      tipoEvento: 'pedido_facturado',
      payload: {
        factura_id: factura.id,
        pedido_id: pedido.__venta_pos_id ? null : pedido.id,
        venta_pos_id: pedido.__venta_pos_id || null,
        cliente_id: factura.cliente_id,
      },
      origen: 'emitirFactura',
    }).catch(err => console.error('[EVENTOS] error emitiendo pedido_facturado:', err));

    // Auditoría: gap real detectado en revisión 2026-08 — ni la fila de
    // `facturas` ni `eventos_negocio` guardaban quién pidió la emisión.
    // Best-effort (registrarAuditoriaSilenciosa nunca lanza) para no poder
    // romper una emisión ARCA ya exitosa por un fallo de auditoría.
    await registrarAuditoriaSilenciosa(
      factura.empresa_id, usuarioId, 'facturas', 'UPDATE', factura.id,
      { estado: factura.estado },
      { estado: actualizada?.estado, numero: actualizada?.numero, cae: actualizada?.cae, total: actualizada?.total }
    );

    return { ok: true, factura: actualizada };

  } catch (err) {
    console.error('[facturas] error inesperado en emitirFactura:', err);
    await sb_update_factura(factura.id, {
      estado: 'error_afip',
      notas_error: 'No se pudo conectar con el proveedor de facturación. Reintentar en unos minutos.',
    });
    return { ok: false, error: 'Error de conexión con el proveedor de facturación' };
  }
}

// ── Anular un comprobante ya emitido (Nota de Crédito C) ─────────────────
//
// Emite una NC C vía WSFEv1, persiste el resultado en `facturas`,
// marca la factura original como 'anulada' y asienta el crédito en cta_cte.
// Toda la lógica pesada está en lib/arca/wsfev1.js:emitirNotaCreditoARCA().
// `usuarioId` (opcional, tercer parámetro): mismo criterio que en
// emitirFactura — quién pidió la anulación (panel o asistente), null si la
// dispara el sistema (ej. cancelar_pedido_asistente cancela un pedido y
// eso arrastra la anulación de su factura; ver comentario en el caller).
export async function anularFactura(factura, motivo = '', usuarioId = null) {
  if (!factura?.id) {
    return { ok: false, error: 'Se requiere el objeto factura con su id para anular.' };
  }

  const resultado = await emitirNotaCreditoARCA(factura.id, motivo);

  if (!resultado.ok) {
    return { ok: false, error: resultado.error };
  }

  // Releer la factura NC recién creada para devolverla al llamador
  const { data: facturaNC } = await FacturasRepo.obtenerFacturaCompleta(resultado.facturaNCId);

  // PDF de la NC en background, igual que en la emisión normal.
  generarPDFComprobante(resultado.facturaNCId).catch(err =>
    console.error('[facturas] Error generando PDF de NC (no crítico):', err.message)
  );

  // Fase 4: mismo criterio que pedido_facturado arriba — declarado desde
  // Fase 1, sin caller hasta ahora. `factura` acá es la factura ORIGINAL
  // (la que se anula), la que trae empresa_id/cliente_id resueltos por
  // el caller (ver anularFacturaHandler).
  emitirEvento({
    empresaId: factura.empresa_id,
    tipoEvento: 'factura_anulada',
    payload: {
      factura_id: factura.id,
      factura_nc_id: resultado.facturaNCId,
      pedido_id: factura.pedido_id || null,
      venta_pos_id: factura.venta_pos_id || null,
      cliente_id: factura.cliente_id,
      motivo,
    },
    origen: 'anularFactura',
  }).catch(err => console.error('[EVENTOS] error emitiendo factura_anulada:', err));

  // Auditoría: misma cobertura que emitirFactura (ver comentario ahí) —
  // registra tanto el "antes" (factura original, ahora anulada) como la
  // NC generada, sin bloquear la respuesta si falla.
  await registrarAuditoriaSilenciosa(
    factura.empresa_id, usuarioId, 'facturas', 'UPDATE', factura.id,
    { estado: factura.estado },
    { estado: 'anulada', motivo, nota_credito_id: resultado.facturaNCId }
  );

  return { ok: true, factura: facturaNC, nota_credito: resultado };
}

// ── Helpers internos ──────────────────────────────────────────────────────

// Trae un pedido + cliente + empresa + items, en la forma que el resto de
// la función espera (idéntico a lo que hacía emitirFactura(pedidoId) antes
// de soportar venta_pos_id).
async function traerOrigenPedido(pedidoId) {
  const { data: pedido, error } = await FacturasRepo.obtenerPedidoParaEmitirFactura(pedidoId);

  if (error || !pedido) return null;
  return pedido;
}

// Trae una venta POS + cliente + empresa + items, normalizada a la MISMA
// forma que traerOrigenPedido() devuelve (clientes, empresas, pedido_items)
// para que armarPayloadComprobante() y el resto del flujo no necesiten
// distinguir el origen.
//
// Consumidor final (venta sin cliente_id): `clientes` queda null y
// armarPayloadComprobante ya maneja ese caso (razon_social/cuit/etc. en
// null — el proveedor de facturación trata eso como consumidor final).
//
// __venta_pos_id viaja en el objeto normalizado únicamente para que
// emitirFactura() pueda, al final, escribir facturas.id de vuelta en
// ventas_pos.factura_id sin tener que volver a desestructurar el origen.
async function traerOrigenVentaPos(ventaPosId) {
  const { data: venta, error } = await FacturasRepo.obtenerVentaPosParaEmitirFactura(ventaPosId);

  if (error || !venta) return null;

  // FIX (bug "Cobrar habilitado en venta ya pagada en efectivo"): emitir
  // una factura de venta POS asentaba SIEMPRE el total completo como deuda
  // en cta_cte, sin mirar cuánto ya se cobró en el momento (efectivo,
  // tarjeta, transferencia). Solo lo que quedó a cuenta corriente es deuda
  // real; el resto ya está cobrado desde que se cerró el ticket.
  const montoCuentaCorriente = (venta.venta_pos_pagos || [])
    .filter(p => p.medio === 'cuenta_corriente')
    .reduce((s, p) => s + (Number(p.monto) || 0), 0);

  return {
    id: venta.id,
    empresa_id: venta.empresa_id,
    total: venta.total,
    subtotal: venta.subtotal,
    iva_total: venta.iva_total,
    clientes: venta.clientes,
    empresas: venta.empresas,
    pedido_items: venta.venta_pos_items, // mismo shape que pedido_items
    __venta_pos_id: venta.id,
    __monto_cta_cte_pos: Math.round(montoCuentaCorriente * 100) / 100,
  };
}

async function obtenerFacturaDeVentaPos(ventaPosId) {
  return await FacturasRepo.obtenerUltimaFacturaDeVentaPos(ventaPosId);
}

async function obtenerFacturaDePedido(pedidoId) {
  return await FacturasRepo.obtenerUltimaFacturaDePedido(pedidoId);
}

// Vencimiento de la factura = hoy + días de crédito del cliente.
// Antes esta columna nunca se completaba en ningún flujo de facturación
// (ni pedidos ni POS), por lo que Cobranzas (fn_cobranzas_facturas /
// fn_cta_cte_lista) no podía clasificar nada en "vence hoy / próximos 7
// días / vencidas" — todo quedaba invisible aunque la deuda fuera real.
// dias_credito ya existe en `clientes` (usado hoy solo por el cron de
// notif.js, contra cta_cte); acá se aplica el mismo criterio pero
// persistido en la factura para que la UI de Cobranzas lo pueda leer.
// Sin cliente asociado (consumidor final) o sin dias_credito configurado,
// se usa 0 días → vence el mismo día de emisión (venta de contado).
function calcularVencimiento(cliente) {
  const dias = Number(cliente?.dias_credito) || 0;
  const v = new Date();
  v.setDate(v.getDate() + dias);
  return v.toISOString().split('T')[0];
}

async function crearFacturaPendiente(pedido, facturacionConfig) {
  // Para ventas POS: lo que no quedó a cuenta corriente ya se cobró en el
  // momento (efectivo/tarjeta/transferencia) — se precarga como cobrado
  // para que la factura nazca reflejando el saldo real, no el total bruto.
  // Para pedidos (sin ese desglose) queda en 0 como siempre.
  const totalYaCobrado = pedido.__venta_pos_id
    ? Math.max(0, pedido.total - (pedido.__monto_cta_cte_pos ?? pedido.total))
    : 0;

  const { data, error } = await FacturasRepo.crearFactura({
    empresa_id:   pedido.empresa_id,
    pedido_id:    pedido.__venta_pos_id ? null : pedido.id,
    venta_pos_id: pedido.__venta_pos_id || null,
    cliente_id: pedido.clientes?.id,
    tipo:       tipoFacturaPara(pedido, facturacionConfig),
    neto:       pedido.subtotal,
    iva:        pedido.iva_total,
    total:      pedido.total,
    total_cobrado: totalYaCobrado,
    estado:     'pendiente',
    vencimiento: calcularVencimiento(pedido.clientes),
  });

  if (error) throw error;
  return data;
}

async function guardarFacturaPendiente(pedido, motivo) {
  const existente = pedido.__venta_pos_id
    ? await obtenerFacturaDeVentaPos(pedido.__venta_pos_id)
    : await obtenerFacturaDePedido(pedido.id);
  if (existente) {
    return sb_update_factura(existente.id, { estado: 'pendiente', notas_error: motivo });
  }
  const { data } = await FacturasRepo.crearFactura({
    empresa_id:   pedido.empresa_id,
    pedido_id:    pedido.__venta_pos_id ? null : pedido.id,
    venta_pos_id: pedido.__venta_pos_id || null,
    cliente_id:  pedido.clientes?.id,
    tipo:        'B',
    neto:        pedido.subtotal,
    iva:         pedido.iva_total,
    total:       pedido.total,
    estado:      'pendiente',
    notas_error: motivo,
    vencimiento: calcularVencimiento(pedido.clientes),
  });
  return data;
}

async function sb_update_factura(facturaId, cambios) {
  const { data, error } = await FacturasRepo.actualizarFactura(facturaId, cambios);

  if (error) throw error;
  return data;
}

// Determina tipo de comprobante (A/B/C) según condición de IVA del cliente.
// Por defecto usa el configurado por la empresa.
function tipoFacturaPara(pedido, facturacionConfig) {
  const condicion = pedido.clientes?.condicion_iva;
  if (condicion === 'responsable_inscripto') return 'A';
  return facturacionConfig?.tipo_factura_default || 'B';
}

// armarPayloadComprobante y armarPayloadNotaCredito fueron eliminadas:
// la construcción del SOAP para ARCA la maneja lib/arca/wsfev1.js.
