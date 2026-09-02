// api/cierre/index.js — REQ-2: Cierre Financiero Encadenado Automático
import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { notifAuto } from './_auto-push.js';
import { enviarEmail } from '../email.js';
import { rateLimit } from '../rate-limit.js';
import { emitirFactura } from '../facturas.js';
import { obtenerUltimoSaldo, insertarMovimiento, listarMovimientosPorCliente } from '../repos/cta-cte.js';
import { registrarCobroCompletoRpc } from '../repos/pagos.js';
import { registrarLog as registrarNotifLog } from '../repos/notif.js';
import * as CierreRepo from '../repos/cierre.js';

const sb = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]);

const rateLimitCierre = rateLimit({ max: 20, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitCierre(req, res)) return;

  // CRON-001 (auditoría 2026-07-26): se sacó la confianza en `x-vercel-cron`
  // (spoofeable por cualquiera en un request normal) — solo se acepta el
  // `CRON_SECRET` real. Antes desbloqueaba procesar la cola financiera
  // (facturar/notificar/bloquear) de TODAS las empresas sin ningún secreto.
  const esInterno = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  let perfil = null;
  if (!esInterno) {
    perfil = await verificarToken(req, sb);
    if (!perfil || !['dueno', 'admin'].includes(perfil.rol))
      return res.status(401).json({ error: 'No autorizado' });
  }

  const procesados = { facturar: 0, notif: 0, bloquear: 0, conciliacion: 0, error: 0 };

  // FIX (audit Fase 2, hallazgo #3): si NO es el cron interno, un dueño/admin
  // sólo puede disparar el procesamiento de la cola de SU empresa. Antes esta
  // query no filtraba por empresa_id y cualquier dueño/admin podía procesar
  // (facturar, notificar, bloquear) la cola financiera de todas las empresas.
  const tareas = await CierreRepo.obtenerTareasColaFinanciera(esInterno ? null : perfil.empresa_id);

  const procesadosLoop = await procesarTareasColaFinanciera(tareas);
  for (const k of Object.keys(procesadosLoop)) procesados[k] += procesadosLoop[k];

  await detectarVencimientosYBloquear();
  return res.json({ ok: true, procesados });
}

// Loop de procesamiento puro (sin tocar req/res ni el gateo de rol/CRON_SECRET
// de arriba) — extraído para que se pueda reusar tal cual desde otro llamador
// ya autorizado y ya scopeado por empresa_id, en vez de reimplementar esta
// lógica en otro archivo. Devuelve los mismos contadores que ya devolvía
// `handler()` en su response.
async function procesarTareasColaFinanciera(tareas) {
  const procesados = { facturar: 0, notif: 0, bloquear: 0, conciliacion: 0, error: 0 };

  for (const tarea of (tareas || [])) {
    await CierreRepo.marcarTareaProcesando(tarea.id, tarea.intentos + 1);

    try {
      if (tarea.tipo === 'facturar') {
        await procesarFacturacion(tarea);
        procesados.facturar++;
      } else if (tarea.tipo === 'notif_vencimiento') {
        await procesarNotifVencimiento(tarea);
        procesados.notif++;
      } else if (tarea.tipo === 'bloquear') {
        await procesarBloqueo(tarea);
        procesados.bloquear++;
        notifAuto(tarea.empresa_id, {
          tipo:   'cierre_cliente_bloqueado',
          titulo: 'Cliente bloqueado',
          cuerpo: `${tarea.datos?.razon_social || 'Un cliente'} fue bloqueado por deuda vencida`,
          link:   '/admin/cobranzas?vista=saldos',
        }).catch(() => {});
      } else if (['asiento_factura', 'asiento_nc', 'vinculo_venta_factura', 'nc_cae_reconciliacion', 'cobro_mp_reconciliacion'].includes(tarea.tipo)) {
        await procesarConciliacionFinanciera(tarea);
        procesados.conciliacion++;
      } else {
        throw new Error(`Tipo de tarea financiera no soportado: ${tarea.tipo}`);
      }
      await CierreRepo.marcarTareaCompletada(tarea.id);
    } catch (err) {
      procesados.error++;
      let estadoActual = 'error';
      let proximoIntento = null;

      if (tarea.intentos >= 3) { // Si es el 4to intento (0, 1, 2, 3)
        estadoActual = 'dead_letter';
        // No se programa un próximo intento, queda en DLQ para revisión manual
      } else {
        const backoff = Math.pow(2, tarea.intentos) * 15;
        proximoIntento = new Date(Date.now() + backoff * 60000);
      }

      await CierreRepo.marcarTareaConError(tarea.id, {
        estado: estadoActual,
        error_msg: err.message,
        proximo_intento: proximoIntento,
      });
    }
  }

  return procesados;
}

