// api/piloto/index.js — REQ-1: Motor de Decisión Autónomo de Pedidos ("Piloto Automático")
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { notifAuto } from './_auto-push.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { db } from '../repos/_db.js';
import { waBreaker } from './notif.js';
import {
  listarEmpresasActivas,
  generarPedidosSugeridosRpc,
  obtenerSugeridosParaWhatsappRpc,
  listarPedidosSugeridos,
  contarPedidosSugeridos,
  confirmarPedidoSugerido,
  descartarPedidoSugerido,
  listarCiclosCompraActivos,
  insertarNotifLogWhatsapp,
} from '../repos/piloto.js';

const rateLimitApi = rateLimit({ max: 100, windowMs: 60_000 });
export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const esCron = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  const accion = req.query.accion || req.body?.accion;

  // La acción 'generar' puede ser llamada por el cron sin token de usuario
  if (accion === 'generar' && esCron) {
    const empresas = await listarEmpresasActivas();
    let totalGenerados = 0;
    for (const emp of empresas) {
      const { data } = await generarPedidosSugeridosRpc(emp.id);
      const generados = data || 0;
      totalGenerados += generados;
      if (generados > 0) {
        notifAuto(emp.id, {
          tipo:   'piloto_sugerencia',
          titulo: 'Piloto Automático',
          cuerpo: `${generados} sugerencia${generados > 1 ? 's' : ''} de pedido lista${generados > 1 ? 's' : ''} para revisar`,
          link:   '/admin/pedidos?tab=sugeridos',
        }).catch?.(() => {});
      }
    }
    return res.json({ ok: true, generados: totalGenerados });
  }

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  // ── GET: listar pedidos sugeridos ─────────────────────────────────────────
  if (req.method === 'GET' && accion === 'sugeridos') {
    const limiteParam = req.query?.limite;
    const limit = limiteParam === 'todas'
      ? null
      : Math.min(parseInt(limiteParam, 10) || 5, 100);

    const [{ data, error }, { count, error: errCount }] = await Promise.all([
      listarPedidosSugeridos(perfil.empresa_id, limit),
      contarPedidosSugeridos(perfil.empresa_id),
    ]);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    if (errCount) return errorSeguro(res, errCount, 500, 'No se pudo completar la operación.');
    return res.json({ sugeridos: data, total: count || 0 });
  }

  // ── POST: generar (desde UI, solo admins) ─────────────────────────────────
  if (req.method === 'POST' && accion === 'generar') {
    if (!['dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    try {
      const generados = await generarSugerenciasPilotoEmpresa(perfil.empresa_id);
      return res.json({ generados });
    } catch (error) {
      return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    }
  }

  // ── POST: confirmar ────────────────────────────────────────────────────────
  if (req.method === 'POST' && accion === 'confirmar') {
    const { pedido_id } = req.body;
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });
    const { error } = await confirmarPedidoSugerido(perfil.empresa_id, pedido_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true });
  }

  // ── POST: descartar ────────────────────────────────────────────────────────
  if (req.method === 'POST' && accion === 'descartar') {
    const { pedido_id } = req.body;
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });
    const { error } = await descartarPedidoSugerido(perfil.empresa_id, pedido_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ok: true });
  }

  // ── GET: ciclos (vista diagnóstico) ───────────────────────────────────────
  if (req.method === 'GET' && accion === 'ciclos') {
    if (!['dueno', 'admin'].includes(perfil.rol))
      return res.status(403).json({ error: 'Sin permiso' });
    const { data, error } = await listarCiclosCompraActivos(perfil.empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ ciclos: data });
  }

  // ── GET/POST: enviar WhatsApp con pedidos sugeridos (cron) ───────────────
  if (accion === 'whatsapp-cron' && esCron) {
    const META_BASE = 'https://graph.facebook.com/v22.0'; // v19.0 venció el 21/5/2026
    const phoneId   = process.env.WA_PHONE_NUMBER_ID;
    const waToken   = process.env.WA_ACCESS_TOKEN;
    const appUrl    = process.env.APP_URL || '';

    if (!phoneId || !waToken) {
      return res.status(500).json({ error: 'WA_PHONE_NUMBER_ID o WA_ACCESS_TOKEN no configurados' });
    }

    function normTel(tel) {
      let t = String(tel).replace(/[\s\-\(\)]/g, '');
      if (t.startsWith('+')) t = t.slice(1);
      if (!t.startsWith('549') && t.length <= 10) t = '549' + t.replace(/^0/, '');
      return /^\d{10,15}$/.test(t) ? t : null;
    }

    const empresas = await listarEmpresasActivas({ excluirDemo: true });
    let totalEnviados = 0, totalErrores = 0;

    for (const { id: empresa_id } of empresas) {
      try { await generarPedidosSugeridosRpc(empresa_id); } catch (_) {}

      const { data: pedidos } = await obtenerSugeridosParaWhatsappRpc(empresa_id);
      if (!pedidos?.length) continue;

      for (const p of pedidos) {
        const tel = normTel(p.cliente_telefono);
        if (!tel) { totalErrores++; continue; }

        const items = (p.items_json || []).slice(0, 3)
          .map(i => `• ${i.nombre}: ${i.cantidad} u.`).join('\n');
        const extra = (p.items_json || []).length > 3 ? `\n...y ${p.items_json.length - 3} más` : '';
        const total = Math.round(p.total || 0).toLocaleString('es-AR');
        const link  = `${appUrl}/cliente/checkout?pedido=${p.pedido_id}`;

        const body = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: tel,
          type: 'text',
          text: {
            preview_url: false,
            body: `¡Hola ${p.cliente_nombre}!\n\nEs momento de tu *pedido habitual*:\n\n${items}${extra}\n\n*Total estimado: $${total}*\n\nConfirmá con 1 clic:\n${link}`
          }
        };

        // Circuit breaker compartido con lib/handlers/notif.js (Etapa 5,
        // PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md) — antes esta
        // llamada no tenía timeout ni breaker: si Meta se caía en medio de
        // un cron con muchas empresas/pedidos, cada envío podía colgarse
        // sin límite y arriesgar el timeout de 60s de la función serverless
        // completa (dejando sin procesar al resto de las empresas del cron).
        let resp, data;
        try {
          resp = await waBreaker.exec(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10_000);
            try {
              return await fetch(`${META_BASE}/${phoneId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${waToken}` },
                body: JSON.stringify(body),
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timer);
            }
          });
          data = await resp.json();
        } catch (err) {
          totalErrores++;
          // Circuito abierto: Meta ya viene fallando de forma consecutiva,
          // no vale la pena seguir golpeándolo con el resto de los pedidos
          // de ESTA empresa en esta corrida — se corta el for interno y se
          // sigue con la próxima empresa (no se aborta todo el cron).
          if (err.name === 'CircuitBreakerOpenError') {
            totalErrores += pedidos.length - pedidos.indexOf(p) - 1;
            break;
          }
          continue;
        }

        if (resp.ok) {
          await insertarNotifLogWhatsapp({
            empresa_id,
            cliente_id: p.cliente_id,
            pedido_id:  p.pedido_id,
            canal:      'whatsapp',
            telefono:   tel,
            message_id: data.messages?.[0]?.id || '',
            payload:    { cliente_nombre: p.cliente_nombre, total: p.total }
          });
          totalEnviados++;
        } else {
          totalErrores++;
        }

        await new Promise(r => setTimeout(r, 200));
      }
    }

    return res.json({ ok: true, enviados: totalEnviados, errores: totalErrores });
  }

  return res.status(404).json({ error: 'Acción no encontrada' });
}

// Versión standalone de la rama POST 'generar' de arriba, para llamadores ya
// autorizados y ya scopeados por empresa_id (ej. la tool de chat del
// asistente) — mismo criterio que procesarColaFinancieraEmpresa en
// lib/handlers/cierre.js.
export async function generarSugerenciasPilotoEmpresa(empresa_id) {
  const { data, error } = await generarPedidosSugeridosRpc(empresa_id);
  if (error) throw new Error(error.message);
  const generados = data || 0;
  if (generados > 0) {
    notifAuto(empresa_id, {
      tipo:   'piloto_sugerencia',
      titulo: 'Piloto Automático',
      cuerpo: `${generados} sugerencia${generados > 1 ? 's' : ''} nueva${generados > 1 ? 's' : ''} generada${generados > 1 ? 's' : ''}`,
      link:   '/admin/pedidos?tab=sugeridos',
    }).catch?.(() => {});
  }
  return generados;
}
