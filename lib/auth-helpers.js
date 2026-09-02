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
import { createRemoteJWKSet, jwtVerify } from 'jose';

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

// FIX (confirmado con logs de producción — Vercel get_runtime_errors: 401 en
// /api/score y /api/pos/cajas-admin con duration_ms ~10.3-10.9s, uno de ellos
// además logueando "[RATE-LIMIT] ... AbortError: This operation was aborted"
// en el mismo request): sb.auth.getUser(token) puede colgarse/tardar cuando
// el servicio de Auth de Supabase está lento (más probable bajo la carga
// concurrente que recibe el tenant demo público). El mismo patrón —
// `const { data: { user }, error } = await sb.auth.getUser(token); if (error
// || !user) return res.status(401)...` — está repetido a mano en ~20
// handlers más allá de verificarToken() (ver abajo), todos con el mismo
// problema: un timeout del lado de Supabase se confunde con "token
// inválido" y dispara un logout falso en el frontend (api-client.js
// redirige a /admin/login ante cualquier 401).
//
// getUserSeguro() centraliza el fix: mismo Promise.race que ya usaba
// admin.js, pero — como verificarToken() más abajo — TIRA una excepción
// marcada (`esTimeoutAuth`) en vez de devolver `{ error }` ante un timeout,
// para que el catch-all del dispatcher (api/index.js) la distinga y
// responda 503 en vez de que el handler la trate como credencial inválida y
// responda 401. Todo el código existente que hace
// `const { data: { user }, error } = await getUserSeguro(sb, token)` sigue
// funcionando igual que antes para el caso normal (token válido/inválido) —
// solo cambia qué pasa cuando Supabase no contesta a tiempo.
//
// FIX (2026-08-29, incidente "Supabase API Gateway: Degraded Performance"):
// dos mitigaciones sobre el mismo punto de falla, confirmadas con
// auth_logs de Supabase — cuando el pedido SÍ llega, el motor de Auth
// contesta en 2-350ms, nunca en segundos:
//
//   1) Timeout 8s → 3s. Esperar 8s antes de cortar no tenía respaldo en los
//      tiempos reales observados; 3s sobra para el caso sano y falla-rápido
//      bastante antes, dejando más margen para los reintentos del cliente.
//
//   2) Caché en memoria de getUser() por token, TTL configurable
//      (AUTH_CACHE_TTL_MS, default 45s). Mientras la lambda esté "caliente"
//      evita repetir el viaje de red a Supabase Auth en cada request del
//      mismo usuario — que es exactamente el viaje que se cuelga cuando el
//      gateway está degradado. Solo se cachea el resultado OK (token válido
//      + user): un resultado de error nunca se cachea, para no enmascarar
//      un timeout puntual ni una revocación real. Se cachea por hash del
//      token (no el token crudo) y se desactiva en NODE_ENV=test para no
//      alterar el comportamiento de la suite existente (que testea
//      handlers con tokens repetidos y mocks distintos por caso).
//
//      Nota pendiente (no resuelta acá): un JWT de Supabase cacheado sigue
//      siendo válido hasta que expira aunque el usuario haya cerrado sesión
//      o haya sido desactivado — la caché de 45s amplía levemente esa
//      ventana. Si se necesita revocación inmediata, invalidar la entrada
//      de este Map desde el flujo de logout/baneo (limpiarCacheAuth) es el
//      próximo paso, o migrar a verificación JWT local (opción 1, pendiente
//      del JWT secret del dashboard de Supabase).
// FIX (2026-08-29, opción 1 — la pendiente): verificación LOCAL del JWT
// contra el JSON Web Key Set público del proyecto
// (https://<project>.supabase.co/auth/v1/.well-known/jwks.json), que no
// requiere ningún secreto ni viaje de red a Supabase Auth. Esto elimina
// de raíz el punto de falla (el timeout/caché de arriba son mitigaciones;
// esto directamente evita el viaje de red en el caso común).
//
// Solo funciona para tokens firmados con una signing key ASIMÉTRICA
// (ES256/RS256) — el proyecto migró a eso (confirmado en el dashboard:
// CURRENT KEY = ECC P-256), pero durante la ventana de transición pueden
// seguir circulando tokens viejos firmados con el secreto legacy HS256
// (sesiones que no refrescaron todavía). Un HS256 no tiene contraparte
// pública, así que NO va a estar en el JWKS — jwtVerify() tira excepción
// y se lo tratamos como "no verificable localmente", no como "inválido":
// verificarJWTLocal() nunca lanza, devuelve `null` y el caller cae al
// camino remoto (Promise.race + caché) de siempre, que sí sabe validar
// ambos tipos de firma. Ídem si el JWKS es inalcanzable (irónicamente el
// mismo tipo de degradación que motivó todo este fix) — timeout corto
// (2s) para no sumarle demasiado al timeout remoto en cascada.
const SUPABASE_JWKS_TIMEOUT_MS = 2000;
let _jwks = null;
let _jwksIssuer = null;

