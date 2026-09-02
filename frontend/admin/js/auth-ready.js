// frontend/admin/js/auth-ready.js
// Etapa 2 — Puerta unificada de autenticación.
// Expone window.authReady: Promise que se resuelve con window.authCtx cuando esté listo.
// Cargar ANTES de auth.js en todos los HTML del admin.

(function () {
  'use strict';

  // Configuración
  // FIX (reportado: "en la demo no carga y al rato vuelve al login"):
  // auth.js resuelve window.authCtx recién después de cargarPerfilConReintento(),
  // que en el peor caso (varios timeouts de red/consulta lenta, algo más
  // probable en el tenant demo público por su carga concurrente) puede tardar
  // hasta 4 intentos × 10s + backoff de 900/2000/4000ms entre medio ≈ 47s.
  // Con AUTH_TIMEOUT_MS en 15s, esta "puerta única" se rendía y redirigía a
  // /admin/login (ver api-client.js) MIENTRAS auth.js seguía reintentando en
  // segundo plano con una sesión en realidad válida. Se sube a 50s para que
  // siempre sea mayor al peor caso real de auth.js — evita el falso timeout
  // sin tocar la lógica de reintentos (que existe a propósito, ver Etapa 3/4
  // en auth.js).
  const AUTH_TIMEOUT_MS = 50000; // 50 segundos
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
