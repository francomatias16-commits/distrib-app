// lib/arca/wsfev1.js
//
// Emisión de comprobantes electrónicos (WSFEv1) contra ARCA/AFIP.
// Soporta Factura A, B y C según la condición de IVA de la empresa emisora
// y, para RI, del cliente receptor (ver resolverLetraComprobante()).
//
// Flujo por llamado a emitirComprobanteARCA():
//   1. Obtiene token/sign desde lib/arca/wsaa.js (con caché).
//   2. Determina la letra de comprobante (A/B/C) según condición IVA.
//   3. Para A/B: reconstruye el desglose de IVA por alícuota desde los
//      ítems reales del pedido/venta (calcularDesgloseIva) — no confía en
//      un neto/iva agregado que puede perder precisión si se mezclan tasas.
//   4. Consulta el último número de comprobante emitido (FECompUltimoAutorizado).
//   5. Arma el request SOAP de autorización (FECAESolicitar).
//   6. Parsea la respuesta y extrae CAE + vencimiento.
//   7. Actualiza la fila en `facturas` con el resultado (cae, cae_vto, numero, estado).
//   8. Devuelve { ok, cae, caeVto, numero } o { ok: false, error }.
//
// Sobre los importes:
//   - Factura C (monotributista): no discrimina IVA. ImpNeto = ImpTotal,
//     ImpIVA = 0, sin bloque <Iva>.
//   - Factura A/B (Responsable Inscripto): SÍ discrimina IVA. ImpNeto e
//     ImpIVA vienen del desglose real por alícuota, y se manda el bloque
//     <Iva> con cada <AlicIva> (Id, BaseImp, Importe) — ARCA valida que
//     BaseImp × alícuota ≈ Importe y que la suma cierre contra ImpNeto/ImpIVA.
//   - Concepto = 1 (Productos) — ajustar si se facturan servicios.
//
// SOAP vs REST: WSFEv1 solo expone SOAP. Se construye el sobre a mano con
// template strings (igual que wsaa.js) sin dependencia de una lib SOAP,
// que en Vercel añade peso innecesario y rompe con ESModules.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { obtenerTokenWSAA } from './wsaa.js';
import { descifrar } from '../crypto-secrets.js';
import { withRetry } from '../retry.js';
import { esEmpresaDemo, caeSimulado } from '../demo-mode.js';
import { calcularDesgloseIva } from '../calc/iva-desglose.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

// ── Lock de emisión (evita numeración duplicada por concurrencia) ───────
// Ver migración 487. Serializa por (empresa_id, punto_venta, tipo_cbte):
// dos emisiones del MISMO tipo de comprobante para la MISMA empresa/punto
// de venta no pueden pedir el número de AFIP en simultáneo.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function adquirirLockEmision(empresaId, puntoVenta, tipoCbte, { intentos = 8, esperaMs = 800 } = {}) {
  for (let i = 0; i < intentos; i++) {
    const { data: token, error } = await supabase.rpc('arca_lock_adquirir', {
      p_empresa_id: empresaId,
      p_punto_venta: puntoVenta,
      p_tipo_cbte: tipoCbte,
    });
    if (error) {
      throw new Error(`[wsfev1] Error adquiriendo lock de emisión: ${error.message}`);
    }
    if (token) return token;
    await sleep(esperaMs);
  }
  return null;
}

async function liberarLockEmision(empresaId, puntoVenta, tipoCbte, token) {
  if (!token) return;
  const { error } = await supabase.rpc('arca_lock_liberar', {
    p_empresa_id: empresaId,
    p_punto_venta: puntoVenta,
    p_tipo_cbte: tipoCbte,
    p_token: token,
  });
  if (error) {
    // No crítico: el lock igual expira solo (detección de stale en
    // arca_lock_adquirir), pero se loguea para no perderlo de vista.
    console.error('[wsfev1] No se pudo liberar el lock de emisión (expirará solo):', error.message);
  }
}

// ── Endpoints WSFEv1 ──────────────────────────────────────────────────

const WSFEV1_URL = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  produccion:   'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
};

// Tipos de comprobante ARCA
const TIPO_CBTE = {
  FACTURA_A:       1,
  FACTURA_B:       6,
  FACTURA_C:       11,
  NOTA_DEBITO_A:   2,
  NOTA_DEBITO_B:   8,
  NOTA_DEBITO_C:   12,
  NOTA_CREDITO_A:  3,
  NOTA_CREDITO_B:  7,
  NOTA_CREDITO_C:  13,
};

// Letra de comprobante ← condición IVA del emisor + condición IVA del receptor.
// - Monotributista: siempre C, no discrimina IVA, sin importar quién sea el receptor.
// - Responsable Inscripto: A si el receptor también es RI (para que pueda
//   computar crédito fiscal), B para cualquier otro receptor (monotributo,
//   consumidor final, exento).
// - Exento: no soportado todavía (comprobante distinto, sin IVA en absoluto,
//   casuística propia) — se sigue bloqueando explícitamente más abajo.
function resolverLetraComprobante(condicionEmpresa, condicionReceptor) {
  const empresaEsMonotributista = ['monotributo', 'monotributista'].includes(condicionEmpresa);
  if (empresaEsMonotributista) return 'C';
  return condicionReceptor === 'responsable_inscripto' ? 'A' : 'B';
}

// Concepto: 1 = Productos, 2 = Servicios, 3 = Productos y Servicios
const CONCEPTO_PRODUCTOS = 1;

// ── Desglose de IVA por alícuota (Factura A/B) ──────────────────────────
// ALICUOTA_IVA_ID y calcularDesgloseIva viven en lib/calc/iva-desglose.js
// (compartido con lib/arca/comprobante-pdf.js) para que ARCA y el PDF
// nunca muestren un desglose distinto del mismo comprobante.

/**
 * Trae los ítems reales del pedido o venta POS que originó la factura, con
 * la alícuota de IVA de cada producto — necesario para reconstruir el
 * desglose de Factura A/B (ver calcularDesgloseIva). `subtotal` en
 * pedido_items/venta_pos_items ya es el neto por ítem (precio × cantidad
 * con descuento aplicado, SIN IVA — ver lib/calc/pedido-totales.js), así
 * que sirve directo como BaseImp.
 *
 * Una factura viene de un pedido O de una venta POS, nunca ambos
 * (constraint CHECK en `facturas`).
 */
async function obtenerItemsParaFactura(factura) {
  if (factura.pedido_id) {
    const { data, error } = await supabase
      .from('pedido_items')
      .select('subtotal, productos(iva)')
      .eq('pedido_id', factura.pedido_id);
    if (error) throw new Error(`[wsfev1] Error leyendo pedido_items: ${error.message}`);
    if (!data?.length) throw new Error(`[wsfev1] El pedido ${factura.pedido_id} no tiene ítems.`);
    return data.map(it => ({ subtotal: it.subtotal, iva: it.productos?.iva ?? 21 }));
  }

  if (factura.venta_pos_id) {
    const { data, error } = await supabase
      .from('venta_pos_items')
      .select('subtotal, productos(iva)')
      .eq('venta_pos_id', factura.venta_pos_id);
    if (error) throw new Error(`[wsfev1] Error leyendo venta_pos_items: ${error.message}`);
    if (!data?.length) throw new Error(`[wsfev1] La venta POS ${factura.venta_pos_id} no tiene ítems.`);
    return data.map(it => ({ subtotal: it.subtotal, iva: it.productos?.iva ?? 21 }));
  }

  throw new Error(
    `[wsfev1] La factura ${factura.id} no tiene pedido_id ni venta_pos_id — no se puede ` +
    'reconstruir el desglose de IVA necesario para Factura A/B.'
  );
}

