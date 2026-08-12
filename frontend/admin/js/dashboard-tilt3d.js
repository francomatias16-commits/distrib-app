// dashboard-tilt3d.js
//
// Efecto 3D para las tarjetas KPI del panel principal (capa GND CRYP):
// tilt que sigue al puntero (rotateX/rotateY según dónde está el mouse
// dentro de la tarjeta) + brillo especular que se mueve con el cursor,
// al estilo de los dashboards "premium" (Stripe, Linear, Vercel) — en
// vez del simple translateY al hover que había antes.
//
// Puramente visual y aditivo: usa delegación de eventos sobre el
// contenedor #kpis-grid (que ya existe en el HTML desde el arranque),
// así que funciona sin importar cuándo dashboard-optimizado.js termine
// de renderizar las tarjetas adentro. No toca datos ni comportamiento.
//
// Se desactiva solo si:
//  - el usuario tiene prefers-reduced-motion activado
//  - el dispositivo no tiene puntero fino (touch / mobile)
(function () {
  var MAX_TILT_DEG = 8;      // inclinación máxima
  var MAX_LIFT_PX = 14;      // cuánto "sale" la tarjeta hacia el usuario
  var EASE_BACK_MS = 350;    // duración del regreso a plano al salir

  var mqReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqFinePointer = window.matchMedia && window.matchMedia('(pointer: fine)');

  function tiltHabilitado() {
    if (mqReducedMotion && mqReducedMotion.matches) return false;
    if (mqFinePointer && !mqFinePointer.matches) return false;
    return true;
  }

  var grid = document.getElementById('kpis-grid');
  if (!grid) return;

  var activo = null; // tarjeta bajo el puntero en este momento

  function aplicarTilt(card, evt) {
    var r = card.getBoundingClientRect();
    var px = (evt.clientX - r.left) / r.width;   // 0..1
    var py = (evt.clientY - r.top) / r.height;   // 0..1
    var rotateY = (px - 0.5) * (MAX_TILT_DEG * 2);
    var rotateX = (0.5 - py) * (MAX_TILT_DEG * 2);

    card.style.transition = 'none';
    card.style.transform =
      'perspective(900px) rotateX(' + rotateX.toFixed(2) + 'deg) ' +
      'rotateY(' + rotateY.toFixed(2) + 'deg) ' +
      'translateZ(' + MAX_LIFT_PX + 'px)';
    card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
    card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
  }

  function resetTilt(card) {
    card.style.transition = 'transform ' + EASE_BACK_MS + 'ms cubic-bezier(.22,1,.36,1)';
    card.style.transform = '';
    card.classList.remove('gc-tilt-activa');
  }

  grid.addEventListener('pointerenter', function (evt) {
    if (!tiltHabilitado()) return;
    var card = evt.target.closest && evt.target.closest('.kpi-card');
    if (!card || !grid.contains(card)) return;
    activo = card;
    card.classList.add('gc-tilt-activa');
    aplicarTilt(card, evt);
  }, true);

  grid.addEventListener('pointermove', function (evt) {
    if (!tiltHabilitado() || !activo) return;
    var card = evt.target.closest && evt.target.closest('.kpi-card');
    if (!card) return;
    aplicarTilt(card, evt);
  });

  grid.addEventListener('pointerleave', function (evt) {
    var card = evt.target.closest && evt.target.closest('.kpi-card');
    if (!card) return;
    resetTilt(card);
    if (activo === card) activo = null;
  }, true);

  // Si el usuario hace scroll o cambia de pestaña con el puntero "trabado"
  // sobre una tarjeta, nos aseguramos de no dejarla inclinada para siempre.
  window.addEventListener('blur', function () {
    if (activo) { resetTilt(activo); activo = null; }
  });
})();
