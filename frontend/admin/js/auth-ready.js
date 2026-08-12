// frontend/admin/js/auth-ready.js
// Etapa 2 — Puerta unificada de autenticación.
// Expone window.authReady: Promise que se resuelve con window.authCtx cuando esté listo.
// Cargar ANTES de auth.js en todos los HTML del admin.

(function () {
  'use strict';

  // Configuración
  const AUTH_TIMEOUT_MS = 15000; // 15 segundos
  const POLL_INTERVAL   = 50;    // polling fallback cada 50ms

  let __authResolve, __authReject;

  window.authReady = new Promise(function (resolve, reject) {
    __authResolve = resolve;
    __authReject  = reject;
  });

  // Fast path: si authCtx ya está disponible (poco probable, pero posible en re-renders)
  if (window.authCtx) {
    __authResolve(window.authCtx);
    return;
  }

  // Escuchar el evento que dispara auth.js al terminar
  window.addEventListener('authReady', function onAuthReadyEvent() {
    if (window.authCtx) {
      clearInterval(__pollId);
      __authResolve(window.authCtx);
    }
  }, { once: true });

  // Polling fallback por si el evento disparó antes de que este script cargara
  var __pollId = setInterval(function () {
    if (window.authCtx) {
      clearInterval(__pollId);
      __authResolve(window.authCtx);
    }
  }, POLL_INTERVAL);

  // Timeout: rechazar si no hay auth en AUTH_TIMEOUT_MS
  setTimeout(function () {
    if (!window.authCtx) {
      clearInterval(__pollId);
      __authReject(new Error('[auth-ready] Timeout: authCtx no disponible tras ' + (AUTH_TIMEOUT_MS / 1000) + 's'));
    }
  }, AUTH_TIMEOUT_MS);

})();
