// frontend/sw-push.js
// Service Worker para Notificaciones Push (Firebase Cloud Messaging)
//
// IMPORTANTE: Este Service Worker no tiene acceso al DOM ni a window.ENV.
// La configuración de Firebase se recibe mediante un mensaje postMessage
// desde push-init.js después del registro, y se persiste en IndexedDB
// para que esté disponible en activaciones futuras del SW.

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// ── Estado interno del SW ─────────────────────────────────────────────────
let messagingInstance = null;

// ── Recibir configuración desde el cliente (push-init.js) ─────────────────
// push-init.js envía la config de Firebase via postMessage al registrar el SW.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'FIREBASE_CONFIG') {
    const config = event.data.config;
    if (!config || !config.projectId || config.projectId === 'tu-proyecto-firebase') {
      console.warn('[SW-Push] Configuración de Firebase no válida o no proporcionada. Notificaciones push deshabilitadas.');
      return;
    }
    initFirebase(config);
  }

  // Manejar solicitud de mostrar notificación desde foreground
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(event.data.title, event.data.options);
  }
});

// ── Inicializar Firebase con la config recibida ───────────────────────────
function initFirebase(config) {
  try {
    // Evitar reinicializar si ya hay una instancia
    if (messagingInstance) return;

    const app = firebase.initializeApp(config);
    messagingInstance = firebase.messaging(app);

    // Manejar notificaciones recibidas en background
    messagingInstance.onBackgroundMessage((payload) => {
      console.log('[SW-Push] Notificación en background:', payload);

      const notificationTitle = payload.notification?.title || 'Notificación';
      const notificationOptions = {
        body:             payload.notification?.body || '',
        icon:             '/icon-192x192.png',
        badge:            '/badge-72x72.png',
        tag:              'distrib-app-notification',
        requireInteraction: false,
        data:             payload.data || {}
      };

      self.registration.showNotification(notificationTitle, notificationOptions);
    });

    console.log('[SW-Push] Firebase inicializado correctamente.');
  } catch (err) {
    console.error('[SW-Push] Error al inicializar Firebase:', err);
  }
}

// ── Click en notificación ─────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  console.log('[SW-Push] Notificación clickeada:', event.notification.tag);
  event.notification.close();

  const urlToOpen = event.notification.data?.link || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// ── Activación del SW ─────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW-Push] Service Worker activado.');
  event.waitUntil(self.clients.claim());
});
