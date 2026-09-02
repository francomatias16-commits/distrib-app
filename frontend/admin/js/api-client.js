// NOTE v125 (M2): window.api (este módulo) solo se carga en dashboard.html.
// Los demás módulos usan fetchJson inline o authCtx.sb directamente.
// Para adopción completa: cargar este script en todos los HTML del admin.

/**
 * api-client.js — Cliente HTTP para panel admin (Vanilla JS + Supabase Auth)
 * distrib-v47 | Módulo Admin
 *
 * CARACTERÍSTICAS:
 *   ✓ Usa el access token de la sesión Supabase (window.authCtx.session)
 *   ✓ Espera window.authReady (Etapa 2 — puerta unificada, timeout 15s)
 *   ✓ Redirige a login si no hay sesión o el token es inválido (401)
 *   ✓ Maneja errores JSON con mensaje claro
 *
 * USO:
 *   const kpis = await api.get('/api/admin/kpis?periodo=7d');
 *   const res  = await api.post('/api/admin/algo', payload);
 */

'use strict';

// ─── Deduplicación de GETs en vuelo ────────────────────────────────────────
// FIX (v861 — diagnóstico 504 en /api/admin/kpis, 18/08): dashboard.html
// dispara cargarKPIs() y cargarARCA() en paralelo (mismo Promise.allSettled
// de arranque, y de nuevo en cada cambio de pestaña Hoy/Semana/Mes) y las
// dos le pegan al MISMO /api/admin/kpis?periodo=X — mismo dato, mismo
// período, mismo instante. Confirmado con EXPLAIN ANALYZE que cada RPC
// individual responde en <200ms (no es lentitud de query ni falta de
// índice); el problema es que esta es la ruta más pesada del panel (1 RPC
// principal + 3 en paralelo) y duplicarla exactamente dobla la chance de
// pasarse del timeout de 10s del plan Hobby de Vercel en un cold start.
// Como un GET es idempotente, cualquier llamada idéntica que llegue
// mientras la primera todavía no resolvió reutiliza la misma promesa en
// vez de abrir un fetch nuevo — corrige este caso puntual y cualquier otro
// duplicado que aparezca a futuro en el resto del panel.
const _enVueloGET = new Map(); // url -> Promise

// ─── Reintentos ante timeout de Supabase Auth ─────────────────────────────────
// FIX (29/08, incidente Supabase "Increased response times for requests" —
// API Gateway en Degraded Performance): getUserSeguro()/admin.js ya cortan a
// los 8s y responden 503 { codigo: 'TIMEOUT_AUTH' } en vez de colgar o
// devolver un 401 falso. Pero durante un incidente así, cada 503 sin más
// todavía obligaba al usuario a reintentar a mano (F5) el panel entero.
// Como la ventana lenta de Supabase suele resolverse en pocos segundos,
// reintentamos automáticamente acá con backoff antes de darle el error al
// usuario — la mayoría de los casos ni se notan.
const REINTENTOS_TIMEOUT_AUTH = 2;      // intentos adicionales tras el primero
const ESPERA_BASE_TIMEOUT_AUTH_MS = 1200; // backoff simple: 1.2s, luego 2.4s

// ─── Fetch base con auth header ───────────────────────────────────────────────
async function fetchJson(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  if (method === 'GET' && _enVueloGET.has(url)) {
    return _enVueloGET.get(url);
  }

  const promise = _fetchJsonInterno(url, options);

  if (method === 'GET') {
    _enVueloGET.set(url, promise);
    promise.finally(() => _enVueloGET.delete(url));
  }

  return promise;
}

async function _fetchJsonInterno(url, options = {}) {
  let token = '';
  let authCtx;
  try {
    authCtx = await window.authReady;
  } catch (err) {
    window.location.href = '/admin/login';
    return;
  }

  // FIX (reportado: "en la demo no carga y al rato vuelve al login"):
  // authCtx.session puede haber quedado desactualizado si el evento de
  // refresh se disparó antes de que auth.js llegara a engancharse (carrera
  // improbable pero posible) — pedirle la sesión al cliente vivo acá es la
  // fuente de verdad real, sin depender de que nadie más la haya
  // sincronizado a tiempo. authCtx.session queda como fallback si por lo
  // que sea getSession() no devuelve nada.
  try {
    const { data } = await authCtx.sb.auth.getSession();
    token = data?.session?.access_token || authCtx?.session?.access_token || '';
  } catch (err) {
    token = authCtx?.session?.access_token || '';
  }

  const method  = (options.method || 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };

  let intento = 0;
  while (true) {
    const resp = await fetch(url, {
      method,
      headers,
      body: options.body,
    });

    if (resp.ok) return resp.json();

    let body = null;
    try { body = await resp.json(); } catch { /* ignorar */ }

    // 456 — usuario demo (solo_lectura): no es una sesión inválida, así que
    // NO redirigimos a login. Se muestra el mensaje devuelto por el
    // dispatcher (ver lib/solo-lectura.js) como un error normal.
    if (body?.codigo === 'DEMO_SOLO_LECTURA') {
      window.mostrarToast?.(body.error, 'warning');
      throw new Error(body.error);
    }

    // 401 → token inválido/expirado, sesión realmente no válida → redirigir.
    // 403 → sesión SÍ es válida, el backend rechazó por rol/permiso puntual
    // de este recurso (ej. vendedor pegándole a /api/pos/cajas-admin, que
    // exige dueno/admin). Antes se trataba igual que un 401 y cualquier
    // llamada del dashboard a un recurso fuera del alcance del rol actual
    // te expulsaba al login con una sesión perfectamente válida — bug
    // reportado: "entro, veo el dashboard un instante, y vuelve al login"
    // en un usuario vendedor. Ahora el 403 cae al throw genérico de abajo,
    // así cada llamador (la mayoría ya tiene su propio try/catch, ver
    // cargarPOS() en dashboard.html) lo maneja sin perder la sesión.
    if (resp.status === 401) {
      window.location.href = '/admin/login';
      return;
    }

    // 503 { codigo: TIMEOUT_AUTH } — Supabase Auth lento (ver comentario
    // arriba). Reintentamos con backoff antes de rendirnos.
    if (resp.status === 503 && body?.codigo === 'TIMEOUT_AUTH' && intento < REINTENTOS_TIMEOUT_AUTH) {
      intento++;
      const espera = ESPERA_BASE_TIMEOUT_AUTH_MS * intento;
      console.warn(`[api-client] Timeout de auth en ${url}, reintento ${intento}/${REINTENTOS_TIMEOUT_AUTH} en ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
      continue;
    }

    if (resp.status === 503 && body?.codigo === 'TIMEOUT_AUTH') {
      window.mostrarToast?.('El servicio de autenticación está lento. Reintentá en unos segundos.', 'warning');
    }

    throw new Error(`[api-client] ${body?.error || body?.message || `HTTP ${resp.status}`} en ${url}`);
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────
window.api = {
  get:    (url)        => fetchJson(url, { method: 'GET' }),
  post:   (url, body)  => fetchJson(url, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  (url, body)  => fetchJson(url, { method: 'PATCH',  body: JSON.stringify(body) }),
  put:    (url, body)  => fetchJson(url, { method: 'PUT',    body: JSON.stringify(body) }),
  delete: (url)        => fetchJson(url, { method: 'DELETE' }),
};
