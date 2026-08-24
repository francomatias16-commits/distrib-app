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
// Tres formas de uso, preservando el comportamiento observable de cada
// caller original (checklist Fase 7, punto 2: no "mejorar" de paso):
//
// - `registrarAuditoria`: insert crudo, sin try/catch — para los 2 sitios
//   de `migracion.js` que tampoco lo tenían en el original (un fallo de
//   auditoría ahí sí puede propagar, igual que antes).
// - `registrarAuditoriaSilenciosa`: best-effort con try/catch interno —
//   para la mayoría de los call sites (config, favoritos, promociones,
//   cajas, turnos), cuyas funciones locales atrapaban el error a
//   propósito ("audit no debe romper el flujo").
// - `registrarAuditoriaFinancieraDurable` (Punto 8, auditoría financiera
//   2026): igual best-effort de cara al caller (nunca lanza, nunca frena
//   el flujo de negocio), pero para los 9 call sites donde lo que se
//   audita es dinero real moviéndose (ventas POS, su anulación,
//   devoluciones, movimientos de caja, pagos a proveedores, cobros vía
//   Mercado Pago) un fallo de `audit_log` ya no se descarta en silencio:
//   se encola en `audit_log_pendientes` (migración 511) para que
//   `reprocesarAuditoriaPendientes` — abajo — lo reintente. Mismo criterio
//   que "operacional silenciosa está bien, financiera silenciosa no" ya
//   aplicado en otras partes del sistema (ver `registrar_pago_proveedor`,
//   Punto 7: ahí la idempotencia protege contra duplicar el pago; acá el
//   outbox protege contra perder el rastro de auditoría de ese pago).

import { db } from './_db.js';

/**
 * Insert crudo en `audit_log`. No atrapa errores — el caller decide.
 */
export async function registrarAuditoria(entrada) {
  return db.from('audit_log').insert(entrada);
}

function armarEntrada(empresa_id, usuario_id, tabla, accion, registro_id, antes, despues) {
  return {
    empresa_id,
    usuario_id,
    tabla,
    accion,
    registro_id: registro_id == null ? null : String(registro_id),
    datos_antes: antes ? JSON.parse(JSON.stringify(antes)) : null,
    datos_despues: despues ? JSON.parse(JSON.stringify(despues)) : null,
  };
}

/**
 * Igual que `registrarAuditoria`, pero best-effort: nunca lanza. Arma el
 * registro a partir de los mismos 7 parámetros posicionales que tenían las
 * dos funciones locales `auditLog` que reemplaza.
 */
export async function registrarAuditoriaSilenciosa(empresa_id, usuario_id, tabla, accion, registro_id, antes, despues) {
  try {
    const { error } = await db.from('audit_log').insert(
      armarEntrada(empresa_id, usuario_id, tabla, accion, registro_id, antes, despues)
    );
    if (error) {
      console.error(`[AUDIT] insert en audit_log falló (silenciosa, no se reintenta) — ${tabla}/${accion}/${registro_id}:`, error.message);
    }
  } catch (err) {
    console.error(`[AUDIT] excepción registrando auditoría (silenciosa, no se reintenta) — ${tabla}/${accion}/${registro_id}:`, err.message);
  }
}

/**
 * Punto 8 (auditoría financiera 2026). Misma firma y mismo contrato de
 * "nunca lanza" que `registrarAuditoriaSilenciosa` — un fallo acá no debe
 * frenar una venta, un pago o un cobro real. La diferencia es qué pasa
 * cuando el INSERT en `audit_log` falla: en vez de descartar el registro,
 * se encola en `audit_log_pendientes` (outbox) para que
 * `reprocesarAuditoriaPendientes` lo reintente más tarde. Si hasta el
 * encolado falla (Supabase caído, no solo un error puntual de la tabla),
 * ahí sí se pierde — pero queda logueado con el detalle completo para
 * recuperación manual, cosa que la variante silenciosa no garantiza.
 */
export async function registrarAuditoriaFinancieraDurable(empresa_id, usuario_id, tabla, accion, registro_id, antes, despues) {
  const entrada = armarEntrada(empresa_id, usuario_id, tabla, accion, registro_id, antes, despues);

  try {
    const { error } = await db.from('audit_log').insert(entrada);
    if (!error) return;

    console.error(`[AUDIT] insert directo en audit_log falló, encolando en audit_log_pendientes — ${tabla}/${accion}/${registro_id}:`, error.message);

    const { error: errorOutbox } = await db.from('audit_log_pendientes').insert(entrada);
    if (errorOutbox) {
      console.error(`[AUDIT] fallo doble: no se pudo encolar en audit_log_pendientes tampoco — ${tabla}/${accion}/${registro_id}. Registro perdido, ver detalle:`, { entrada, errorOutbox: errorOutbox.message });
    }
  } catch (err) {
    // Excepción real (timeout de red, etc.) — ni siquiera se pudo intentar
    // el insert directo. Un segundo intento contra la misma conexión
    // caída probablemente falle igual, pero vale la pena encolarlo (el
    // reprocesador corre más tarde, cuando la conexión ya volvió).
    console.error(`[AUDIT] excepción en insert directo, intentando encolar en audit_log_pendientes — ${tabla}/${accion}/${registro_id}:`, err.message);
    try {
      const { error: errorOutbox } = await db.from('audit_log_pendientes').insert(entrada);
      if (errorOutbox) {
        console.error(`[AUDIT] fallo doble tras excepción: no se pudo encolar — ${tabla}/${accion}/${registro_id}. Registro perdido, ver detalle:`, { entrada, errorOutbox: errorOutbox.message });
      }
    } catch (errOutboxEx) {
      console.error(`[AUDIT] excepción también al encolar — ${tabla}/${accion}/${registro_id}. Registro perdido, ver detalle:`, { entrada, errOutboxEx: errOutboxEx.message });
    }
  }
}

