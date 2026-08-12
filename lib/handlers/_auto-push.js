/**
 * _auto-push.js — Helper de notificaciones push para los motores de automatización v53
 * Bug fix: dispositivos_push no tiene columna "rol" — se hace join con usuarios.
 *
 * Migrado a capa de repos (lib/repos/notif.js): antes recibía `sb` como
 * primer parámetro y cada uno de los ~13 callers le pasaba su propia
 * instancia de cliente Supabase (`sb`, `db`, `supabase` — todas apuntando
 * al mismo backend igual). Ahora usa el singleton `db` internamente vía
 * NotifRepo, como el resto de los repos — se actualizaron los call sites
 * para dejar de pasar el cliente.
 */
import webpush from 'web-push';
import { rateLimitPorClave } from '../rate-limit.js';
import { NotifRepo } from '../repos/index.js';

// Solo configurar si tenemos las keys VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_MAILTO || 'admin@distrib.app'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

// notifAuto no es un endpoint HTTP (lo llaman ~10 handlers distintos, cada
// uno ya con su propio rateLimit de request), así que un límite por IP no
// lo protege. Esto es un tope aparte: cuántas VECES por minuto una misma
// empresa puede disparar un batch de push de automatización, para que un
// bug en un loop (o una automatización mal configurada que reintenta) no
// spamee a los admins ni queme la cuota de VAPID/webpush. 20/min = 1 cada 3s,
// muy por encima de cualquier uso normal (los triggers reales son eventos
// puntuales: stock bajo, sesión de migración con error, etc.).
const limiteEnviosAuto = rateLimitPorClave({ max: 20, windowMs: 60_000 });

// FIX (auditoría alertas críticas 2026-07-12): notifAuto no insertaba NUNCA
// en notif_log, ni siquiera cuando el envío tenía éxito — a diferencia de
// enviarPush() (_push.js), este canal no dejaba ningún rastro auditable.
// Afecta a cierre_cliente_bloqueado, migracion_sesion_error, piloto,
// score_recalculado, stock_quiebre, stock_sin_proveedor, y demás tipos que
// pasan por acá. Se agrega logueo siempre, con entregada/motivo.
async function _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada, motivo, dispositivos_alcanzados }) {
  await NotifRepo.registrarLog({
    empresa_id, tipo, canal: 'push', entregada, motivo: motivo || null,
    payload: { titulo, cuerpo, dispositivos_alcanzados },
  });
}

/**
 * Envía push a todos los admins/dueños de la empresa con push activo
 * y la preferencia del tipo habilitada.
 */
export async function notifAuto(empresa_id, { tipo, titulo, cuerpo, link = '/admin/automatizacion' }) {
  try {
    if (!process.env.VAPID_PUBLIC_KEY) {
      await _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada: false, motivo: 'vapid_no_configurado' });
      return { enviadas: 0, razon: 'vapid_no_configurado' };
    }

    if (await limiteEnviosAuto(`notifAuto:${empresa_id}`)) {
      console.warn(`[notifAuto] rate limit interno superado para empresa ${empresa_id} (tipo=${tipo})`);
      await _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada: false, motivo: 'rate_limit_interno' });
      return { enviadas: 0, razon: 'rate_limit_interno' };
    }

    // 1. Verificar si la empresa tiene este tipo habilitado
    const pref = await NotifRepo.obtenerPrefsAuto(empresa_id, tipo);
    if (pref && pref[tipo] === false) {
      await _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada: false, motivo: 'tipo_deshabilitado' });
      return { enviadas: 0, razon: 'tipo_deshabilitado' };
    }

    // 2. Obtener usuarios admin/dueño de la empresa
    const usuarios = await NotifRepo.listarAdminsDueno(empresa_id, { campos: 'id' });

    if (!usuarios?.length) {
      await _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada: false, motivo: 'sin_usuarios_admin' });
      return { enviadas: 0, razon: 'sin_usuarios_admin' };
    }
    const userIds = usuarios.map(u => u.id);

    // 3. Obtener tokens push activos de esos usuarios
    const tokens = await NotifRepo.listarTokensPushDeUsuarios(userIds);

    if (!tokens?.length) {
      await _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada: false, motivo: 'sin_tokens_push' });
      return { enviadas: 0, razon: 'sin_tokens_push' };
    }

    // 4. Enviar notificaciones
    const payload = JSON.stringify({ titulo, cuerpo, link, tipo });
    let enviadas = 0;
    const promesas = tokens.map(async token => {
      try {
        await webpush.sendNotification(
          { endpoint: token.endpoint, keys: { p256dh: token.p256dh, auth: token.auth } },
          payload,
          { TTL: 86400 }
        );
        enviadas++;
      } catch (err) {
        // Si el token expiró, marcarlo como inactivo
        if (err.statusCode === 410 || err.statusCode === 404) {
          await NotifRepo.desactivarDispositivoPushPorEndpoint(token.endpoint);
        }
      }
    });
    await Promise.allSettled(promesas);
    await _logAuto({
      empresa_id, tipo, titulo, cuerpo,
      entregada: enviadas > 0,
      motivo: enviadas > 0 ? null : 'todos_los_tokens_fallaron',
      dispositivos_alcanzados: enviadas,
    });
    return { enviadas };
  } catch (err) {
    console.error('[notifAuto]', err.message);
    await _logAuto({ empresa_id, tipo, titulo, cuerpo, entregada: false, motivo: 'error_interno: ' + err.message });
    return { enviadas: 0, error: err.message };
  }
}
