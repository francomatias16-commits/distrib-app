/**
 * automatizacion.js — Panel de Control v54
 * Fixes: skeletons inmediatos, bootstrap ultra-robusto, URL correcta de API
 */
'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────
const q = s => document.querySelector(s);

function formatTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso), ahora = new Date(), diff = ahora - d;
  if (diff < 60000)   return 'hace un momento';
  if (diff < 3600000) return `hace ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)} h`;
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function formatFecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
}
function formatMonto(n) {
  return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

let _toastTimer;
function toast(msg, tipo = 'info') {
  let t = q('#auto-toast');
  if (!t) {
    t = Object.assign(document.createElement('div'), { id: 'auto-toast' });
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(22,24,29,.18);transition:opacity .3s;pointer-events:none';
    document.body.appendChild(t);
  }
  const bg = { info: 'var(--color-info,#1F3555)', ok: 'var(--color-success,#487050)', error: 'var(--color-danger,#7A2820)', warn: 'var(--color-warning,#8A5F13)' };
  Object.assign(t.style, { background: bg[tipo] || bg.info, color: '#fff', opacity: '1' });
  t.textContent = msg;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}

// ── Estado ────────────────────────────────────────────────────────────────
let _estado  = null;
let _polling = null;
let _iniciado = false;
function _token() { return window.authCtx?.session?.access_token || ''; }

// ── SKELETONS INMEDIATOS — no esperar auth ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderSkeletons();
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
function arrancar() {
  window.authReady
    .then(() => iniciarSafe())
    .catch(err => console.error('[automatizacion] Auth error:', err.message));
}

document.addEventListener('DOMContentLoaded', arrancar);

function iniciarSafe() {
  if (_iniciado) return;
  _iniciado = true;
  iniciar().catch(err => {
    console.error('[Auto] iniciar:', err);
    renderError('No se pudo iniciar el panel de alertas automáticas');
  });
}

// ── Inicialización ────────────────────────────────────────────────────────
async function iniciar() {
  if (!_token()) {
    renderError('Token de sesión no disponible. <a href="/admin/login" style="color:var(--color-primary,#6A9873)">Iniciar sesión</a>');
    return;
  }

  // Topbar
  const hoy = new Date().toLocaleDateString('es-AR',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const elFecha = q('#auto-fecha');
  if (elFecha) elFecha.textContent = hoy;
  const elUser = q('#topbar-usuario') || q('#auto-usuario');
  if (elUser) elUser.textContent = window.authCtx?.perfil?.nombre || '';

  // Skeletons ya se muestran desde DOMContentLoaded
  // Cargar datos reales
  await cargarEstado();
  cargarReglasAuto(); // Fase 6 — no bloquea el resto del bootstrap
  cargarTareasAuto(); // Fase 6b — tareas creadas por la acción crear_tarea
  iniciarPolling();
  verificarPushEstado();

  q('#btn-refrescar')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.classList.add('girando');
    await cargarEstado();
    btn.classList.remove('girando');
  });
}

// ── API ───────────────────────────────────────────────────────────────────
async function cargarEstado() {
  try {
    const resp = await fetch('/api/automatizacion', {
      headers: { 'Authorization': `Bearer ${_token()}` }
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => resp.statusText);
      throw new Error(`HTTP ${resp.status}: ${txt.substring(0, 120)}`);
    }
    _estado = await resp.json();
    renderPanel(_estado);
    const ts = q('#auto-generado');
    if (ts && _estado.generado_en) ts.textContent = `Actualizado: ${formatTs(_estado.generado_en)}`;
  } catch (err) {
    console.error('[Auto] cargarEstado:', err);
    toast('No se pudieron cargar los datos', 'error');
    // Mostrar el error en el grid si no hay datos previos
    if (!_estado) renderError('No se pudieron cargar los datos');
  }
}

function iniciarPolling() {
  if (_polling) clearInterval(_polling);
  _polling = setInterval(cargarEstado, 30_000);
  window.addEventListener('beforeunload', () => clearInterval(_polling), { once: true });
}

