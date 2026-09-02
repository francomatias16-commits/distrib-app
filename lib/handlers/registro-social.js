// lib/handlers/registro-social.js
// Handler para /api/registro-social — Segundo paso del registro para usuarios
// que se dan de alta con Google / Microsoft / Facebook (OAuth).
//
// Por qué existe un endpoint aparte de /api/registro:
//   /api/registro crea el usuario en Supabase Auth con email+password Y la
//   empresa en el mismo paso. Con OAuth, Supabase ya crea el usuario de Auth
//   automáticamente al volver del proveedor (Google/Meta/Microsoft) — acá
//   solo falta pedirle los 2 datos que ningún proveedor social conoce
//   (razón social y CUIT) y correr el mismo RPC multi-tenant reutilizando
//   ese usuario ya autenticado, en vez de crear uno nuevo.
//
// Flujo:
//   1. Usuario toca "Continuar con Google" en /registro
//   2. Supabase redirige a Google → vuelve autenticado a /completar-registro
//   3. completar-registro.html llama a este endpoint con el access_token
//      de la sesión + { empresa_nombre, empresa_cuit }
//   4. Acá se valida el token, se corre registrar_empresa_saas y listo.
//
// Idempotente: si el usuario ya tiene empresa asignada (ej. vuelve a tocar
// "Continuar con Google" para loguearse, no para registrarse), no duplica
// nada y devuelve ok:true con la empresa existente.
//
// MF Web Solutions | distrib SaaS

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { getUserSeguro } from '../auth-helpers.js';
import { rateLimit }    from '../rate-limit.js';
import { validarCUIT, enviarBienvenida } from './registro.js';

const supabaseAdmin = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }]);

// Mismo criterio conservador que /api/registro
const limiter = rateLimit({ max: 8, windowMs: 60 * 60_000 });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  if (await limiter(req, res)) return;

  // ── Validar sesión OAuth (token que manda el front, ya autenticado) ─────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'No autenticado. Volvé a iniciar sesión.' });
  }

  const { data: userData, error: userError } = await getUserSeguro(supabaseAdmin, token);
  if (userError || !userData?.user) {
    return res.status(401).json({ ok: false, error: 'Sesión inválida o vencida. Volvé a intentar el login.' });
  }

  const user = userData.user;
  const emailUsuario = user.email;
  if (!emailUsuario) {
    return res.status(400).json({ ok: false, error: 'Tu cuenta no tiene un email verificado por el proveedor.' });
  }

  const { empresa_nombre, empresa_cuit, empresa_telefono, empresa_email } = req.body ?? {};

  if (!empresa_nombre?.trim())
    return res.status(400).json({ ok: false, error: 'El nombre de la empresa es requerido.' });

  if (!empresa_cuit?.trim())
    return res.status(400).json({ ok: false, error: 'El CUIT es requerido.' });

  if (!validarCUIT(empresa_cuit))
    return res.status(400).json({ ok: false, error: 'CUIT inválido. Verificá los dígitos.' });

  // ── Idempotencia: si ya tiene empresa, no duplicar (ej. reintento) ──────
  const { data: yaExiste } = await supabaseAdmin
    .from('usuarios')
    .select('empresa_id')
    .eq('id', user.id)
    .maybeSingle();

  if (yaExiste?.empresa_id) {
    return res.status(200).json({ ok: true, empresa_id: yaExiste.empresa_id, ya_existia: true });
  }

  const nombreUsuario =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    emailUsuario.split('@')[0];

  // ── Llamar al mismo RPC multi-tenant que usa /api/registro ──────────────
  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('registrar_empresa_saas', {
    p_empresa_nombre:    empresa_nombre.trim(),
    p_empresa_cuit:      empresa_cuit.replace(/\s/g, ''),
    p_empresa_domicilio: null,
    p_empresa_telefono:  empresa_telefono?.trim() || null,
    p_empresa_email:     empresa_email?.trim() || null,
    p_usuario_id:        user.id,
    p_usuario_nombre:    nombreUsuario,
    p_usuario_email:     emailUsuario,
  });

  if (rpcError || !rpcData?.ok) {
    const errMsg = rpcData?.error || rpcError?.message || 'Error al crear la empresa.';
    console.error('[REGISTRO-SOCIAL] Error RPC registrar_empresa_saas:', errMsg);
    return res.status(500).json({ ok: false, error: errMsg });
  }

  // ── Enviar email de bienvenida (no bloqueante) ──────────────────────────
  enviarBienvenida({
    adminEmail:    emailUsuario,
    adminNombre:   nombreUsuario,
    empresaNombre: empresa_nombre.trim(),
    trialFin:      rpcData.trial_fin,
  }).catch(e => console.warn('[REGISTRO-SOCIAL] Email bienvenida falló (no crítico):', e?.message));

  return res.status(200).json({
    ok:         true,
    empresa_id: rpcData.empresa_id,
    trial_fin:  rpcData.trial_fin,
    mensaje:    rpcData.mensaje,
  });
}
