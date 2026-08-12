// lib/handlers/auditoria.js — Innovación #6: Auditoría Predictiva de Anomalías Internas
//
// Cron nocturno que corre detectar_anomalias_auditoria() (db/070_auditoria_anomalias.sql)
// y avisa al dueño/admin por push cuando aparece un patrón sospechoso: descuentos
// repetidos, ajustes de stock sin OC de respaldo, o movimientos de stock alterados.
//
// Sin tabla de alertas propia (a diferencia de alertas_stock): no hay workflow de
// "resolver" sobre estas anomalías, son información para que el dueño investigue.
// La idempotencia del push se logra acotando la ventana del cron a 1 día (sólo lo
// nuevo desde la corrida anterior) — la "vista previa" manual/dashboard sí usa una
// ventana de 7 días para dar panorama, pero esa NO dispara push (ver `notificar`).
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { notifAuto } from './_auto-push.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { db } from '../repos/_db.js';
import {
  listarEmpresasActivas,
  detectarAnomaliasRpc,
  upsertAnomaliaRevisada,
  listarAnomaliasRevisadas,
} from '../repos/auditoria.js';

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  // CRON-001 (auditoría 2026-07-26): se sacó la confianza en `x-vercel-cron`
  // (spoofeable por cualquiera en un request normal) — solo se acepta el
  // `CRON_SECRET` real.
  const esInterno = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  if (!esInterno) {
    const perfil = await verificarToken(req, db);
    if (!perfil || !['dueno', 'admin'].includes(perfil.rol))
      return res.status(401).json({ error: 'No autorizado' });
    req._perfil = perfil;
  }

  const accion = req.query.accion || req.body?.accion;

  // ── Analizar empresa(s) y, si es el cron, avisar al dueño ─────────────────
  if (accion === 'analizar') {
    let empresas;
    if (esInterno) {
      empresas = await listarEmpresasActivas();
    } else {
      empresas = [{ id: req._perfil.empresa_id }];
    }

    // Cron: sólo lo nuevo desde ayer (evita re-avisar lo mismo 7 noches seguidas).
    // Manual/dashboard: ventana configurable (default 7 días) para dar panorama.
    const diasLookback = esInterno ? 1 : (Number(req.query.dias) || 7);

    const resultados = [];
    for (const emp of empresas) {
      const anomalias = await detectarYNotificar(emp.id, diasLookback, esInterno);
      resultados.push({
        empresa_id: emp.id,
        anomalias_detectadas: anomalias.length,
        anomalias,
      });
    }
    return res.json({ ok: true, resultados });
  }

  // ── Marcar anomalía como revisada (persiste en DB) ───────────────────────
  if (accion === 'resolver' && req.method === 'POST') {
    const { tipo_anomalia, usuario_id, entidad_id, notas } = req.body || {};
    if (!tipo_anomalia) return res.status(400).json({ error: 'tipo_anomalia requerido' });

    const { error } = await upsertAnomaliaRevisada({
      empresa_id:    req._perfil.empresa_id,
      tipo_anomalia,
      usuario_id:    usuario_id || null,
      entidad_id:    entidad_id || null,
      resuelto_por:  req._perfil.id,
      notas:         notas || null,
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true });
  }

  // ── Listar revisadas para la empresa (para sincronizar estado en frontend) ─
  if (accion === 'revisadas') {
    const { data, error } = await listarAnomaliasRevisadas(req._perfil.empresa_id);

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true, revisadas: data || [] });
  }

  return res.status(404).json({ error: 'Acción no encontrada' });
}