// Versión scopeada por empresa, para llamadores ya autorizados que NO son
// el cron interno (ej. la tool de chat del asistente) — mismo criterio de
// selección que la rama `!esInterno` de arriba (pendiente/error, con
// intentos<4, ya vencido su proximo_intento), pero como función standalone.
// Deliberadamente NO llama a detectarVencimientosYBloquear(): esa función
// escanea facturas vencidas de TODAS las empresas (no filtra por
// empresa_id) para encolar los `bloquear` — dejarla fuera de acá evita que
// una empresa dispare, de paso, la detección de vencidos de las demás.
export async function procesarColaFinancieraEmpresa(empresaId) {
  const tareas = await CierreRepo.obtenerTareasColaFinanciera(empresaId);
  return procesarTareasColaFinanciera(tareas);
}

async function procesarConciliacionFinanciera(tarea) {
  const payload = tarea.payload || {};

  if (tarea.tipo === 'asiento_factura' || tarea.tipo === 'asiento_nc') {
    const { data, error } = await sb.rpc('asentar_movimiento_cta_cte_factura', {
      p_factura_id: payload.factura_id,
      p_tipo: tarea.tipo === 'asiento_nc' ? 'credito' : 'debito',
      p_monto: Number(payload.monto),
      p_descripcion: payload.numero ? `Conciliación ${payload.numero}` : `Conciliación ${tarea.tipo}`,
    });
    if (error || !data?.ok) throw new Error(error?.message || data?.error || 'La RPC de asiento no confirmó la conciliación.');
    return;
  }

  if (tarea.tipo === 'vinculo_venta_factura') {
    const { error } = await sb
      .from('ventas_pos')
      .update({ factura_id: payload.factura_id })
      .eq('id', payload.venta_pos_id)
      .eq('empresa_id', tarea.empresa_id);
    if (error) throw new Error(error.message);
    return;
  }

  if (tarea.tipo === 'nc_cae_reconciliacion') {
    const { error, data } = await sb.rpc('persistir_nc_y_anular_factura', {
      p_empresa_id: tarea.empresa_id,
      p_factura_original_id: payload.factura_original_id,
      p_cliente_id: payload.cliente_id,
      p_neto: payload.neto,
      p_iva: payload.iva,
      p_total: payload.total,
      p_cae: payload.cae,
      p_cae_vto: payload.cae_vto,
      p_numero: payload.numero,
      p_tipo: payload.tipo,
      p_motivo: payload.motivo || null,
    });
    if (error || !data?.ok) throw new Error(error?.message || data?.error || 'La RPC de reconciliación de NC no confirmó la operación.');
    return;
  }

  // SYNC-07 (Auditoría Integral 2026): reintento del registro de cobro de
  // Mercado Pago que falló en el webhook o en el polling (ver
  // lib/handlers/pagos.js). Se reusa el mismo `offline_local_id` con el
  // que se intentó la primera vez — registrar_cobro_completo dedupea por
  // ese campo contra un índice único, así que reintentar acá nunca puede
  // duplicar el cobro, sea cual sea el motivo del fallo original.
  if (tarea.tipo === 'cobro_mp_reconciliacion') {
    const { data, error } = await registrarCobroCompletoRpc({
      p_empresa_id: tarea.empresa_id,
      p_cliente_id: payload.cliente_id,
      p_monto: payload.monto,
      p_medio: 'mercado_pago',
      p_referencia: payload.payment_id,
      p_offline_local_id: payload.offline_local_id,
    });
    if (error || !data?.ok) throw new Error(error?.message || data?.error || 'La RPC de cobro no confirmó la reconciliación.');
    return;
  }

  throw new Error(`Tipo de conciliación desconocido: ${tarea.tipo}`);
}

