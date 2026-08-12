// frontend/proveedor/pwa-init.js
// Registra el Service Worker offline del portal proveedor.
// A diferencia de cliente/chofer, no ofrece botón "Instalar app": el
// acceso es por link con token (sin sesión propia), ver nota en
// sw-proveedor.js.
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/proveedor/sw-proveedor.js', { scope: '/proveedor' })
        .catch((err) => console.warn('[Proveedor] No se pudo registrar el SW:', err));
    });
  }
})();
