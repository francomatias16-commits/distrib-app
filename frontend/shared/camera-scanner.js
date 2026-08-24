// frontend/shared/camera-scanner.js
//
// v628 — Escáner de código de barras con la CÁMARA DEL DISPOSITIVO donde se
// está usando el sistema (celular O computadora con webcam), como alternativa
// directa a "Vincular celular" (que requiere un segundo dispositivo).
//
// Hasta ahora esto solo existía adentro del POS (pos-scanner.js), atado a su
// HTML y su CSS. Este módulo generaliza esa misma lógica (ZXing sobre
// getUserMedia) en un componente sin dependencias de markup: inyecta su
// propio modal en el DOM la primera vez que se usa, así cualquier pantalla
// (Productos, Stock, etc.) lo suma con un solo <script> + una llamada a
// CameraScanner.abrir(...).
//
// Requiere que la página incluya @zxing/browser antes de este script:
//   <script src="https://unpkg.com/@zxing/browser@0.1.5"></script>
//
// Uso:
//   window.CameraScanner.abrir({
//     titulo: 'Escanear código de producto',
//     instrucciones: 'Apuntá la cámara al código de barras.',
//     onCodigo: (codigo) => { ... },   // se llama una vez por código detectado
//     cerrarAlDetectar: true,          // default true: cierra el modal solo al primer código
//   });

(function () {
  'use strict';

  const COOLDOWN_MS = 1500;

  let controls = null;
  let ultimoCodigo = null;
  let ultimoTs = 0;
  let opts = {};
  let montado = false;

  function soportaCamara() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && !!window.ZXingBrowser;
  }

  // ── Inyección de markup + estilos (una sola vez por página) ───────────

  function montar() {
    if (montado) return;
    montado = true;

    const style = document.createElement('style');
    style.textContent = `
      #cs-overlay {
        position: fixed; inset: 0; background: rgba(22,24,29,.55);
        display: none; align-items: center; justify-content: center;
        z-index: var(--z-modal, 400); padding: 16px;
      }
      #cs-overlay.abierto { display: flex; }
      #cs-modal {
        background: var(--color-surface, #fff); border-radius: var(--radius-lg, 8px);
        width: 100%; max-width: 440px; max-height: 90vh; overflow-y: auto;
        padding: 20px; box-shadow: var(--shadow-xl, 4px 6px 0 rgba(22,24,29,.08), 0 0 0 1px #E7E9E4);
        display: flex; flex-direction: column; gap: 12px;
      }
      #cs-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      #cs-titulo { margin: 0; font-size: 1.05rem; font-weight: 700; color: var(--color-text, #111A17); }
      #cs-cerrar {
        background: none; border: none; border-radius: var(--radius-md, 4px);
        padding: 4px; cursor: pointer; color: var(--color-text-muted, #5B6660);
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      #cs-cerrar:hover { background: var(--color-bg, #F6F7F5); }
      #cs-video-wrap {
        position: relative; width: 100%; aspect-ratio: 4 / 3;
        border-radius: var(--radius-md, 4px); overflow: hidden; background: #000;
      }
      #cs-video-wrap video { width: 100%; height: 100%; object-fit: cover; display: block; }
      #cs-marco {
        position: absolute; inset: 14% 8%;
        border: 2px solid rgba(255,255,255,.9); border-radius: var(--radius-md, 4px);
        box-shadow: 0 0 0 999px rgba(22,24,29,.28); pointer-events: none;
      }
      #cs-instrucciones { font-size: 0.8rem; color: var(--color-text-muted, #5B6660); margin: 0; text-align: center; }
      #cs-error {
        display: none; font-size: 0.8rem; color: var(--color-danger, #7A2820); margin: 0;
        background: var(--color-danger-bg, #F5DDD8); border-radius: var(--radius-md, 4px);
        padding: 8px 10px;
      }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'cs-overlay';
    overlay.innerHTML = `
      <div id="cs-modal" role="dialog" aria-modal="true" aria-labelledby="cs-titulo">
        <div id="cs-header">
          <h2 id="cs-titulo">Escanear con la cámara</h2>
          <button type="button" id="cs-cerrar" aria-label="Cerrar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div id="cs-video-wrap">
          <video id="cs-video" autoplay muted playsinline></video>
          <div id="cs-marco" aria-hidden="true"></div>
        </div>
        <p id="cs-instrucciones">Apuntá la cámara al código de barras del producto.</p>
        <p id="cs-error"></p>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(); });
    document.getElementById('cs-cerrar').addEventListener('click', cerrar);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('cs-overlay')?.classList.contains('abierto')) cerrar();
    });
  }

  function mostrarError(msg) {
    const errEl = document.getElementById('cs-error');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = '';
  }

  // ── Abrir / cerrar ──────────────────────────────────────────────────

  async function abrir(config) {
    opts = config || {};
    montar();

    const overlay = document.getElementById('cs-overlay');
    const video = document.getElementById('cs-video');
    const errEl = document.getElementById('cs-error');

    document.getElementById('cs-titulo').textContent = opts.titulo || 'Escanear con la cámara';
    document.getElementById('cs-instrucciones').textContent =
      opts.instrucciones || 'Apuntá la cámara al código de barras del producto. Funciona con la webcam o la cámara del celular.';

    if (!soportaCamara()) {
      window.mostrarToast
        ? window.mostrarToast('Este navegador no soporta escanear con la cámara. Probá con Chrome o Safari actualizados, o usá "Vincular celular".', 'error', 5000)
        : alert('Este navegador no soporta escanear con la cámara.');
      return;
    }

    if (errEl) errEl.style.display = 'none';
    overlay.classList.add('abierto');
    ultimoCodigo = null;
    ultimoTs = 0;

    try {
      const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
      // "environment" = cámara trasera en celulares; en notebooks/PC sin
      // cámara trasera el navegador cae solita a la única disponible.
      controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (!result) return;
          const codigo = result.getText();
          if (!codigo) return;

          const ahora = Date.now();
          if (codigo === ultimoCodigo && (ahora - ultimoTs) < COOLDOWN_MS) return;
          ultimoCodigo = codigo;
          ultimoTs = ahora;

          if (navigator.vibrate) navigator.vibrate(80);

          const cerrarAlDetectar = opts.cerrarAlDetectar !== false;
          if (cerrarAlDetectar) cerrar();

          if (typeof opts.onCodigo === 'function') opts.onCodigo(codigo);
        }
      );
    } catch (e) {
      console.error('[camera-scanner] no se pudo iniciar la cámara:', e);
      let msg = 'No se pudo iniciar la cámara.';
      if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
        msg = 'Se necesita permiso de cámara para escanear. Habilitalo en el navegador (ícono de candado en la barra de direcciones) e intentá de nuevo.';
      } else if (e && e.name === 'NotFoundError') {
        msg = 'No se encontró ninguna cámara en este dispositivo. Podés usar "Vincular celular" en su lugar.';
      } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        msg = 'El acceso a la cámara requiere una conexión segura (https). Avisale a soporte.';
      }
      mostrarError(msg);
    }
  }

  function cerrar() {
    const overlay = document.getElementById('cs-overlay');
    if (overlay) overlay.classList.remove('abierto');
    if (controls) {
      try { controls.stop(); } catch (_e) {}
      controls = null;
    }
    const video = document.getElementById('cs-video');
    if (video && video.srcObject) {
      try { video.srcObject.getTracks().forEach((t) => t.stop()); } catch (_e) {}
      video.srcObject = null;
    }
    if (typeof opts.onCerrar === 'function') opts.onCerrar();
  }

  window.CameraScanner = { abrir, cerrar, soportaCamara };
})();
