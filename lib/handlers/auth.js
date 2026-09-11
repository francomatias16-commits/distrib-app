// api/auth/index.js — Router consolidado de Autenticación
// Fusiona en un solo Serverless Function:
//   - Login / Refresh / Logout / Me  (antes api/auth.js — sesión JWT/Cookie
//     HttpOnly + CSRF para el portal chofer)
//   - Reset de contraseña            (antes api/auth/index.js — flujo
//     Supabase Auth + email brandeado, usado por el portal cliente)
//
// api/auth.js y api/auth/index.js no pueden coexistir en Vercel (archivo y
// directorio con el mismo nombre generan rutas conflictivas), por eso se
// fusionan aquí en un único handler que enruta por req.url.
//
// Rutas:
//   POST /api/auth/login
//   POST /api/auth/refresh
//   POST /api/auth/logout
//   GET  /api/auth/me
//   POST /api/auth/reset-password           (email — portal admin/chofer)
//   POST /api/auth/reset-password-whatsapp  (código — portal cliente, v719)
//   POST /api/auth/confirmar-codigo-whatsapp (v719)
//   POST /api/auth/change-password

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import jwt               from 'jsonwebtoken';
import crypto             from 'crypto';

import { enviarEmailRecuperacionPassword }          from '../email.js';
import { rateLimit, rateLimitAuth }                 from '../rate-limit.js';
import { applySecurityHeaders, applyCorsHeaders }   from '../security-headers.js';
import { CircuitBreaker, CircuitBreakerOpenError }  from '../circuit-breaker.js';
import { withRetry }                                from '../retry.js';
import { errorSeguro } from '../error-response.js';
import { chequearPasswordONull } from '../auth/leaked-password-check.js';
import {
  JWT_REFRESH_SECRET,
  COOKIE_OPTS_BASE,
  emitirAccessToken,
  emitirRefreshToken,
  hashToken,
  generarCsrfToken,
  parseCookie,
  getIP,
  limpiarCookies,
  verificarRequest,
  verificarToken,
} from '../auth-helpers.js';

const limiterLogin = rateLimit({ max: 5, windowMs: 60_000 });

// FIX v957 (hallazgo Etapa 2b, seguridad transversal): ni handleChangePassword
// ni handleConfirmarCodigoWhatsapp invalidaban los refresh_tokens existentes
// del usuario al cambiar la contraseña. Un refresh token robado (sesión
// comprometida) seguía siendo válido por hasta 7 días — el usuario podía
// "arreglar" el problema cambiando la contraseña sin que eso desloguee al
// atacante, que sigue pudiendo pedir access tokens nuevos con el refresh que
// ya tenía. No hay precedente de este patrón en otro archivo del repo (es la
// única tabla refresh_tokens del proyecto), así que se agrega acá.
async function revocarSesionesUsuario(usuarioId) {
  try {
    await supabaseAdmin.from('refresh_tokens').update({ revocado: true })
      .eq('usuario_id', usuarioId).eq('revocado', false);
  } catch (err) {
    console.error('[AUTH] Error revocando sesiones tras cambio de contraseña:', err.message);
  }
}

const authBreaker = new CircuitBreaker({ name: 'supabase-auth', umbralFallas: 3, tiempoRecuperacion: 20_000 });

const supabaseAdmin = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'public' } }]);

const APP_URL = process.env.APP_URL;
if (!APP_URL || APP_URL === 'https://tu-dominio.vercel.app') {
  console.warn('[AUTH] APP_URL no configurada — links de reset apuntarán a placeholder.');
}
const REDIRECT_BASE = APP_URL || 'https://tu-dominio.vercel.app';

// Mismo patrón que WA_ENDPOINT en lib/handlers/notif.js (enviarNotifPedido /
// enviarAvisoDeudaVencida): el envío de templates de WhatsApp se hace vía
// POST al propio /api/notif/whatsapp en vez de importar la lógica de
// notif.js directo, para no duplicar el corte de modo demo / costos /
// reintentos que ya vive ahí.
const WA_ENDPOINT = process.env.WA_ENDPOINT || 'http://localhost:3000/api/notif/whatsapp';

const CODIGO_WA_TTL_MS = 10 * 60 * 1000; // 10 minutos
const CODIGO_WA_MAX_INTENTOS = 5;

