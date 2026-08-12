/**
 * retry.js — Reintentos con backoff exponencial + jitter
 * distrib-v38-optimized | Módulo 2: Resiliencia API
 *
 * USO:
 *   const data = await withRetry(() => fetch('/api/supabase/...'), { intentos: 3 });
 */



/**
 * @param {() => Promise<any>} fn        Función a ejecutar
 * @param {object}             opts
 * @param {number}             opts.intentos       Máximo de intentos (default: 3)
 * @param {number}             opts.baseDelayMs    Delay base en ms (default: 300)
 * @param {number}             opts.maxDelayMs     Delay máximo en ms (default: 10000)
 * @param {(err: Error) => boolean} opts.esReintentable  Determina si el error amerita reintento
 */
export async function withRetry(fn, {
  intentos       = 3,
  baseDelayMs    = 300,
  maxDelayMs     = 10_000,
  esReintentable = defaultEsReintentable,
} = {}) {
  let ultimoError;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;

      const esUltimo = intento === intentos;
      if (esUltimo || !esReintentable(err)) throw err;

      const delay = calcularDelay(intento, baseDelayMs, maxDelayMs);
      console.warn(`[retry] Intento ${intento}/${intentos} falló. Reintentando en ${delay}ms.`, err?.message);
      await sleep(delay);
    }
  }

  throw ultimoError;
}

/**
 * Backoff exponencial con jitter aleatorio para evitar thundering herd.
 * Fórmula: min(maxDelay, base * 2^(intento-1)) + jitter(0-100ms)
 */
function calcularDelay(intento, baseDelayMs, maxDelayMs) {
  const exponencial = baseDelayMs * Math.pow(2, intento - 1);
  const jitter      = Math.random() * 100;
  return Math.min(maxDelayMs, exponencial + jitter);
}

/**
 * Por defecto: reintentar en errores de red y 5xx (nunca en 4xx — son errores de datos).
 */
function defaultEsReintentable(err) {
  if (!err) return false;
  // Error de red puro (sin status)
  if (!err.status && !err.response) return true;
  // HTTP 429 Too Many Requests
  if (err.status === 429) return true;
  // HTTP 5xx — errores del servidor (transitorios)
  if (err.status >= 500 && err.status < 600) return true;
  // Todo lo demás (4xx, errores de validación) → NO reintentar
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

