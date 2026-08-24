// lib/handlers/registro.js
// Handler para /api/registro — Registro público de nuevas empresas (SaaS multi-tenant)
//
// Ruta:
//   POST /api/registro  → crea empresa en trial + usuario admin + envía bienvenida
//
// A diferencia de setup.js (one-time), este endpoint se puede llamar infinitas veces,
// una por cada nueva empresa que quiera registrarse.
// Protección: rate limit + validación CUIT + RPC SECURITY DEFINER en Supabase.
//
// MF Web Solutions | distrib SaaS

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit }    from '../rate-limit.js';
import { enviarEmail }  from '../email.js';
import { chequearPasswordONull } from '../auth/leaked-password-check.js';

const supabaseAdmin = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }]);

// Rate limit conservador: 5 registros por IP por hora (evitar spam)
const limiter = rateLimit({ max: 5, windowMs: 60 * 60_000 });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Validación CUIT módulo 11 (server-side) ──────────────────────────────
export function validarCUIT(cuit) {
  const c = String(cuit).replace(/[-\s]/g, '');
  if (!/^\d{11}$/.test(c)) return false;
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = mult.reduce((acc, m, i) => acc + m * parseInt(c[i]), 0);
  const resto = suma % 11;
  const vrf = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return vrf === parseInt(c[10]);
}

// ── Email de bienvenida ───────────────────────────────────────────────────
export async function enviarBienvenida({ adminEmail, adminNombre, empresaNombre, trialFin }) {
  // Días de trial calculados en base a trialFin real (viene de saas_config.dias_trial
  // vía el RPC registrar_empresa_saas) — antes esto decía "30 días" hardcodeado,
  // desalineado del valor real configurado en producción (10 días). Ahora se deriva
  // siempre del dato real, así queda correcto aunque el superadmin cambie dias_trial
  // desde /admin/saas-billing.
  const diasTrial = trialFin
    ? Math.max(1, Math.round((new Date(trialFin) - new Date()) / 86_400_000))
    : null;

  const fechaTrial = trialFin
    ? new Date(trialFin).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })
    : new Date(Date.now() + 10 * 86_400_000).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

  const textoDias = diasTrial ? `${diasTrial} días` : 'unos días';

  const appUrl = process.env.APP_URL || 'https://distrib.vercel.app';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1EFE8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D3D1C7;">
    <div style="background:#185FA5;padding:28px 32px;">
      <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">distrib</h1>
      <p style="margin:6px 0 0;color:#c7dcf5;font-size:14px;">Sistema de gestión para distribuidoras</p>
    </div>
    <div style="padding:28px 32px;">
      <h2 style="margin:0 0 12px;font-size:20px;color:#2C2C2A;">¡Bienvenido/a, ${adminNombre.split(' ')[0]}!</h2>
      <p style="margin:0 0 20px;color:#5F5E5A;font-size:15px;line-height:1.6;">
        Tu empresa <strong>${empresaNombre}</strong> ya está registrada en distrib.
        Tenés <strong>${textoDias} de prueba gratuita</strong> para explorar todas las funciones.
      </p>

      <div style="background:#E6F1FB;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0;color:#185FA5;font-size:14px;font-weight:600;">
          Tu período de prueba vence el <strong>${fechaTrial}</strong>
        </p>
        <p style="margin:6px 0 0;color:#185FA5;font-size:13px;">
          Sin tarjeta de crédito requerida. Podés cancelar cuando quieras.
        </p>
      </div>

      <p style="margin:0 0 8px;color:#2C2C2A;font-size:14px;font-weight:600;">¿Por dónde empezar?</p>
      <ol style="margin:0 0 24px;padding-left:20px;color:#5F5E5A;font-size:14px;line-height:1.8;">
        <li>Ingresá al panel y completá los datos de tu empresa</li>
        <li>Cargá tus primeros productos</li>
        <li>Agregá tus clientes y empezá a tomar pedidos</li>
      </ol>

      <div style="text-align:center;margin-bottom:24px;">
        <a href="${appUrl}/admin/login"
           style="display:inline-block;padding:14px 32px;background:#185FA5;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
          Ingresar al panel →
        </a>
      </div>

      <p style="margin:0;color:#9B9A96;font-size:12px;line-height:1.6;text-align:center;">
        Si tenés dudas, respondé este email o escribinos por WhatsApp.<br>
        Este mensaje fue enviado a ${adminEmail}.
      </p>
    </div>
  </div>
