// frontend/cliente/pwa-init.js
// Registra el Service Worker offline del portal cliente y expone un botón
// "Instalar app" cuando el navegador dispara beforeinstallprompt.
// iOS/Safari nunca dispara ese evento, así que además se detecta iOS y se
// muestra el mismo botón pero con un modal de instrucciones (con estilos
// propios e íconos reales) en vez de esperar un prompt que no va a llegar.
// Mismo patrón que frontend/admin/js/auth.js y frontend/chofer/pwa-init.js.
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/cliente/sw-cliente.js', { scope: '/cliente/' })
        .catch((err) => console.warn('[Cliente] No se pudo registrar el SW:', err));
    });
  }

  let deferredPrompt = null;

  function esIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    mostrarBotonInstalar();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    ocultarBotonInstalar();
  });

  // iOS no dispara beforeinstallprompt nunca: si detectamos iOS y la app no
  // está ya instalada (display-mode standalone), mostramos el botón directo
  // con instrucciones, sin esperar un evento que no va a llegar.
  if (esIOS() && !window.matchMedia('(display-mode: standalone)').matches) {
    mostrarBotonInstalar(true);
  }

  function mostrarBotonInstalar(esIOSManual) {
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

    if (esIOSManual) {
      btn.addEventListener('click', () => {
        mostrarInstruccionesIOS();
      });
    } else {
      btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        btn.disabled = true;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        ocultarBotonInstalar();
      });
    }

    document.body.appendChild(btn);
  }

  function ocultarBotonInstalar() {
    const btn = document.getElementById('btn-instalar-cliente');
    if (btn) btn.remove();
  }

  // El modal muestra los mismos íconos que la persona ve en su pantalla de
  // Safari, un paso a la vez, con estilos propios inyectados (no depende del
  // estilo heredado de la página que lo llama).
  function inyectarEstilosInstruccionesIOS() {
    if (document.getElementById('estilos-instalar-ios')) return;
    const style = document.createElement('style');
    style.id = 'estilos-instalar-ios';
    style.textContent = `
      #modal-instalar-ios {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(15, 23, 20, 0.55); backdrop-filter: blur(2px);
        display: flex; align-items: flex-end; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        animation: fluxo-ios-fade-in .18s ease-out;
      }
      @media (min-width: 560px) { #modal-instalar-ios { align-items: center; padding: 20px; } }
      @keyframes fluxo-ios-fade-in { from { opacity: 0 } to { opacity: 1 } }
      @keyframes fluxo-ios-slide-up { from { transform: translateY(24px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
      #modal-instalar-ios .card {
        position: relative; width: 100%; max-width: 400px; max-height: 88vh; overflow-y: auto;
        background: #fff; color: #16241c; border-radius: 20px 20px 0 0;
        padding: 28px 22px 22px; box-shadow: 0 -8px 32px rgba(15,23,20,.25);
        animation: fluxo-ios-slide-up .22s cubic-bezier(.16,1,.3,1);
      }
      @media (min-width: 560px) { #modal-instalar-ios .card { border-radius: 20px; } }
      #modal-instalar-ios .cerrar {
        position: absolute; top: 14px; right: 14px; width: 30px; height: 30px;
        border: none; border-radius: 50%; background: #f0f3f1; color: #5b6660;
        font-size: 18px; line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      #modal-instalar-ios .cerrar:hover { background: #e2e7e4; }
      #modal-instalar-ios .head { text-align: center; margin-bottom: 22px; }
      #modal-instalar-ios .badge {
        width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 14px;
        background: linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%); color: #fff;
        font-weight: 700; font-size: 22px; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 10px rgba(29,78,216,.35);
      }
      #modal-instalar-ios .head h3 { margin: 0 0 6px; font-size: 18px; font-weight: 700; color: #16241c; }
      #modal-instalar-ios .head p { margin: 0; font-size: 14px; line-height: 1.5; color: #5b6660; padding: 0 8px; }
      #modal-instalar-ios .paso {
        display: flex; align-items: flex-start; gap: 14px; padding: 14px 12px;
        border-radius: 14px; background: #f7f9f7; margin-bottom: 10px;
      }
      #modal-instalar-ios .paso-num {
        flex: none; width: 24px; height: 24px; border-radius: 50%; background: #2563EB; color: #fff;
        font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 2px;
      }
      #modal-instalar-ios .paso-icono {
        flex: none; width: 42px; height: 42px; border-radius: 10px; background: #fff;
        border: 1px solid #e2e7e4; display: flex; align-items: center; justify-content: center;
      }
      #modal-instalar-ios .paso-texto { flex: 1; min-width: 0; padding-top: 1px; }
      #modal-instalar-ios .paso-texto b { display: block; font-size: 14.5px; font-weight: 700; color: #16241c; margin-bottom: 2px; }
      #modal-instalar-ios .paso-texto span { display: block; font-size: 13px; line-height: 1.4; color: #5b6660; }
      #modal-instalar-ios .btn-entendido {
        width: 100%; margin-top: 14px; padding: 13px; border: none; border-radius: 12px;
        background: #2563EB; color: #fff; font-size: 15px; font-weight: 700; font-family: inherit; cursor: pointer;
      }
      #modal-instalar-ios .btn-entendido:hover { background: #1D4ED8; }
      #modal-instalar-ios .btn-entendido:active { transform: scale(.98); }
    `;
    document.head.appendChild(style);
  }

  function mostrarInstruccionesIOS() {
    if (document.getElementById('modal-instalar-ios')) return;
    inyectarEstilosInstruccionesIOS();

    const overlay = document.createElement('div');
    overlay.id = 'modal-instalar-ios';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'instalar-ios-titulo');
    overlay.innerHTML = `
      <div class="card">
        <button type="button" class="cerrar" aria-label="Cerrar">&times;</button>

        <div class="head">
          <div class="badge">F</div>
          <h3 id="instalar-ios-titulo">Instalá Fluxo en tu iPhone</h3>
          <p>Safari no permite instalarla con un botón, pero son solo dos toques.</p>
        </div>

        <div class="paso">
          <div class="paso-num">1</div>
          <div class="paso-icono">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3v12m0-12 4 4m-4-4-4 4" stroke="#0A84FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M6 11v6.5A1.5 1.5 0 0 0 7.5 19h9a1.5 1.5 0 0 0 1.5-1.5V11" stroke="#0A84FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="paso-texto">
            <b>Tocá el ícono Compartir</b>
            <span>Es el cuadrado con la flecha hacia arriba, en la barra de abajo de Safari</span>
          </div>
        </div>

        <div class="paso">
          <div class="paso-num">2</div>
          <div class="paso-icono">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="4" width="16" height="16" rx="4" stroke="#1B2B1F" stroke-width="1.7"/>
              <path d="M12 8.5v7M8.5 12h7" stroke="#1B2B1F" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="paso-texto">
            <b>Elegí "Agregar a inicio"</b>
            <span>Bajá en la lista de opciones que se abre hasta encontrarla</span>
          </div>
        </div>

        <button type="button" class="btn-entendido">Entendido</button>
      </div>`;

    const cerrar = () => overlay.remove();
    overlay.querySelector('.cerrar').addEventListener('click', cerrar);
    overlay.querySelector('.btn-entendido').addEventListener('click', cerrar);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(); });
    document.body.appendChild(overlay);
  }
})();