function obtenerJWKS() {
  if (_jwks) return _jwks;
  // Igual que la caché de arriba: nunca tocar red real en la suite de
  // tests, aunque por accidente quede seteada una SUPABASE_URL real.
  if (process.env.NODE_ENV === 'test') return null;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null; // sin URL configurada no hay forma de armar el JWKS
  _jwksIssuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  _jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl), {
    timeoutDuration: SUPABASE_JWKS_TIMEOUT_MS,
  });
  return _jwks;
}

async function verificarJWTLocal(token) {
  const jwks = obtenerJWKS();
  if (!jwks) return null;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: _jwksIssuer,
      audience: 'authenticated',
    });

    // Mismo shape que sb.auth.getUser() en data.user, con los campos que
    // el resto del código realmente usa (auditado con grep sobre
    // handlers/: .id, .email, .user_metadata — ver JWT Claims Reference
    // de Supabase para el resto de claims disponibles).
    return {
      id: payload.sub,
      email: payload.email,
      phone: payload.phone,
      role: payload.role,
      aud: payload.aud,
      app_metadata: payload.app_metadata || {},
      user_metadata: payload.user_metadata || {},
    };
  } catch (_err) {
    // No verificable localmente: token legacy HS256 (sin contraparte en
    // el JWKS), JWKS inalcanzable, token vencido, o clock skew. Ninguno
    // de estos casos debe traducirse en "credencial inválida" acá — se
    // delega al camino remoto, que si el token realmente es inválido va
    // a devolver el mismo resultado que hoy.
    return null;
  }
}

const AUTH_CACHE_TTL_MS  = Number(process.env.AUTH_CACHE_TTL_MS) || 45_000;
const AUTH_CACHE_ENABLED = process.env.NODE_ENV !== 'test';
const authUserCache = new Map(); // hash(token) -> { data, expiresAt }

function limpiarEntradasVencidas() {
  const ahora = Date.now();
  for (const [clave, entrada] of authUserCache) {
    if (entrada.expiresAt <= ahora) authUserCache.delete(clave);
  }
}

// Exportado para tests/flujos de logout que necesiten invalidar la caché
// manualmente (p. ej. al desactivar un usuario) en vez de esperar el TTL.
export function limpiarCacheAuth(token) {
  if (token) authUserCache.delete(hashToken(token));
  else authUserCache.clear();
}

export async function getUserSeguro(sb, token, timeoutMs = 3000) {
  // Paso 0: verificación local (JWKS), sin red. Si el token fue firmado
  // con la signing key asimétrica actual, esto resuelve todo sin tocar
  // Supabase — no hace falta ni consultar la caché.
  const userLocal = await verificarJWTLocal(token);
  if (userLocal) return { data: { user: userLocal }, error: null };

  const cacheKey = AUTH_CACHE_ENABLED ? hashToken(token) : null;

  if (cacheKey) {
    const cacheado = authUserCache.get(cacheKey);
    if (cacheado && cacheado.expiresAt > Date.now()) {
      return { data: cacheado.data, error: null };
    }
  }

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs));
  const consulta = sb.auth.getUser(token).then((r) => ({ timedOut: false, ...r }));
  const resultado = await Promise.race([consulta, timeout]);

  if (resultado.timedOut) {
    console.error('[auth-helpers] Timeout consultando Supabase Auth (auth.getUser), se corta rápido en vez de colgar');
    const err = new Error('El servicio de autenticación tardó demasiado en responder. Reintentá en unos segundos.');
    err.esTimeoutAuth = true;
    throw err;
  }

  const { data, error } = resultado;

  if (cacheKey && !error && data?.user) {
    authUserCache.set(cacheKey, { data, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    // Barrido ocasional para no acumular tokens vencidos indefinidamente
    // en una lambda de larga vida (no en cada set, para no pagar el costo
    // en cada request).
    if (authUserCache.size % 50 === 0) limpiarEntradasVencidas();
  }

  return { data, error };
}

export async function verificarToken(req, sb) {
  const authHeader = req.headers['authorization'] || '';
  // Permitir CRON_SECRET para llamadas internas (crons de Vercel)
  if (process.env.CRON_SECRET && compararSeguro(authHeader, `Bearer ${process.env.CRON_SECRET}`)) {
    return { id: null, rol: 'cron', empresa_id: null };
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  // Verificar el JWT de Supabase y obtener el usuario (getUserSeguro tira
  // esTimeoutAuth en vez de devolver error si Supabase no contesta a tiempo
  // — ver comentario arriba).
  const { data: { user }, error } = await getUserSeguro(sb, token);
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