// =============================================================================
export default async function handler(req, res) {
  applySecurityHeaders(res);
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // _ruta es el sub-segmento que vercel.json pasa via query param
  // (ej: "login", "refresh"). Fallback a req.url para compatibilidad local.
  const _ruta = req.query._ruta;
  const ruta  = req.url?.replace(/\?.*$/, '');

  try {
    if (req.method === 'POST' && (_ruta === 'login'          || ruta === '/api/auth/login'))          return await handleLogin(req, res);
    if (req.method === 'POST' && (_ruta === 'refresh'        || ruta === '/api/auth/refresh'))        return await handleRefresh(req, res);
    if (req.method === 'POST' && (_ruta === 'logout'         || ruta === '/api/auth/logout'))         return await handleLogout(req, res);
    if (req.method === 'GET'  && (_ruta === 'me'             || ruta === '/api/auth/me'))             return await handleMe(req, res);
    if (req.method === 'POST' && (_ruta === 'reset-password'  || ruta === '/api/auth/reset-password'))  return await handleResetPassword(req, res);
    if (req.method === 'POST' && (_ruta === 'reset-password-whatsapp'  || ruta === '/api/auth/reset-password-whatsapp'))  return await handleResetPasswordWhatsapp(req, res);
    if (req.method === 'POST' && (_ruta === 'confirmar-codigo-whatsapp'  || ruta === '/api/auth/confirmar-codigo-whatsapp'))  return await handleConfirmarCodigoWhatsapp(req, res);
    if (req.method === 'POST' && (_ruta === 'change-password'  || ruta === '/api/auth/change-password'))  return await handleChangePassword(req, res);
    return res.status(404).json({ error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('[auth]', err);
    if (err instanceof CircuitBreakerOpenError) {
      return errorSeguro(res, err, 503, 'No se pudo completar la operación.', { retryAfter: err.retryAfterSeconds });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// -- POST /api/auth/login -----------------------------------------------------
async function handleLogin(req, res) {
  if (await limiterLogin(req, res)) return;

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos.' });

  const { data, error } = await authBreaker.exec(() =>
    withRetry(() => supabaseAdmin.auth.signInWithPassword({ email, password }))
  );
  if (error || !data?.user) return res.status(401).json({ error: 'Credenciales inválidas.' });

  const { data: perfil } = await supabaseAdmin
    .from('usuarios').select('id, nombre, rol, activo').eq('id', data.user.id).single();
  if (!perfil?.activo) return res.status(403).json({ error: 'Usuario desactivado. Contactar administración.' });

  const payload   = { sub: perfil.id, rol: perfil.rol };
  const accessToken = emitirAccessToken(payload);
  const { tokenRaw: refreshToken, tokenHash } = emitirRefreshToken(payload);
  const csrfToken = generarCsrfToken();

  await supabaseAdmin.from('refresh_tokens').insert({
    usuario_id: perfil.id, token_hash: tokenHash,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    user_agent: req.headers['user-agent']?.slice(0, 200) || null, ip: getIP(req),
  });

  res.setHeader('Set-Cookie', [
    `access_token=${accessToken}; ${COOKIE_OPTS_BASE}; Max-Age=900`,
    `refresh_token=${refreshToken}; ${COOKIE_OPTS_BASE}; Max-Age=604800; Path=/api/auth/refresh`,
    `csrf_token=${csrfToken}; Secure; SameSite=Strict; Path=/; Max-Age=900`,
  ]);
  res.setHeader('X-CSRF-Token', csrfToken);
  return res.status(200).json({ ok: true, usuario: { id: perfil.id, nombre: perfil.nombre, rol: perfil.rol } });
}

// -- POST /api/auth/refresh ---------------------------------------------------
async function handleRefresh(req, res) {
  const refreshToken = parseCookie(req.headers.cookie, 'refresh_token');
  if (!refreshToken) return res.status(401).json({ error: 'Sin refresh token.' });

  let payload;
  try { payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET); }
  catch { limpiarCookies(res); return res.status(401).json({ error: 'Refresh token inválido o expirado.' }); }

  const tokenHash = hashToken(refreshToken);

  // SEC-09 (Auditoría Integral 2026): consumo atómico del refresh token.
  // Antes esto era un SELECT (leer revocado) seguido de un UPDATE aparte;
  // dos refresh concurrentes con la misma cookie podían pasar los dos el
  // chequeo `!revocado` antes de que cualquiera alcanzara a marcarlo, y
  // terminar emitiendo dos pares de tokens válidos a partir de un mismo
  // refresh que debía consumirse una sola vez. Ahora la condición vive en
  // el UPDATE mismo (`eq('revocado', false)`): sólo puede "ganar" la
  // request que efectivamente logra dar vuelta esa fila; la que llega
  // después ya la encuentra en revocado=true y no matchea ninguna fila.
  const { data: consumido } = await supabaseAdmin
    .from('refresh_tokens')
    .update({ revocado: true })
    .eq('token_hash', tokenHash)
    .eq('revocado', false)
    .select('id, usuario_id')
    .maybeSingle();

  if (!consumido) {
    // No matcheó ninguna fila: o el token no existe, o ya estaba revocado
    // (replay de un refresh viejo, o carrera perdida contra otra request
    // legítima). No hay forma de distinguir ambos casos desde acá, así que
    // por las dudas se trata como posible robo/replay y se revoca el resto
    // de la sesión de ese usuario, igual que hacía el código anterior.
    const { data: tokenExistente } = await supabaseAdmin
      .from('refresh_tokens').select('usuario_id').eq('token_hash', tokenHash).maybeSingle();
    if (tokenExistente?.usuario_id) {
      await supabaseAdmin.from('refresh_tokens').update({ revocado: true }).eq('usuario_id', tokenExistente.usuario_id);
    }
    limpiarCookies(res);
    return res.status(401).json({ error: 'Sesión inválida. Iniciá sesión nuevamente.' });
  }

  // SEC-09: el flujo viejo emitía el nuevo par confiando solo en que el
  // refresh token fuera válido, sin volver a mirar el estado actual del
  // usuario/empresa. Un usuario desactivado (o una empresa suspendida)
  // después del login podía seguir renovando su sesión indefinidamente
  // mientras conservara un refresh token vigente. Ahora se revalida contra
  // la base antes de emitir, igual que ya se exige en el login.
  const { data: usuarioActual } = await supabaseAdmin
    .from('usuarios').select('id, rol, activo, empresa_id').eq('id', consumido.usuario_id).single();

  if (!usuarioActual?.activo) {
    limpiarCookies(res);
    return res.status(403).json({ error: 'Usuario desactivado. Contactar administración.' });
  }

  if (usuarioActual.empresa_id) {
    const { data: empresaActual } = await supabaseAdmin
      .from('empresas').select('activa, saas_suspendida').eq('id', usuarioActual.empresa_id).single();
    if (empresaActual && (empresaActual.activa === false || empresaActual.saas_suspendida)) {
      limpiarCookies(res);
      return res.status(403).json({ error: 'Cuenta suspendida. Contactar administración.' });
    }
  }

  // Se usa el rol vigente en la base (usuarioActual.rol), no el que venía
  // en el JWT viejo (payload.rol) — si el rol cambió desde el último
  // login, el refresh ya no debe seguir arrastrando el rol desactualizado.
  const nuevoPayload = { sub: usuarioActual.id, rol: usuarioActual.rol };
  const nuevoAccess  = emitirAccessToken(nuevoPayload);
  const { tokenRaw: nuevoRefresh, tokenHash: nuevoHash } = emitirRefreshToken(nuevoPayload);
  const nuevoCsrf    = generarCsrfToken();

  await supabaseAdmin.from('refresh_tokens').insert({
    usuario_id: usuarioActual.id, token_hash: nuevoHash,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), ip: getIP(req),
  });

  res.setHeader('Set-Cookie', [
    `access_token=${nuevoAccess}; ${COOKIE_OPTS_BASE}; Max-Age=900`,
    `refresh_token=${nuevoRefresh}; ${COOKIE_OPTS_BASE}; Max-Age=604800; Path=/api/auth/refresh`,
    `csrf_token=${nuevoCsrf}; Secure; SameSite=Strict; Path=/; Max-Age=900`,
  ]);
  res.setHeader('X-CSRF-Token', nuevoCsrf);
  return res.status(200).json({ ok: true });
}

// -- POST /api/auth/logout ----------------------------------------------------
async function handleLogout(req, res) {
  const refreshToken = parseCookie(req.headers.cookie, 'refresh_token');
  if (refreshToken) {
    await supabaseAdmin.from('refresh_tokens').update({ revocado: true }).eq('token_hash', hashToken(refreshToken));
  }
  limpiarCookies(res);
  return res.status(200).json({ ok: true });
}

// -- GET /api/auth/me ---------------------------------------------------------
// FIX (auditoría UX etapa 14, Hallazgo 1): antes usaba verificarRequest()
// (cookie access_token + JWT_SECRET propio), que ningún login real llega a
// setear -- los 3 portales con contraseña usan sb.auth.signInWithPassword()
// directo, nunca /api/auth/login. Como consecuencia esto devolvía 401 el
// 100% de las veces para cualquier caller real (ej. suspendida.html, que
// manda el Bearer token de Supabase, no la cookie). Ahora usa
// verificarToken() (mismo helper que ya usan otros 14 handlers) y además
// devuelve `empresa` -- suspendida.html necesita saas_suspendida, saas_plan,
// saas_trial_fin, saas_precio_mes para decidir qué mostrar, y antes esto
// nunca los incluía aunque hubiera funcionado.
async function handleMe(req, res) {
  const perfil = await verificarToken(req, supabaseAdmin);
  if (!perfil) return res.status(401).json({ error: 'No autenticado.' });

  let empresa = null;
  if (perfil.empresa_id) {
    const { data } = await supabaseAdmin
      .from('empresas')
      .select('id, nombre, activa, saas_suspendida, saas_plan, saas_trial_fin, saas_precio_mes')
      .eq('id', perfil.empresa_id)
      .single();
    empresa = data || null;
  }

  return res.status(200).json({
    usuario: { id: perfil.id, nombre: perfil.nombre, rol: perfil.rol, email: perfil.email, solo_lectura: !!perfil.solo_lectura },
    empresa,
  });
}

// -- POST /api/auth/reset-password --------------------------------------------
// Hallazgo 5.2 (auditoría v254): evitar loguear el email completo en texto
// plano — se mantiene trazabilidad (dominio + últimos caracteres del local-part)
// sin exponer el dato personal completo en los logs de servidor.
function ofuscarEmail(email) {
  const [local, dominio] = String(email).split('@');
  if (!dominio) return '***';
  const visible = local.slice(-2);
  return `${'*'.repeat(Math.max(local.length - 2, 1))}${visible}@${dominio}`;
}

async function handleResetPassword(req, res) {
  if (await rateLimitAuth(req, res)) return;

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Campo email requerido' });

  const emailNorm = email.trim().toLowerCase();
  procesarRecuperacion(emailNorm).catch(err => console.error('[RESET-PW] Error:', err.message));

  return res.status(200).json({
    ok: true,
    mensaje: 'Si el email está registrado, recibirás las instrucciones en los próximos minutos.',
  });
}

async function procesarRecuperacion(email) {
  const { data: usuarios } = await supabaseAdmin
    .from('usuarios').select('id, empresa_id, nombre').eq('email', email).limit(1);
  if (!usuarios?.length) { console.log(`[RESET-PW] Email no encontrado: ${ofuscarEmail(email)}`); return; }

  const empresaId = usuarios[0].empresa_id;
  let empresa = null;
  if (empresaId) {
    const { data } = await supabaseAdmin.from('empresas').select('id, nombre, email').eq('id', empresaId).single();
    empresa = data;
  }

  const redirectTo = `${REDIRECT_BASE}/cliente/login?reset=1`;
  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery', email, options: { redirectTo },
  });
  if (linkError || !linkData?.properties?.action_link) {
    console.error('[RESET-PW] Error generando link:', linkError?.message); return;
  }

  await enviarEmailRecuperacionPassword(email, linkData.properties.action_link, empresa);
  console.log(`[RESET-PW] Email enviado a ${ofuscarEmail(email)}`);
}

// -- POST /api/auth/reset-password-whatsapp -----------------------------------
// Reset de contraseña para el portal cliente (v719/455). Ver comentario de
// la migración 455 para el porqué: el cliente del portal no tiene un email
// real cargado en usuarios.email (es el ficticio ...@portal.distrib), así
// que el reset por email de arriba nunca le hubiera llegado a nadie. El
// cliente ya se identifica 100% por su WhatsApp (mismo algoritmo que
// frontend/cliente/login.html para armar el email ficticio), así que el
// reset natural es un código de 6 dígitos por WhatsApp.

// Duplicado a propósito (mismo algoritmo que frontend/cliente/login.html y
// lib/handlers/clientes.js#normalizarTelefono) — criterio ya establecido en
// este proyecto: cada módulo que necesita esto lo tiene local en vez de
// importar entre handlers (ver notif.js, chofer_invitacion.js).
function normalizarTelefonoCliente(tel) {
  let digits = String(tel || '').replace(/\D/g, '');
  if (!digits) return null;
  if (!digits.startsWith('54')) {
    if (digits.startsWith('0')) digits = digits.slice(1);
    digits = '54' + digits;
  }
  return digits;
}

function emailFicticioPortal(telefonoNormalizado) {
  return `${telefonoNormalizado}@portal.distrib`;
}

// Mismo criterio que ofuscarEmail() de arriba (Hallazgo 5.2, auditoría
// v254): trazabilidad en logs sin exponer el teléfono completo.
function ofuscarTelefono(telefono) {
  const t = String(telefono || '');
  if (t.length <= 4) return '***';
  return `${'*'.repeat(t.length - 4)}${t.slice(-4)}`;
}

function generarCodigoWhatsapp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 dígitos, incluye ceros a la izquierda
}

