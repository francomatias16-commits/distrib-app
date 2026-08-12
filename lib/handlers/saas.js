// lib/handlers/saas.js
// Handler para /api/saas — Panel superadmin de suscripciones SaaS
//
// Rutas:
//   GET  /api/saas/kpis           → KPIs del dashboard (MRR, activas, trials, morosos)
//   GET  /api/saas/empresas        → Lista todas las empresas con estado SaaS
//   GET  /api/saas/config          → Lee la configuración global (CBU, precio, etc.)
//   POST /api/saas/config          → Actualiza la configuración global
//   POST /api/saas/confirmar-pago  → Marca factura como pagada y reactiva empresa
//   POST /api/saas/reactivar       → Reactiva empresa suspendida (gracia manual)
//   POST /api/saas/cancelar        → Cancela empresa permanentemente
//   POST /api/saas/precio          → Cambia precio individual de una empresa
//   POST /api/saas/suspender       → Suspende empresa manualmente
//   GET  /api/saas/migraciones     → Panel de migraciones de todos los tenants (punto 12 del plan)
//   GET  /api/saas/eventos-negocio → Auditoría de negocio cross-empresa (Fase 5 plan ERP):
//                                     lista eventos_negocio de TODOS los tenants, con filtros
//                                     opcionales por empresa_id/tipo_evento/estado y paginación.
//   POST /api/saas/demo-reset      → Resetea la empresa demo pública a su snapshot base
//                                     (fn_reset_demo_v2). Si no existe snapshot todavía,
//                                     lo crea automáticamente antes de resetear.
//   POST /api/saas/demo-snapshot   → Fuerza (re)generar el snapshot base de la demo
//                                     (fn_snapshot_demo_v2), sin resetear nada.
//
// Requiere: usuario con rol 'superadmin', o rol 'dueno' de la empresa raíz
// ('MF Web Solutions', o SUPERADMIN_EMPRESA_ID si está configurado).
// Ningún otro 'dueno' (incluida la cuenta demo pública) tiene acceso.
// MF Web Solutions | distrib SaaS

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { rateLimit }    from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { obtenerPerfilConEmpresa } from '../repos/usuarios.js';
import {
  obtenerSaasConfig,
  saasDashboardKpisRpc,
  saasPanelListarRpc,
  saasConfigActualizarRpc,
  saasConfirmarPagoRpc,
  saasEmpresaReactivarRpc,
  saasSuspenderEmpresaRpc,
  saasEmpresaCancelarRpc,
  saasEmpresaCambiarPrecioRpc,
  fnResetDemoV2Rpc,
  fnSnapshotDemoV2Rpc,
  migracionSuperadminResumenRpc,
  listarEventosNegocio,
} from '../repos/saas.js';

// Se mantiene el cliente propio solo para Auth (getUser) — no es acceso a tabla.
const supabaseAdmin = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }]);

