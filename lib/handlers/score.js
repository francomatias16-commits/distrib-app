// lib/handlers/score.js — REQ-5: Score de Salud del Cliente ("Semáforo Inteligente")
//
// D4: migrado a lib/repos/ — queries de datos via ScoreRepo/ClienteRepo/NotifRepo.
// La lógica de negocio (ofrecerPlanDePago, cooldowns, WA) permanece aquí.

import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { notifAuto } from './_auto-push.js';
import { db } from '../repos/_db.js';
import { ScoreRepo, ClienteRepo, NotifRepo, EmpresaRepo } from '../repos/index.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';

const WA_ENDPOINT = process.env.WA_ENDPOINT || 'http://localhost:3000/api/notif/whatsapp';
const HORAS_COOLDOWN_PLAN_PAGO = 24 * 6;

// Innovación #4: ofrecer plan de pago por WhatsApp cuando el cliente cae a riesgo/bloqueado.
async function ofrecerPlanDePago(empresaId, cliente, opciones = {}) {
  const { forzar = false } = opciones;
  if (!cliente.telefono) return { ok: false, motivo: 'sin_telefono' };

  const deuda = await ClienteRepo.calcularDeudaCliente(cliente.id);
  if (deuda <= 0) return { ok: false, motivo: 'sin_deuda' };

  if (!forzar) {
    const ultimoEnvio = await NotifRepo.ultimoEnvio(empresaId, cliente.id, 'oferta_plan_pago');
    if (ultimoEnvio) {
      const horasDesde = (Date.now() - new Date(ultimoEnvio).getTime()) / 1000 / 3600;
      if (horasDesde < HORAS_COOLDOWN_PLAN_PAGO)
        return { ok: false, motivo: 'cooldown', ultimo_envio: ultimoEnvio };
    }
  }

  const waResp = await fetch(WA_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: 'oferta_plan_pago',
      telefono: cliente.telefono,
      params: { nombre_cliente: cliente.razon_social, monto_deuda: deuda },
      empresa_id: empresaId,
    }),
  });
  const waData = await waResp.json();
  if (!waResp.ok) {
    console.error(`[SCORE] WhatsApp oferta_plan_pago falló para ${cliente.id}:`, waData.error);
    return { ok: false, motivo: 'whatsapp_error', error: waData.error };
  }

  await NotifRepo.registrarLog({
    cliente_id: cliente.id, empresa_id: empresaId, tipo: 'oferta_plan_pago',
    canal: 'whatsapp', telefono: cliente.telefono, message_id: waData.message_id || null,
    payload: { monto_deuda: deuda, score_categoria: cliente.score_categoria },
  });
  return { ok: true, monto_deuda: deuda };
}

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  // CRON-001 (auditoría 2026-07-26): antes esto solo chequeaba el header
  // `x-vercel-cron` — cualquiera puede mandar ese header en un request HTTP
  // normal, Vercel no lo valida/filtra en el borde. Con eso bastaba para
  // esCron=true y saltarse el login, incluyendo `accion=recalcular-todos`
  // (recalcula el score de TODAS las empresas activas). Se exige ahora el
  // `CRON_SECRET` real (lo único que Vercel garantiza no-spoofeable, según
  // su propia documentación) y queda fail-closed si no está configurada.
  const esCron = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  let perfil = null;

  if (!esCron) {
    perfil = await verificarToken(req, db);
    if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  }

  const accion = req.query.accion;

  // ── POST: ofrecer plan de pago manualmente ────────────────────────────────
  if (req.method === 'POST' && accion === 'ofrecer-plan-pago') {
    if (!['dueno', 'admin', 'vendedor', 'contador'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    const { cliente_id } = req.body;
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });

    const cliente = await ClienteRepo.obtenerClienteParaOfertaPlanPago(perfil.empresa_id, cliente_id);
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

    const resultado = await ofrecerPlanDePago(perfil.empresa_id, cliente, { forzar: true });
    if (!resultado.ok) {
      const mensajes = {
        sin_telefono: 'El cliente no tiene teléfono cargado',
        sin_deuda: 'El cliente no tiene deuda registrada',
        whatsapp_error: 'Falló el envío de WhatsApp',
      };
      return res.status(400).json({ error: mensajes[resultado.motivo] || 'No se pudo enviar la oferta' });
    }
    return res.json({ ok: true, monto_deuda: resultado.monto_deuda });
  }

  // ── GET: historial de score de un cliente ─────────────────────────────────
  if (req.method === 'GET' && accion === 'cliente') {
    const { cliente_id } = req.query;
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });

    const [historial, cliente, ultimaOferta] = await Promise.all([
      ScoreRepo.historialScore(perfil.empresa_id, cliente_id),
      ClienteRepo.obtenerScoreCliente(perfil.empresa_id, cliente_id),
      NotifRepo.ultimoEnvio(perfil.empresa_id, cliente_id, 'oferta_plan_pago'),
    ]);

    return res.json({ cliente, historial, ultima_oferta_plan_pago: ultimaOferta || null });
  }

  // ── GET: priorización de cobranza ─────────────────────────────────────────
  if (req.method === 'GET' && accion === 'cobranza-priorizada') {
    if (!['dueno', 'admin', 'vendedor', 'contador'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    try {
      const cobranza = await ScoreRepo.cobranzaPriorizada(perfil.empresa_id, { prioridad: req.query.prioridad });
      return res.json({ cobranza });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── POST: recalcular score de un cliente ──────────────────────────────────
  if (req.method === 'POST' && accion === 'recalcular') {
    if (!['dueno', 'admin', 'vendedor'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    try {
      const score = await ScoreRepo.calcularScore(
        perfil.empresa_id, req.body.cliente_id, 'recalculo_manual'
      );
      return res.json({ score });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── POST: recalcular todos (cron semanal o admin) ─────────────────────────
  if (req.method === 'POST' && accion === 'recalcular-todos') {
    if (!esCron && !['dueno', 'admin'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });

    const empresas = esCron
      ? await EmpresaRepo.listarEmpresasActivas()
      : [{ id: perfil.empresa_id }];

    let totalActualizados = 0;
    let totalErrores = 0;

    for (const emp of empresas) {
      const { actualizados, errores } = await recalcularScoreEmpresa(emp.id);
      totalActualizados += actualizados;
      totalErrores      += errores;
    }

    return res.json({ ok: true, actualizados: totalActualizados, errores: totalErrores });
  }

  // ── GET: alertas de score no resueltas ────────────────────────────────────
  // FIX (auditoría, etapa 12): sin chequeo de rol — cualquier usuario
  // autenticado de la empresa, incluido un cliente con acceso portal (rol
  // 'cliente'), podía traer las alertas de TODOS los clientes (nombre,
  // teléfono, caída de score) con solo llamar el endpoint con su propio
  // token válido. Mismo set de roles que ya usa 'cobranza-priorizada' arriba.
  if (req.method === 'GET' && accion === 'alertas') {
    if (!['dueno', 'admin', 'vendedor', 'contador'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    try {
      // ?limite=N (widget del dashboard pide pocas); ?limite=todas para la
      // vista completa. Tope de 100 para no permitir cargas descontroladas.
      const limiteParam = req.query?.limite;
      const limit = limiteParam === 'todas'
        ? null
        : Math.min(parseInt(limiteParam, 10) || 5, 100);

      const [alertas, total] = await Promise.all([
        ScoreRepo.alertasPendientes(perfil.empresa_id, { limit }),
        ScoreRepo.contarAlertasPendientes(perfil.empresa_id),
      ]);
      return res.json({ alertas, total });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── POST: resolver alerta ─────────────────────────────────────────────────
  // FIX (auditoría, etapa 12): sin chequeo de rol — cualquier usuario
  // autenticado, incluido un cliente del portal, podía marcar como resuelta
  // cualquier alerta de score de la empresa adivinando/enumerando alerta_id.
  if (req.method === 'POST' && accion === 'resolver-alerta') {
    if (!['dueno', 'admin', 'vendedor', 'contador'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    try {
      await ScoreRepo.resolverAlerta(perfil.empresa_id, req.body.alerta_id);
      return res.json({ ok: true });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── GET: reglas de score ──────────────────────────────────────────────────
  // FIX (auditoría, etapa 12): sin chequeo de rol — exponía los umbrales
  // internos de scoring (con qué reglas se calcula el score de riesgo de un
  // cliente) a cualquier usuario autenticado, incluido un cliente del
  // portal, que podría usarlo para intentar "gamear" su propio score.
  if (req.method === 'GET' && accion === 'reglas') {
    if (!['dueno', 'admin', 'vendedor', 'contador'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    const reglas = await ScoreRepo.obtenerReglas(perfil.empresa_id);
    return res.json({ reglas });
  }

  // ── POST: guardar reglas ──────────────────────────────────────────────────
  if (req.method === 'POST' && accion === 'guardar-reglas') {
    if (!['dueno', 'admin'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    try {
      const reglas = await ScoreRepo.guardarReglas(perfil.empresa_id, req.body);
      return res.json({ ok: true, reglas });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── GET: ranking ──────────────────────────────────────────────────────────
  // FIX (auditoría, etapa 12): mismo patrón — sin chequeo de rol, exponía el
  // ranking de score de TODOS los clientes a cualquier usuario autenticado.
  if (req.method === 'GET' && accion === 'ranking') {
    if (!['dueno', 'admin', 'vendedor', 'contador'].includes(perfil?.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    try {
      const ranking = await ClienteRepo.rankingScore(perfil.empresa_id);
      return res.json({ ranking });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  return res.status(404).json({ error: 'Acción no encontrada' });
}

// Versión standalone del cuerpo del loop-por-empresa de la rama
// 'recalcular-todos' de arriba (Innovación #4 incluida: push + oferta de
// plan de pago por WhatsApp a los clientes que caen en riesgo/bloqueado) —
// mismo criterio que procesarColaFinancieraEmpresa en cierre.js, para que un
// llamador ya autorizado y ya scopeado por empresa_id (ej. la tool de chat
// del asistente) la reuse directo en vez de reimplementar el loop o pegarle
// un fetch HTTP interno reenviando el Bearer del usuario.
export async function recalcularScoreEmpresa(empresa_id) {
  const { actualizados, errores } = await ScoreRepo.recalcularTodos(empresa_id, 'recalculo_semanal');

  const clientesRiesgo = await ClienteRepo.listarClientesPorScore(empresa_id, ['riesgo', 'bloqueado']);

  if (clientesRiesgo.length > 0) {
    notifAuto(empresa_id, {
      tipo:   'score_caida_critica',
      titulo: 'Score recalculado',
      cuerpo: `${clientesRiesgo.length} cliente${clientesRiesgo.length > 1 ? 's' : ''} en estado de riesgo o bloqueado`,
      link:   '/admin/clientes?filter=riesgo',
    }).catch(() => {});
  }

  for (const cliente of clientesRiesgo) {
    await ofrecerPlanDePago(empresa_id, cliente)
      .catch(err => console.error(`[SCORE] ofrecerPlanDePago ${cliente.id}:`, err.message));
  }

  return { actualizados, errores, clientes_en_riesgo: clientesRiesgo.length };
}