// ── Skeletons y errores ───────────────────────────────────────────────────
function renderSkeletons() {
  const grid = q('#auto-grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 5 }, () => `
    <div class="sk-motor-card">
      <div class="sk-line" style="width:55%;height:16px;margin-bottom:10px"></div>
      <div class="sk-line" style="width:35%;height:10px;margin-bottom:20px"></div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <div class="sk-line" style="flex:1;height:58px;border-radius:8px"></div>
        <div class="sk-line" style="flex:1;height:58px;border-radius:8px"></div>
        <div class="sk-line" style="flex:1;height:58px;border-radius:8px"></div>
      </div>
      <div class="sk-line" style="height:40px;border-radius:7px;margin-bottom:6px"></div>
      <div class="sk-line" style="height:40px;border-radius:7px"></div>
    </div>`).join('');
}

function renderError(htmlMsg) {
  const grid = q('#auto-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:48px 24px;color:var(--color-text-muted)">
      <div style="margin-bottom:14px"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div style="font-size:15px;font-weight:700;color:var(--color-text);margin-bottom:8px">Error al cargar los motores</div>
      <div style="font-size:13px;max-width:420px;margin:0 auto 20px">${htmlMsg}</div>
      <button onclick="location.reload()" style="padding:9px 22px;border-radius:8px;background:var(--color-primary,#6A9873);color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:600">
        Recargar página
      </button>
    </div>`;
}

// ── Render principal ───────────────────────────────────────────────────────
function renderPanel(estado) {
  const grid = q('#auto-grid');
  if (!grid) return;

  const cards = [
    ['piloto',    buildPilotoCard],
    ['cierre',    buildCierreCard],
    ['rutas',     buildRutasCard],
    ['stock',     buildStockCard],
    ['score',     buildScoreCard],
    ['auditoria', buildAuditoriaCard],
  ];

  const frag = document.createDocumentFragment();
  for (const [key, builder] of cards) {
    const data = estado[key] || {};
    let html;
    try {
      html = builder(data);
    } catch (e) {
      console.error(`[Auto] buildCard ${key}:`, e);
      html = buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', key, 'No se pudo cargar esta sección');
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (tmp.firstElementChild) frag.appendChild(tmp.firstElementChild);
  }
  grid.innerHTML = '';
  grid.appendChild(frag);
}

// ═══════════════════════════════════════════════════════════════════════════
// TARJETAS DE MOTOR
// ═══════════════════════════════════════════════════════════════════════════

function buildErrorCard(icono, titulo, msg) {
  return `<div class="motor-card motor-card--error">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon">${icono}</div>
        <div><div class="motor-card__title">${titulo}</div><div class="motor-card__sub">Error al cargar</div></div>
      </div>
      <span class="motor-status ms-error">Error</span>
    </div>
    <div class="motor-card__body" style="align-items:center;min-height:100px;justify-content:center;text-align:center">
      <div style="font-size:12px;color:var(--color-text-muted);padding:0 12px">${msg}</div>
      <button onclick="cargarEstado()" style="margin-top:10px;padding:5px 14px;border-radius:7px;border:1px solid var(--color-border);background:var(--color-surface);cursor:pointer;font-size:12px">Reintentar</button>
    </div>
  </div>`;
}

// ── REQ-1: Piloto Automático ───────────────────────────────────────────────
function buildPilotoCard(p) {
  if (p.error) return buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/><circle cx="15" cy="14" r="1.2" fill="currentColor"/><line x1="12" y1="8" x2="12" y2="4"/><circle cx="12" cy="3" r="1"/><line x1="1" y1="14" x2="4" y2="14"/><line x1="20" y1="14" x2="23" y2="14"/></svg>', 'Piloto Automático', p.error);
  const sp = p.sugeridos_pendientes || 0, ca = p.ciclos_activos || 0;
  const status = sp > 0 ? 'ms-warn' : ca > 0 ? 'ms-ok' : 'ms-idle';
  const lbl = sp > 0 ? `${sp} próximos` : ca > 0 ? 'Activo' : 'Sin ciclos';

  const items = (p.recientes || []).slice(0, 3).map(s => {
    const conf = Number(s.confianza_sugerencia || 0);
    const niv = conf >= 0.8 ? 'alta' : conf >= 0.6 ? 'media' : 'baja';
    return `<div class="motor-list-item">
      <div style="flex:1;min-width:0">
        <strong style="font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.sanitize(s.clientes?.razon_social || '—')}</strong>
        <span style="font-size:11px;color:var(--color-text-muted)">${window.sanitize(s.productos?.nombre || '—')} · ${window.window.formatFecha(s.proximo_pedido)}</span>
      </div>
      <span class="tarea-badge conf-${niv}">${Math.round(conf * 100)}%</span>
    </div>`;
  }).join('') || '<p class="empty-hint">Sin sugerencias inminentes</p>';

  return `<div class="motor-card">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon icon-piloto"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/><circle cx="15" cy="14" r="1.2" fill="currentColor"/><line x1="12" y1="8" x2="12" y2="4"/><circle cx="12" cy="3" r="1"/><line x1="1" y1="14" x2="4" y2="14"/><line x1="20" y1="14" x2="23" y2="14"/></svg></div>
        <div><div class="motor-card__title">Piloto Automático</div><div class="motor-card__sub">Motor de sugerencias de pedidos</div></div>
      </div>
      <span class="motor-status ${status}">${lbl}</span>
    </div>
    <div class="motor-card__body">
      <div class="motor-kpi-row">
        <div class="motor-kpi"><div class="motor-kpi__val ${sp > 0 ? 'kpi-warn' : 'kpi-muted'}">${sp}</div><div class="motor-kpi__lbl">Próx. 7 días</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val kpi-blue">${ca}</div><div class="motor-kpi__lbl">Ciclos activos</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val kpi-ok">${p.confianza_promedio != null ? p.confianza_promedio + '%' : '—'}</div><div class="motor-kpi__lbl">Confianza</div></div>
      </div>
      <div class="motor-list-label">Próximas sugerencias</div>
      <div class="motor-list">${items}</div>
      <div class="motor-ts"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${p.ultima_ejecucion ? formatTs(p.ultima_ejecucion) : 'Nunca ejecutado'}</div>
    </div>
    <div class="motor-card__footer">
      <button class="btn-ejecutar" id="btn-piloto" onclick="ejecutarMotor('piloto',this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>Ejecutar</button>
      <a href="/admin/pedidos" class="btn-ver-mas">Ver pedidos →</a>
    </div>
  </div>`;
}

// ── REQ-2: Cierre Financiero ───────────────────────────────────────────────
function buildCierreCard(c) {
  if (c.error) return buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19"/></svg>', 'Cierre Financiero', c.error);
  const pend = c.pendientes || 0, err = c.errores || 0, bloq = c.bloqueados || 0;
  const status = err > 0 ? 'ms-error' : pend > 0 ? 'ms-warn' : bloq > 0 ? 'ms-warn' : 'ms-ok';
  const lbl = err > 0 ? `${err} con error` : pend > 0 ? `${pend} pendientes` : bloq > 0 ? `${bloq} bloqueados` : 'Al día';

  const items = (c.recientes || []).slice(0, 3).map(r =>
    `<div class="motor-list-item">
      <div style="flex:1"><strong style="font-size:13px">${r.cliente || '—'}</strong>
      ${r.monto ? `<span style="font-size:11px;color:var(--color-success,#487050);display:block">${formatMonto(r.monto)}</span>` : ''}</div>
      <span style="font-size:11px;color:var(--color-text-muted)">${formatTs(r.updated_at)}</span>
    </div>`).join('') || '<p class="empty-hint">Sin movimientos recientes</p>';

  return `<div class="motor-card">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon icon-cierre"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19"/></svg></div>
        <div><div class="motor-card__title">Cierre Financiero</div><div class="motor-card__sub">Facturación · Vencimientos · Bloqueos</div></div>
      </div>
      <span class="motor-status ${status}">${lbl}</span>
    </div>
    <div class="motor-card__body">
      <div class="motor-kpi-row">
        <div class="motor-kpi"><div class="motor-kpi__val ${pend > 0 ? 'kpi-warn' : 'kpi-ok'}">${pend}</div><div class="motor-kpi__lbl">Fact. pend.</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val ${err > 0 ? 'kpi-error' : 'kpi-ok'}">${err}</div><div class="motor-kpi__lbl">Con error</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val ${bloq > 0 ? 'kpi-error' : 'kpi-muted'}">${bloq}</div><div class="motor-kpi__lbl">Bloqueados</div></div>
      </div>
      ${c.monto_pendiente > 0 ? `<div class="motor-monto-box"><span style="font-size:11px;color:var(--color-text-muted);text-transform:uppercase">Monto pendiente</span><span style="font-size:20px;font-weight:800;color:var(--color-warning,#8A5F13)">${formatMonto(c.monto_pendiente)}</span></div>` : ''}
      <div class="motor-list-label">Cobros recientes (7 días)</div>
      <div class="motor-list">${items}</div>
      <div class="motor-ts"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${c.ultima_ejecucion ? formatTs(c.ultima_ejecucion) : 'Sin actividad reciente'}</div>
    </div>
    <div class="motor-card__footer">
      <button class="btn-ejecutar" id="btn-cierre" onclick="ejecutarMotor('cierre',this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>Procesar cola</button>
      <a href="/admin/cobranzas?vista=saldos" class="btn-ver-mas">Saldos por cliente →</a>
    </div>
  </div>`;
}

// ── REQ-3: Rutas Dinámicas ─────────────────────────────────────────────────
function buildRutasCard(r) {
  if (r.error) return buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21"/><line x1="8" y1="3" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="21"/></svg>', 'Rutas Dinámicas', r.error);
  const pct = r.pct_completitud || 0;
  const status = r.rutas_activas > 0 ? 'ms-ok' : r.rutas_hoy > 0 ? 'ms-idle' : 'ms-idle';
  const lbl = r.rutas_activas > 0 ? `${r.rutas_activas} en curso` : r.rutas_hoy > 0 ? 'Finalizadas' : 'Sin rutas';

  const items = (r.lista || []).slice(0, 4).map(rt => {
    const pctRt = rt.paradas > 0 ? Math.round(rt.entregadas / rt.paradas * 100) : 0;
    return `<div class="motor-list-item">
      <div style="flex:1">
        <strong style="font-size:13px">${sanitize(rt.chofer)}</strong>
        <div class="mini-progress-wrap" style="margin-top:4px"><div class="mini-progress-fill" style="width:${pctRt}%"></div></div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <span style="font-size:11px;font-weight:700">${rt.entregadas}/${rt.paradas}</span>
        <span style="display:block;font-size:10px;color:var(--color-text-muted)">${rt.gps_ok ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 11a10 10 0 0 1 16 0"/><path d="M7 15a6 6 0 0 1 10 0"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>GPS' : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/></svg>Sin GPS'}</span>
      </div>
    </div>`;
  }).join('') || '<p class="empty-hint">Sin rutas asignadas hoy</p>';

  return `<div class="motor-card">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon icon-rutas"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polygon points="1 6 8 3 16 6 23 3 23 18 16 21 8 18 1 21"/><line x1="8" y1="3" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="21"/></svg></div>
        <div><div class="motor-card__title">Rutas Dinámicas</div><div class="motor-card__sub">GPS en vivo · Re-optimización</div></div>
      </div>
      <span class="motor-status ${status}">${lbl}</span>
    </div>
    <div class="motor-card__body">
      <div class="motor-kpi-row">
        <div class="motor-kpi"><div class="motor-kpi__val kpi-blue">${r.rutas_hoy || 0}</div><div class="motor-kpi__lbl">Rutas hoy</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val kpi-ok">${r.choferes_con_gps || 0}</div><div class="motor-kpi__lbl">Con GPS</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val ${pct < 50 ? 'kpi-warn' : 'kpi-ok'}">${pct}%</div><div class="motor-kpi__lbl">Completitud</div></div>
      </div>
      <div class="motor-progress-wrap"><div class="motor-progress-fill" style="width:${pct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--color-text-muted);margin-top:4px"><span>${r.entregadas || 0} entregadas</span><span>${r.total_paradas || 0} total</span></div>
      <div class="motor-list-label">Estado por chofer</div>
      <div class="motor-list">${items}</div>
    </div>
    <div class="motor-card__footer">
      <span class="motor-realtime-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Tiempo real</span>
      <a href="/admin/rutas" class="btn-ver-mas">Ver rutas →</a>
    </div>
  </div>`;
}

// ── REQ-4: Stock Autónomo ──────────────────────────────────────────────────
function buildStockCard(s) {
  if (s.error) return buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>', 'Stock Autónomo', s.error);
  const bstk = s.productos_bajo_stock || 0, al = s.alertas_activas || 0, ord = s.ordenes_auto || 0;
  const status = bstk > 0 ? 'ms-error' : al > 0 ? 'ms-warn' : ord > 0 ? 'ms-ok' : 'ms-idle';
  const lbl = bstk > 0 ? `${bstk} en quiebre` : al > 0 ? `${al} alertas` : ord > 0 ? `${ord} órdenes` : 'Stock OK';

  const alertItems = (s.alertas || []).slice(0, 4).map(a =>
    `<div class="motor-list-item">
      <strong style="font-size:13px;flex:1">${window.sanitize(a.productos?.nombre || '—')}</strong>
      ${a.dias_restantes != null ? `<span style="font-size:10px;color:var(--color-text-muted)">${a.dias_restantes}d</span>` : ''}
      <span class="tarea-badge ${a.tipo === 'quiebre' ? 'conf-baja' : 'conf-media'}">${a.tipo}</span>
    </div>`).join('') || '<p class="empty-hint">Stock saludable<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg></p>';

  const ordenItems = (s.ordenes || []).slice(0, 2).map(o =>
    `<div class="motor-list-item" style="background:rgba(91,74,143,.06);border:1px solid rgba(91,74,143,.2);border-radius:8px">
      <strong style="font-size:12px;flex:1">${o.numero}</strong>
      <span class="tarea-badge conf-media">${o.estado}</span>
      <button class="btn-aprobar-orden" onclick="aprobarOrdenPanel('${o.id}',this)">Aprobar</button>
    </div>`).join('');

  return `<div class="motor-card">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon icon-stock"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg></div>
        <div><div class="motor-card__title">Stock Autónomo</div><div class="motor-card__sub">Proyección · Órdenes automáticas</div></div>
      </div>
      <span class="motor-status ${status}">${lbl}</span>
    </div>
    <div class="motor-card__body">
      <div class="motor-kpi-row">
        <div class="motor-kpi"><div class="motor-kpi__val ${bstk > 0 ? 'kpi-error' : 'kpi-ok'}">${bstk}</div><div class="motor-kpi__lbl">Quiebre</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val ${s.lotes_por_vencer > 0 ? 'kpi-warn' : 'kpi-muted'}">${s.lotes_por_vencer || 0}</div><div class="motor-kpi__lbl">Por vencer</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val kpi-blue">${ord}</div><div class="motor-kpi__lbl">Órdenes auto</div></div>
      </div>
      <div class="motor-list-label">Alertas</div>
      <div class="motor-list">${alertItems}</div>
      ${ordenItems ? `<div class="motor-list-label" style="margin-top:6px">Órdenes para aprobar</div><div class="motor-list">${ordenItems}</div>` : ''}
      <div class="motor-ts"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${s.ultima_ejecucion ? formatTs(s.ultima_ejecucion) : 'Sin análisis reciente'}</div>
    </div>
    <div class="motor-card__footer">
      <button class="btn-ejecutar" id="btn-stock" onclick="ejecutarMotor('stock',this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>Analizar</button>
      <a href="/admin/stock" class="btn-ver-mas">Ver stock →</a>
    </div>
  </div>`;
}

// ── REQ-5: Score de Clientes ───────────────────────────────────────────────
function buildScoreCard(s) {
  if (s.error) return buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="15" r="6"/><path d="M9 10.5L7 2h4l1 4 1-4h4l-2 8.5"/></svg>', 'Nivel de Confianza de Clientes', s.error);
  const cats = s.categorias || {}, total = s.total_clientes || 0;
  const status = s.alertas_activas > 0 ? 'ms-warn' : s.con_score > 0 ? 'ms-ok' : 'ms-idle';
  const lbl = s.alertas_activas > 0 ? `${s.alertas_activas} en riesgo` : s.con_score > 0 ? 'Monitoreado' : 'Sin datos';

  const con = s.con_score || 0;
  const pctC = con > 0 ? Math.round((cats.critico || 0)   / con * 100) : 0;
  const pctR = con > 0 ? Math.round((cats.en_riesgo || 0) / con * 100) : 0;
  const pctS = con > 0 ? Math.round((cats.saludable || 0) / con * 100) : 0;

  const barChart = con > 0 ? `<div class="score-bar-group">
    <div class="score-bar-item"><div class="score-bar" style="height:${pctC*0.8+4}px;background:var(--color-danger-mid,#D1594A)"></div><span class="score-bar-lbl">${cats.critico || 0}<br><small>Críticos</small></span></div>
    <div class="score-bar-item"><div class="score-bar" style="height:${pctR*0.8+4}px;background:var(--color-warning-mid,#E0A53E)"></div><span class="score-bar-lbl">${cats.en_riesgo || 0}<br><small>Riesgo</small></span></div>
    <div class="score-bar-item"><div class="score-bar" style="height:${pctS*0.8+4}px;background:var(--color-success-mid,#75A37D)"></div><span class="score-bar-lbl">${cats.saludable || 0}<br><small>Sanos</small></span></div>
    <div class="score-bar-item"><div class="score-bar" style="height:${Math.round((s.sin_score||0)/Math.max(total,1)*100)*0.8+4}px;background:var(--color-border,#DDE1DC)"></div><span class="score-bar-lbl">${s.sin_score || 0}<br><small>Sin nivel</small></span></div>
  </div>` : '';

  const peores = (s.peores || []).slice(0, 3).map(c =>
    `<div class="motor-list-item">
      <strong style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sanitize(c.razon_social)}</strong>
      <span class="score-pill score-${c.categoria || 'sin_score'}">${Math.round(Number(c.score || 0))}</span>
    </div>`).join('') || '<p class="empty-hint">Sin niveles de confianza calculados</p>';

  return `<div class="motor-card">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon icon-score"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="15" r="6"/><path d="M9 10.5L7 2h4l1 4 1-4h4l-2 8.5"/></svg></div>
        <div><div class="motor-card__title">Nivel de Confianza de Clientes</div><div class="motor-card__sub">Semáforo inteligente de salud</div></div>
      </div>
      <span class="motor-status ${status}">${lbl}</span>
    </div>
    <div class="motor-card__body">
      <div class="motor-kpi-row">
        <div class="motor-kpi"><div class="motor-kpi__val kpi-blue">${total}</div><div class="motor-kpi__lbl">Clientes</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val ${(cats.critico || 0) > 0 ? 'kpi-error' : 'kpi-muted'}">${cats.critico || 0}</div><div class="motor-kpi__lbl">Críticos</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val kpi-ok">${s.score_promedio != null ? s.score_promedio : '—'}</div><div class="motor-kpi__lbl">Confianza prom.</div></div>
      </div>
      ${barChart}
      <div class="motor-list-label">Menor nivel de confianza</div>
      <div class="motor-list">${peores}</div>
      <div class="motor-ts"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${s.ultima_actualizacion ? formatTs(s.ultima_actualizacion) : 'Sin recálculo'}</div>
    </div>
    <div class="motor-card__footer">
      <button class="btn-ejecutar" id="btn-score" onclick="ejecutarMotor('score',this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>Recalcular</button>
      <a href="/admin/clientes" class="btn-ver-mas">Ver clientes →</a>
    </div>
  </div>`;
}

function buildAuditoriaCard(s) {
  if (s.error) return buildErrorCard('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>', 'Qué pasó en mi negocio', s.error);

  const total   = s.alertas_activas || 0;
  const altas   = s.severidad_alta  || 0;
  const status  = altas > 0 ? 'ms-error' : total > 0 ? 'ms-warn' : 'ms-ok';
  const lbl     = altas > 0 ? `${altas} crítica${altas > 1 ? 's' : ''}` : total > 0 ? `${total} a revisar` : 'Todo normal';

  const TIPO_LABELS = {
    descuento_repetido_vendedor:            'Descuentos repetidos por vendedor',
    descuento_repetido_vendedor_cliente:    'Descuento repetido al mismo cliente',
    ajuste_stock_sin_respaldo:              'Ajuste de stock sin orden de compra',
    movimiento_stock_alterado:              'Movimiento de stock modificado/eliminado',
    pedido_anulado_repetido:                'Anulaciones repetidas por vendedor',
    descuento_excede_maximo:                'Descuento fuera de rango',
    precio_manual_bajo_lista:               'Precio manual por debajo de lista',
    nota_credito_veloz_post_factura:        'Nota de crédito emitida muy rápido',
    cheque_rechazado_con_cobro_vinculado:   'Cheque rechazado con cobro vinculado',
    cobro_sin_respaldo_cta_cte:             'Cobro sin respaldo contable',
    cliente_bloqueado_con_pedido_posterior: 'Pedido a cliente bloqueado',
    ajuste_puntos_manual_sin_pedido:        'Puntos de fidelización ajustados manualmente',
    entrega_secuencia_veloz:                'Entregas confirmadas demasiado rápido',
    actividad_stock_fuera_horario:          'Actividad de stock fuera de horario',
    volumen_pedidos_anomalo_vendedor:       'Pico de volumen de pedidos',
  };

  const recientes = (s.recientes || []).map(a => {
    const etiqueta = TIPO_LABELS[a.tipo_anomalia] || a.tipo_anomalia;
    const quien    = a.usuario_nombre ? `<span style="font-weight:600">${window.sanitize(a.usuario_nombre)}</span>` : 'Usuario desconocido';
    const extra    = a.entidad_nombre ? ` · ${window.sanitize(a.entidad_nombre)}` : '';
    const badge    = a.severidad === 'alta'
      ? '<span style="background:var(--color-danger-bg,#F5DDD8);color:var(--color-danger,#7A2820);border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;margin-left:4px">Alta</span>'
      : '<span style="background:var(--color-warning-bg,#FBE8C9);color:var(--color-warning,#8A5F13);border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;margin-left:4px">Media</span>';
    return `<div class="motor-list-item" style="flex-direction:column;align-items:flex-start;gap:2px">
      <div style="display:flex;align-items:center;gap:4px;width:100%">
        <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${etiqueta}</span>${badge}
      </div>
      <div style="font-size:11px;color:var(--color-text-muted)">${quien}${extra} · ${a.cantidad_eventos} evento${a.cantidad_eventos > 1 ? 's' : ''}</div>
    </div>`;
  }).join('') || '<p class="empty-hint">Sin anomalías detectadas en los últimos 7 días</p>';

  return `<div class="motor-card">
    <div class="motor-card__header">
      <div class="motor-card__title-wrap">
        <div class="motor-card__icon icon-score"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
        <div><div class="motor-card__title">Qué pasó en mi negocio</div><div class="motor-card__sub">Patrones sospechosos · Últimos 7 días</div></div>
      </div>
      <span class="motor-status ${status}">${lbl}</span>
    </div>
    <div class="motor-card__body">
      <div class="motor-kpi-row">
        <div class="motor-kpi"><div class="motor-kpi__val ${altas > 0 ? 'kpi-error' : 'kpi-muted'}">${altas}</div><div class="motor-kpi__lbl">Críticas</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val ${total > 0 && altas === 0 ? 'kpi-warn' : 'kpi-muted'}">${total - altas}</div><div class="motor-kpi__lbl">A revisar</div></div>
        <div class="motor-kpi"><div class="motor-kpi__val kpi-blue">${total}</div><div class="motor-kpi__lbl">Total</div></div>
      </div>
      <div class="motor-list-label">Patrones recientes</div>
      <div class="motor-list">${recientes}</div>
      <div class="motor-ts"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${s.ultima_ejecucion ? formatTs(s.ultima_ejecucion) : 'Sin datos recientes'}</div>
    </div>
    <div class="motor-card__footer">
      <button class="btn-ejecutar" id="btn-auditoria" onclick="ejecutarAuditoria(this)"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>Analizar ahora</button>
      ${total > 0 ? `<a href="/admin/anomalias" class="btn-ver-mas">Ver detalle →</a>` : '<span></span>'}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCIONES
// ═══════════════════════════════════════════════════════════════════════════
window.ejecutarMotor = async function(motor, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Ejecutando…'; }
  try {
    const resp = await fetch('/api/automatizacion?accion=ejecutar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ motor }),
    });
    const d = await resp.json();
    if (!resp.ok) throw new Error(d.error || resp.statusText);
    toast(`Motor "${motor}" ejecutado`, 'ok');
    setTimeout(cargarEstado, 1500);
  } catch (err) {
    console.error('[Auto] ejecutar motor:', err);
    toast('No se pudo ejecutar el motor', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>' + ({ piloto: 'Ejecutar', cierre: 'Procesar cola', stock: 'Analizar', score: 'Recalcular', rutas: 'Optimizar' }[motor] || 'Ejecutar'); }
  }
};

window.ejecutarAuditoria = async function(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Analizando…'; }
  try {
    const resp = await fetch('/api/auditoria?accion=analizar&dias=7', {
      headers: { Authorization: `Bearer ${_token()}` },
    });
    const d = await resp.json();
    if (!resp.ok) throw new Error(d.error || resp.statusText);
    const total = d.resultados?.[0]?.anomalias_detectadas ?? 0;
    toast(total > 0 ? `Se detectaron ${total} anomalía${total > 1 ? 's' : ''}` : 'Sin anomalías detectadas', total > 0 ? 'warn' : 'ok');
    setTimeout(cargarEstado, 1200);
  } catch (err) {
    console.error('[Auto] analizar anomalías:', err);
    toast('No se pudo completar el análisis', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;margin-right:4px"><polygon points="6 3 20 12 6 21 6 3"/></svg>Analizar ahora'; }
  }
};

window.aprobarOrdenPanel = async function(ordenId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const resp = await fetch('/api/stock-auto?accion=aprobar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orden_id: ordenId }),
    });
    const d = await resp.json();
    if (!resp.ok) throw new Error(d.error);
    toast('Orden aprobada', 'ok');
    // La orden ya se envió al proveedor; llevar al usuario a verla en
    // Compras en vez de dejarlo en el panel resumen sin contexto.
    setTimeout(() => { window.location.href = `/admin/compras?id=${ordenId}`; }, 700);
  } catch (err) {
    console.error('[Auto] aprobar orden:', err);
    toast('No se pudo aprobar la orden', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Aprobar'; }
  }
};

// ── Push Notifications ────────────────────────────────────────────────────
let _pushSub = null;
async function verificarPushEstado() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    _pushSub = await reg.pushManager.getSubscription();
    actualizarUIPush(!!_pushSub);
  } catch {}
}
function actualizarUIPush(activo) {
  const btn = q('#btn-push-toggle'), txt = q('#push-estado-txt'), prefs = q('#push-prefs');
  if (btn) { btn.textContent = activo ? 'Desactivar alertas' : 'Activar alertas'; btn.classList.toggle('btn-push--activo', activo); }
  if (txt) txt.textContent = activo ? 'Alertas activas — te avisamos cuando los motores detecten eventos críticos' : 'Recibí notificaciones cuando los motores detecten eventos críticos';
  if (prefs) prefs.style.display = activo ? 'block' : 'none';
}
window.togglePush = async function() {
  if (!('serviceWorker' in navigator)) { toast('Tu navegador no soporta push', 'warn'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Permiso denegado', 'warn'); return; }
    const reg = await navigator.serviceWorker.ready;
    if (_pushSub) {
      const endpoint = _pushSub.endpoint;
      // Cancelar primero en el server (mientras la subscription del browser
      // sigue viva) para poder reintentar si falla, en vez de desincronizar.
      const resp = await fetch('/api/automatizacion?accion=push-cancelar', { method: 'DELETE', headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
      if (!resp.ok) {
        console.warn('[Auto] push-cancelar error:', resp.status);
        toast('No se pudo desactivar las alertas — probá de nuevo', 'error');
        return;
      }
      await _pushSub.unsubscribe();
      _pushSub = null; actualizarUIPush(false); toast('Alertas desactivadas', 'info');
    } else {
      const vapidResp = await fetch('/api/automatizacion?accion=vapid-key', { headers: { Authorization: `Bearer ${_token()}` } });
      if (!vapidResp.ok) { toast('No se pudo obtener la configuración de alertas', 'error'); return; }
      const { key } = await vapidResp.json();
      if (!key) { toast('Push no configurado en el servidor', 'warn'); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const subResp = await fetch('/api/automatizacion?accion=push-suscribir', { method: 'POST', headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))), auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))) } }) });
      if (!subResp.ok) {
        console.warn('[Auto] push-suscribir error:', subResp.status);
        // No dejar una subscription huérfana en el browser si el server no la guardó.
        try { await sub.unsubscribe(); } catch {}
        toast('No se pudieron activar las alertas — probá de nuevo', 'error');
        return;
      }
      _pushSub = sub; actualizarUIPush(true); toast('Alertas activadas', 'ok');
    }
  } catch (err) { console.error('[Auto] activar push:', err); toast('No se pudieron activar las alertas', 'error'); }
};
window.guardarPref = async function(el) {
  const valorPrevio = !el.checked;
  try {
    const resp = await fetch('/api/automatizacion?accion=push-prefs', { method: 'POST', headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: el.id.replace('pref-', ''), valor: el.checked }) });
    if (!resp.ok) throw new Error('resp ' + resp.status);
  } catch (err) {
    console.warn('[Auto] guardarPref error:', err.message);
    el.checked = valorPrevio;
    toast('No se pudo guardar la preferencia', 'error');
  }
};

// FIX: cargarEstado se llama desde onclick="cargarEstado()" en el botón "Reintentar",
// pero al ser este archivo un módulo ES6 no queda accesible en window sin exponerla.
window.cargarEstado = cargarEstado;

// ═══════════════════════════════════════════════════════════════════════════
// REGLAS PERSONALIZADAS (Fase 6 — PLAN_ERP_SINCRONIZACION_2026.md)
// "Cuando pase X, si se cumple esto, avisame" — CRUD contra
// /api/reglas-automatizacion. El motor que las evalúa en tiempo real corre
// del lado del servidor (lib/reglas-automatizacion.js, llamado desde
// eventos-dispatcher.js); acá solo se administran.
// ═══════════════════════════════════════════════════════════════════════════

const EVENTO_LABELS = {
  pedido_creado:       'Se crea un pedido',
  pedido_facturado:    'Se factura un pedido',
  factura_anulada:     'Se anula una factura',
  cliente_en_mora:     'Un cliente entra en mora',
  cheques_por_vencer:  'Un cheque está por vencer',
};
const OPERADOR_LABELS = { '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤' };
const ROL_LABELS = { dueno: 'Dueño', admin: 'Admin', vendedor: 'Vendedor', contador: 'Contador', depositero: 'Depositero', chofer: 'Chofer' };

// Debe coincidir con TEMPLATES_WHATSAPP_DISPONIBLES en
// lib/reglas-automatizacion.js y lib/repos/reglas-automatizacion.js.
const WA_TEMPLATE_LABELS = {
  confirmacion_pedido: 'Confirmación de pedido',
  pedido_despachado:   'Pedido despachado',
  pedido_cancelado:    'Pedido cancelado',
  deuda_vencida:       'Deuda vencida',
  pedido_entregado:    'Pedido entregado',
  pedido_no_entregado: 'Pedido no entregado',
  pedido_por_llegar:   'Pedido por llegar (ETA)',
  cheques_por_vencer:  'Cheques por vencer',
  oferta_plan_pago:    'Oferta de plan de pago',
  ruta_asignada:       'Ruta asignada (chofer)',
};
const ACCION_TIPO_LABELS = { notificar_push: 'Notificación push', enviar_whatsapp: 'WhatsApp', crear_tarea: 'Tarea' };

let _reglasAuto = [];
let _eventosDisponibles = Object.keys(EVENTO_LABELS);
let _editandoReglaId = null;
let _tareasAuto = [];

async function apiReglasAuto(method, query = '', body = null) {
  const resp = await fetch(`/api/reglas-automatizacion${query}`, {
    method,
    headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data;
}

async function cargarReglasAuto() {
  const tbody = q('#tbody-reglas-auto');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--color-text-muted)">Cargando…</td></tr>`;
  try {
    const { reglas, eventos_disponibles } = await apiReglasAuto('GET');
    _reglasAuto = reglas || [];
    if (Array.isArray(eventos_disponibles) && eventos_disponibles.length) _eventosDisponibles = eventos_disponibles;
    renderReglasAuto();
  } catch (err) {
    console.error('[Auto] cargarReglasAuto:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--color-text-muted)">No se pudieron cargar las reglas</td></tr>`;
  }
}

function describirCondicionSimple(c) {
  const op = OPERADOR_LABELS[c.operador] || c.operador;
  return `${c.campo} ${op} ${c.valor}`;
}

function describirCondicion(condicion) {
  if (!condicion || typeof condicion !== 'object') return 'Siempre';
  if (Array.isArray(condicion.y) && condicion.y.length) {
    return condicion.y.map(describirCondicionSimple).join(' Y ');
  }
  if (Array.isArray(condicion.o) && condicion.o.length) {
    return condicion.o.map(describirCondicionSimple).join(' O ');
  }
  if (!condicion.campo) return 'Siempre';
  return describirCondicionSimple(condicion);
}

function describirAccion(accion) {
  if (!accion) return '—';
  if (accion.tipo === 'notificar_push') {
    const roles = (accion.roles || ['dueno', 'admin']).map(r => ROL_LABELS[r] || r).join(', ');
    return `Push a ${roles}: "${accion.titulo || ''}"`;
  }
  if (accion.tipo === 'enviar_whatsapp') {
    return `WhatsApp: ${WA_TEMPLATE_LABELS[accion.template] || accion.template || ''}`;
  }
  if (accion.tipo === 'crear_tarea') {
    const roles = (accion.roles || ['dueno', 'admin']).map(r => ROL_LABELS[r] || r).join(', ');
    return `Tarea para ${roles}: "${accion.titulo || ''}"`;
  }
  return '—';
}

function renderReglasAuto() {
  const tbody = q('#tbody-reglas-auto');
  const card  = q('#reglas-auto-card');
  const vacio = q('#reglas-auto-empty');
  if (!tbody) return;

  if (!_reglasAuto.length) {
    tbody.innerHTML = '';
    if (card)  card.querySelector('table').style.display = 'none';
    if (vacio) vacio.style.display = 'block';
    return;
  }
  if (card)  card.querySelector('table').style.display = '';
  if (vacio) vacio.style.display = 'none';

  tbody.innerHTML = _reglasAuto.map(r => `
    <tr class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalReglaAuto('${r.id}')">
      <td><strong>${escapeHtml(r.nombre)}</strong>${r.descripcion ? `<div style="font-size:12px;color:var(--color-text-muted)">${escapeHtml(r.descripcion)}</div>` : ''}</td>
      <td>${escapeHtml(EVENTO_LABELS[r.evento_disparador] || r.evento_disparador)}</td>
      <td style="font-family:var(--font-mono,monospace);font-size:12px">${escapeHtml(describirCondicion(r.condicion))}</td>
      <td style="font-size:13px">${escapeHtml(describirAccion(r.accion))}</td>
      <td>
        <span class="badge ${r.activa ? 'badge--success' : ''}" style="cursor:pointer" onclick="toggleReglaAuto('${r.id}', ${!r.activa})" title="Click para ${r.activa ? 'desactivar' : 'activar'}">
          ${r.activa ? 'Activa' : 'Inactiva'}
        </span>
      </td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn--ghost btn--icon btn--sm" onclick="abrirModalReglaAuto('${r.id}')" title="Editar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button type="button" class="btn btn--ghost btn--icon btn--sm" onclick="eliminarReglaAuto('${r.id}')" title="Eliminar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function poblarSelectEventos() {
  const sel = q('#ra-evento');
  if (!sel) return;
  sel.innerHTML = _eventosDisponibles.map(ev => `<option value="${ev}">${EVENTO_LABELS[ev] || ev}</option>`).join('');
}

function poblarSelectTemplatesWa() {
  const sel = q('#ra-wa-template');
  if (!sel) return;
  sel.innerHTML = Object.entries(WA_TEMPLATE_LABELS).map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}

function limpiarErroresReglaAuto() {
  ['ra-nombre', 'ra-titulo', 'ra-mensaje', 'ra-wa-template', 'ra-tarea-titulo'].forEach(id => {
    const err = q(`#${id}-error`);
    if (err) { err.style.display = 'none'; err.textContent = ''; }
  });
}

// ── Filas de condición (constructor y/o) ────────────────────────────────
function filaCondicionHtml(valores = {}) {
  const { campo = '', operador = '', valor = '' } = valores;
  return `
    <div class="ra-condicion-row">
      <input type="text" class="form-input ra-cond-campo" placeholder="Campo (ej: monto, cliente_nombre)" value="${escapeHtml(campo)}" />
      <select class="form-select ra-cond-operador">
        <option value="">— sin condición —</option>
        <option value="=" ${operador === '=' ? 'selected' : ''}>es igual a</option>
        <option value="!=" ${operador === '!=' ? 'selected' : ''}>es distinto de</option>
        <option value=">" ${operador === '>' ? 'selected' : ''}>es mayor que</option>
        <option value=">=" ${operador === '>=' ? 'selected' : ''}>es mayor o igual que</option>
        <option value="<" ${operador === '<' ? 'selected' : ''}>es menor que</option>
        <option value="<=" ${operador === '<=' ? 'selected' : ''}>es menor o igual que</option>
      </select>
      <input type="text" class="form-input ra-cond-valor" placeholder="Valor" value="${escapeHtml(valor)}" />
      <button type="button" class="ra-fila-quitar" onclick="quitarFilaCondicion(this)" title="Quitar condición">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

window.agregarFilaCondicion = function(valores) {
  const cont = q('#ra-cond-filas');
  if (!cont) return;
  cont.insertAdjacentHTML('beforeend', filaCondicionHtml(valores));
  actualizarVisibilidadCombinador();
};

window.quitarFilaCondicion = function(btn) {
  btn.closest('.ra-condicion-row')?.remove();
  actualizarVisibilidadCombinador();
};

function actualizarVisibilidadCombinador() {
  const filas = q('#ra-cond-filas')?.querySelectorAll('.ra-condicion-row').length || 0;
  const wrap = q('#ra-cond-combinador-wrap');
  if (wrap) wrap.style.display = filas > 1 ? 'block' : 'none';
}

function leerCondicionRegla() {
  const filas = Array.from(q('#ra-cond-filas')?.querySelectorAll('.ra-condicion-row') || []);
  const condiciones = [];
  for (const fila of filas) {
    const campo = fila.querySelector('.ra-cond-campo').value.trim();
    const operador = fila.querySelector('.ra-cond-operador').value;
    const valorRaw = fila.querySelector('.ra-cond-valor').value.trim();
    if (!campo || !operador) continue; // fila vacía o sin operador: se ignora, no se manda "siempre falsa"
    const valorNumerico = Number(valorRaw);
    condiciones.push({ campo, operador, valor: valorRaw !== '' && !Number.isNaN(valorNumerico) ? valorNumerico : valorRaw });
  }
  if (!condiciones.length) return {};
  if (condiciones.length === 1) return condiciones[0];
  const combinador = q('#ra-cond-combinador')?.value === 'o' ? 'o' : 'y';
  return { [combinador]: condiciones };
}

function cargarCondicionEnForm(condicion) {
  const cont = q('#ra-cond-filas');
  if (cont) cont.innerHTML = '';
  if (Array.isArray(condicion?.y) && condicion.y.length) {
    condicion.y.forEach(c => window.agregarFilaCondicion(c));
    if (q('#ra-cond-combinador')) q('#ra-cond-combinador').value = 'y';
  } else if (Array.isArray(condicion?.o) && condicion.o.length) {
    condicion.o.forEach(c => window.agregarFilaCondicion(c));
    if (q('#ra-cond-combinador')) q('#ra-cond-combinador').value = 'o';
  } else if (condicion?.campo) {
    window.agregarFilaCondicion(condicion);
  } else {
    window.agregarFilaCondicion();
  }
}

// ── Filas de parámetros de WhatsApp ─────────────────────────────────────
function filaParamWaHtml(clave = '', valor = '') {
  return `
    <div class="ra-param-row">
      <input type="text" class="form-input ra-wa-param-clave" placeholder="Nombre del parámetro (ej: monto_vencido)" value="${escapeHtml(clave)}" />
      <input type="text" class="form-input ra-wa-param-valor" placeholder="Valor" value="${escapeHtml(valor)}" />
      <button type="button" class="ra-fila-quitar" onclick="this.closest('.ra-param-row').remove()" title="Quitar parámetro">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

window.agregarFilaParamWa = function(clave, valor) {
  q('#ra-wa-params-filas')?.insertAdjacentHTML('beforeend', filaParamWaHtml(clave, valor));
};

function leerParamsWa() {
  const filas = Array.from(q('#ra-wa-params-filas')?.querySelectorAll('.ra-param-row') || []);
  const params = {};
  for (const fila of filas) {
    const clave = fila.querySelector('.ra-wa-param-clave').value.trim();
    const valor = fila.querySelector('.ra-wa-param-valor').value.trim();
    if (clave) params[clave] = valor;
  }
  return params;
}

function cargarParamsWaEnForm(params) {
  const cont = q('#ra-wa-params-filas');
  if (cont) cont.innerHTML = '';
  Object.entries(params || {}).forEach(([k, v]) => { if (k !== 'nombre_cliente') window.agregarFilaParamWa(k, v); });
}

// ── Selector de tipo de acción ──────────────────────────────────────────
window.cambiarTipoAccionRegla = function() {
  const tipo = q('#ra-accion-tipo').value;
  q('#ra-accion-push').style.display      = tipo === 'notificar_push'  ? '' : 'none';
  q('#ra-accion-whatsapp').style.display  = tipo === 'enviar_whatsapp' ? '' : 'none';
  q('#ra-accion-tarea').style.display     = tipo === 'crear_tarea'     ? '' : 'none';
};

window.abrirModalReglaAuto = function(id = null) {
  poblarSelectEventos();
  poblarSelectTemplatesWa();
  limpiarErroresReglaAuto();
  _editandoReglaId = id;

  const titulo = q('#modal-regla-auto-titulo');
  const regla = id ? _reglasAuto.find(r => r.id === id) : null;

  if (regla) {
    if (titulo) titulo.textContent = 'Editar regla personalizada';
    q('#ra-nombre').value = regla.nombre || '';
    q('#ra-evento').value = regla.evento_disparador || _eventosDisponibles[0];
    q('#ra-activa').checked = !!regla.activa;
    cargarCondicionEnForm(regla.condicion);

    const tipoAccion = regla.accion?.tipo || 'notificar_push';
    q('#ra-accion-tipo').value = tipoAccion;
    window.cambiarTipoAccionRegla();

    q('#ra-titulo').value = regla.accion?.titulo || '';
    q('#ra-mensaje').value = regla.accion?.mensaje || '';
    const rolesPush = (tipoAccion === 'notificar_push' && regla.accion?.roles) || ['dueno', 'admin'];
    q('#ra-roles-grid').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = rolesPush.includes(cb.value); });

    q('#ra-wa-template').value = regla.accion?.template || Object.keys(WA_TEMPLATE_LABELS)[0];
    cargarParamsWaEnForm(regla.accion?.params);

    q('#ra-tarea-titulo').value = tipoAccion === 'crear_tarea' ? (regla.accion?.titulo || '') : '';
    q('#ra-tarea-descripcion').value = regla.accion?.descripcion || '';
    const rolesTarea = (tipoAccion === 'crear_tarea' && regla.accion?.roles) || ['dueno', 'admin'];
    q('#ra-tarea-roles-grid').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = rolesTarea.includes(cb.value); });
  } else {
    if (titulo) titulo.textContent = 'Nueva regla personalizada';
    q('#ra-nombre').value = '';
    q('#ra-evento').value = _eventosDisponibles[0] || '';
    q('#ra-activa').checked = true;
    cargarCondicionEnForm({});

    q('#ra-accion-tipo').value = 'notificar_push';
    window.cambiarTipoAccionRegla();
    q('#ra-titulo').value = '';
    q('#ra-mensaje').value = '';
    q('#ra-roles-grid').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = cb.value === 'dueno' || cb.value === 'admin'; });

    q('#ra-wa-template').value = Object.keys(WA_TEMPLATE_LABELS)[0];
    cargarParamsWaEnForm({});

    q('#ra-tarea-titulo').value = '';
    q('#ra-tarea-descripcion').value = '';
    q('#ra-tarea-roles-grid').querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = cb.value === 'dueno' || cb.value === 'admin'; });
  }

  q('#modal-regla-auto-backdrop').style.display = 'block';
  q('#modal-regla-auto').style.display = 'flex';
  requestAnimationFrame(() => {
    q('#modal-regla-auto-backdrop').classList.add('visible');
    q('#ra-nombre').focus();
  });
};

