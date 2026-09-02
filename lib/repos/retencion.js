// lib/repos/retencion.js
// Etapa 2 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md.
// Acceso a datos del archivado + purga con retención de notif_log,
// eventos_negocio, audit_log, security_audit_historial, whatsapp_*
// y asistente_* — solo llama al RPC (SECURITY DEFINER, restringido a
// service_role) que hace el trabajo real en la base.

import { db } from './_db.js';

export async function archivarYPurgarRetencion(diasRetencion) {
  return db.rpc('archivar_y_purgar_retencion', { p_dias_retencion: diasRetencion });
}