</body>
</html>`;

  return enviarEmail({
    to:      adminEmail,
    subject: `¡Bienvenido a distrib, ${adminNombre.split(' ')[0]}! Tu trial de ${textoDias} ya comenzó`,
    html,
  });
}

// ── Handler principal ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  // Rate limit
  if (await limiter(req, res)) return;

  const {
    empresa_nombre,
    empresa_cuit,
    empresa_telefono,
    empresa_email,
    admin_nombre,
    admin_email,
    admin_password,
  } = req.body ?? {};

  // ── Validaciones básicas ────────────────────────────────────────────────
  if (!empresa_nombre?.trim())
    return res.status(400).json({ ok: false, error: 'El nombre de la empresa es requerido.' });

  if (!empresa_cuit?.trim())
    return res.status(400).json({ ok: false, error: 'El CUIT es requerido.' });

  if (!validarCUIT(empresa_cuit))
    return res.status(400).json({ ok: false, error: 'CUIT inválido. Verificá los dígitos.' });

  if (!admin_nombre?.trim())
    return res.status(400).json({ ok: false, error: 'Tu nombre es requerido.' });

  if (!admin_email?.trim() || !admin_email.includes('@'))
    return res.status(400).json({ ok: false, error: 'Email inválido.' });

  if (!admin_password || admin_password.length < 8)
    return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });

  // Reemplazo de "Prevent use of leaked passwords" de Supabase (solo Pro+,
  // ver AUDITORIA_PRE_LANZAMIENTO.md sección 3) — chequeo contra HaveIBeenPwned.
  const errorPwFiltrada = await chequearPasswordONull(admin_password);
  if (errorPwFiltrada) return res.status(400).json({ ok: false, ...errorPwFiltrada });

  // ── Crear usuario en Supabase Auth ──────────────────────────────────────
  const emailNorm = admin_email.trim().toLowerCase();

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email:         emailNorm,
    password:      admin_password,
    email_confirm: true,   // confirmado automáticamente — no requieren clic en email
  });

  if (authError) {
    const msg = authError.message ?? '';
    if (msg.toLowerCase().includes('already registered') || msg.includes('already exists')) {
      return res.status(409).json({ ok: false, error: 'El email ya tiene una cuenta registrada.' });
    }
    console.error('[REGISTRO] Error auth.admin.createUser:', msg);
    return res.status(500).json({ ok: false, error: 'Error al crear el usuario: ' + msg });
  }

  const usuarioId = authData.user.id;

  // ── Llamar al RPC multi-tenant ──────────────────────────────────────────
  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('registrar_empresa_saas', {
    p_empresa_nombre:    empresa_nombre.trim(),
    p_empresa_cuit:      empresa_cuit.replace(/\s/g, ''),
    p_empresa_domicilio: null,
    p_empresa_telefono:  empresa_telefono?.trim() || null,
    p_empresa_email:     empresa_email?.trim() || null,
    p_usuario_id:        usuarioId,
    p_usuario_nombre:    admin_nombre.trim(),
    p_usuario_email:     emailNorm,
  });

  if (rpcError || !rpcData?.ok) {
    // Rollback: borrar el auth.user para no dejar huérfano
    await supabaseAdmin.auth.admin.deleteUser(usuarioId).catch(() => {});
    const errMsg = rpcData?.error || rpcError?.message || 'Error al crear la empresa.';
    console.error('[REGISTRO] Error RPC registrar_empresa_saas:', errMsg);
    return res.status(500).json({ ok: false, error: errMsg });
  }

  // ── Enviar email de bienvenida (no bloqueante) ──────────────────────────
  enviarBienvenida({
    adminEmail:   emailNorm,
    adminNombre:  admin_nombre.trim(),
    empresaNombre: empresa_nombre.trim(),
    trialFin:     rpcData.trial_fin,
  }).catch(e => console.warn('[REGISTRO] Email bienvenida falló (no crítico):', e?.message));

  // ── Respuesta exitosa ───────────────────────────────────────────────────
  return res.status(200).json({
    ok:         true,
    empresa_id: rpcData.empresa_id,
    trial_fin:  rpcData.trial_fin,
    mensaje:    rpcData.mensaje,
  });
}