window.cerrarModalReglaAuto = function() {
  q('#modal-regla-auto-backdrop').classList.remove('visible');
  q('#modal-regla-auto-backdrop').style.display = 'none';
  q('#modal-regla-auto').style.display = 'none';
  _editandoReglaId = null;
};

window.guardarReglaAuto = async function() {
  limpiarErroresReglaAuto();

  const nombre = q('#ra-nombre').value.trim();
  const evento_disparador = q('#ra-evento').value;
  const activa = q('#ra-activa').checked;
  const tipoAccion = q('#ra-accion-tipo').value;

  let huboError = false;
  if (!nombre) { mostrarErrorCampo('ra-nombre', 'El nombre es obligatorio'); huboError = true; }

  let accion = null;
  if (tipoAccion === 'notificar_push') {
    const titulo = q('#ra-titulo').value.trim();
    const mensaje = q('#ra-mensaje').value.trim();
    const roles = Array.from(q('#ra-roles-grid').querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    if (!titulo) { mostrarErrorCampo('ra-titulo', 'El título es obligatorio'); huboError = true; }
    if (!mensaje) { mostrarErrorCampo('ra-mensaje', 'El mensaje es obligatorio'); huboError = true; }
    accion = { tipo: 'notificar_push', titulo, mensaje, roles: roles.length ? roles : ['dueno', 'admin'] };
  } else if (tipoAccion === 'enviar_whatsapp') {
    const template = q('#ra-wa-template').value;
    if (!template) { mostrarErrorCampo('ra-wa-template', 'Elegí una plantilla'); huboError = true; }
    accion = { tipo: 'enviar_whatsapp', template, params: leerParamsWa() };
  } else if (tipoAccion === 'crear_tarea') {
    const tituloTarea = q('#ra-tarea-titulo').value.trim();
    const descripcion = q('#ra-tarea-descripcion').value.trim();
    const roles = Array.from(q('#ra-tarea-roles-grid').querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
    if (!tituloTarea) { mostrarErrorCampo('ra-tarea-titulo', 'El título es obligatorio'); huboError = true; }
    accion = { tipo: 'crear_tarea', titulo: tituloTarea, descripcion: descripcion || undefined, roles: roles.length ? roles : ['dueno', 'admin'] };
  }

  if (huboError) return;

  const payload = {
    nombre,
    evento_disparador,
    condicion: leerCondicionRegla(),
    accion,
    activa,
  };

  const btn = q('#btn-guardar-regla-auto');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    if (_editandoReglaId) {
      await apiReglasAuto('PATCH', `?id=${_editandoReglaId}`, payload);
      toast('Regla actualizada', 'ok');
    } else {
      await apiReglasAuto('POST', '', payload);
      toast('Regla creada', 'ok');
    }
    window.cerrarModalReglaAuto();
    await cargarReglasAuto();
  } catch (err) {
    console.error('[Auto] guardarReglaAuto:', err);
    toast(err.message || 'No se pudo guardar la regla', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar regla'; }
  }
};

function mostrarErrorCampo(id, msg) {
  const err = q(`#${id}-error`);
  if (err) { err.textContent = msg; err.style.display = 'block'; }
}

window.toggleReglaAuto = async function(id, nuevoValor) {
  try {
    await apiReglasAuto('POST', '?_svc=toggle', { id, activa: nuevoValor });
    toast(nuevoValor ? 'Regla activada' : 'Regla desactivada', 'ok');
    await cargarReglasAuto();
  } catch (err) {
    console.error('[Auto] toggleReglaAuto:', err);
    toast('No se pudo cambiar el estado de la regla', 'error');
  }
};

window.eliminarReglaAuto = async function(id) {
  const regla = _reglasAuto.find(r => r.id === id);
  if (!confirm(`¿Eliminar la regla "${regla?.nombre || ''}"? Esta acción no se puede deshacer.`)) return;
  try {
    await apiReglasAuto('DELETE', `?id=${id}`);
    toast('Regla eliminada', 'ok');
    await cargarReglasAuto();
  } catch (err) {
    console.error('[Auto] eliminarReglaAuto:', err);
    toast('No se pudo eliminar la regla', 'error');
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// TAREAS (Fase 6b) — pendientes creados por la acción "crear_tarea" de una
// regla. Cualquier rol interno al que la tarea le fue asignada puede verla y
// completarla (no solo dueño/admin, a diferencia del ABM de reglas de
// arriba) — ver ROLES_TAREAS en lib/handlers/reglas-automatizacion.js.
// ═══════════════════════════════════════════════════════════════════════════

async function apiTareasAuto(query, opts) {
  const resp = await fetch(`/api/reglas-automatizacion${query}`, {
    method: opts?.method || 'GET',
    headers: { Authorization: `Bearer ${_token()}`, 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data;
}

async function cargarTareasAuto() {
  const tbody = q('#tbody-tareas-auto');
  if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--color-text-muted)">Cargando…</td></tr>`;
  try {
    const { tareas } = await apiTareasAuto('?_svc=tareas');
    _tareasAuto = tareas || [];
    renderTareasAuto();
  } catch (err) {
    console.error('[Auto] cargarTareasAuto:', err);
    // Fail-quiet: si el usuario no tiene permiso (rol externo) o falla la
    // carga, la sección de tareas no debe romper el resto del panel.
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--color-text-muted)">No se pudieron cargar las tareas</td></tr>`;
  }
}

function renderTareasAuto() {
  const tbody = q('#tbody-tareas-auto');
  const card  = q('#tareas-auto-card');
  const vacio = q('#tareas-auto-empty');
  if (!tbody) return;

  if (!_tareasAuto.length) {
    tbody.innerHTML = '';
    if (card)  card.querySelector('table').style.display = 'none';
    if (vacio) vacio.style.display = 'block';
    return;
  }
  if (card)  card.querySelector('table').style.display = '';
  if (vacio) vacio.style.display = 'none';

  tbody.innerHTML = _tareasAuto.map(t => `
    <tr>
      <td><strong>${escapeHtml(t.titulo)}</strong>${t.descripcion ? `<div style="font-size:12px;color:var(--color-text-muted)">${escapeHtml(t.descripcion)}</div>` : ''}</td>
      <td style="font-size:13px">${escapeHtml(EVENTO_LABELS[t.evento_disparador] || t.evento_disparador)}</td>
      <td style="font-size:13px">${formatTs(t.created_at)}</td>
      <td><span class="badge">Pendiente</span></td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn--ghost btn--icon btn--sm" onclick="completarTareaAuto('${t.id}')" title="Marcar como completada">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
}

window.completarTareaAuto = async function(id) {
  try {
    await apiTareasAuto('?_svc=tareas-completar', { method: 'POST', body: { id } });
    toast('Tarea completada', 'ok');
    await cargarTareasAuto();
  } catch (err) {
    console.error('[Auto] completarTareaAuto:', err);
    toast('No se pudo completar la tarea', 'error');
  }
};
