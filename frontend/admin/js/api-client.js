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
  try {
    const authCtx = await window.authReady;
    token = authCtx?.session?.access_token || '';
  } catch (err) {
    window.location.href = '/admin/login';
    return;
  }

  const method  = (options.method || 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {}),
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: options.body,
  });

  if (!resp.ok) {
    let body = null;
    try { body = await resp.json(); } catch { /* ignorar */ }

    // 456 — usuario demo (solo_lectura): no es una sesión inválida, así que
    // NO redirigimos a login. Se muestra el mensaje devuelto por el
    // dispatcher (ver lib/solo-lectura.js) como un error normal.
    if (body?.codigo === 'DEMO_SOLO_LECTURA') {
      window.mostrarToast?.(body.error, 'warning');
      throw new Error(body.error);
    }

    // Si 401/403 (sin ser el caso de arriba) → sesión expirada → redirigir
    if (resp.status === 401 || resp.status === 403) {
      window.location.href = '/admin/login';
      return;
    }

    throw new Error(`[api-client] ${body?.error || body?.message || `HTTP ${resp.status}`} en ${url}`);
  }

  return resp.json();
}

// ─── API pública ──────────────────────────────────────────────────────────────
window.api = {
  get:    (url)        => fetchJson(url, { method: 'GET' }),
  post:   (url, body)  => fetchJson(url, { method: 'POST',   body: JSON.stringify(body) }),
  patch:  (url, body)  => fetchJson(url, { method: 'PATCH',  body: JSON.stringify(body) }),
  put:    (url, body)  => fetchJson(url, { method: 'PUT',    body: JSON.stringify(body) }),
  delete: (url)        => fetchJson(url, { method: 'DELETE' }),
};
