// frontend/env-config.js
window.ENV = {
  // ── Supabase ───────────────────────────────────────────────────────
  SUPABASE_URL:                   'https://jgiquzjwoedmzwqgzubr.supabase.co',
  SUPABASE_ANON_KEY:              'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnaXF1emp3b2VkbXp3cWd6dWJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMzY0NjgsImV4cCI6MjA5NjcxMjQ2OH0.ZXmY5p-dHPJnltOU1Qo-WPqrNIWBwEOuV_ONrjIyugM',

  // ── Firebase ───────────────────────────────────────────────────────
  FIREBASE_API_KEY:               'AIzaSyAaD-OS5G4YreKG886hDVU4N8PlFNXmcPQ',
  FIREBASE_PROJECT_ID:            'distribuidora-d021d',
  FIREBASE_MESSAGING_SENDER_ID:   '819996288714',
  FIREBASE_APP_ID:                '1:819996288714:web:390080da94809e1da5f633',
  FIREBASE_VAPID_KEY:             'BE4W39dqbvj2LHpfdBvA6kaJ94jKYYp59Tov_XkfFeMkqzM28fMGj8vKf9_QU26LQ61q6wLAZ48WgTDPpo4jep4',

  // ── App ────────────────────────────────────────────────────────────
  APP_VERSION: '1.0.0',

  // ── WhatsApp Embedded Signup (Etapa 7) ───────────────────────────────
  // Públicos a propósito (los necesita el JS SDK de Meta en el navegador):
  // el App ID no es secreto, y el Configuration ID solo referencia una
  // configuración ya creada en el panel de Meta. El App Secret NUNCA va
  // acá, vive solo como variable de entorno del backend (WA_APP_SECRET).
  WA_APP_ID:             '2765961223784707',    // app "empresa" (Business-type, confirmada Etapa 7.1)
  WA_EMBEDDED_CONFIG_ID: '28288615890741251',   // "ES Config", creada 11 jul 2026 (corregido v288: tenía un dígito "8" de más)

  // ── Sentry (Fase 4.1, plan de acción) — error tracking del frontend ──
  // Igual que el resto de las claves de este archivo, el DSN de Sentry no
  // es secreto (está pensado para viajar en código cliente — cualquiera
  // puede verlo en el bundle igual). Vacío = Sentry no se inicializa en el
  // navegador (ver bootstrap más abajo). Completar con el DSN del proyecto
  // Sentry cuando esté creado.
  SENTRY_DSN: 'https://9d97680b4b4cc2d90c6cab54fa7dd907@o4511797880094720.ingest.us.sentry.io/4511797909848064',
};

// ── Bootstrap de Sentry en el navegador (Fase 4.1) ──────────────────────
// env-config.js es, a propósito, el único archivo que ya se incluye en las
// 56 páginas del frontend (admin, cliente y chofer) — por eso es el lugar
// natural para engancharlo una sola vez en vez de tocar cada HTML. Carga
// el bundle oficial de Sentry desde su CDN (no requiere bundler) solo si
// hay un SENTRY_DSN configurado arriba; si está vacío, esto no hace nada.
(function bootstrapSentry() {
  if (!window.ENV.SENTRY_DSN) return;

  const script = document.createElement('script');
  script.src = 'https://browser.sentry-cdn.com/10.68.0/bundle.min.js';
  script.crossOrigin = 'anonymous';
  script.onload = function () {
    Sentry.init({
      dsn: window.ENV.SENTRY_DSN,
      // No hay VERCEL_ENV en el navegador — se infiere por hostname, igual
      // criterio simple que usa el resto del proyecto para "¿esto es prod?".
      environment: /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'development' : 'production',
      tracesSampleRate: 0, // igual que en el backend: solo error tracking por ahora
    });
  };
  document.head.appendChild(script);
})();
