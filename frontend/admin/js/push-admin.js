// frontend/admin/js/push-admin.js
// Gestión de notificaciones push en el panel admin.
//
// Flujo:
//   1. Cuando el admin está autenticado, intentar registrar el SW push.
//   2. Pedir permiso de notificaciones al usuario (solo si no rechazó antes).
//   3. Obtener el FCM token con la clave VAPID del proyecto Firebase.
//   4. Registrar el token en la BD via POST /api/notif/push.
//   5. Escuchar mensajes del SW para abrir el pedido correcto al hacer clic.
//
// Requiere en window.ENV (env-config.js):
//   FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_MESSAGING_SENDER_ID,
//   FIREBASE_APP_ID, FIREBASE_VAPID_KEY
//
// Si alguna de estas variables no está configurada, el módulo se desactiva
// silenciosamente sin lanzar errores — el panel funciona sin push.




// ── Config ─────────────────────────────────────────────────────────────────
const ENV = window.ENV || {};

const FIREBASE_CONFIG = {
  apiKey:            ENV.FIREBASE_API_KEY,
  projectId:         ENV.FIREBASE_PROJECT_ID,
  messagingSenderId: ENV.FIREBASE_MESSAGING_SENDER_ID,
  appId:             ENV.FIREBASE_APP_ID,
};

const VAPID_KEY  = ENV.FIREBASE_VAPID_KEY;
const SW_PATH    = '/frontend/admin/sw-admin.js';
const PUSH_URL   = '/api/notif/push';

// ── Estado ─────────────────────────────────────────────────────────────────
let messagingInstance = null;
let swRegistration    = null;
let fcmTokenActual    = null;

// ── Inicializar (llamar desde auth.js cuando el usuario está listo) ─────────
async function inicializarPushAdmin(sb, usuarioId, empresaId) {
window.inicializarPushAdmin = inicializarPushAdmin;
  // Verificar pre-condiciones sin lanzar errores fatales
  if (!FIREBASE_CONFIG.apiKey || !VAPID_KEY) {
    console.info('[PUSH-ADMIN] Firebase no configurado en ENV — push desactivado');
    return;
  }

  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    console.info('[PUSH-ADMIN] Navegador sin soporte de push');
    return;
  }

  // No pedir permiso si ya fue denegado
  if (Notification.permission === 'denied') {
    console.info('[PUSH-ADMIN] Permiso de notificaciones denegado por el usuario');
    return;
  }

  try {
    // 1. Registrar el Service Worker del admin
    swRegistration = await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
    await swRegistration.update();

    // 2. Enviar config de Firebase al SW para que pueda inicializarse
    const sw = swRegistration.active || swRegistration.installing || swRegistration.waiting;
    sw?.postMessage({ type: 'FIREBASE_CONFIG', config: FIREBASE_CONFIG });

    // 3. Inicializar Firebase en el contexto de la página
    const app = firebase.initializeApp(FIREBASE_CONFIG, 'admin-push');
    messagingInstance = firebase.messaging.getMessaging(app);

    // 4. Pedir permiso (muestra el diálogo del browser si está en 'default')
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.info('[PUSH-ADMIN] Permiso no concedido:', permission);
      return;
    }

    // 5. Obtener el FCM token
    const token = await firebase.messaging.getToken(messagingInstance, {
      vapidKey:           VAPID_KEY,
      serviceWorkerRegistration: swRegistration,
    });

    if (!token) {
      console.warn('[PUSH-ADMIN] No se pudo obtener FCM token');
      return;
    }

    fcmTokenActual = token;

    // 6. Registrar token en la BD
    const { data: { session } } = await sb.auth.getSession();
    await fetch(PUSH_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({
        usuario_id:       usuarioId,
        empresa_id:       empresaId,
        token_push:       token,
        tipo_dispositivo: 'web',
      }),
    });

    console.log('[PUSH-ADMIN] Token FCM registrado ✓');

    // 7. Manejar mensajes mientras la página está en primer plano
    onMessage(messagingInstance, (payload) => {
      const notif   = payload.notification || {};
      const data    = payload.data || {};
      const pedidoId = data.pedido_id;

      mostrarToastPush({
        titulo:    notif.title || '📦 Nuevo pedido',
        cuerpo:    notif.body  || 'Un cliente realizó un nuevo pedido.',
        pedido_id: pedidoId,
        link:      data.link || '/admin/pedidos',
      });
    });

    // 8. Escuchar clics del SW cuando el tab está en background
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'NOTIF_CLICK' && e.data.pedido_id) {
        // Disparar el evento para que pedidos.js pueda abrir el modal
        window.dispatchEvent(new CustomEvent('push-pedido-click', {
          detail: { pedido_id: e.data.pedido_id },
        }));
      }
    });

  } catch (err) {
    // Push es no crítico — logueamos y seguimos
    console.warn('[PUSH-ADMIN] Error inicializando push:', err.message);
  }
}