async function handleResetPasswordWhatsapp(req, res) {
  if (await rateLimitAuth(req, res)) return;

  const { telefono } = req.body || {};
  if (!telefono || typeof telefono !== 'string') {
    return res.status(400).json({ error: 'Campo telefono requerido' });
  }

  const telefonoNorm = normalizarTelefonoCliente(telefono);

  // Fire-and-forget, mismo patrón que procesarRecuperacion() de arriba: la
  // respuesta al cliente es siempre la misma, exista o no el número, para
  // no revelar qué números están registrados.
  procesarResetWhatsapp(telefonoNorm).catch(err => console.error('[RESET-PW-WA] Error:', err.message));

  return res.status(200).json({
    ok: true,
    mensaje: 'Si el número está registrado, te enviamos un código por WhatsApp.',
  });
}

async function procesarResetWhatsapp(telefonoNorm) {
  if (!telefonoNorm) return;

  const email = emailFicticioPortal(telefonoNorm);
  const { data: usuario } = await supabaseAdmin
    .from('usuarios').select('id, empresa_id, cliente_id, rol, activo').eq('email', email).limit(1).maybeSingle();

  // No existe, no es un cliente del portal, o está desactivado: no se
  // manda nada, pero tampoco se lo dice (mismo criterio que el reset por
  // email — evita enumeración de números registrados).
  if (!usuario || usuario.rol !== 'cliente' || !usuario.cliente_id || !usuario.activo) {
    console.log(`[RESET-PW-WA] Número no habilitado para reset: ${ofuscarTelefono(telefonoNorm)}`);
    return;
  }

  const codigo = generarCodigoWhatsapp();
  const { error: insertError } = await supabaseAdmin.from('whatsapp_reset_codigos').insert({
    empresa_id: usuario.empresa_id,
    cliente_id: usuario.cliente_id,
    usuario_id: usuario.id,
    telefono: telefonoNorm,
    codigo_hash: hashToken(codigo),
    expira_at: new Date(Date.now() + CODIGO_WA_TTL_MS).toISOString(),
  });
  if (insertError) {
    console.error('[RESET-PW-WA] Error guardando código:', insertError.message);
    return;
  }

  try {
    // FIX AUTOMATIZACION-003 — ver comentario en lib/handlers/notif.js.
    const waResp = await fetch(WA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
      },
      body: JSON.stringify({
        template: 'codigo_recuperacion_password',
        telefono: telefonoNorm,
        params: { codigo },
        empresa_id: usuario.empresa_id,
      }),
    });
    if (!waResp.ok) {
      const data = await waResp.json().catch(() => ({}));
      console.error('[RESET-PW-WA] Error enviando WhatsApp:', data?.error || waResp.status);
      return;
    }
  } catch (err) {
    console.error('[RESET-PW-WA] No se pudo conectar con /api/notif/whatsapp:', err.message);
    return;
  }

  console.log(`[RESET-PW-WA] Código enviado a ${ofuscarTelefono(telefonoNorm)}`);
}

