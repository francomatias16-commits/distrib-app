// lib/repos/audit.js
// Capa de acceso a datos para `audit_log`.
//
// Fase 7 — repo de auditoría "propio" que quedaba pendiente (ver el
// comentario en la cabecera de `lib/repos/migracion.js`: "los 2
// `.from('audit_log').insert(...)` quedan sin migrar, a la espera de un
// repo de auditoría propio"). `proveedores.js` y `maestros.js` tenían
// además cada uno su propia función local `auditLog(...)` — mismo nombre,
// misma firma, mismo cuerpo carácter por carácter — que se consolida acá.
//
// `registrarAuditoriaImpersonacion` (lib/repos/chofer-invitacion.js) NO se
// movió acá a propósito: es un evento fijo con su propio shape
// (`chofer_id`/`chofer_nombre`), no el logger genérico — mismo criterio ya
// usado para no mezclar `WhatsappBotRepo` con `NotifRepo` aunque ambos
// toquen tablas de notif.
//
// Dos formas de uso, preservando el comportamiento observable de cada
// caller original (checklist Fase 7, punto 2: no "mejorar" de paso):
//
// - `registrarAuditoria`: insert crudo, sin try/catch — para los 2 sitios
//   de `migracion.js` que tampoco lo tenían en el original (un fallo de
//   auditoría ahí sí puede propagar, igual que antes).
// - `registrarAuditoriaSilenciosa`: best-effort con try/catch interno —
//   para `proveedores.js`/`maestros.js`, cuyas funciones locales atrapaban
//   el error a propósito ("audit no debe romper el flujo").

import { db } from './_db.js';

/**
 * Insert crudo en `audit_log`. No atrapa errores — el caller decide.
 */
export async function registrarAuditoria(entrada) {
  return db.from('audit_log').insert(entrada);
}

/**
 * Igual que `registrarAuditoria`, pero best-effort: nunca lanza. Arma el
 * registro a partir de los mismos 7 parámetros posicionales que tenían las
 * dos funciones locales `auditLog` que reemplaza.
 */
export async function registrarAuditoriaSilenciosa(empresa_id, usuario_id, tabla, accion, registro_id, antes, despues) {
  try {
    await db.from('audit_log').insert({
      empresa_id,
      usuario_id,
      tabla,
      accion,
      registro_id: String(registro_id),
      datos_antes: antes ? JSON.parse(JSON.stringify(antes)) : null,
      datos_despues: despues ? JSON.parse(JSON.stringify(despues)) : null,
    });
  } catch (_) { /* audit no debe romper el flujo */ }
}