// ── Desregistrar token al cerrar sesión ────────────────────────────────────
async function desregistrarPushAdmin(sb, usuarioId) {
window.desregistrarPushAdmin = desregistrarPushAdmin;
  if (!fcmTokenActual || !usuarioId) return;
  try {
    const { data: { session } } = await sb.auth.getSession();
    await fetch(PUSH_URL, {
      method:  'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ usuario_id: usuarioId, token_push: fcmTokenActual }),
    });
    fcmTokenActual = null;
  } catch (err) {
    console.warn('[PUSH-ADMIN] Error desregistrando push:', err.message);
  }
}

// ── Toast de notificación en primer plano ──────────────────────────────────
// Muestra una tira en la esquina superior derecha con el detalle del pedido.
function mostrarToastPush({ titulo, cuerpo, pedido_id, link }) {
  // Reutilizar el sistema de toast si existe, o crear uno dedicado
  const existente = document.getElementById('toast-push-admin');
  const el = existente || crearToastPushEl();

  el.innerHTML = `
    <div class="tpa-header">
      <span class="tpa-icono">📦</span>
      <strong class="tpa-titulo">${escHtml(titulo)}</strong>
      <button class="tpa-cerrar" onclick="this.closest('#toast-push-admin').classList.remove('visible')">✕</button>
    </div>
    <div class="tpa-body">${escHtml(cuerpo)}</div>
    ${pedido_id
      ? `<button class="tpa-btn" onclick="abrirPedidoDesdePush('${pedido_id}')">Ver pedido →</button>`
      : `<a class="tpa-btn" href="${escHtml(link)}">Ver pedidos →</a>`
    }`;

  el.classList.add('visible');
  clearTimeout(el._autoHide);
  el._autoHide = setTimeout(() => el.classList.remove('visible'), 8000);
}

function crearToastPushEl() {
  // Inyectar estilos si aún no están
  if (!document.getElementById('tpa-style')) {
    const style = document.createElement('style');
    style.id = 'tpa-style';
    style.textContent = `
      #toast-push-admin {
        position: fixed; top: 16px; right: 16px; z-index: 99999;
        background: var(--color-surface,#FCFAF5); border: 1px solid var(--color-border-soft,#DAD3C0);
        border-left: 4px solid var(--color-primary, #B87A00);
        border-radius: 8px; padding: 14px 16px;
        box-shadow: 0 4px 24px rgba(0,0,0,.12);
        max-width: 320px; min-width: 260px;
        transform: translateX(110%); transition: transform .3s ease;
        font-family: inherit;
      }
      #toast-push-admin.visible { transform: translateX(0); }
      .tpa-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
      .tpa-icono  { font-size: 16px; }
      .tpa-titulo { font-size: 13px; font-weight: 600; flex: 1; }
      .tpa-cerrar { border: none; background: none; cursor: pointer;
                    color: var(--color-text-light,#6B695F); font-size: 14px; padding: 0; }
      .tpa-body   { font-size: 12px; color: var(--color-text-muted,#4B4A45); margin-bottom: 10px; }
      .tpa-btn    {
        display: inline-block; padding: 5px 12px; border-radius: 6px;
        background: var(--color-primary-bg, rgba(232,160,0,.14));
        color: var(--color-primary, #B87A00);
        font-size: 12px; font-weight: 600;
        border: none; cursor: pointer; text-decoration: none;
      }
      .tpa-btn:hover { opacity: .85; }
    `;
    document.head.appendChild(style);
  }

  const el = document.createElement('div');
  el.id = 'toast-push-admin';
  document.body.appendChild(el);
  return el;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Abrir modal del pedido desde push ─────────────────────────────────────
// Llamado desde el onclick del botón en el toast
window.abrirPedidoDesdePush = function(pedidoId) {
  document.getElementById('toast-push-admin')?.classList.remove('visible');
  // Si pedidos.js está cargado, intentar abrir el modal directamente
  if (typeof window.abrirModalPorId === 'function') {
    window.abrirModalPorId(pedidoId);
  } else {
    window.location.href = `/admin/pedidos?id=${pedidoId}`;
  }
};

// Named export para compatibilidad con import { inicializarPushAdmin } en pedidos.html
export { inicializarPushAdmin };