// -- POST /api/auth/confirmar-codigo-whatsapp ----------------------------------
// Segundo paso del flujo de arriba: valida el código de 6 dígitos y, si es
// correcto, fija la contraseña nueva directamente (no hay "contraseña
// actual" que pedir — si el cliente la tuviera, no estaría acá).
async function handleConfirmarCodigoWhatsapp(req, res) {
  if (await rateLimitAuth(req, res)) return;

  const { telefono, codigo, password_nuevo } = req.body || {};
  if (!telefono || !codigo || !password_nuevo) {
    return res.status(400).json({ error: 'Se requieren teléfono, código y contraseña nueva.' });
  }
  if (typeof password_nuevo !== 'string' || password_nuevo.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  }
  const errorPwFiltradaWa = await chequearPasswordONull(password_nuevo);
  if (errorPwFiltradaWa) return res.status(400).json(errorPwFiltradaWa);

  const telefonoNorm = normalizarTelefonoCliente(telefono);
  const email = emailFicticioPortal(telefonoNorm);

  const { data: usuario } = await supabaseAdmin
    .from('usuarios').select('id, cliente_id, rol, activo').eq('email', email).limit(1).maybeSingle();
  if (!usuario || usuario.rol !== 'cliente' || !usuario.cliente_id || !usuario.activo) {
    // Mismo mensaje genérico que un código incorrecto — no revela si el
    // número existe.
    return res.status(400).json({ error: 'Código inválido o vencido.' });
  }

  const { data: fila } = await supabaseAdmin
    .from('whatsapp_reset_codigos')
    .select('id, codigo_hash, intentos, expira_at, usado')
    .eq('usuario_id', usuario.id).eq('usado', false)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();

  if (!fila || new Date(fila.expira_at) < new Date()) {
    return res.status(400).json({ error: 'Código inválido o vencido.' });
  }
  if (fila.intentos >= CODIGO_WA_MAX_INTENTOS) {
    return res.status(429).json({ error: 'Demasiados intentos. Pedí un código nuevo.' });
  }

  if (hashToken(String(codigo).trim()) !== fila.codigo_hash) {
    await supabaseAdmin.from('whatsapp_reset_codigos').update({ intentos: fila.intentos + 1 }).eq('id', fila.id);
    return res.status(400).json({ error: 'Código inválido o vencido.' });
  }

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(usuario.id, {
    password: password_nuevo,
  });
  if (updateError) {
    console.error('[RESET-PW-WA] Error actualizando contraseña:', updateError.message);
    return res.status(500).json({ error: 'No se pudo actualizar la contraseña.' });
  }

  await supabaseAdmin.from('whatsapp_reset_codigos').update({ usado: true }).eq('id', fila.id);
  await revocarSesionesUsuario(usuario.id);

  console.log(`[RESET-PW-WA] Contraseña actualizada para usuario ${usuario.id}`);
  return res.status(200).json({ ok: true, mensaje: 'Contraseña actualizada correctamente.' });
}

