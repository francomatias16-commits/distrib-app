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

// ─── Fetch base con auth header ───────────────────────────────────────────────
async function fetchJson(url, options = {}) {
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

  const resp = await fetch(url, { ...options, method, headers });

  // Si 401/403 → sesión expirada → redirigir
  if (resp.status === 401 || resp.status === 403) {
    window.location.href = '/admin/login';
    return;
  }

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      msg = body.error || body.message || msg;
    } catch { /* ignorar */ }
    throw new Error(`[api-client] ${msg} en ${url}`);
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
