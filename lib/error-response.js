// lib/error-response.js
// Hallazgo 5.1 (auditoría v254) — helper único para responder errores sin
// filtrar detalle interno (nombre de tabla/columna/constraint/query) al
// cliente. El detalle completo se loguea server-side con un correlation_id
// que sí se devuelve al cliente para poder cruzarlo con los logs.
import crypto from 'crypto';

export function errorSeguro(res, error, status = 500, mensajePublico = 'No se pudo completar la operación.', extra = {}) {
  const correlationId = crypto.randomUUID();
  console.error(`[ERROR] correlation_id=${correlationId}:`, error?.message || error);
  return res.status(status).json({ ...extra, error: mensajePublico, correlation_id: correlationId });
}