// ── Reprocesador de audit_log_pendientes ───────────────────────────────
// Mismo patrón de claim atómico + lease + tope de reintentos que
// `reclamarEventos`/`despacharPendientes` en `lib/eventos-dispatcher.js` y
// que el outbox de salientes de WhatsApp (v657): un UPDATE condicionado al
// estado leído (`.eq('estado', candidato.estado)`) hace de compare-and-swap
// optimista — si dos workers leen el mismo candidato, solo uno gana el
// claim, el otro pierde la carrera y sigue de largo. No usa `FOR UPDATE
// SKIP LOCKED` en SQL porque, igual que en eventos_negocio, el claim se
// hace desde JS contra la REST API de Supabase, no dentro de una
// transacción SQL propia.

const AUDIT_MAX_INTENTOS = 5;
const AUDIT_LEASE_MS = 2 * 60 * 1000; // 2 minutos — mismo criterio que EVENTOS_LEASE_MS: el reintento es rápido, un lease vencido significa un worker caído a mitad de camino.

async function reclamarPendientesAuditoria({ limite, incluirErrores }) {
  const leaseVencidoAntes = new Date(Date.now() - AUDIT_LEASE_MS).toISOString();
  const estadosCandidatos = incluirErrores ? ['pendiente', 'error'] : ['pendiente'];

  let query = db
    .from('audit_log_pendientes')
    .select('*')
    .order('created_at')
    .limit(limite * 3); // margen: algunos candidatos pueden perder la carrera del claim.

  const filtroOr = [
    `estado.in.(${estadosCandidatos.join(',')})`,
    `and(estado.eq.procesando,procesando_desde.lt.${leaseVencidoAntes})`,
  ].join(',');
  query = query.or(filtroOr);

  const { data: candidatos, error } = await query;
  if (error) {
    console.error('[AUDIT] error leyendo audit_log_pendientes candidatos:', error.message);
    return { pendientes: [], error: error.message };
  }

  const reclamados = [];
  for (const candidato of (candidatos || [])) {
    if (reclamados.length >= limite) break;

    // Dead-letter: agotó el tope de reintentos, no se reclama de nuevo
    // aunque incluirErrores=true lo haya traído en el SELECT de arriba.
    if (candidato.estado === 'error' && (candidato.intentos || 0) >= AUDIT_MAX_INTENTOS) continue;

    const nuevosIntentos = (candidato.intentos || 0) + 1;
    const { data: ganado, error: claimError } = await db
      .from('audit_log_pendientes')
      .update({ estado: 'procesando', procesando_desde: new Date().toISOString(), intentos: nuevosIntentos })
      .eq('id', candidato.id)
      .eq('estado', candidato.estado) // condición de carrera: solo si sigue como lo leímos
      .select('*')
      .maybeSingle();

    if (claimError) {
      console.error(`[AUDIT] error reclamando pendiente ${candidato.id}:`, claimError.message);
      continue;
    }
    if (ganado) reclamados.push(ganado);
  }

  return { pendientes: reclamados, error: null };
}

/**
 * Reintenta insertar en `audit_log` los registros encolados en
 * `audit_log_pendientes`. Pensado para correr desde un cron (ver
 * `handleAuditLogReprocesarCron` en `lib/handlers/notif.js`, mismo esquema
 * de auth que `eventos-reprocesar-cron`/`whatsapp-salientes-reprocesar-cron`).
 */
export async function reprocesarAuditoriaPendientes({ limite = 50, incluirErrores = true } = {}) {
  const { pendientes, error } = await reclamarPendientesAuditoria({ limite, incluirErrores });
  if (error) return { ok: false, procesados: 0, error };

  let procesados = 0;
  let conError = 0;
  let agotados = 0;

  for (const pendiente of pendientes) {
    procesados++;

    const entrada = {
      empresa_id: pendiente.empresa_id,
      usuario_id: pendiente.usuario_id,
      tabla: pendiente.tabla,
      accion: pendiente.accion,
      registro_id: pendiente.registro_id,
      datos_antes: pendiente.datos_antes,
      datos_despues: pendiente.datos_despues,
    };

    const { error: errorInsert } = await db.from('audit_log').insert(entrada);

    if (!errorInsert) {
      // Se mantiene la fila en 'procesado' (no se borra) por trazabilidad
      // — mismo criterio que eventos_negocio, que tampoco borra eventos
      // despachados con éxito.
      await db
        .from('audit_log_pendientes')
        .update({ estado: 'procesado', procesando_desde: null })
        .eq('id', pendiente.id);
      continue;
    }

    conError++;
    const agotado = pendiente.intentos >= AUDIT_MAX_INTENTOS;
    if (agotado) agotados++;

    console.error(`[AUDIT] reintento falló para pendiente ${pendiente.id} (intento ${pendiente.intentos}/${AUDIT_MAX_INTENTOS}${agotado ? ', dead-letter' : ''}):`, errorInsert.message);

    await db
      .from('audit_log_pendientes')
      .update({ estado: 'error', procesando_desde: null, ultimo_error: errorInsert.message })
      .eq('id', pendiente.id);
  }

  return { ok: conError === 0, procesados, conError, agotados };
}
