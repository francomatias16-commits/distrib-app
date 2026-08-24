// frontend/cliente/pwa-init.js
// Registra el Service Worker offline del portal cliente y expone un botón
// "Instalar app" cuando el navegador dispara beforeinstallprompt.
// Mismo patrón que frontend/chofer/pwa-init.js.
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/cliente/sw-cliente.js', { scope: '/cliente/' })
        .catch((err) => console.warn('[Cliente] No se pudo registrar el SW:', err));
    });
  }

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    mostrarBotonInstalar();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    ocultarBotonInstalar();
  });

  function mostrarBotonInstalar() {
    if (document.getElementById('btn-instalar-cliente')) return;

    const btn = document.createElement('button');
    btn.id = 'btn-instalar-cliente';
    btn.type = 'button';
    btn.textContent = 'Instalar app';
    btn.setAttribute('aria-label', 'Instalar app de cliente en este dispositivo');
    btn.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:10px 18px', 'border:none', 'border-radius:999px',
      'background:#2563EB', 'color:#fff', 'font-family:inherit', 'font-size:0.9rem',
      'font-weight:600', 'box-shadow:0 4px 12px rgba(22,24,29,0.25)', 'cursor:pointer',
    ].join(';');

    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      btn.disabled = true;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      ocultarBotonInstalar();
    });

    document.body.appendChild(btn);
  }

  function ocultarBotonInstalar() {
    const btn = document.getElementById('btn-instalar-cliente');
    if (btn) btn.remove();
  }
})();
