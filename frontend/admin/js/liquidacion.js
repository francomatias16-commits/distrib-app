// frontend/admin/js/liquidacion.js — Innovación #1 (roadmap-innovaciones-distrib.md)
// Backend: lib/handlers/stock.js → handleLiquidacion()
//   GET  /api/liquidacion                    → listar ofertas activas
//   GET  /api/liquidacion?accion=reglas      → reglas_liquidacion de la empresa
//   POST /api/liquidacion?accion=guardar-reglas
//   POST /api/liquidacion?accion=generar     → disparo manual (solo dueno/admin)

const ROLES_EDITAR = ['dueno', 'admin'];

let todasOfertas = [];

async function api(path, opts = {}) {
  const sess = (await window.authCtx.sb.auth.getSession()).data.session;
  if (!sess) return null;
  const r = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${sess.access_token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return r.json();
}

window.authReady
  .then(() => init())
  .catch((err) => {
    console.error('[auth] authReady falló:', err?.message);
    if (!window.authCtx || !window.authCtx.perfil) window.location.href = '/admin/login';
  });

async function init() {
  const hoy = new Date();
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const user = window.authCtx?.perfil;
  if (!user) return;
  document.getElementById('topbar-usuario').textContent = user.nombre || user.email;

  const puedeEditar = ROLES_EDITAR.includes(user.rol);
  document.getElementById('btn-generar-ahora').style.display = puedeEditar ? 'inline-flex' : 'none';
  document.getElementById('reglas-footer').style.display = puedeEditar ? 'flex' : 'none';
  document.querySelectorAll('#reg-activo, .form-grid input').forEach(el => el.disabled = !puedeEditar);

  await Promise.all([cargarReglas(), cargarOfertas()]);
}

// ── Reglas ──────────────────────────────────────────────────────────────
async function cargarReglas() {
  try {
    const data = await api('/api/liquidacion?accion=reglas');
    const r = data?.reglas || {};
    document.getElementById('reg-activo').checked     = r.activo !== false;
    document.getElementById('reg-dias-alerta').value   = r.dias_alerta ?? 7;
    document.getElementById('reg-dias-n1').value       = r.dias_nivel1 ?? 3;
    document.getElementById('reg-pct-n1').value        = r.pct_nivel1 ?? 10;
    document.getElementById('reg-dias-n2').value       = r.dias_nivel2 ?? 1;
    document.getElementById('reg-pct-n2').value        = r.pct_nivel2 ?? 15;
    document.getElementById('reg-dias-n3').value       = r.dias_nivel3 ?? 0;
    document.getElementById('reg-pct-n3').value        = r.pct_nivel3 ?? 25;
  } catch (e) {
    console.error(e);
    mostrarToast('No se pudieron cargar las reglas', 'err');
  }
}

async function guardarReglas() {
  const ok = await window.confirmar('¿Guardar las reglas de liquidación? Afecta los descuentos automáticos de todos los productos con vencimiento próximo.', { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;

  const btn = document.getElementById('btn-guardar-reglas');
  btn.disabled = true; btn.textContent = 'Guardando...';

  try {
    const payload = {
      activo:      document.getElementById('reg-activo').checked,
      dias_alerta: Number(document.getElementById('reg-dias-alerta').value),
      dias_nivel1: Number(document.getElementById('reg-dias-n1').value),
      pct_nivel1:  Number(document.getElementById('reg-pct-n1').value),
      dias_nivel2: Number(document.getElementById('reg-dias-n2').value),
      pct_nivel2:  Number(document.getElementById('reg-pct-n2').value),
      dias_nivel3: Number(document.getElementById('reg-dias-n3').value),
      pct_nivel3:  Number(document.getElementById('reg-pct-n3').value),
    };
    const data = await api('/api/liquidacion?accion=guardar-reglas', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!data?.ok) throw new Error(data?.error || 'No se pudieron guardar las reglas');
    mostrarToast('Reglas guardadas', 'ok');
  } catch (e) {
    console.error(e);
    mostrarToast(e.message?.startsWith('No se pudieron') ? e.message : 'No se pudieron guardar las reglas. Probá de nuevo.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar reglas';
  }
}

// ── Ofertas activas ──────────────────────────────────────────────────────
async function cargarOfertas() {
  try {
    const data = await api('/api/liquidacion');
    todasOfertas = data?.ofertas || [];
    renderKPIs(todasOfertas);
    renderTablaOfertas(todasOfertas);
  } catch (e) {
    console.error(e);
    mostrarToast('No se pudieron cargar las ofertas', 'err');
  }
}

function renderKPIs(ofertas) {
  document.getElementById('kpi-activas').textContent = ofertas.length;

  if (!ofertas.length) {
    document.getElementById('kpi-descuento').textContent = '0%';
    document.getElementById('kpi-proxima').textContent = '—';
    document.getElementById('kpi-proxima-sub').textContent = 'sin ofertas activas';
    return;
  }

  const promDescuento = ofertas.reduce((s, o) => s + (+o.descuento_pct || 0), 0) / ofertas.length;
  document.getElementById('kpi-descuento').textContent = promDescuento.toFixed(1) + '%';

  const proxima = [...ofertas].sort((a, b) => new Date(a.vence_oferta_at) - new Date(b.vence_oferta_at))[0];
  const dias = Math.max(0, Math.ceil((new Date(proxima.vence_oferta_at) - new Date()) / 86400000));
  document.getElementById('kpi-proxima').textContent = dias === 0 ? 'Hoy' : `${dias} día(s)`;
  document.getElementById('kpi-proxima-sub').textContent = proxima.productos?.nombre || '—';
}

function renderTablaOfertas(lista) {
  const tbody = document.getElementById('tbody-ofertas');
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No hay ofertas de liquidación activas. Se generan desde lotes próximos a vencer con «Generar ofertas ahora».</div></td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(o => {
    const p = o.productos || {};
    const l = o.lotes || {};
    return `<tr>
      <td>${window.sanitize(p.nombre || '—')} <span style="color:var(--color-text-light);font-size:11px">(${window.sanitize(p.codigo || '—')})</span></td>
      <td style="font-family:monospace">${l.numero_lote ? window.sanitize(l.numero_lote) : '—'}</td>
      <td>${formatPeso(p.precio_base)}</td>
      <td class="monto monto-verde">${formatPeso(o.precio_oferta)}</td>
      <td><span class="chip chip-rojo">-${(+o.descuento_pct).toFixed(0)}%</span></td>
      <td>${o.cantidad_snapshot}</td>
      <td>${formatFecha(o.vence_oferta_at)}</td>
    </tr>`;
  }).join('');
}

function filtrarOfertas() {
  const q = document.getElementById('buscar-oferta').value.toLowerCase();
  const filtrado = todasOfertas.filter(o => {
    const nombre = (o.productos?.nombre || '').toLowerCase();
    const codigo = (o.productos?.codigo || '').toLowerCase();
    return !q || nombre.includes(q) || codigo.includes(q);
  });
  renderTablaOfertas(filtrado);
}

// ── Disparo manual ───────────────────────────────────────────────────────
async function generarOfertasAhora() {
  const btn = document.getElementById('btn-generar-ahora');
  btn.disabled = true;

  try {
    const data = await api('/api/liquidacion?accion=generar', { method: 'POST' });
    if (!data?.ok) throw new Error(data?.resultados?.[0]?.error || 'No se pudieron generar las ofertas');

    const r = data.resultados?.[0] || {};
    const creadas = r.creadas?.length || 0;
    mostrarToast(`Listo: ${creadas} oferta(s) generada(s)/actualizada(s)`, 'ok');
    await cargarOfertas();
  } catch (e) {
    console.error(e);
    mostrarToast(e.message?.startsWith('No se pudieron') ? e.message : 'No se pudieron generar las ofertas. Probá de nuevo.', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function formatPeso(n) {
  return '$' + (+n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatFecha(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

window.filtrarOfertas        = filtrarOfertas;
window.guardarReglas         = guardarReglas;

window.filtrarOfertas        = filtrarOfertas;
window.guardarReglas         = guardarReglas;
window.generarOfertasAhora   = generarOfertasAhora;
