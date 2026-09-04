// dashboard-tilt3d.js
//
// Efecto 3D para las tarjetas del panel principal (.card.card-nav dentro
// de .grid): tilt que sigue al puntero (rotateX/rotateY según dónde está
// el mouse dentro de la tarjeta) + brillo especular que se mueve con el
// cursor, al estilo de los dashboards "premium" (Stripe, Linear, Vercel)
// — en vez del simple translateY al hover que ya tenía cada .card-nav
// (ver .card-nav:hover en el <style> del dashboard).
//
// Puramente visual y aditivo: usa delegación de eventos sobre el
// contenedor .grid (que ya existe en el HTML desde el arranque), así
// que funciona sin importar cuándo el resto de los scripts deferred
// terminen de poblar los datos adentro de cada tarjeta. No toca datos
// ni comportamiento, y no interfiere con el onclick de abrirZoom()/
// abrirAsistenteCard() de cada tarjeta (solo agrega un transform inline
// que se limpia en pointerleave/blur).
//
// Se desactiva solo si:
//  - el usuario tiene prefers-reduced-motion activado
//  - el dispositivo no tiene puntero fino (touch / mobile) — en ese
//    caso el hover plano existente (.card-nav:hover) sigue funcionando
//    igual que antes, sin ningún cambio.
(function () {
  var MAX_TILT_DEG = 3;      // inclinación máxima (antes 8: se sentía muy fuerte en las esquinas)
  var MAX_LIFT_PX = 4;       // cuánto "sale" la tarjeta hacia el usuario (antes 10)
  var EASE_BACK_MS = 350;    // duración del regreso a plano al salir

  var mqReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqFinePointer = window.matchMedia && window.matchMedia('(pointer: fine)');

  function tiltHabilitado() {
    if (mqReducedMotion && mqReducedMotion.matches) return false;
    if (mqFinePointer && !mqFinePointer.matches) return false;
    return true;
  }

  var grid = document.querySelector('.grid');
  if (!grid) return;

  var activo = null; // tarjeta bajo el puntero en este momento

  // Suaviza el valor -0.5..0.5 con una curva (raíz) en vez de lineal:
  // así la inclinación crece rápido cerca del centro y se "aplana" cerca
  // del borde, en lugar de acelerar hacia el máximo justo en las esquinas
  // (que es lo que generaba el titileo fuerte al acercarse a los 4 extremos).
  function suavizar(v) {
    var s = v < 0 ? -1 : 1;
    return s * Math.sqrt(Math.abs(v) * 2) * 0.5;
  }

  function aplicarTilt(card, evt) {
    // No aplicar tilt a una tarjeta que está en modo modal (pantalla
    // completa): ahí el transform de tilt competía con el posicionamiento
    // fijo del modal y hacía "temblar" la tarjeta, corriendo el botón de
    // cerrar (X) justo cuando el cursor se acercaba a una esquina.
    if (card.classList.contains('zoom-active')) return;

    var r = card.getBoundingClientRect();
    var px = (evt.clientX - r.left) / r.width;   // 0..1
    var py = (evt.clientY - r.top) / r.height;   // 0..1
    var nx = suavizar(px - 0.5); // -0.5..0.5 suavizado
    var ny = suavizar(py - 0.5);
    var rotateY = nx * (MAX_TILT_DEG * 2);
    var rotateX = -ny * (MAX_TILT_DEG * 2);

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
    var card = evt.target.closest && evt.target.closest('.card-nav');
    if (!card || !grid.contains(card)) return;
    if (card.classList.contains('zoom-active')) return; // tarjeta en modal: sin tilt
    activo = card;
    card.classList.add('gc-tilt-activa');
    aplicarTilt(card, evt);
  }, true);

  grid.addEventListener('pointermove', function (evt) {
    if (!tiltHabilitado() || !activo) return;
    var card = evt.target.closest && evt.target.closest('.card-nav');
    if (!card) return;
    if (card.classList.contains('zoom-active')) { resetTilt(card); activo = null; return; }
    aplicarTilt(card, evt);
  });

  grid.addEventListener('pointerleave', function (evt) {
    var card = evt.target.closest && evt.target.closest('.card-nav');
    if (!card) return;
    resetTilt(card);
    if (activo === card) activo = null;
  }, true);

  // Si el usuario cambia de pestaña/ventana con el puntero "trabado"
  // sobre una tarjeta, nos aseguramos de no dejarla inclinada para siempre.
  window.addEventListener('blur', function () {
    if (activo) { resetTilt(activo); activo = null; }
  });

  // abrirZoom() marca la tarjeta clickeada con .zoom-active y la anima a
  // pantalla completa; si el click ocurre con el tilt aplicado, dejamos
  // la tarjeta plana antes de que arranque esa animación para que no
  // quede inclinada de fondo detrás del modal.
  grid.addEventListener('pointerdown', function (evt) {
    var card = evt.target.closest && evt.target.closest('.card-nav');
    if (!card) return;
    resetTilt(card);
    if (activo === card) activo = null;
  }, true);
})();