// ── API pública ───────────────────────────────────────────────────────

/**
 * Emite una Factura C para el registro `facturaId` que ya existe en la tabla
 * `facturas` con estado 'pendiente'.
 *
 * Requisitos previos:
 *   - La fila en `facturas` debe tener: total, cliente_id, empresa_id.
 *   - `facturacion_config` de la empresa debe tener: cuit, punto_venta,
 *     cert_pem, key_pem, homologacion.
 *   - El cliente puede o no tener CUIT (consumidor final si no lo tiene).
 *
 * @param {string} facturaId  UUID de la fila en `facturas`.
 * @returns {{ ok: boolean, cae?: string, caeVto?: string, numero?: number, error?: string }}
 */
export async function emitirComprobanteARCA(facturaId) {
  if (!facturaId) {
    return { ok: false, error: '[wsfev1] Se requiere facturaId.' };
  }

  // 1. Leer la factura + cliente + config de la empresa
  let factura, config;
  try {
    ({ factura, config } = await leerContextoFactura(facturaId));
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Guard: no re-emitir una factura que ya tiene CAE
  if (factura.estado === 'emitida') {
    return { ok: false, error: `[wsfev1] La factura ${facturaId} ya fue emitida (CAE existente).` };
  }

  // ── Corte de modo demo — Fase 3 del proceso demo/comercial ────────────
  // Ninguna empresa marcada es_demo puede disparar una llamada real a
  // AFIP/ARCA, ni siquiera de solo lectura (FECompUltimoAutorizado). Se
  // simula toda la respuesta y se persiste igual que el flujo real, para
  // que el resto del sistema (impresión, listado de facturas) no note
  // diferencia.
  if (await esEmpresaDemo(factura.empresa_id)) {
    const puntoVentaDemo = config.punto_venta || 1;
    // Tipo sentinel 0: la numeración demo cuenta TODAS las facturas
    // 'emitida' de la empresa (no distingue tipo_cbte), así que el lock
    // usa una sola clave fija por empresa+punto de venta demo.
    const lockTokenDemo = await adquirirLockEmision(factura.empresa_id, puntoVentaDemo, 0);
    if (!lockTokenDemo) {
      return await registrarError(
        facturaId,
        '[wsfev1-demo] Otra emisión de esta empresa está en curso. Reintentá en unos segundos.'
      );
    }
    try {
      const { cae, caeVto } = caeSimulado();
      const { count } = await supabase
        .from('facturas')
        .select('id', { count: 'exact', head: true })
        .eq('empresa_id', factura.empresa_id)
        .eq('estado', 'emitida');
      const nroCbteDemo = (count || 0) + 1;
      const numeroFormateadoDemo = String(nroCbteDemo).padStart(8, '0');

      await supabase
        .from('facturas')
        .update({
          estado:  'emitida',
          cae,
          cae_vto: caeVto,
          numero:  `C-${String(puntoVentaDemo).padStart(5, '0')}-${numeroFormateadoDemo}`,
          neto:    redondear2(Number(factura.total)),
          iva:     0,
          tipo:    'C',
        })
        .eq('id', facturaId);

      return {
        ok: true,
        cae,
        caeVto,
        numero: nroCbteDemo,
        numeroFormateado: `C-${String(puntoVentaDemo).padStart(5, '0')}-${numeroFormateadoDemo}`,
        demo: true,
      };
    } finally {
      await liberarLockEmision(factura.empresa_id, puntoVentaDemo, 0, lockTokenDemo);
    }
  }

  // Determinar letra de comprobante (A/B/C) según condición IVA del emisor
  // y del receptor — ver resolverLetraComprobante(). "Exento" u otra
  // condición no contemplada se sigue bloqueando explícitamente: es un
  // comprobante distinto (sin IVA en absoluto) con casuística propia que
  // todavía no está implementada acá.
  const condicionEmpresa = (config.condicion_iva || 'monotributo').toLowerCase();
  if (!['monotributo', 'monotributista', 'responsable_inscripto'].includes(condicionEmpresa)) {
    return await registrarError(
      facturaId,
      `[wsfev1] La empresa está configurada con condición de IVA "${config.condicion_iva}", que ` +
      'todavía no está soportada (solo monotributo y responsable_inscripto). ' +
      'Contactar soporte para habilitar esta condición antes de facturar.'
    );
  }

  const condicionReceptor = factura.clientes?.condicion_iva || 'consumidor_final';
  const letra = resolverLetraComprobante(condicionEmpresa, condicionReceptor);
  const tipoCbte = letra === 'A' ? TIPO_CBTE.FACTURA_A
                  : letra === 'B' ? TIPO_CBTE.FACTURA_B
                  : TIPO_CBTE.FACTURA_C;

  const homologacion = config.homologacion;
  const url = homologacion ? WSFEV1_URL.homologacion : WSFEV1_URL.produccion;

  // FIX ARCA-AUDIT-01: lock por empresa+punto_venta+tipo_cbte para que dos
  // emisiones concurrentes del mismo tipo de comprobante no consulten el
  // mismo "último número" de AFIP y pidan CAE duplicado. Ver migración 487.
  // Se captura localmente cualquier error de la propia adquisición del
  // lock (ej. falla de red hacia Supabase) para no lanzar sin capturar
  // hacia el llamador — mismo criterio defensivo que el resto de esta
  // función, que siempre vuelve un { ok:false, error } en vez de tirar.
  let lockToken;
  try {
    lockToken = await adquirirLockEmision(factura.empresa_id, config.punto_venta, tipoCbte);
  } catch (err) {
    return await registrarError(facturaId, `[wsfev1] Error adquiriendo lock de emisión: ${err.message}`);
  }
  if (!lockToken) {
    return await registrarError(
      facturaId,
      '[wsfev1] Ya hay otra factura de este mismo tipo/punto de venta emitiéndose en este momento. ' +
      'Reintentá en unos segundos.'
    );
  }

  try {
    // 2. Token WSAA
    let token, sign;
    try {
      ({ token, sign } = await obtenerTokenWSAA(factura.empresa_id));
    } catch (err) {
      return await registrarError(facturaId, `[wsfev1] Error obteniendo token WSAA: ${err.message}`);
    }

    // 3. Último número emitido para este tipo/punto de venta
    let ultimoNro;
    try {
      ultimoNro = await consultarUltimoNumero({
        url,
        token,
        sign,
        cuit:       config.cuit,
        ptoVenta:   config.punto_venta,
        tipoCbte,
      });
    } catch (err) {
      return await registrarError(facturaId, `[wsfev1] Error consultando último número: ${err.message}`);
    }

    const nroCbte = ultimoNro + 1;

    return await continuarEmisionFactura({ factura, facturaId, config, letra, tipoCbte, token, sign, url, nroCbte });
  } finally {
    await liberarLockEmision(factura.empresa_id, config.punto_venta, tipoCbte, lockToken);
  }
}

// Continúa emitirComprobanteARCA() a partir del número de comprobante ya
// reservado bajo lock (pasos 4-5 del flujo original). Separado en su
// propia función solo para poder envolver los pasos 2-5 en un try/finally
// que libere el lock sin duplicar ese try/finally en cada return temprano.
async function continuarEmisionFactura({ factura, facturaId, config, letra, tipoCbte, token, sign, url, nroCbte }) {
  // 4. Armar y enviar el request de autorización
  const fecha = hoy(); // YYYYMMDD que ARCA exige
  const total = Number(factura.total);
  const impTotal = redondear2(total);

  // Factura C: no discrimina IVA. ImpNeto = ImpTotal, ImpIVA = 0, sin <Iva>.
  // Factura A/B: se reconstruye el desglose real por alícuota desde los
  // ítems del pedido/venta que originó la factura — ver calcularDesgloseIva().
  let impNeto, impIVA, ivaItems = null;
  if (letra === 'C') {
    impNeto = impTotal;
    impIVA  = 0;
  } else {
    let items;
    try {
      items = await obtenerItemsParaFactura(factura);
    } catch (err) {
      return await registrarError(facturaId, err.message);
    }

    let desglose;
    try {
      desglose = calcularDesgloseIva(items);
    } catch (err) {
      return await registrarError(facturaId, err.message);
    }

    impNeto  = desglose.impNeto;
    impIVA   = desglose.impIVA;
    ivaItems = desglose.alicuotas;

    // Chequeo de consistencia: neto + iva reconstruido desde los ítems debe
    // cerrar contra facturas.total. Si no cierra (total desactualizado,
    // descuento a nivel pedido no reflejado en los ítems, etc.), mejor
    // cortar acá que mandarle a ARCA un comprobante que no coincide con lo
    // que el cliente ve en el sistema.
    const diferencia = Math.abs(redondear2(impNeto + impIVA) - impTotal);
    if (diferencia > 0.05) {
      return await registrarError(
        facturaId,
        `[wsfev1] El desglose de IVA reconstruido desde los ítems (neto ${impNeto} + iva ` +
        `${impIVA} = ${redondear2(impNeto + impIVA)}) no coincide con facturas.total (${impTotal}). ` +
        `Diferencia: ${diferencia.toFixed(2)}. Revisar antes de emitir.`
      );
    }
  }

  const docTipo = resolverDocTipo(factura.clientes?.condicion_iva, factura.clientes?.cuit);
  const docNro  = resolverDocNro(factura.clientes?.condicion_iva, factura.clientes?.cuit);
  const condicionIvaReceptorId = resolverCondicionIvaReceptor(factura.clientes?.condicion_iva);

  // Factura A exige receptor identificado con CUIT (docTipo 80). Si el
  // cliente quedó marcado RI pero sin CUIT válido cargado, resolverDocTipo
  // ya cayó a 99 (sin identificar) — eso ARCA lo rechaza para tipo A, así
  // que se corta acá con un mensaje accionable en vez del rechazo genérico.
  if (letra === 'A' && docTipo !== 80) {
    return await registrarError(
      facturaId,
      `[wsfev1] La factura requiere letra A (cliente Responsable Inscripto) pero no tiene un ` +
      `CUIT válido cargado (cuit actual: "${factura.clientes?.cuit ?? ''}"). ` +
      'ARCA exige receptor identificado por CUIT en Factura A. Corregir el CUIT del cliente antes de facturar.'
    );
  }

  let cae, caeVto;
  try {
    ({ cae, caeVto } = await solicitarCAE({
      url,
      token,
      sign,
      cuit:      config.cuit,
      ptoVenta:  config.punto_venta,
      tipoCbte,
      nroCbte,
      fecha,
      concepto:  CONCEPTO_PRODUCTOS,
      docTipo,
      docNro,
      impTotal,
      impNeto,
      impIVA,
      condicionIvaReceptorId,
      ivaItems,
    }));
  } catch (err) {
    return await registrarError(facturaId, `[wsfev1] Error solicitando CAE: ${err.message}`);
  }

  // 5. Persistir resultado exitoso
  const numeroFormateado = String(nroCbte).padStart(8, '0');
  const numeroCompleto = `${letra}-${String(config.punto_venta).padStart(5, '0')}-${numeroFormateado}`;
  const { error: updateError } = await supabase
    .from('facturas')
    .update({
      estado:       'emitida',
      cae,
      cae_vto:      caeVto,       // formato YYYY-MM-DD
      numero:       numeroCompleto,
      neto:         impNeto,
      iva:          impIVA,
      tipo:         letra,
    })
    .eq('id', facturaId);

  if (updateError) {
    // El CAE ya fue otorgado por ARCA, pero la persistencia local falló.
    // Nunca devolver ok:true ni dejar la factura reintentable como pendiente:
    // un reintento podría pedir un segundo comprobante fiscal.
    const mensaje = `CAE ${cae} obtenido en ARCA, pero no se pudo persistir la factura: ${updateError.message}`;
    console.error('[wsfev1] CAE obtenido pero falló el UPDATE en facturas:', updateError.message, {
      facturaId, cae, caeVto, numero: nroCbte,
    });

    const { error: estadoError } = await supabase
      .from('facturas')
      .update({
        estado: 'cae_obtenido_sin_persistir',
        notas_error: mensaje,
        cae,
        cae_vto: caeVto,
        numero: numeroCompleto,
        tipo: letra,
      })
      .eq('id', facturaId);

    if (estadoError) {
      console.error('[wsfev1] Tampoco se pudo marcar cae_obtenido_sin_persistir:', estadoError.message, { facturaId });
    }

    return {
      ok: false,
      codigo: 'cae_obtenido_sin_persistir',
      estado: 'cae_obtenido_sin_persistir',
      error: 'ARCA autorizó el comprobante, pero la persistencia local falló. Requiere reconciliación; no reintentar la emisión.',
      facturaId,
      cae,
      caeVto,
      numero: nroCbte,
      numeroFormateado: numeroCompleto,
    };
  }

  return {
    ok:     true,
    cae,
    caeVto,
    numero: nroCbte,
    numeroFormateado: numeroCompleto,
  };
}

// ── Leer contexto ─────────────────────────────────────────────────────

async function leerContextoFactura(facturaId) {
  const { data: factura, error: errFact } = await supabase
    .from('facturas')
    .select('id, empresa_id, cliente_id, pedido_id, venta_pos_id, tipo, total, estado, cae, numero, fecha_emision, clientes(cuit, condicion_iva)')
    .eq('id', facturaId)
    .single();

  if (errFact || !factura) {
    throw new Error(`[wsfev1] Factura ${facturaId} no encontrada: ${errFact?.message ?? 'sin datos'}`);
  }

  // NOTA: el check de estado se hace en cada caller con su propia lógica:
  //  - emitirComprobanteARCA: rechaza si YA está emitida (no re-emitir)
  //  - emitirNotaCreditoARCA: rechaza si NO está emitida (sólo se anulan emitidas)

  if (!factura.total || factura.total <= 0) {
    throw new Error(`[wsfev1] La factura ${facturaId} tiene total inválido: ${factura.total}`);
  }

  const { data: config, error: errCfg } = await supabase
    .from('facturacion_config')
    .select('cuit, punto_venta, homologacion, cert_pem, key_pem, condicion_iva')
    .eq('empresa_id', factura.empresa_id)
    .eq('activo', true)
    .maybeSingle();

  if (errCfg) {
    throw new Error(`[wsfev1] Error leyendo facturacion_config: ${errCfg.message}`);
  }
  if (!config) {
    throw new Error(`[wsfev1] No hay facturacion_config activa para empresa ${factura.empresa_id}`);
  }
  if (!config.cuit || !config.punto_venta) {
    throw new Error(`[wsfev1] facturacion_config incompleta: falta cuit o punto_venta`);
  }

  // Defensivo: cert_pem/key_pem se guardan cifrados (lib/crypto-secrets.js).
  // Este módulo no los usa directamente hoy (la firma ocurre en wsaa.js),
  // pero se descifran acá también para que ningún caller futuro termine
  // operando sobre el valor cifrado sin darse cuenta.
  config.cert_pem = descifrar(config.cert_pem);
  config.key_pem  = descifrar(config.key_pem);

  return { factura, config };
}

// ── Consultar último número autorizado ───────────────────────────────

async function consultarUltimoNumero({ url, token, sign, cuit, ptoVenta, tipoCbte }) {
  const soap =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:ar="http://ar.gov.afip.dif.FEV1/">\n' +
    '  <soapenv:Header/>\n' +
    '  <soapenv:Body>\n' +
    '    <ar:FECompUltimoAutorizado>\n' +
    '      <ar:Auth>\n' +
    `        <ar:Token>${token}</ar:Token>\n` +
    `        <ar:Sign>${sign}</ar:Sign>\n` +
    `        <ar:Cuit>${limpiarCuit(cuit)}</ar:Cuit>\n` +
    '      </ar:Auth>\n' +
    `      <ar:PtoVta>${ptoVenta}</ar:PtoVta>\n` +
    `      <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>\n` +
    '    </ar:FECompUltimoAutorizado>\n' +
    '  </soapenv:Body>\n' +
    '</soapenv:Envelope>';

  // FECompUltimoAutorizado solo consulta el último número usado, sin efectos
  // secundarios — es seguro reintentarlo en timeouts/5xx transitorios.
  const text = await withRetry(() => llamarSOAP(url, 'FECompUltimoAutorizado', soap), { intentos: 3 });

  // Verificar errores ARCA en la respuesta
  verificarErroresARCA(text, 'FECompUltimoAutorizado');

  const nroMatch = text.match(/<CbteNro>(\d+)<\/CbteNro>/);
  if (!nroMatch) {
    throw new Error(`[wsfev1] FECompUltimoAutorizado no devolvió CbteNro. Respuesta: ${text.slice(0, 400)}`);
  }

  return parseInt(nroMatch[1], 10);
}

// ── Solicitar CAE ─────────────────────────────────────────────────────

async function solicitarCAE({
  url, token, sign, cuit, ptoVenta, tipoCbte, nroCbte,
  fecha, concepto, docTipo, docNro, impTotal, impNeto, impIVA,
  condicionIvaReceptorId,   // obligatorio desde RG 5616 (ver resolverCondicionIvaReceptor)
  cbteAsoc = null,   // { tipo, ptoVenta, nro, cuit, fecha } — requerido para NC
  ivaItems = null,   // [{ id, baseImp, importe }] — requerido para Factura A/B, null para C
}) {
  // El bloque <CbtesAsoc> solo aparece en NC/ND; para facturas ordinarias va vacío.
  const bloqueAsoc = cbteAsoc
    ? (
        '            <ar:CbtesAsoc>\n' +
        '              <ar:CbteAsoc>\n' +
        `                <ar:Tipo>${cbteAsoc.tipo}</ar:Tipo>\n` +
        `                <ar:PtoVta>${cbteAsoc.ptoVenta}</ar:PtoVta>\n` +
        `                <ar:Nro>${cbteAsoc.nro}</ar:Nro>\n` +
        `                <ar:Cuit>${cbteAsoc.cuit}</ar:Cuit>\n` +
        `                <ar:CbteFch>${cbteAsoc.fecha}</ar:CbteFch>\n` +
        '              </ar:CbteAsoc>\n' +
        '            </ar:CbtesAsoc>\n'
      )
    : '';

  // El bloque <Iva> solo aparece en Factura A/B (donde se discrimina IVA
  // por alícuota); Factura C no lo manda. Va después de <CbtesAsoc> en la
  // secuencia que expone el manual de WSFEv1.
  const bloqueIva = (ivaItems && ivaItems.length)
    ? (
        '            <ar:Iva>\n' +
        ivaItems.map(a =>
          '              <ar:AlicIva>\n' +
          `                <ar:Id>${a.id}</ar:Id>\n` +
          `                <ar:BaseImp>${a.baseImp.toFixed(2)}</ar:BaseImp>\n` +
          `                <ar:Importe>${a.importe.toFixed(2)}</ar:Importe>\n` +
          '              </ar:AlicIva>\n'
        ).join('') +
        '            </ar:Iva>\n'
      )
    : '';

  const soap =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:ar="http://ar.gov.afip.dif.FEV1/">\n' +
    '  <soapenv:Header/>\n' +
    '  <soapenv:Body>\n' +
    '    <ar:FECAESolicitar>\n' +
    '      <ar:Auth>\n' +
    `        <ar:Token>${token}</ar:Token>\n` +
    `        <ar:Sign>${sign}</ar:Sign>\n` +
    `        <ar:Cuit>${limpiarCuit(cuit)}</ar:Cuit>\n` +
    '      </ar:Auth>\n' +
    '      <ar:FeCAEReq>\n' +
    '        <ar:FeCabReq>\n' +
    `          <ar:CantReg>1</ar:CantReg>\n` +
    `          <ar:PtoVta>${ptoVenta}</ar:PtoVta>\n` +
    `          <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>\n` +
    '        </ar:FeCabReq>\n' +
    '        <ar:FeDetReq>\n' +
    '          <ar:FECAEDetRequest>\n' +
    `            <ar:Concepto>${concepto}</ar:Concepto>\n` +
    `            <ar:DocTipo>${docTipo}</ar:DocTipo>\n` +
    `            <ar:DocNro>${docNro}</ar:DocNro>\n` +
    `            <ar:CbteDesde>${nroCbte}</ar:CbteDesde>\n` +
    `            <ar:CbteHasta>${nroCbte}</ar:CbteHasta>\n` +
    `            <ar:CbteFch>${fecha}</ar:CbteFch>\n` +
    `            <ar:ImpTotal>${impTotal.toFixed(2)}</ar:ImpTotal>\n` +
    `            <ar:ImpTotConc>0.00</ar:ImpTotConc>\n` +
    `            <ar:ImpNeto>${impNeto.toFixed(2)}</ar:ImpNeto>\n` +
    `            <ar:ImpOpEx>0.00</ar:ImpOpEx>\n` +
    `            <ar:ImpIVA>${impIVA.toFixed(2)}</ar:ImpIVA>\n` +
    `            <ar:ImpTrib>0.00</ar:ImpTrib>\n` +
    `            <ar:MonId>PES</ar:MonId>\n` +
    `            <ar:MonCotiz>1</ar:MonCotiz>\n` +
    `            <ar:CondicionIVAReceptorId>${condicionIvaReceptorId}</ar:CondicionIVAReceptorId>\n` +
    bloqueAsoc +
    bloqueIva +
    '          </ar:FECAEDetRequest>\n' +
    '        </ar:FeDetReq>\n' +
    '      </ar:FeCAEReq>\n' +
    '    </ar:FECAESolicitar>\n' +
    '  </soapenv:Body>\n' +
    '</soapenv:Envelope>';

  // FECAESolicitar emite y numera el comprobante: NO es seguro reintentar
  // automáticamente. Si esto tira timeout, no sabemos si ARCA llegó a
  // procesar la emisión de su lado o no — reintentar a ciegas podría
  // numerar el mismo comprobante dos veces. Se deja sin retry automático;
  // el caller debe usar FECompUltimoAutorizado para verificar el estado
  // real antes de reintentar manualmente la emisión.
  let text;
  try {
    text = await llamarSOAP(url, 'FECAESolicitar', soap);
  } catch (err) {
    if (err.message?.includes('Timeout')) {
      throw new Error(
        `${err.message} No se reintenta automáticamente porque no es seguro: ` +
        `verificar con FECompUltimoAutorizado si el comprobante quedó autorizado ` +
        `en ARCA antes de volver a emitirlo.`
      );
    }
    throw err;
  }

  // Errores de cabecera SOAP (auth, red, ARCA down)
  verificarErroresARCA(text, 'FECAESolicitar');

  // Resultado del comprobante (puede ser A=Aprobado o R=Rechazado)
  const resultado = text.match(/<Resultado>([\s\S]*?)<\/Resultado>/)?.[1]?.trim();
  if (resultado !== 'A') {
    // Extraer observaciones y errores de ARCA para dar un mensaje útil
    const obs = extraerObservaciones(text);
    const errores = extraerErrores(text);
    const detalle = [...obs, ...errores].join(' | ') || 'Sin detalle adicional';
    throw new Error(`[wsfev1] ARCA rechazó el comprobante (Resultado=${resultado}): ${detalle}`);
  }

  const cae = text.match(/<CAE>([\s\S]*?)<\/CAE>/)?.[1]?.trim();
  const caeVtoRaw = text.match(/<CAEFchVto>([\s\S]*?)<\/CAEFchVto>/)?.[1]?.trim();

  if (!cae || !caeVtoRaw) {
    throw new Error(
      `[wsfev1] FECAESolicitar aprobado pero no se encontró CAE/CAEFchVto en la respuesta. ` +
      `Respuesta: ${text.slice(0, 500)}`
    );
  }

  // ARCA devuelve la fecha como YYYYMMDD → convertir a YYYY-MM-DD para Postgres
  const caeVto = `${caeVtoRaw.slice(0, 4)}-${caeVtoRaw.slice(4, 6)}-${caeVtoRaw.slice(6, 8)}`;

  return { cae, caeVto };
}

// ── HTTP SOAP genérico ────────────────────────────────────────────────

// Timeout de las llamadas SOAP a ARCA. AFIP no tiene SLA de latencia
// publicado y en la práctica puede demorar o no responder; sin esto, una
// función serverless puede quedar colgada hasta que Vercel la mate,
// devolviendo un 504 genérico en vez de un error claro y accionable.
const ARCA_TIMEOUT_MS = 15_000;

async function llamarSOAP(url, action, body) {
  let resp, text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCA_TIMEOUT_MS);

  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction:     `http://ar.gov.afip.dif.FEV1/${action}`,
      },
      body,
      signal: controller.signal,
    });
    text = await resp.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(
        `[wsfev1] Timeout (${ARCA_TIMEOUT_MS}ms) esperando respuesta de ARCA en ${action} (${url}).`
      );
      // Sin .status → defaultEsReintentable() de retry.js lo trata como
      // error de red transitorio y reintenta.
      throw timeoutErr;
    }
    throw new Error(`[wsfev1] Error de red en ${action} (${url}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const fault = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (fault) {
    // SOAP Fault es un rechazo de negocio de ARCA (CUIT inválido, cert
    // vencido, etc.), no un problema transitorio — no debe reintentarse.
    const faultErr = new Error(`[wsfev1] SOAP Fault en ${action}: ${decodificarXML(fault[1])}`);
    faultErr.status = 400;
    throw faultErr;
  }

  if (!resp.ok) {
    const httpErr = new Error(`[wsfev1] HTTP ${resp.status} en ${action}: ${text.slice(0, 400)}`);
    httpErr.status = resp.status; // permite que withRetry distinga 5xx (reintentable) de 4xx
    throw httpErr;
  }

  return text;
}

// ── Parseo de respuestas ARCA ─────────────────────────────────────────

function verificarErroresARCA(xml, accion) {
  // <Errors><Err><Code>N</Code><Msg>texto</Msg></Err></Errors>
  const erroresMatch = xml.match(/<Errors>([\s\S]*?)<\/Errors>/);
  if (!erroresMatch) return;

  const msgs = [...erroresMatch[1].matchAll(/<Msg>([\s\S]*?)<\/Msg>/g)]
    .map(m => decodificarXML(m[1].trim()))
    .filter(Boolean);

  if (msgs.length > 0) {
    throw new Error(`[wsfev1] Error ARCA en ${accion}: ${msgs.join(' | ')}`);
  }
}

function extraerObservaciones(xml) {
  const seccion = xml.match(/<Obs>([\s\S]*?)<\/Obs>/);
  if (!seccion) return [];
  return [...seccion[1].matchAll(/<Msg>([\s\S]*?)<\/Msg>/g)]
    .map(m => `Obs: ${decodificarXML(m[1].trim())}`);
}

function extraerErrores(xml) {
  const seccion = xml.match(/<Errors>([\s\S]*?)<\/Errors>/);
  if (!seccion) return [];
  return [...seccion[1].matchAll(/<Msg>([\s\S]*?)<\/Msg>/g)]
    .map(m => `Err: ${decodificarXML(m[1].trim())}`);
}

// ── Helpers de dominio ────────────────────────────────────────────────

/**
 * DocTipo ARCA:
 *   80 = CUIT           → responsable inscripto / monotributista con CUIT válido
 *   99 = Sin identificar → consumidor final (con o sin CUIT cargado)
 *
 * IMPORTANTE: la condicion_iva del cliente tiene prioridad sobre el campo cuit.
 * Si el cliente está registrado como 'consumidor_final', siempre se manda DocTipo 99
 * y DocNro 0, independientemente de lo que tenga cargado en el campo cuit.
 * Esto evita que ARCA rechace por padrón CUITs de prueba/demo en clientes CF.
 *
 * Solo se intenta DocTipo 80 (CUIT) cuando la condicion_iva es
 * 'responsable_inscripto' o 'monotributo' Y el cuit tiene formato válido.
 */
function resolverDocTipo(condicionIva, cuit) {
  // Consumidor final: siempre sin identificar, sin importar el CUIT cargado
  if (!condicionIva || condicionIva === 'consumidor_final') return 99;

  // RI o monotributista: usar CUIT si tiene formato válido, sino sin identificar
  if (
    (condicionIva === 'responsable_inscripto' || condicionIva === 'monotributo') &&
    cuit && /^\d{2}-\d{8}-\d$/.test(cuit)
  ) {
    return 80;
  }

  return 99; // fallback: sin identificar
}

/**
 * CondicionIVAReceptorId — obligatorio desde RG 5616 en <FECAEDetRequest>.
 * Códigos según tabla de ARCA (método FEParamGetCondicionIvaReceptor):
 *   1 = IVA Responsable Inscripto
 *   5 = Consumidor Final
 *   6 = Responsable Monotributo
 * Si el valor guardado en `clientes.condicion_iva` no matchea ninguno de
 * estos, se cae a Consumidor Final (5) — es el código más permisivo y el
 * que ARCA documenta para casos sin dato específico del receptor.
 */
function resolverCondicionIvaReceptor(condicionIva) {
  switch (condicionIva) {
    case 'responsable_inscripto': return 1;
    case 'monotributo':           return 6;
    case 'consumidor_final':      return 5;
    default:                      return 5;
  }
}

/**
 * Debe llamarse con los mismos parámetros que resolverDocTipo para ser consistente.
 * Si resolverDocTipo devuelve 99, este debe devolver 0.
 * Si devuelve 80, este devuelve el CUIT sin guiones.
 */
function resolverDocNro(condicionIva, cuit) {
  if (!condicionIva || condicionIva === 'consumidor_final') return 0;

  if (
    (condicionIva === 'responsable_inscripto' || condicionIva === 'monotributo') &&
    cuit && /^\d{2}-\d{8}-\d$/.test(cuit)
  ) {
    return cuit.replace(/-/g, ''); // ARCA espera solo dígitos, sin guiones
  }

  return 0; // fallback
}

/** Devuelve fecha de hoy en formato YYYYMMDD que ARCA exige en CbteFch. */
function hoy() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/** Elimina guiones del CUIT para el tag <Cuit> de ARCA (espera solo dígitos). */
function limpiarCuit(cuit) {
  return String(cuit).replace(/-/g, '');
}

/** Redondea a 2 decimales con toFixed-seguro (evita errores de punto flotante). */
function redondear2(n) {
  return Math.round(n * 100) / 100;
}

function decodificarXML(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ── Registro de errores en BD ─────────────────────────────────────────

/**
 * Marca la factura como 'error_afip' en la BD y devuelve { ok: false, error }.
 * No lanza — siempre devuelve el objeto de error para que el llamador lo
 * pueda propagar al cliente HTTP.
 */
async function registrarError(facturaId, mensaje) {
  const { error: updErr } = await supabase
    .from('facturas')
    .update({ estado: 'error_afip' })
    .eq('id', facturaId);

  if (updErr) {
    console.error('[wsfev1] No se pudo actualizar estado a error_afip:', updErr.message);
  }

  console.error(mensaje, { facturaId });
  return { ok: false, error: mensaje };
}

// ── Nota de Crédito C (tipo 13) ───────────────────────────────────────

/**
 * Emite una Nota de Crédito C (tipo 13) que anula total o parcialmente
 * una Factura C previamente emitida.
 *
 * Requisitos previos:
 *   - `facturaOriginalId` debe existir en `facturas` con estado='emitida',
 *     campos `cae`, `numero` (formato "C-XXXXX-NNNNNNNN") y `total` > 0.
 *   - La empresa debe tener `facturacion_config` activa con cert + clave.
 *
 * El número puro de comprobante (CbteNro en <CbtesAsoc>) se extrae del
 * campo `numero` de la BD quitando el prefijo "C-XXXXX-".
 * La fecha del comprobante original (CbteFch en <CbtesAsoc>) se toma
 * de `fecha_emision`; si no está, se usa la fecha actual (ARCA lo acepta
 * dentro de un margen de días).
 *
 * @param {string} facturaOriginalId  UUID de la factura a anular.
 * @param {string} [motivo]           Texto libre para `notas_error` (opcional).
 * @returns {{ ok: boolean, cae?: string, caeVto?: string, numero?: number,
 *             facturaNCId?: string, error?: string }}
 */
export async function emitirNotaCreditoARCA(facturaOriginalId, motivo = '') {
  if (!facturaOriginalId) {
    return { ok: false, error: '[wsfev1] Se requiere facturaOriginalId para la NC.' };
  }

  // 1. Leer factura original + config de la empresa
  let facturaOrig, config;
  try {
    ({ factura: facturaOrig, config } = await leerContextoFactura(facturaOriginalId));
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (facturaOrig.estado !== 'emitida') {
    return {
      ok: false,
      error: `[wsfev1] La factura ${facturaOriginalId} no está en estado 'emitida' ` +
             `(estado actual: ${facturaOrig.estado}). Solo se pueden anular facturas emitidas.`,
    };
  }

  const { data: conciliacionNC } = await supabase
    .from('cola_financiera')
    .select('id, error_msg')
    .eq('empresa_id', facturaOrig.empresa_id)
    .eq('referencia_id', facturaOriginalId)
    .eq('tipo', 'nc_cae_reconciliacion')
    .in('estado', ['pendiente', 'error', 'procesando'])
    .limit(1)
    .maybeSingle();
  if (conciliacionNC) {
    return {
      ok: false,
      codigo: 'cae_nc_obtenido_sin_persistir',
      error: 'ARCA ya autorizó una Nota de Crédito para esta factura, pero falta reconciliar la persistencia local. No se solicitará otro CAE.',
      conciliacion_id: conciliacionNC.id,
      detalle: conciliacionNC.error_msg,
    };
  }

  if (!facturaOrig.cae || !facturaOrig.numero) {
    return {
      ok: false,
      error: `[wsfev1] La factura ${facturaOriginalId} no tiene CAE o número registrado. ` +
             'No se puede emitir la nota de crédito sin esos datos.',
    };
  }

  // Extraer el número puro de comprobante del campo numero ("C-00001-00000042" → 42)
  const nroOrigPuro = extraerNumeroPuro(facturaOrig.numero);
  if (!nroOrigPuro) {
    return {
      ok: false,
      error: `[wsfev1] No se pudo extraer el número de comprobante del campo numero: "${facturaOrig.numero}". ` +
             'Formato esperado: "C-XXXXX-NNNNNNNN".',
    };
  }

  // Fecha de la factura original en formato YYYYMMDD (lo que ARCA exige en CbtesAsoc)
  const fechaOrig = facturaOrig.fecha_emision
    ? fechaArcaDesdeISO(facturaOrig.fecha_emision)
    : hoy();

  // ── Corte de modo demo — Fase 3 del proceso demo/comercial ────────────
  // Misma lógica que en emitirComprobanteARCA: cero llamadas reales a
  // AFIP/ARCA para empresas demo, incluida la consulta de último número.
  if (await esEmpresaDemo(facturaOrig.empresa_id)) {
    const puntoVentaDemo = config.punto_venta || 1;
    // Tipo sentinel -1: distinto del sentinel 0 usado para facturas demo,
    // ya que acá la numeración demo cuenta por separado (tipo='NC_C').
    // anularFactura() no envuelve este llamado en try/catch — se captura
    // localmente para no propagar sin capturar (mismo criterio que en el
    // resto de esta función).
    let lockTokenDemo;
    try {
      lockTokenDemo = await adquirirLockEmision(facturaOrig.empresa_id, puntoVentaDemo, -1);
    } catch (err) {
      return { ok: false, error: `[wsfev1-demo] Error adquiriendo lock de emisión: ${err.message}` };
    }
    if (!lockTokenDemo) {
      return { ok: false, error: '[wsfev1-demo] Otra emisión de esta empresa está en curso. Reintentá en unos segundos.' };
    }
    try {
      const { cae, caeVto } = caeSimulado();
      const { count } = await supabase
        .from('facturas')
        .select('id', { count: 'exact', head: true })
        .eq('empresa_id', facturaOrig.empresa_id)
        .eq('tipo', 'NC_C');
      const nroNCDemo = (count || 0) + 1;
      const numeroNCDemo = `NC_C-${String(puntoVentaDemo).padStart(5, '0')}-${String(nroNCDemo).padStart(8, '0')}`;
      const totalDemo = redondear2(Number(facturaOrig.total));

      const { data: facturaNCDemo, error: insertErrDemo } = await supabase
        .from('facturas')
        .insert({
          empresa_id:        facturaOrig.empresa_id,
          cliente_id:        facturaOrig.cliente_id,
          pedido_id:         null,
          tipo:              'NC_C',
          neto:              totalDemo,
          iva:               0,
          total:             totalDemo,
          cae,
          cae_vto:           caeVto,
          numero:            numeroNCDemo,
          estado:            'emitida',
          fecha_emision:     new Date().toISOString(),
          factura_origen_id: facturaOriginalId,
        })
        .select('id')
        .single();

      if (insertErrDemo) {
        return { ok: false, error: `[wsfev1-demo] No se pudo persistir la NC simulada: ${insertErrDemo.message}` };
      }

      await supabase.from('facturas').update({ estado: 'anulada' }).eq('id', facturaOriginalId);

      return {
        ok: true,
        cae,
        caeVto,
        numero: nroNCDemo,
        facturaNCId: facturaNCDemo.id,
        demo: true,
      };
    } finally {
      await liberarLockEmision(facturaOrig.empresa_id, puntoVentaDemo, -1, lockTokenDemo);
    }
  }

  // La letra de la NC se toma de `facturaOrig.tipo` — el valor que quedó
  // grabado cuando esa factura se emitió realmente contra ARCA (ver
  // emitirComprobanteARCA). No se recalcula a partir de la condición IVA
  // actual del cliente/empresa: esos datos pueden haber cambiado desde la
  // emisión, y la NC tiene que anular exactamente lo que ARCA autorizó,
  // no lo que hoy resolvería resolverLetraComprobante().
  const letra = facturaOrig.tipo;
  if (!['A', 'B', 'C'].includes(letra)) {
    return {
      ok: false,
      error: `[wsfev1] La factura ${facturaOriginalId} tiene tipo "${facturaOrig.tipo}" ` +
        '(no es A/B/C) — no se puede determinar qué Nota de Crédito emitir para anularla.',
    };
  }

  const tipoCbteNC = letra === 'A' ? TIPO_CBTE.NOTA_CREDITO_A
                    : letra === 'B' ? TIPO_CBTE.NOTA_CREDITO_B
                    : TIPO_CBTE.NOTA_CREDITO_C;
  const tipoCbteFacturaOrig = letra === 'A' ? TIPO_CBTE.FACTURA_A
                             : letra === 'B' ? TIPO_CBTE.FACTURA_B
                             : TIPO_CBTE.FACTURA_C;

  const homologacion = config.homologacion;
  const url = homologacion ? WSFEV1_URL.homologacion : WSFEV1_URL.produccion;

  // FIX ARCA-AUDIT-01: mismo lock que emitirComprobanteARCA, clave por
  // tipo_cbte de la NC (distinto del tipo_cbte de la factura, así que no
  // se pisan entre sí, pero dos NC del mismo tipo/punto de venta sí se
  // serializan). Ver migración 487. anularFactura() en lib/facturas.js NO
  // envuelve este llamado en try/catch, así que acá conviene capturar
  // localmente cualquier error de la adquisición del lock en vez de
  // dejarlo propagar sin capturar.
  let lockToken;
  try {
    lockToken = await adquirirLockEmision(facturaOrig.empresa_id, config.punto_venta, tipoCbteNC);
  } catch (err) {
    return { ok: false, error: `[wsfev1] Error adquiriendo lock de emisión para NC: ${err.message}` };
  }
  if (!lockToken) {
    return {
      ok: false,
      error: '[wsfev1] Ya hay otra nota de crédito de este mismo tipo/punto de venta emitiéndose en este momento. ' +
        'Reintentá en unos segundos.',
    };
  }

  try {
    // 2. Token WSAA
    let token, sign;
    try {
      ({ token, sign } = await obtenerTokenWSAA(facturaOrig.empresa_id));
    } catch (err) {
      return { ok: false, error: `[wsfev1] Error obteniendo token WSAA para NC: ${err.message}` };
    }

    // 3. Último número emitido para Nota de Crédito C en este punto de venta
    let ultimoNro;
    try {
      ultimoNro = await consultarUltimoNumero({
        url,
        token,
        sign,
        cuit:     config.cuit,
        ptoVenta: config.punto_venta,
        tipoCbte: tipoCbteNC,
      });
    } catch (err) {
      return { ok: false, error: `[wsfev1] Error consultando último número NC: ${err.message}` };
    }

    const nroNC = ultimoNro + 1;

    return await continuarEmisionNC({
      facturaOrig, facturaOriginalId, config, letra, tipoCbteNC, tipoCbteFacturaOrig,
      nroOrigPuro, fechaOrig, token, sign, url, nroNC, motivo,
    });
  } finally {
    await liberarLockEmision(facturaOrig.empresa_id, config.punto_venta, tipoCbteNC, lockToken);
  }
}

// Continúa emitirNotaCreditoARCA() a partir del número de NC ya reservado
// bajo lock (pasos 4-8 del flujo original).
async function continuarEmisionNC({
  facturaOrig, facturaOriginalId, config, letra, tipoCbteNC, tipoCbteFacturaOrig,
  nroOrigPuro, fechaOrig, token, sign, url, nroNC, motivo,
}) {
  // 4. Importes: anulación total del comprobante original.
  //    Letra C: no discrimina IVA, igual que la factura original.
  //    Letra A/B: se reconstruye el mismo desglose por alícuota que tenía
  //    la factura original, desde los mismos ítems del pedido/venta —
  //    la NC total tiene que anular exactamente lo que se facturó.
  const total    = redondear2(Number(facturaOrig.total));
  const impTotal = total;
  let impNeto, impIVA, ivaItems = null;
  if (letra === 'C') {
    impNeto = total;
    impIVA  = 0;
  } else {
    let items;
    try {
      items = await obtenerItemsParaFactura(facturaOrig);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    let desglose;
    try {
      desglose = calcularDesgloseIva(items);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    impNeto  = desglose.impNeto;
    impIVA   = desglose.impIVA;
    ivaItems = desglose.alicuotas;

    const diferencia = Math.abs(redondear2(impNeto + impIVA) - impTotal);
    if (diferencia > 0.05) {
      return {
        ok: false,
        error: `[wsfev1] El desglose de IVA reconstruido para la NC (neto ${impNeto} + iva ` +
          `${impIVA} = ${redondear2(impNeto + impIVA)}) no coincide con el total de la factura ` +
          `original (${impTotal}). Diferencia: ${diferencia.toFixed(2)}. Revisar antes de anular.`,
      };
    }
  }

  const docTipo = resolverDocTipo(facturaOrig.clientes?.condicion_iva, facturaOrig.clientes?.cuit);
  const docNro  = resolverDocNro(facturaOrig.clientes?.condicion_iva, facturaOrig.clientes?.cuit);
  const condicionIvaReceptorId = resolverCondicionIvaReceptor(facturaOrig.clientes?.condicion_iva);

  // 5. Solicitar CAE para la NC, incluyendo el comprobante asociado
  let cae, caeVto;
  try {
    ({ cae, caeVto } = await solicitarCAE({
      url,
      token,
      sign,
      cuit:      config.cuit,
      ptoVenta:  config.punto_venta,
      tipoCbte:  tipoCbteNC,
      nroCbte:   nroNC,
      fecha:     hoy(),
      concepto:  CONCEPTO_PRODUCTOS,
      docTipo,
      docNro,
      impTotal,
      impNeto,
      impIVA,
      condicionIvaReceptorId,
      ivaItems,
      // Comprobante asociado (la factura que se está anulando)
      cbteAsoc: {
        tipo:     tipoCbteFacturaOrig,
        ptoVenta: config.punto_venta,
        nro:      nroOrigPuro,
        cuit:     limpiarCuit(config.cuit),
        fecha:    fechaOrig,
      },
    }));
  } catch (err) {
    return { ok: false, error: `[wsfev1] Error solicitando CAE para NC: ${err.message}` };
  }

  // 6. Persistir la Nota de Crédito y anular la factura original en una RPC
  // transaccional. Si falla después del CAE, se encola todo el payload y se
  // bloquean reemisiones para evitar duplicados fiscales.
  const numeroFormateadoNC = String(nroNC).padStart(8, '0');
  const numeroNC = `NC_${letra}-${String(config.punto_venta).padStart(5, '0')}-${numeroFormateadoNC}`;
  const tipoNC = `NC_${letra}`;
  const { data: persistenciaNC, error: persistenciaError } = await supabase.rpc(
    'persistir_nc_y_anular_factura',
    {
      p_empresa_id: facturaOrig.empresa_id,
      p_factura_original_id: facturaOriginalId,
      p_cliente_id: facturaOrig.cliente_id,
      p_neto: impNeto,
      p_iva: impIVA,
      p_total: impTotal,
      p_cae: cae,
      p_cae_vto: caeVto,
      p_numero: numeroNC,
      p_tipo: tipoNC,
      p_motivo: motivo || null,
    },
  );

  if (persistenciaError || !persistenciaNC?.ok || !persistenciaNC.factura_nc_id) {
    const persistenciaMensaje = persistenciaError?.message || persistenciaNC?.error || 'La RPC no confirmó la persistencia atómica de la NC';
    console.error('[wsfev1] CAE de NC obtenido pero persistencia transaccional falló:', persistenciaMensaje, {
      facturaOriginalId, cae, caeVto, numero: numeroNC,
    });
    const { error: colaError } = await supabase
      .from('cola_financiera')
      .upsert({
        empresa_id: facturaOrig.empresa_id,
        tipo: 'nc_cae_reconciliacion',
        referencia_id: facturaOriginalId,
        estado: 'pendiente',
        intentos: 0,
        proximo_intento: new Date().toISOString(),
        payload: {
          factura_original_id: facturaOriginalId,
          cliente_id: facturaOrig.cliente_id,
          neto: impNeto,
          iva: impIVA,
          total: impTotal,
          cae,
          cae_vto: caeVto,
          numero: numeroNC,
          tipo: tipoNC,
          motivo: motivo || null,
        },
        error_msg: persistenciaMensaje,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'referencia_id,tipo,estado', ignoreDuplicates: false });
    if (colaError) console.error('[wsfev1] No se pudo encolar reconciliación de NC:', colaError.message);
    return {
      ok: false,
      codigo: 'cae_nc_obtenido_sin_persistir',
      estado: 'cae_nc_obtenido_sin_persistir',
      cae,
      caeVto,
      numero: nroNC,
      numeroFormateado: numeroNC,
      error: 'ARCA autorizó la Nota de Crédito, pero la persistencia local falló. No reintentar; revisar la cola de conciliación.',
    };
  }

  const facturaNC = { id: persistenciaNC.factura_nc_id };

  // 7. Asentar el crédito en cta_cte (solo si hay cliente identificado)
  // FIX (auditoría pedido→factura→cta_cte→cobro): ahora vía RPC transaccional
  // (asentar_movimiento_cta_cte_factura) en vez de un INSERT suelto. La RPC
  // es idempotente (no duplica si se reintenta) y valida contra la factura.
  if (facturaOrig.cliente_id) {
    const { data: asiento, error: ctaCteErr } = await supabase.rpc(
      'asentar_movimiento_cta_cte_factura',
      {
        p_factura_id: facturaNC.id,
        p_tipo: 'credito',
        p_monto: impTotal,
        p_descripcion: `Nota de Crédito ${numeroNC} (anula ${facturaOrig.numero})`,
      }
    );

    if (ctaCteErr || !asiento?.ok) {
      const asientoMensaje = ctaCteErr?.message || asiento?.error || 'La RPC no confirmó el asiento de crédito';
      console.error(
        '[wsfev1] NC emitida pero falló el asiento en cta_cte:',
        asientoMensaje,
        { facturaNCId: facturaNC.id, clienteId: facturaOrig.cliente_id }
      );
      const { error: colaError } = await supabase
        .from('cola_financiera')
        .upsert({
          empresa_id: facturaOrig.empresa_id,
          tipo: 'asiento_nc',
          referencia_id: facturaNC.id,
          estado: 'pendiente',
          intentos: 0,
          proximo_intento: new Date().toISOString(),
          payload: {
            factura_id: facturaNC.id,
            cliente_id: facturaOrig.cliente_id,
            monto: impTotal,
            numero: numeroNC,
            factura_original_id: facturaOriginalId,
          },
          error_msg: asientoMensaje,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'referencia_id,tipo,estado', ignoreDuplicates: false });
      if (colaError) console.error('[wsfev1] No se pudo encolar asiento NC pendiente:', colaError.message);
    }
  }

  return {
    ok:           true,
    cae,
    caeVto,
    numero:       nroNC,
    numeroFormateado: numeroNC,
    facturaNCId:  facturaNC.id,
  };
}

// ── Helpers de NC ─────────────────────────────────────────────────────

/**
 * Extrae el número entero puro de un campo `numero` con formato "C-XXXXX-NNNNNNNN"
 * o "NC_C-XXXXX-NNNNNNNN". Devuelve null si el formato no coincide.
 */
function extraerNumeroPuro(numero) {
  if (!numero) return null;
  const match = numero.match(/[-_](\d{8})$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Convierte una fecha ISO (2026-06-22T...) al formato YYYYMMDD que ARCA espera
 * en el campo CbteFch de CbtesAsoc.
 */
function fechaArcaDesdeISO(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return hoy();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