async function procesarFacturacion(tarea) {
  const { pedido_id, total, dias_credito, vence_en } = tarea.payload;

  // Idempotencia: verificar si ya existe factura para este pedido
  const factExist = await CierreRepo.obtenerFacturaPorPedido(pedido_id);
  if (factExist) return;

  const pedido = await CierreRepo.obtenerPedidoParaFacturacion(pedido_id);

  // FIX (auditoría 2026-07-30): antes se chequeaba
  // `empresas.config.facturacion.api_key`/`.usertoken` — integración vieja
  // (FacturAPI) ya reemplazada por ARCA/WSFEv1 (ver lib/facturas.js). Como
  // ninguna empresa real tiene ese config seteado (se verificó contra la
  // base: 0 de 2), esa rama nunca facturaba — el cierre asentaba el débito
  // en cta_cte pero NUNCA emitía la factura electrónica real. Ahora se
  // chequea `facturacion_config` (la tabla que usa de verdad ARCA) y, si
  // está activa, se llama a emitirFactura() — la misma función que usa el
  // botón "Facturar" manual del panel — en vez de reimplementar la
  // integración con ARCA acá.
  const facturacionConfig = await CierreRepo.obtenerFacturacionConfigActiva(pedido.empresa_id);

  let facturaId = null;
  let facturaNumero = null;
  let facturaEmitida = false;

  if (facturacionConfig) {
    const resultado = await emitirFactura(pedido_id);
    if (!resultado.ok) {
      // FIX: antes un error acá no cortaba nada (nunca se chequeaba si la
      // llamada había salido bien) — la tarea se daba por 'completado'
      // igual, sin factura y sin ningún registro de que algo había
      // fallado. Ahora se relanza para que procesarTareasColaFinanciera()
      // marque la tarea como 'error' y reintente con el mismo backoff que
      // ya tiene cualquier otro error de esta función.
      throw new Error(`No se pudo facturar el pedido ${pedido_id}: ${resultado.error}`);
    }
    facturaId = resultado.factura.id;
    facturaNumero = resultado.factura.numero;
    facturaEmitida = true;

    if (vence_en) {
      await CierreRepo.actualizarFechaVencimientoFactura(facturaId, vence_en);
    }
  }

  // Si se facturó, emitirFactura() ya asentó el débito en cta_cte por su
  // cuenta (RPC asentar_movimiento_cta_cte_factura, ver lib/facturas.js) —
  // insertarEnCtaCte() de acá abajo es SOLO para el caso sin facturación
  // electrónica configurada (se sigue registrando la deuda igual, sin
  // factura, como hacía el código original). Llamarlo también cuando SÍ
  // se facturó duplicaría la deuda del cliente.
  if (!facturaEmitida) {
    await insertarEnCtaCte(pedido, facturaId);
  }

  if (pedido.clientes?.email) {
    await enviarEmail({
      to: pedido.clientes.email,
      subject: `Tu pedido fue entregado · Factura #${facturaNumero || ''}`,
      html: `<p>Hola ${pedido.clientes.razon_social},</p>
             <p>Tu pedido fue entregado. Total: <strong>$${Number(total).toLocaleString('es-AR')}</strong></p>
             ${vence_en ? `<p>Vencimiento: ${vence_en}</p>` : ''}`
    });
  }
}

async function insertarEnCtaCte(pedido, factura_id) {
  const saldoAnterior = await obtenerUltimoSaldo(pedido.empresa_id, pedido.cliente_id);

  // FIX (audit Fase 2, hallazgo #2): faltaba empresa_id en el payload (la
  // columna es NOT NULL) y el error de Supabase nunca se revisaba, así que
  // un insert fallido quedaba en silencio y la tarea de cola_financiera se
  // marcaba igual como 'completado' en el caller. Ahora se completa
  // empresa_id y se relanza el error para que procesarFacturacion() lo
  // propague y el loop principal (api/cierre) marque la tarea como error
  // y reintente en vez de darla por hecha.
  try {
    await insertarMovimiento({
      empresa_id: pedido.empresa_id,
      cliente_id: pedido.cliente_id,
      tipo: 'debito',
      monto: pedido.total,
      factura_id,
      saldo: saldoAnterior + pedido.total,
      fecha: new Date(),
    });
  } catch (error) {
    console.error('[CIERRE] Error insertando en cta_cte:', error.message, { pedido_id: pedido.id });
    throw new Error(`insertarEnCtaCte falló: ${error.message}`);
  }
}

