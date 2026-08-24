// lib/rate-limit.js
// DT-04 + FIX SEC-07 (auditoría 2026): rate limiting para endpoints sensibles.
//
// ANTES: contador en un Map en memoria, por instancia del proceso. En
// Vercel/serverless cada instancia (y cada cold start) tiene su propio Map,
// así que el límite configurado (ej. "10 intentos por minuto") en realidad
// era "10 intentos por minuto POR INSTANCIA VIVA" — con N instancias
// concurrentes el límite real era N veces el nominal, sin ningún piso. Un
// atacante distribuyendo requests en paralelo (lo que Vercel hace solo,
// escalando instancias bajo carga) diluía el control justo cuando más hacía
// falta: login, reset de contraseña, asistente, APIs públicas.
//
// AHORA: el contador vive en Postgres (tabla `rate_limits` + función
// `rl_check_and_increment`, migración 20260817_p2_lote3_rate_limit_distribuido),
// como INSERT ... ON CONFLICT ... DO UPDATE atómico — una sola instrucción,
// sin ventana de carrera entre leer y escribir, compartido de verdad por
// todas las instancias/regiones.
//
// Si Supabase no responde (caída de red puntual), se degrada a un Map local
// como red de contención best-effort en vez de tumbar el endpoint entero —
// mismo criterio de "fail soft con log" que ya usa el resto del proyecto
// para dependencias externas (ver mpBreaker en lib/handlers/pagos.js). Se
// loguea siempre que se cae a este modo para que quede visible en Vercel.

import { db } from './repos/_db.js';

const fallbackStore = new Map(); // solo se usa si el RPC falla

function fallbackCheck(key, max, windowMs) {
  const now = Date.now();
  let entry = fallbackStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
  }
  entry.count++;
  fallbackStore.set(key, entry);

  if (fallbackStore.size > 500) {
    for (const [k, v] of fallbackStore) {
      if (now > v.resetAt) fallbackStore.delete(k);
    }
  }

  return {
    excedido: entry.count > max,
    contador: entry.count,
    reset_at: new Date(entry.resetAt).toISOString(),
  };
}

async function checkDistribuido(key, max, windowMs) {
  try {
    const { data, error } = await db.rpc('rl_check_and_increment', {
      p_clave: key,
      p_max: max,
      p_window_ms: windowMs,
    });
    if (error || !data || !data[0]) {
      console.error('[RATE-LIMIT] rl_check_and_increment falló, degradando a Map local:', error?.message);
      return fallbackCheck(key, max, windowMs);
    }
    const row = data[0];
    return { excedido: row.excedido, contador: row.contador, reset_at: row.reset_at };
  } catch (err) {
    console.error('[RATE-LIMIT] Excepción llamando rl_check_and_increment, degradando a Map local:', err.message);
    return fallbackCheck(key, max, windowMs);
  }
}

/**
 * rateLimit({ max, windowMs })
 * Devuelve un middleware ASYNC que rechaza con 429 si se supera el límite.
 *
 * Uso:
 *   import { rateLimit } from '../../lib/rate-limit.js';
 *   const limiter = rateLimit({ max: 20, windowMs: 60_000 });
 *
 *   export default async function handler(req, res) {
 *     if (await limiter(req, res)) return; // 429 ya enviado
 *     // ... lógica normal
 *   }
 *
 * (Todos los call sites del proyecto ya hacían `await limiter(req, res)`
 * desde que se documentó así originalmente, aunque la implementación previa
 * fuera síncrona — este cambio no requiere tocar ningún caller.)
 */
export function rateLimit({ max = 60, windowMs = 60_000 } = {}) {
  return async function check(req, res) {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || req.socket?.remoteAddress
             || 'unknown';
    const key = `${ip}:${req.url?.split('?')[0]}`;

    const { excedido, contador, reset_at } = await checkDistribuido(key, max, windowMs);

    const remaining = Math.max(0, max - contador);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);

    if (excedido) {
      const retryAfter = Math.max(1, Math.ceil((new Date(reset_at).getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Demasiadas solicitudes. Intentá de nuevo en unos segundos.',
        retryAfter,
      });
      return true; // indica que ya respondió
    }

    return false; // continuar
  };
}

/**
 * rateLimitAuth: preset estricto para endpoints de autenticación (login, reset).
 * 10 intentos por minuto por IP.
 */
export const rateLimitAuth = rateLimit({ max: 10, windowMs: 60_000 });

/**
 * rateLimitApi: preset general para endpoints de escritura (POST/PATCH/DELETE).
 * 60 requests por minuto por IP.
 */
export const rateLimitApi = rateLimit({ max: 60, windowMs: 60_000 });

/**
 * rateLimitPorClave({ max, windowMs })
 * Variante de rateLimit() para código interno que NO tiene req/res (workers
 * de automatización, helpers de push llamados desde un loop, cron jobs).
 * No responde HTTP: solo dice si la clave superó el límite, para que el
 * caller decida qué hacer (loggear y saltear, típicamente).
 *
 * A diferencia de rateLimit() (que arma la clave como ip:endpoint), acá la
 * clave la elige el caller — normalmente empresa_id o usuario_id.
 *
 * NOTA: ahora es ASYNC (antes era síncrona) porque el contador vive en DB —
 * ver FIX SEC-07 arriba. Los dos call sites existentes en el proyecto
 * (lib/handlers/_push.js, lib/handlers/_auto-push.js) ya usan `await`; si
 * se agrega un caller nuevo, recordar que hay que awaitearlo.
 *
 * Uso:
 *   import { rateLimitPorClave } from '../rate-limit.js';
 *   const limiteEnvios = rateLimitPorClave({ max: 20, windowMs: 60_000 });
 *   if (await limiteEnvios(`notifAuto:${empresa_id}`)) return { enviadas: 0, razon: 'rate_limit_interno' };
 */
export function rateLimitPorClave({ max = 30, windowMs = 60_000 } = {}) {
  return async function check(clave) {
    const key = String(clave);
    const { excedido } = await checkDistribuido(key, max, windowMs);
    return excedido; // true = superó el límite
  };
}
