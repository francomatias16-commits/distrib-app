// lib/auth-helpers.js
// Helpers compartidos de autenticación JWT/Cookie (sesión del portal chofer).
//
// Extraído desde el antiguo api/auth.js para poder reutilizarse tanto desde
// api/auth/index.js (login/refresh/logout/me) como desde api/notif/index.js
// (verificación de sesión para suscripción Push VAPID).
//
// No es un endpoint HTTP — solo helpers, vive en lib/ (fuera de api/) para
// no contar como Serverless Function adicional.

import jwt    from 'jsonwebtoken';
import crypto from 'crypto';

export const JWT_SECRET         = process.env.JWT_SECRET;
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// FIX (2026-07-14, incidente "dashboard no conecta con los datos"): este
// chequeo antes tiraba `throw` acá arriba, a nivel de módulo. Como
// api/index.js importa TODOS los handlers de una sola vez en una única
// Serverless Function, ese throw pasaba en el import de auth-helpers.js y
// tumbaba el arranque de TODA la lambda — no solo /api/auth/*, sino
// /api/admin/kpis, /api/admin/pedidos, y cualquier otra ruta, aunque no
// tuvieran nada que ver con JWT_REFRESH_SECRET.
//
// Ahora el chequeo se hace en el momento de USO real (emitir/verificar el
// refresh token), así si falta la env var solo rompe el login/refresh —
// el resto del panel sigue funcionando y el error queda claro.
function requireRefreshSecret() {
  if (!JWT_REFRESH_SECRET) {
    throw new Error('[auth-helpers] JWT_REFRESH_SECRET no definido — no usar un secreto derivado en producción.');
  }
  return JWT_REFRESH_SECRET;
}

export const ACCESS_TOKEN_TTL  = '15m';  // Corto: minimiza ventana de exposición
export const REFRESH_TOKEN_TTL = '7d';

export const COOKIE_OPTS_BASE = [
  'HttpOnly',
  'Secure',
  'SameSite=Strict',
  'Path=/',
].join('; ');

export function emitirAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
}

export function emitirRefreshToken(payload) {
  const tokenRaw = jwt.sign(payload, requireRefreshSecret(), { expiresIn: REFRESH_TOKEN_TTL, algorithm: 'HS256' });
  return { tokenRaw, tokenHash: hashToken(tokenRaw) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generarCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function parseCookie(cookieHeader, nombre) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

export function limpiarCookies(res) {
  res.setHeader('Set-Cookie', [
    `access_token=; ${COOKIE_OPTS_BASE}; Max-Age=0`,
    `refresh_token=; ${COOKIE_OPTS_BASE}; Max-Age=0; Path=/api/auth/refresh`,
    `csrf_token=; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  ]);
}

/**
 * Verifica el Bearer token de Supabase (enviado por el frontend admin como
 * Authorization: Bearer <supabase_access_token>).
 * Retorna el perfil del usuario (fila de `usuarios`) o null.
 *
 * USO en handlers que reciben requests del panel admin:
 *   const perfil = await verificarToken(req, sb);
 *   if (!perfil) return res.status(401).json({ error: 'No autorizado' });
 *
 * @param {object} req  - Vercel/Node request
 * @param {object} sb   - Cliente Supabase con SERVICE_ROLE_KEY
 */
function compararSeguro(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export async function verificarToken(req, sb) {
  const authHeader = req.headers['authorization'] || '';
  // Permitir CRON_SECRET para llamadas internas (crons de Vercel)
  if (process.env.CRON_SECRET && compararSeguro(authHeader, `Bearer ${process.env.CRON_SECRET}`)) {
    return { id: null, rol: 'cron', empresa_id: null };
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  // Verificar el JWT de Supabase y obtener el usuario
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return null;

  // Buscar el perfil en la tabla `usuarios`.
  // Etapa 11 (auditoría de módulos, Usuarios/roles/permisos): antes esto no
  // filtraba por `activo`, a diferencia de la carga de perfil del frontend
  // (auth.js, Etapa 2 de la auditoría de seguridad), que sí lo exige desde
  // hace tiempo. Si el ban en Supabase Auth fallaba en silencio (el
  // `.catch(() => {})` de usuarios.js al desactivar), un usuario desactivado
  // seguía teniendo acceso completo a los ~16 handlers que usan esta función
  // mientras su JWT de Supabase no expirara. Ahora se exige acá también,
  // igual que en el frontend.
  const { data: perfil } = await sb
    .from('usuarios')
    .select('id, nombre, email, rol, empresa_id, activo, cliente_id, solo_lectura')
    .eq('id', user.id)
    .eq('activo', true)
    .single();

  return perfil || null;
}

/**
 * Verifica el access token (cookie) y el CSRF token (header X-CSRF-Token).
 * Retorna { usuario } o { error }.
 *
 * USO en otras rutas serverless:
 *   const { usuario, error } = verificarRequest(req);
 *   if (error) return res.status(401).json({ error });
 */
export function verificarRequest(req) {
  const token = parseCookie(req.headers.cookie, 'access_token');
  if (!token) return { error: 'No autenticado.' };

  // Verificar CSRF en mutaciones (POST, PATCH, PUT, DELETE)
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    const csrfHeader = req.headers['x-csrf-token'];
    const csrfCookie = parseCookie(req.headers.cookie, 'csrf_token');
    if (!csrfHeader || csrfHeader !== csrfCookie) {
      return { error: 'CSRF token inválido.' };
    }
  }

  try {
    const usuario = jwt.verify(token, JWT_SECRET);
    return { usuario };
  } catch (err) {
    return { error: err.name === 'TokenExpiredError' ? 'Sesión expirada.' : 'Token inválido.' };
  }
}