async function procesarNotifVencimiento(tarea) {
  const cliente = await CierreRepo.obtenerClienteParaNotifVencimiento(tarea.referencia_id);

  const deuda = await obtenerUltimoSaldo(tarea.empresa_id, tarea.referencia_id);
  if (deuda <= 0) return;

  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

  // WhatsApp
  // FIX v957 (hallazgo continuación Etapa 2b): el `.catch(() => {})` descartaba
  // el error entero — ni siquiera un console.error, a diferencia de todos los
  // demás disparos de WhatsApp del repo (pedidos.js, auth.js), que como mínimo
  // loguean. Ahora se chequea resp.ok y se deja rastro en notif_log (mismo
  // repo/tabla que usa pedidos.js vía _logNotif), sin cambiar el criterio de
  // "no cortar el cierre financiero si falla un aviso".
  try {
    const respWa = await fetch(`${base}/api/notif/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'recordatorio_vencimiento',
        telefono: cliente.telefono,
        params: {
          nombre_cliente: cliente.razon_social.split(' ')[0],
          monto: deuda,
          dias: tarea.payload.dias_vencimiento
        }
      })
    });
    const dataWa = await respWa.json().catch(() => ({}));
    await registrarNotifLog({
      empresa_id: tarea.empresa_id,
      cliente_id: tarea.referencia_id,
      tipo: 'recordatorio_vencimiento',
      canal: 'whatsapp',
      telefono: cliente.telefono || null,
      payload: { monto: deuda, dias: tarea.payload.dias_vencimiento, error: respWa.ok ? null : (dataWa.error || null) },
      entregada: respWa.ok,
      motivo: respWa.ok ? null : 'error_envio',
    });
    if (!respWa.ok) console.error('[CIERRE] Error WA recordatorio_vencimiento:', dataWa.error);
  } catch (errWa) {
    console.error('[CIERRE] Excepción WA recordatorio_vencimiento:', errWa.message);
    await registrarNotifLog({
      empresa_id: tarea.empresa_id,
      cliente_id: tarea.referencia_id,
      tipo: 'recordatorio_vencimiento',
      canal: 'whatsapp',
      telefono: cliente.telefono || null,
      payload: { monto: deuda, dias: tarea.payload.dias_vencimiento, error: errWa.message },
      entregada: false,
      motivo: 'excepcion',
    });
  }

  // Email
  if (cliente.email) {
    await enviarEmail({
      to: cliente.email,
      subject: 'Recordatorio de pago próximo a vencer',
      html: `<p>Hola ${cliente.razon_social}, tu deuda de $${Number(deuda).toLocaleString('es-AR')} vence en ${tarea.payload.dias_vencimiento} días.</p>`
    });
  }
}

async function detectarVencimientosYBloquear() {
  const cutoffISO = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const vencidas = await CierreRepo.obtenerFacturasVencidasSinNotificar(cutoffISO);

  for (const f of (vencidas || [])) {
    const cliente_id = f.pedidos?.cliente_id;
    if (!cliente_id) continue;

    const movs = await listarMovimientosPorCliente(f.empresa_id, cliente_id);

    const deuda = (movs || []).reduce((acc, m) => m.tipo === 'debito' ? acc + m.monto : acc - m.monto, 0);
    if (deuda > 0) {
      await CierreRepo.encolarTareaBloqueo({
        empresa_id: f.empresa_id,
        tipo: 'bloquear',
        referencia_id: cliente_id,
        payload: { deuda, motivo: 'deuda_vencida' }
      });
    }
    await CierreRepo.marcarFacturaNotif15dEnviada(f.id);
  }
}

async function procesarBloqueo(tarea) {
  const { deuda } = tarea.payload;
  await CierreRepo.bloquearCliente(tarea.referencia_id, {
    /* bloqueado y bloqueado_motivo: columnas agregadas por 047_sincronizacion_real_db.sql */
    bloqueado_motivo: `Deuda vencida $${Number(deuda).toLocaleString('es-AR')}`
  });

  await CierreRepo.upsertBloqueoCliente({
    cliente_id: tarea.referencia_id,
    empresa_id: tarea.empresa_id,
    motivo: 'deuda_vencida',
    deuda_monto: deuda,
    activo: true
  });
}