// Ya estaba scopeada por empresa_id y aceptaba diasLookback/notificar como
// parámetros — se exporta tal cual, mismo criterio que
// procesarColaFinancieraEmpresa en cierre.js, para que la tool de chat del
// asistente la reuse directo en vez de pegarle un fetch HTTP interno
// reenviando el Bearer del usuario. Para un trigger manual puntual (no el
// cron nocturno) se recomienda igual diasLookback=1 + notificar=true, para
// no romper la idempotencia del push documentada arriba (evita re-avisar lo
// mismo si se corre varias veces seguidas).
export async function detectarYNotificar(empresa_id, diasLookback, notificar) {
  const { data, error } = await detectarAnomaliasRpc(empresa_id, diasLookback);

  if (error) {
    console.error('[AUDITORIA] Error en detectar_anomalias_auditoria:', error.message);
    return [];
  }

  const anomalias = data || [];
  if (notificar && anomalias.length) {
    const altas = anomalias.filter(a => a.severidad === 'alta');
    const cuerpo = anomalias.length === 1
      ? describirAnomalia(anomalias[0])
      : `Se detectaron ${anomalias.length} patrones sospechosos` +
        (altas.length ? ` (${altas.length} de severidad alta)` : '') + '.';

    notifAuto(empresa_id, {
      tipo: 'auditoria_anomalia',
      titulo: altas.length ? 'Anomalía detectada' : 'Posible anomalía detectada',
      cuerpo,
      link: '/admin/automatizacion',
    }).catch(() => {});
  }

  return anomalias;
}

function describirAnomalia(a) {
  const quien = a.usuario_nombre || 'un usuario';
  switch (a.tipo_anomalia) {
    case 'descuento_repetido_vendedor':
      return `${quien} aplicó descuentos en ${a.cantidad_eventos} pedidos distintos`;
    case 'descuento_repetido_vendedor_cliente':
      return `${quien} le dio descuento repetido al mismo cliente (${a.entidad_nombre || 'sin nombre'}) en ${a.cantidad_eventos} pedidos`;
    case 'ajuste_stock_sin_respaldo':
      return `${quien} hizo ${a.cantidad_eventos} ajustes de stock sin orden de compra de respaldo`;
    case 'movimiento_stock_alterado':
      return `${quien} modificó o eliminó ${a.cantidad_eventos} movimiento(s) de stock ya registrados`;
    case 'pedido_anulado_repetido':
      return `${quien} anuló ${a.cantidad_eventos} pedidos distintos`;
    case 'descuento_excede_maximo':
      return `${quien} aplicó un descuento fuera de rango al cliente ${a.entidad_nombre || 'sin nombre'}`;
    case 'precio_manual_bajo_lista':
      return `${quien} cargó precio manual por debajo de lista en ${a.cantidad_eventos} ítems`;
    case 'nota_credito_veloz_post_factura':
      return `${quien} emitió ${a.cantidad_eventos} nota(s) de crédito muy poco después de facturar a ${a.entidad_nombre || 'un cliente'}`;
    case 'cheque_rechazado_con_cobro_vinculado':
      return `Hay ${a.cantidad_eventos} cheque(s) rechazado(s) de ${a.entidad_nombre || 'un cliente'} que siguen vinculados a un cobro`;
    case 'cobro_sin_respaldo_cta_cte':
      return `${quien} registró ${a.cantidad_eventos} cobro(s) sin respaldo en cuenta corriente`;
    case 'cliente_bloqueado_con_pedido_posterior':
      return `Se cargó un pedido a ${a.entidad_nombre || 'un cliente'} después de bloquearlo`;
    case 'ajuste_puntos_manual_sin_pedido':
      return `Se sumaron puntos manualmente a ${a.entidad_nombre || 'un cliente'} sin pedido asociado, ${a.cantidad_eventos} veces`;
    case 'entrega_secuencia_veloz':
      return `${a.cantidad_eventos} entregas de ${a.entidad_nombre || 'una ruta'} se confirmaron con diferencia de tiempo mínima`;
    case 'actividad_stock_fuera_horario':
      return `${quien} cargó ${a.cantidad_eventos} movimiento(s) de stock de madrugada`;
    case 'volumen_pedidos_anomalo_vendedor':
      return `${quien} generó un volumen de pedidos muy por encima de su propio promedio reciente`;
    case 'turno_caja_abierto_prolongado':
      return `${a.entidad_nombre || 'Una caja'} sigue con el turno abierto hace ${a.cantidad_eventos} hs (${quien})`;
    default:
      return 'Se detectó un patrón sospechoso en la actividad reciente';
  }
}