const limiter = rateLimit({ max: 100, windowMs: 60_000 });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.APP_URL ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Verificar que hay CUALQUIER usuario autenticado (no necesariamente
//    superadmin) — usado solo para el subconjunto de /api/saas/config que
//    necesita ver un dueño/admin común cuando su empresa está suspendida
//    (ver GET /api/saas/config más abajo). ─────────────────────────────────
async function getUsuarioAutenticado(req) {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (!token) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── Verificar que el usuario es superadmin ────────────────────────────────
async function getSuperAdmin(req) {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (!token) return null;

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;

  const perfil = await obtenerPerfilConEmpresa(user.id);

  if (!perfil) return null;

  // FIX SEGURIDAD (v220): antes esto aceptaba a CUALQUIER usuario con rol
  // 'dueno', sin importar de qué empresa — incluida la cuenta demo pública.
  // Como este handler usa el cliente service_role (bypassea RLS por
  // completo), cualquier "dueno" podía ver MRR real, suspender/cancelar
  // clientes reales y cambiarles el precio con solo llamar la API directo.
  //
  // El frontend (superadmin.html) ya tenía el guard correcto —
  // perfil.empresas.nombre === 'MF Web Solutions' — pero era puramente
  // decorativo porque no protegía la API. Acá replicamos la MISMA regla
  // server-side, que es la que realmente importa.
  //
  // Recomendado a futuro: reemplazar el match por nombre (frágil si se
  // renombra la empresa) por SUPERADMIN_EMPRESA_ID (uuid) en las env vars,
  // ver chequeo de respaldo más abajo.
  const NOMBRE_EMPRESA_RAIZ = 'MF Web Solutions';
  const empresaRaizIdEnv = process.env.SUPERADMIN_EMPRESA_ID;

  const esSuperadmin = perfil.rol === 'superadmin';
  const esDuenoDeEmpresaRaiz = perfil.rol === 'dueno' && (
    perfil.empresas?.nombre === NOMBRE_EMPRESA_RAIZ
    || (!!empresaRaizIdEnv && perfil.empresa_id === empresaRaizIdEnv)
  );

  if (!esSuperadmin && !esDuenoDeEmpresaRaiz) return null;

  return { user, perfil };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (await limiter(req, res)) return;

  const _svc = req.query._svc;

  // FIX (auditoría UX etapa 14, Hallazgo 1 — efecto colateral encontrado al
  // corregirlo): GET /api/saas/config exigía superadmin para TODO, incluido
  // este caso. Aunque se arregle handleMe() en /api/auth/me,
  // suspendida.html hace un segundo fetch a este endpoint para mostrar el
  // CBU/alias/titular/banco, y un dueño/admin común (no superadmin) de una
  // empresa suspendida nunca iba a poder verlos -- se quedaba sin ninguna
  // forma de saber cómo pagar. Se responde acá, ANTES del gate de
  // superadmin, con el subconjunto de campos pensados para mostrarse a
  // cualquier cliente (se excluye email_admin, que es contacto interno).
  if (req.method === 'GET' && _svc === 'config') {
    const usuario = await getUsuarioAutenticado(req);
    if (!usuario) return res.status(401).json({ error: 'No autorizado.' });

    const esSuperadmin = await getSuperAdmin(req);
    const { data, error } = await obtenerSaasConfig(
      esSuperadmin ? '*' : 'cbu, alias, titular, banco, precio_mensual, dias_trial',
    );
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(data);
  }

  // ── Autenticación (superadmin) para el resto de las rutas ────────────────
  const admin = await getSuperAdmin(req);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado. Se requiere rol superadmin.' });
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/saas/kpis
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'kpis') {
    const { data, error } = await saasDashboardKpisRpc();
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(data);
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/saas/empresas
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'empresas') {
    const { data, error } = await saasPanelListarRpc();
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(Array.isArray(data) ? data : []);
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/config
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'config') {
    const { cbu, alias, titular, banco, precio, dias_trial, email_admin } = req.body ?? {};
    const { data, error } = await saasConfigActualizarRpc({
      p_cbu:         cbu         ?? null,
      p_alias:       alias       ?? null,
      p_titular:     titular     ?? null,
      p_banco:       banco       ?? null,
      p_precio:      precio      ?? null,
      p_dias_trial:  dias_trial  ?? null,
      p_email_admin: email_admin ?? null,
    });
    if (error || !data?.ok) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ ok: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/confirmar-pago
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'confirmar-pago') {
    const { factura_id } = req.body ?? {};
    if (!factura_id) return res.status(400).json({ error: 'factura_id requerido' });

    const { data, error } = await saasConfirmarPagoRpc({
      factura_id,
      admin_user_id: admin.perfil.id,
    });
    if (error || !data?.ok) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(data);
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/reactivar
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'reactivar') {
    const { empresa_id, dias_extra } = req.body ?? {};
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });

    const { data, error } = await saasEmpresaReactivarRpc({
      empresa_id,
      dias_extra: dias_extra ?? 30,
    });
    if (error || !data?.ok) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(data);
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/suspender
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'suspender') {
    const { empresa_id } = req.body ?? {};
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });

    const { error } = await saasSuspenderEmpresaRpc(empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ ok: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/cancelar
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'cancelar') {
    const { empresa_id } = req.body ?? {};
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });

    const { data, error } = await saasEmpresaCancelarRpc(empresa_id);
    if (error || !data?.ok) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(data);
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/precio
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'precio') {
    const { empresa_id, precio } = req.body ?? {};
    if (!empresa_id || precio == null) return res.status(400).json({ error: 'empresa_id y precio requeridos' });

    const { data, error } = await saasEmpresaCambiarPrecioRpc({
      empresa_id,
      precio: Number(precio),
    });
    if (error || !data?.ok) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(data);
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/demo-reset
  // Resetea la empresa demo pública a su snapshot base (fn_reset_demo_v2).
  // Si todavía no existe snapshot para esa empresa (primer uso, o snapshot
  // borrado a mano), lo genera en el momento (fn_snapshot_demo_v2) y recién
  // ahí resetea — no debería pasar en operación normal (la demo se
  // snapshotea una sola vez al crearla), pero así el botón nunca falla por
  // este motivo. Ambas RPCs son SECURITY DEFINER y solo callables por
  // service_role (ver migración 210) — este handler ya corre con ese
  // cliente, así que no hace falta nada extra ahí.
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'demo-reset') {
    const { empresa_id } = req.body ?? {};

    let { error: resetError } = await fnResetDemoV2Rpc(empresa_id);

    if (resetError && /No existe snapshot/i.test(resetError.message ?? '')) {
      const { error: snapError } = await fnSnapshotDemoV2Rpc(empresa_id);
      if (snapError) {
        return errorSeguro(res, snapError, 500, 'No se pudo crear el snapshot inicial.');
      }

      ({ error: resetError } = await fnResetDemoV2Rpc(empresa_id));
    }

    if (resetError) return errorSeguro(res, resetError, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ ok: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/saas/demo-snapshot
  // Fuerza (re)generar el snapshot base de la demo, sin resetear nada.
  // Útil después de recargar/editar a mano los datos de la demo y querer
  // que ese sea el nuevo estado "base" al que vuelve el botón de reset.
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && _svc === 'demo-snapshot') {
    const { empresa_id } = req.body ?? {};

    const { data, error } = await fnSnapshotDemoV2Rpc(empresa_id);
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ ok: true, empresa_id: data });
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/saas/migraciones — punto 12 del plan: panel de superadmin para
  // monitorear migraciones de todos los tenants (sesiones en curso/falladas
  // o de los últimos 14 días). La RPC ya valida is_saas_owner() por su cuenta
  // (migración 175) — este chequeo de rol acá es defensa en profundidad, no
  // el único gate.
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'migraciones') {
    const { data, error } = await migracionSuperadminResumenRpc();
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json(Array.isArray(data) ? data : []);
  }

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/saas/eventos-negocio — Fase 5 del plan ERP: auditoría de
  // negocio centralizada. Vista cross-empresa (todos los tenants) de
  // eventos_negocio para el superadmin — el equivalente de "Qué pasó en mi
  // negocio" (frontend/admin/auditoria.html) pero sin el filtro de RLS por
  // empresa_id, que ahora restringe esa tabla a dueño/admin de CADA empresa
  // (ver migración fase5_eventos_negocio_rls_dueno_admin). Este handler usa
  // el repo con service_role (bypassea RLS) — el único gate es el chequeo
  // de superadmin de más arriba.
  //
  // Filtros opcionales via query string: empresaId, tipoEvento, estado.
  // Paginación: limite (default 50, máx 200) + offset (default 0).
  // ────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && _svc === 'eventos-negocio') {
    const { empresaId, tipoEvento, estado } = req.query;
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { data, error, count } = await listarEventosNegocio({ empresaId, tipoEvento, estado, offset, limite });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(200).json({ data: data || [], total: count || 0, limite, offset });
  }

  return res.status(404).json({ error: 'Ruta SaaS no encontrada.' });
}