// -- POST /api/auth/change-password -------------------------------------------
// Usuario autenticado cambia su propia contraseña.
// FIX (auditoría UX etapa 14, Hallazgo 1): antes requería cookie
// access_token + CSRF header propios, que ningún login real llega a setear
// (los 3 portales con contraseña usan sb.auth.signInWithPassword() directo).
// cuenta.html (portal cliente) nunca pudo cambiar la contraseña -- 401
// "No autenticado" el 100% de las veces. Ahora usa verificarToken(), el
// mismo helper que ya usan otros 14 handlers, con el Bearer token real de
// la sesión de Supabase.
async function handleChangePassword(req, res) {
  const perfil = await verificarToken(req, supabaseAdmin);
  if (!perfil) return res.status(401).json({ error: 'No autenticado.' });

  const { password_actual, password_nuevo } = req.body || {};

  if (!password_actual || !password_nuevo) {
    return res.status(400).json({ error: 'Se requieren contraseña actual y nueva.' });
  }
  if (typeof password_nuevo !== 'string' || password_nuevo.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  }
  if (password_actual === password_nuevo) {
    return res.status(400).json({ error: 'La nueva contraseña debe ser diferente a la actual.' });
  }
  const errorPwFiltradaCambio = await chequearPasswordONull(password_nuevo);
  if (errorPwFiltradaCambio) return res.status(400).json(errorPwFiltradaCambio);

  if (!perfil.email) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }

  // Verificar contraseña actual intentando login
  const { error: loginError } = await supabaseAdmin.auth.signInWithPassword({
    email: perfil.email,
    password: password_actual,
  });
  if (loginError) {
    return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
  }

  // Actualizar contraseña con admin API
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(perfil.id, {
    password: password_nuevo,
  });
  if (updateError) {
    console.error('[CHANGE-PW] Error actualizando contraseña:', updateError.message);
    return res.status(500).json({ error: 'No se pudo actualizar la contraseña.' });
  }

  await revocarSesionesUsuario(perfil.id);

  console.log(`[CHANGE-PW] Contraseña actualizada para usuario ${perfil.id}`);
  return res.status(200).json({ ok: true, mensaje: 'Contraseña actualizada correctamente.' });
}
