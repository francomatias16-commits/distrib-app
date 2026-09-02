// lib/handlers/retencion.js
// Etapa 2 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md.
//
// Cron diario (fuera de horario pico, ver vercel.json) que archiva y purga
// con retención de 180 días: notif_log / eventos_negocio / audit_log
// (2026-08-28) + security_audit_historial / whatsapp_conversaciones+mensajes
// / asistente_conversaciones+mensajes (ampliación 2026-08-29, ver migración
// 20260829000000) — decidido con el usuario: archivar a tabla _historico
// antes de borrar, no un borrado directo. whatsapp solo purga conversaciones
// ya cerradas, nunca una activa por vieja que sea. El trabajo real
// (DELETE...RETURNING + INSERT atómico) vive en el RPC
// `archivar_y_purgar_retencion` (SECURITY DEFINER, restringido a
// service_role) — este handler solo autentica el cron y expone un trigger
// manual para dueño/admin, mismo criterio que auditoria.js.
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { db } from '../repos/_db.js';
import { archivarYPurgarRetencion } from '../repos/retencion.js';

const DIAS_RETENCION_DEFAULT = 180;

const rateLimitApi = rateLimit({ max: 20, windowMs: 60_000 });

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });

  // CRON-001 (mismo criterio que auditoria.js/notif.js): solo CRON_SECRET
  // real otorga acceso como job automático, nunca headers spoofeables.
  const esInterno = !!process.env.CRON_SECRET
    && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;

  if (!esInterno) {
    const perfil = await verificarToken(req, db);
    if (!perfil || !['dueno', 'admin'].includes(perfil.rol)) {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  try {
    const { data, error } = await archivarYPurgarRetencion(DIAS_RETENCION_DEFAULT);
    if (error) throw error;
    return res.status(200).json({ ok: true, ...data });
  } catch (e) {
    return errorSeguro(res, e, 500, 'No se pudo completar el archivado/purga de retención.');
  }
}
