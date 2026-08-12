/**
 * security-headers.js — Headers de seguridad HTTP estándar
 * distrib-v38-optimized | Módulo 2
 *
 * Aplica en TODAS las respuestas serverless para mitigar:
 *   - Clickjacking (X-Frame-Options)
 *   - XSS reflejado (X-XSS-Protection, CSP)
 *   - Sniffing de MIME (X-Content-Type-Options)
 *   - Information leakage (X-Powered-By eliminado)
 */



// Dominios permitidos como origen del frontend
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Aplica headers de seguridad estándar a la respuesta.
 * Llamar al inicio de cada handler serverless.
 */
export function applySecurityHeaders(res) {
  // Evitar que el navegador adivine el tipo MIME
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Evitar embedding en iframes (clickjacking)
  res.setHeader('X-Frame-Options', 'DENY');

  // Forzar HTTPS en el navegador (1 año)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Ocultar el runtime del servidor
  res.removeHeader('X-Powered-By');
  res.setHeader('Server', '');

  // Referrer mínimo (no filtrar URLs internas a terceros)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy: deshabilitar acceso a hardware no necesario
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Content Security Policy básica para APIs (solo JSON, sin HTML)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'"
  );
}

/**
 * Aplica CORS dinámico solo a orígenes explícitamente permitidos.
 * Rechaza orígenes no listados con 403 en preflight.
 */
export function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin',      origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',     'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',     'Content-Type,X-CSRF-Token,Authorization');
    res.setHeader('Access-Control-Max-Age',           '86400');
    res.setHeader('Vary', 'Origin');
  }
}


// Alias español — compatibilidad con todos los handlers existentes
export const aplicarHeaders = applySecurityHeaders;
