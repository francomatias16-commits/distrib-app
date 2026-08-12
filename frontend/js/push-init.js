// frontend/js/push-init.js
// Inicialización de Notificaciones Push (Firebase Cloud Messaging)
//
// Flujo:
//   1. Lee la config de Firebase desde window.ENV (inyectada por env-config.js).
//   2. Registra el Service Worker (sw-push.js) y le envía la config via postMessage.
//   3. Solicita permiso de notificaciones al usuario.
//   4. Obtiene el token FCM y lo registra en el servidor.

import { initializeApp }    from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging.js';

// ── Leer config desde window.ENV ─────────────────────────────────────────
function getFirebaseConfig() {
  return {
    apiKey:            window.ENV?.FIREBASE_API_KEY,
    projectId:         window.ENV?.FIREBASE_PROJECT_ID,
    messagingSenderId: window.ENV?.FIREBASE_MESSAGING_SENDER_ID,
    appId:             window.ENV?.FIREBASE_APP_ID,
  };
}

function isConfigValida(config) {
  return config.apiKey && config.projectId &&
         config.projectId !== 'tu-proyecto-firebase' &&
         config.messagingSenderId && config.appId;
}

let messaging = null;

// ── Inicializar Push Notifications ────────────────────────────────────────
export async function initPushNotifications() {
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) {
      console.warn('[Push] Notificaciones push no soportadas en este navegador.');
      return false;
    }

    const config = getFirebaseConfig();
    if (!isConfigValida(config)) {
      console.warn('[Push] Variables de Firebase no configuradas en env-config.js. Notificaciones deshabilitadas.');
      return false;
    }

    // 1. Registrar Service Worker
    let swRegistration;
    try {
      swRegistration = await navigator.serviceWorker.register('/sw-push.js');
      console.log('[Push] Service Worker registrado.');
    } catch (error) {
      console.error('[Push] Error al registrar Service Worker:', error);
      return false;
    }

    // 2. Enviar configuración de Firebase al Service Worker via postMessage
    //    (el SW no tiene acceso a window.ENV, por lo que se la pasamos aquí)
    const swTarget = swRegistration.installing || swRegistration.waiting || swRegistration.active;
    if (swTarget) {
      swTarget.postMessage({ type: 'FIREBASE_CONFIG', config });
    }
    // También enviarlo al SW activo por si ya estaba corriendo
    if (swRegistration.active) {
      swRegistration.active.postMessage({ type: 'FIREBASE_CONFIG', config });
    }

    // 3. Inicializar Firebase en el contexto del cliente (foreground)
    const app = initializeApp(config);
    messaging = getMessaging(app);

    // 4. Solicitar permiso
    if (Notification.permission === 'granted') {
      await registrarDispositivo(swRegistration);
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        await registrarDispositivo(swRegistration);
      }
    }

    // 5. Escuchar mensajes en foreground
    if (messaging) {
      onMessage(messaging, (payload) => {
        console.log('[Push] Notificación en foreground:', payload);
        const opts = {
          body:   payload.notification?.body  || '',
          icon:   '/icon-192x192.png',
          badge:  '/badge-72x72.png',
          data:   payload.data || {}
        };
        // Delegar al SW para mostrar la notificación de forma consistente
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type:    'SHOW_NOTIFICATION',
            title:   payload.notification?.title || 'Notificación',
            options: opts
          });
        }
      });
    }

    return true;

  } catch (error) {
    console.error('[Push] Error al inicializar push notifications:', error);
    return false;
  }
}

// ── Registrar Dispositivo en el Servidor ──────────────────────────────────
async function registrarDispositivo(swRegistration) {
  try {
    if (!messaging) return;

    const vapidKey = window.ENV?.FIREBASE_VAPID_KEY;
    if (!vapidKey) {
      console.warn('[Push] FIREBASE_VAPID_KEY no configurada. No se puede obtener token FCM.');
      return;
    }

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: swRegistration
    });

    if (!token) {
      console.warn('[Push] No se pudo obtener token FCM.');
      return;
    }

    const { data: { session } } = await window.authCtx?.sb?.auth?.getSession?.() || {};
    if (!session) return;

    const { data: userData } = await window.authCtx?.sb
      ?.from('usuarios')
      ?.select('id, empresa_id')
      ?.eq('id', session.user.id)
      ?.single?.() || {};

    if (!userData) return;

    const response = await fetch('/api/notif/push', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        usuario_id:       userData.id,
        empresa_id:       userData.empresa_id,
        token_push:       token,
        tipo_dispositivo: 'web'
      })
    });

    if (response.ok) {
      console.log('[Push] Dispositivo registrado para notificaciones push.');
      localStorage.setItem('push_token', token);
    } else {
      console.error('[Push] Error al registrar dispositivo:', await response.text());
    }

  } catch (error) {
    console.error('[Push] Error al registrar dispositivo:', error);
  }
}

// ── Desregistrar Dispositivo ──────────────────────────────────────────────
export async function desregistrarDispositivo() {
  try {
    const token = localStorage.getItem('push_token');
    if (!token) return;

    const { data: { session } } = await window.authCtx?.sb?.auth?.getSession?.() || {};
    if (!session) return;

    const { data: userData } = await window.authCtx?.sb
      ?.from('usuarios')
      ?.select('id')
      ?.eq('id', session.user.id)
      ?.single?.() || {};

    if (!userData) return;

    await fetch('/api/notif/push', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ usuario_id: userData.id, token_push: token })
    });

    localStorage.removeItem('push_token');
    console.log('[Push] Dispositivo desregistrado.');

  } catch (error) {
    console.error('[Push] Error al desregistrar dispositivo:', error);
  }
}

// ── Solicitar Permiso Manualmente ─────────────────────────────────────────
export async function solicitarPermisoNotificaciones() {
  if (!('Notification' in window)) {
    window.toast('Tu navegador no soporta notificaciones.', 'warning');
    return false;
  }
  // FIX (auditoría 2026, etapa 15, Hallazgo 1 — causa 2): si en esta página
  // todavía no se corrió initPushNotifications() (Service Worker sin
  // registrar, Firebase sin inicializar), `messaging` queda null y
  // registrarDispositivo() no hacía nada de forma silenciosa aunque el
  // usuario concediera el permiso — el permiso quedaba "granted" pero
  // nunca se llegaba a registrar ningún token. Ahora, si no está
  // inicializado, se corre el flujo completo primero.
  if (!messaging) {
    return await initPushNotifications();
  }
  if (Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker.getRegistration('/sw-push.js');
    await registrarDispositivo(reg);
    return true;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    const reg = await navigator.serviceWorker.getRegistration('/sw-push.js');
    await registrarDispositivo(reg);
    return true;
  }
  return false;
}

// Exponer en window para llamadas desde HTML inline
window.initPushNotifications          = initPushNotifications;
window.desregistrarDispositivo        = desregistrarDispositivo;
window.solicitarPermisoNotificaciones = solicitarPermisoNotificaciones;
