// lib/handlers/setup.js
// Handler para /api/setup — Inicialización del sistema
//
// Rutas:
//   GET  /api/setup/status  → verifica si el sistema ya fue inicializado
//   POST /api/setup/init    → crea empresa + primer usuario (dueño)
//   GET  /api/health        → diagnóstico de config (env vars + conexión Supabase)
//
// Este endpoint funciona sin autenticación previa.
// La protección real está en el RPC setup_inicial_empresa que
// verifica internamente que no exista ninguna empresa.
//
// MF Web Solutions | distrib-app

import { rateLimit }    from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import {
  verificarConexionSupabase,
  contarEmpresas,
  crearUsuarioAuth,
  eliminarUsuarioAuth,
  ejecutarSetupInicialEmpresa,
} from '../repos/setup.js';

// Rate limit conservador: máx 10 req/min por IP
const limiter = rateLimit({ max: 10, windowMs: 60_000 });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const _svc = req.query._svc;

  // ── GET /api/health ──────────────────────────────────────────────────────
  // Diagnóstico de configuración en producción. NO expone valores de las env
  // vars, solo si están presentes o no, y si la conexión real a Supabase
  // funciona. Pensado para detectar rápido el patrón "faltan env vars en
  // Vercel Production" (ver CHANGELOG_v336 y v337) sin tener que adivinar
  // desde los 500 genéricos que ve el navegador.
  if (req.method === 'GET' && _svc === 'health') {
    if (await limiter(req, res)) return;

    const envVars = {
      SUPABASE_URL:                 !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY:    !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      JWT_SECRET:                   !!process.env.JWT_SECRET,
      JWT_REFRESH_SECRET:           !!process.env.JWT_REFRESH_SECRET,
      APP_URL:                      !!process.env.APP_URL,
      FIREBASE_SERVICE_ACCOUNT_KEY: !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      CRON_SECRET:                  !!process.env.CRON_SECRET,
    };

    const faltantes = Object.entries(envVars)
      .filter(([, presente]) => !presente)
      .map(([nombre]) => nombre);

    let supabaseCheck = { ok: false, detalle: 'no verificado (faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' };

    if (envVars.SUPABASE_URL && envVars.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const { ok, error } = await verificarConexionSupabase();

        supabaseCheck = ok
          ? { ok: true, detalle: 'Conexión a Supabase OK (consulta de prueba exitosa)' }
          : { ok: false, detalle: `Supabase respondió con error: ${error.message}` };
      } catch (err) {
        supabaseCheck = { ok: false, detalle: `Excepción al conectar: ${err.message}` };
      }
    }

    return res.status(200).json({
      ok: faltantes.length === 0 && supabaseCheck.ok,
      env_vars: envVars,
      env_vars_faltantes: faltantes,
      supabase: supabaseCheck,
      timestamp: new Date().toISOString(),
    });
  }

  // ── GET /api/setup/status ─────────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'status') {
    const count = await contarEmpresas();

    return res.status(200).json({
      inicializado: count > 0,
    });
  }

  // ── POST /api/setup/init ──────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'init') {
    if (await limiter(req, res)) return;

    const {
      empresa_nombre,
      empresa_cuit,
      empresa_domicilio,
      empresa_telefono,
      empresa_email,
      dueno_nombre,
      dueno_email,
      dueno_password,
    } = req.body ?? {};

    // Validaciones previas (antes de tocar Auth)
    if (!empresa_nombre?.trim())
      return res.status(400).json({ error: 'El nombre de la empresa es requerido.' });
    if (!empresa_cuit?.trim())
      return res.status(400).json({ error: 'El CUIT es requerido.' });
    if (!dueno_nombre?.trim())
      return res.status(400).json({ error: 'El nombre del responsable es requerido.' });
    if (!dueno_email?.trim())
      return res.status(400).json({ error: 'El email del responsable es requerido.' });
    if (!dueno_password || dueno_password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });

    // Verificar de nuevo que el sistema esté vacío (doble guarda)
    const count = await contarEmpresas();

    if (count > 0) {
      return res.status(409).json({
        error: 'El sistema ya fue inicializado. Contactá al administrador.',
      });
    }

    // Crear usuario en Supabase Auth con service_role (no envía email de confirmación)
    const { data: authData, error: authError } = await crearUsuarioAuth({
      email: dueno_email.trim().toLowerCase(),
      password: dueno_password,
    });

    if (authError) {
      if (authError.message?.toLowerCase().includes('already registered')) {
        return res.status(409).json({ error: 'El email ya está registrado en el sistema.' });
      }
      return errorSeguro(res, authError, 500, 'Error al crear el usuario.');
    }

    const usuarioId = authData.user.id;

    // Llamar al RPC que crea empresa + usuario en public con SECURITY DEFINER
    const { data: rpcData, error: rpcError } = await ejecutarSetupInicialEmpresa({
      p_empresa_nombre:    empresa_nombre.trim(),
      p_empresa_cuit:      empresa_cuit.trim(),
      p_empresa_domicilio: empresa_domicilio?.trim() || null,
      p_empresa_telefono:  empresa_telefono?.trim() || null,
      p_empresa_email:     empresa_email?.trim() || null,
      p_usuario_id:        usuarioId,
      p_usuario_nombre:    dueno_nombre.trim(),
      p_usuario_email:     dueno_email.trim().toLowerCase(),
    });

    if (rpcError || !rpcData?.ok) {
      // Rollback: borrar el auth.user creado para no dejar huérfano
      await eliminarUsuarioAuth(usuarioId);
      return res.status(500).json({
        error: rpcData?.error || rpcError?.message || 'Error al inicializar el sistema.',
      });
    }

    return res.status(200).json({
      ok: true,
      empresa_id: rpcData.empresa_id,
      mensaje: 'Sistema inicializado. Ya podés iniciar sesión.',
    });
  }

  return res.status(404).json({ error: 'Ruta no encontrada.' });
}
