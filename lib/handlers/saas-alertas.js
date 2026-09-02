// lib/handlers/saas-alertas.js
// Handler para /api/index?_mod=saas-alertas — avisos internos al dueño de
// la plataforma (Ruben / MF Web Solutions), NO al tenant.
//
// Motivo: existen dos canales de aviso ya construidos, pero ninguno cubre
// "avisame a mí cuando se registra una empresa nueva, sin entrar a Supabase":
//   - push-interno (lib/handlers/notif.js) avisa a USUARIOS DE UN TENANT
//     puntual vía push del navegador/celular — pensado para "che, tenés un
//     pedido nuevo", no para el dueño de la plataforma.
//   - el panel superadmin (lib/handlers/saas.js) hay que abrirlo a mano.
//
// Este endpoint reutiliza el MISMO secreto ya configurado para push-interno
// (INTERNAL_PUSH_SECRET / public.get_push_secret() en la base) — no hace
// falta crear ni configurar un secreto nuevo en ningún lado.
//
// Entrada (llamado por el trigger de Supabase, ver migración 548):
//   POST /api/index?_mod=saas-alertas
//   headers: { 'x-push-secret': <INTERNAL_PUSH_SECRET> }
//   body: {
//     tipo: 'nuevo_tenant',
//     empresa: { id, nombre, email, cuit, created_at, saas_trial_fin, saas_plan }
//   }
//
// Salida: envía un email a SAAS_ALERTA_EMAIL (variable de entorno en Vercel
// — configurarla con tu propio email) usando el mismo enviarEmail() genérico
// de lib/email.js que ya usan las confirmaciones de pedido.
//
// Variables de entorno requeridas:
//   INTERNAL_PUSH_SECRET  (ya existe — la misma que usa push-interno)
//   SAAS_ALERTA_EMAIL     (NUEVA — tu email, para recibir estos avisos)
//   RESEND_API_KEY, EMAIL_FROM (ya existen)

import { enviarEmail } from '../email.js';

function formatFecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function avisarNuevoTenant(empresa) {
  const destino = process.env.SAAS_ALERTA_EMAIL;
  if (!destino) {
    console.warn('[SAAS-ALERTAS] SAAS_ALERTA_EMAIL no configurada — aviso omitido');
    return { ok: false, razon: 'no_configurado' };
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#F1EFE8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="max-width:480px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #D3D1C7;">
      <div style="background:#185FA5;padding:24px 28px;">
        <h1 style="margin:0;color:#fff;font-size:18px;">Nueva empresa registrada en Fluxo</h1>
      </div>
      <div style="padding:24px 28px;font-size:14px;color:#2C2C2A;line-height:1.7;">
        <p style="margin:0 0 12px;"><strong>${empresa?.nombre || 'Sin nombre'}</strong></p>
        <p style="margin:0 0 4px;">Email: ${empresa?.email || '—'}</p>
        <p style="margin:0 0 4px;">CUIT: ${empresa?.cuit || '—'}</p>
        <p style="margin:0 0 4px;">Plan inicial: ${empresa?.saas_plan || 'trial'}</p>
        <p style="margin:0 0 4px;">Fin de trial: ${formatFecha(empresa?.saas_trial_fin)}</p>
        <p style="margin:12px 0 0;color:#5F5E5A;font-size:12px;">Registrada el ${formatFecha(empresa?.created_at)}</p>
      </div>
    </div>
  </body></html>`;

  return enviarEmail({
    to: destino,
    subject: `Nuevo registro en Fluxo: ${empresa?.nombre || 'empresa sin nombre'}`,
    html,
  });
}

export default async function saasAlertasHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Mismo secreto/patrón fail-closed que pushInternoHandler (lib/handlers/notif.js):
  // sin la variable configurada, el endpoint rechaza todo con 503 en vez de
  // quedar abierto o aceptar un fallback inseguro.
  const secret = process.env.INTERNAL_PUSH_SECRET;
  if (!secret) {
    console.error('[SECURITY] saasAlertasHandler: INTERNAL_PUSH_SECRET no configurada — rechazando (fail-closed).');
    return res.status(503).json({ error: 'Endpoint no configurado' });
  }
  if (req.headers['x-push-secret'] !== secret) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { tipo, empresa } = req.body || {};
  if (!tipo || !empresa) return res.status(400).json({ error: 'Faltan campos requeridos' });

  try {
    if (tipo === 'nuevo_tenant') {
      const r = await avisarNuevoTenant(empresa);
      return res.status(200).json({ ok: true, email: r });
    }
    return res.status(400).json({ error: `tipo desconocido: "${tipo}". Válido: nuevo_tenant` });
  } catch (err) {
    console.error('[SAAS-ALERTAS] Error:', err?.stack || err?.message || err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}
