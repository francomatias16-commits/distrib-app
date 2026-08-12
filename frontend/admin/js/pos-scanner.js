// frontend/admin/js/pos-scanner.js
//
// v612 — Escaneo de código de barras con la cámara del celular, como
// alternativa al lector de mano en el POS.
//
// Usa @zxing/browser (decodeFromConstraints sobre la cámara trasera) para
// leer códigos de barra en modo continuo mientras el modal está abierto —
// así el cajero puede escanear varios artículos seguidos sin volver a
// tocar el botón, igual que con un lector físico.
//
// Importante: NO se inventa un camino de búsqueda nuevo. Cada código
// detectado se vuelca en el mismo input (#pos-input-producto) y dispara
// la misma función buscarProductos(codigo, true) que ya usa el lector
// físico al mandar Enter — así se reutiliza tal cual la lógica existente
// de "un solo resultado → agregar al carrito", los beeps de éxito/error
// (pitarExito/pitarError, definidos en pos.js) y el fallback a caché
// local sin conexión (PosOffline).
//
// Cooldown de 1.5s por código: si la cámara sigue enfocando el mismo
// código un instante de más (varios frames seguidos), no se reprocesa
// ni se duplica el ítem en el carrito.

(function () {
  'use strict';

  const COOLDOWN_MS = 1500;

  let controls = null;      // objeto de control que devuelve ZXing (controls.stop())
  let ultimoCodigo = null;
  let ultimoTs = 0;

  // Mismo motivo que en scan-pos/portal.js: nunca tratar como producto un
  // código que en realidad es el link de "Vincular celular" (por ejemplo si
  // esta cámara local queda apuntando de rebote a la pantalla del modal).
  const RE_LINK_PROPIO = /\/scan-pos(?:[/?]|$)/i;

  function soportaCamara() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && !!window.ZXingBrowser;
  }

  function mostrarErrorScanner(msg) {
    const errEl = document.getElementById('pos-scanner-error');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = '';
  }

  async function abrirModalScanner() {
    const overlay = document.getElementById('modal-scanner-overlay');
    const video   = document.getElementById('pos-scanner-video');
    const errEl   = document.getElementById('pos-scanner-error');
    if (!overlay || !video) return;

    if (!soportaCamara()) {
      window.mostrarToast
        ? window.mostrarToast('Este navegador no soporta escanear con la cámara. Probá con Chrome o Safari actualizados.', 'error', 5000)
        : alert('Este navegador no soporta escanear con la cámara.');
      return;
    }

    if (errEl) errEl.style.display = 'none';
    overlay.style.display = 'flex';
    ultimoCodigo = null;
    ultimoTs = 0;

    try {
      const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
      // facingMode "environment" = cámara trasera (la que sirve para leer
      // códigos de barra; la frontal quedaría para selfies/videollamadas).
      controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (!result) return;
          const codigo = result.getText();
          if (!codigo || RE_LINK_PROPIO.test(codigo)) return;

          const ahora = Date.now();
          if (codigo === ultimoCodigo && (ahora - ultimoTs) < COOLDOWN_MS) return;
          ultimoCodigo = codigo;
          ultimoTs = ahora;

          if (navigator.vibrate) navigator.vibrate(80);

          // Mismo camino que usa el lector físico al mandar Enter.
          const input = document.getElementById('pos-input-producto');
          if (input) input.value = codigo;
          if (typeof window.buscarProductos === 'function') {
            window.buscarProductos(codigo, true);
          }
        }
      );
    } catch (e) {
      console.error('[pos-scanner] no se pudo iniciar la cámara:', e);
      let msg = 'No se pudo iniciar la cámara.';
      if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
        msg = 'Se necesita permiso de cámara para escanear. Habilitalo en el navegador (ícono de candado en la barra de direcciones) e intentá de nuevo.';
      } else if (e && e.name === 'NotFoundError') {
        msg = 'No se encontró ninguna cámara en este dispositivo.';
      } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        msg = 'El acceso a la cámara requiere una conexión segura (https). Avisale a soporte.';
      }
      mostrarErrorScanner(msg);
    }
  }

  function cerrarModalScanner() {
    const overlay = document.getElementById('modal-scanner-overlay');
    if (overlay) overlay.style.display = 'none';
    if (controls) {
      try { controls.stop(); } catch (_e) {}
      controls = null;
    }
    const video = document.getElementById('pos-scanner-video');
    if (video && video.srcObject) {
      try { video.srcObject.getTracks().forEach(t => t.stop()); } catch (_e) {}
      video.srcObject = null;
    }
    // Devolver el foco al buscador, igual que hace el resto del POS
    // después de cerrar cualquier modal.
    document.getElementById('pos-input-producto')?.focus();
  }

  // Cerrar con Escape, como el resto de los modales del POS.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('modal-scanner-overlay');
    if (overlay && overlay.style.display !== 'none') cerrarModalScanner();
  });

  window.abrirModalScanner = abrirModalScanner;
  window.cerrarModalScanner = cerrarModalScanner;
})();
