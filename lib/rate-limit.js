// lib/rate-limit.js
// DT-04: Rate limiting simple en memoria para endpoints sensibles.
// En producción con múltiples instancias se recomienda Redis;
// para Vercel Serverless con instancias efímeras esto cubre el caso común.

const store = new Map(); // ip:endpoint → { count, resetAt }

/**
 * rateLimit({ max, windowMs })
 * Devuelve un middleware que rechaza con 429 si se supera el límite.
 *
 * Uso:
 *   import { rateLimit } from '../../lib/rate-limit.js';
 *   const limiter = rateLimit({ max: 20, windowMs: 60_000 });
 *
 *   export default async function handler(req, res) {
 *     if (await limiter(req, res)) return; // 429 ya enviado
 *     // ... lógica normal
 *   }
 */
export function rateLimit({ max = 60, windowMs = 60_000 } = {}) {
  return function check(req, res) {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || req.socket?.remoteAddress
             || 'unknown';
    const key = `${ip}:${req.url?.split('?')[0]}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }

    entry.count++;
    store.set(key, entry);

    // Limpiar entradas viejas cada ~500 llamadas para no crecer indefinidamente
    if (store.size > 500) {
      for (const [k, v] of store) {
        if (now > v.resetAt) store.delete(k);
      }
    }

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.status(429).json({
        error: 'Demasiadas solicitudes. Intentá de nuevo en unos segundos.',
        retryAfter,
      });
      return true; // indica que ya respondió
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', max - entry.count);
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
 * clave la elige el caller — normalmente empresa_id o usuario_id — así que
 * dos usos distintos de rateLimitPorClave() con el mismo prefijo no chocan
 * entre sí aunque compartan el Map de abajo.
 *
 * Uso:
 *   import { rateLimitPorClave } from '../rate-limit.js';
 *   const limiteEnvios = rateLimitPorClave({ max: 20, windowMs: 60_000 });
 *   if (limiteEnvios(`notifAuto:${empresa_id}`)) return { enviadas: 0, razon: 'rate_limit_interno' };
 */
export function rateLimitPorClave({ max = 30, windowMs = 60_000 } = {}) {
  return function check(clave) {
    const key = String(clave);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }

    entry.count++;
    store.set(key, entry);

    if (store.size > 500) {
      for (const [k, v] of store) {
        if (now > v.resetAt) store.delete(k);
      }
    }

    return entry.count > max; // true = superó el límite
  };
}
