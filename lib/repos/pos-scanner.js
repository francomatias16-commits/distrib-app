// lib/repos/pos-scanner.js
// Acceso a datos del vínculo "celular como lector remoto del POS"
// (tabla `pos_scanner_tokens`). Mismo criterio que chofer-invitacion.js:
// acá solo I/O contra Supabase; la orquestación (generación/hash del
// token, armado de la URL del QR, contrato {ok,status,error}) vive en
// lib/handlers/pos-scanner.js.
//
// Importante: esta tabla NO guarda los códigos de barra escaneados — esos
// viajan directo celular → compu por un canal de Supabase Realtime
// Broadcast derivado del token, sin tocar la base de datos. Acá solo se
// administra la sesión de vínculo (alta, validación, revocación).

import { db } from './_db.js';

/** Caja activa de la empresa — valida que exista antes de emitir un token. */
export async function existeCajaActivaEnEmpresa(empresa_id, caja_id) {
  const { data } = await db
    .from('cajas_pos')
    .select('id')
    .eq('id', caja_id)
    .eq('empresa_id', empresa_id)
    .eq('activa', true)
    .maybeSingle();
  return !!data;
}

export async function crearTokenScanner({ empresa_id, contexto, entidad_id, creado_por, token_hash, expira_at }) {
  const { data, error } = await db
    .from('pos_scanner_tokens')
    .insert({ empresa_id, contexto, entidad_id, creado_por, token_hash, expira_at })
    .select('id, expira_at')
    .single();
  if (error) throw new Error(`[PosScannerRepo.crearToken] ${error.message}`);
  return data;
}

/** Revoca por hash, acotado a la empresa del que pide la revocación. */
export async function revocarTokenScannerPorHash(empresa_id, token_hash) {
  const { data, error } = await db
    .from('pos_scanner_tokens')
    .update({ revocado_at: new Date().toISOString() })
    .eq('empresa_id', empresa_id)
    .eq('token_hash', token_hash)
    .is('revocado_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`[PosScannerRepo.revocarToken] ${error.message}`);
  return !!data;
}

/** Valida (sin consumir) un token vía RPC — ver migración 438/439. */
export async function validarTokenScanner(token_hash) {
  const { data, error } = await db.rpc('validar_token_scanner_pos', { p_token_hash: token_hash });
  if (error) throw new Error(`[PosScannerRepo.validarToken] ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Sliding expiration: empuja expira_at hacia adelante mientras el vínculo
 * está en uso activo, para que una sesión de mostrador larga no se corte
 * sola en medio del turno. Solo pisa la fecha si el token sigue vivo (no
 * revocado, no vencido ya) — nunca "resucita" un vínculo muerto.
 */
export async function extenderTokenScanner(empresa_id, token_hash, nuevaExpiraAt) {
  const { data, error } = await db
    .from('pos_scanner_tokens')
    .update({ expira_at: nuevaExpiraAt })
    .eq('empresa_id', empresa_id)
    .eq('token_hash', token_hash)
    .is('revocado_at', null)
    .gt('expira_at', new Date().toISOString())
    .select('id, expira_at')
    .maybeSingle();
  if (error) throw new Error(`[PosScannerRepo.extenderToken] ${error.message}`);
  return data;
}

/**
 * Housekeeping best-effort: borra tokens ya vencidos/revocados hace rato
 * de esta empresa. Se llama de paso al generar uno nuevo — no hay cron
 * dedicado porque el volumen de esta tabla es bajo (una fila por sesión
 * de vínculo, TTL corto) y no vale la pena un job aparte para esto.
 */
export async function limpiarTokensVencidos(empresa_id) {
  const haceUnDia = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    await db
      .from('pos_scanner_tokens')
      .delete()
      .eq('empresa_id', empresa_id)
      .lt('expira_at', haceUnDia);
  } catch (_e) {
    // best-effort — nunca debe tumbar la generación de un token nuevo
  }
}
