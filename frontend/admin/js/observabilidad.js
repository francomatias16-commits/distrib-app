/* admin/js/observabilidad.js — "Salud del sistema"
   PLAN_ERP_SINCRONIZACION_2026.md — Fase 8 (observabilidad continua).
   Consume GET /api/admin/salud-eventos y GET /api/admin/metricas-negocio
   (ver lib/handlers/admin.js). Ambos leen eventos_negocio (Fase 1) — no
   hay tabla ni motor de métricas nuevo, esto es agregación sobre lo que
   las fases 1-3 ya generan. */

function _tok() {
  return window.authCtx?.session?.access_token || '';
}

function _fechaCorta(fechaISO) {
  if (!fechaISO) return '—';
  const d = new Date(fechaISO);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function _msALegible(ms) {
  if (ms == null) return '—';
  const seg = ms / 1000;
  if (seg < 60) return `${Math.round(seg)} seg`;
  const min = seg / 60;
  if (min < 60) return `${Math.round(min)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

window.authReady.then(async (ctx) => {
  const perfil = ctx?.perfil;
  if (!perfil || !['dueno', 'admin'].includes(perfil.rol)) {
    document.getElementById('sin-permiso').classList.remove('hidden');
    document.getElementById('contenido-obs').style.display = 'none';
    return;
  }
  const usr = document.getElementById('topbar-usuario');
  if (usr) usr.textContent = perfil.nombre || perfil.email || '';
  cargarTodo();
}).catch(err => console.error('[observabilidad] authReady falló:', err?.message));

async function cargarTodo() {
  const horas = document.getElementById('horas-select')?.value || 24;
  document.getElementById('skeleton-salud').style.display = 'flex';
  document.getElementById('bloque-salud').style.display = 'none';

  try {
    const headers = { Authorization: `Bearer ${_tok()}` };
    const [respSalud, respMetricas] = await Promise.all([
      fetch(`/api/admin/salud-eventos?horas=${encodeURIComponent(horas)}`, { headers }),
      fetch(`/api/admin/metricas-negocio?horas=${encodeURIComponent(horas)}`, { headers }),
    ]);
    if (!respSalud.ok)    throw new Error('No se pudo cargar la salud del bus de eventos.');
    if (!respMetricas.ok) throw new Error('No se pudieron cargar las métricas de negocio.');

    const salud     = await respSalud.json();
    const metricas  = await respMetricas.json();

    renderResumen(salud.resumen);
    renderPorTipo(salud.por_tipo || []);
    renderEnError(salud.en_error_prolongado || []);
    renderPedidosPorHora(metricas.pedidos_por_hora || []);
    renderTiempoFacturacion(metricas.tiempo_promedio_pedido_facturacion);

    document.getElementById('skeleton-salud').style.display = 'none';
    document.getElementById('bloque-salud').style.display = 'block';
  } catch (err) {
    console.error('[observabilidad] cargarTodo falló:', err.message);
    if (window.toast) window.toast('No se pudo cargar la salud del sistema.', 'error');
    document.getElementById('skeleton-salud').style.display = 'none';
  }
}

function renderResumen(resumen) {
  const cont = document.getElementById('cards-resumen');
  const r = resumen || { total: 0, pendiente: 0, procesado: 0, error: 0, pendiente_sin_listener: 0 };
  const sinListener = r.pendiente_sin_listener || 0;
  // Los pendientes "sin listener" (tipos de evento sin reacción migrada
  // todavía, ver TIPOS_EVENTO_SIN_LISTENER) van a quedar así para siempre
  // por diseño — se aclara en la propia card para no leerse como una cola
  // atascada del despachador.
  const notaSinListener = sinListener > 0
    ? `<div class="obs-card-nota">de los cuales ${sinListener} son de tipos sin listener asignado (trazabilidad, no requiere acción)</div>`
    : '';
  cont.innerHTML = `
    <div class="obs-card"><div class="valor">${r.total}</div><div class="label">Eventos totales</div></div>
    <div class="obs-card card-procesado"><div class="valor">${r.procesado}</div><div class="label">Procesados</div></div>
    <div class="obs-card card-pendiente"><div class="valor">${r.pendiente}</div><div class="label">Pendientes</div>${notaSinListener}</div>
    <div class="obs-card card-error"><div class="valor">${r.error}</div><div class="label">En error</div></div>
  `;
}

function renderPorTipo(porTipo) {
  const body  = document.getElementById('tabla-por-tipo-body');
  const vacio = document.getElementById('tabla-por-tipo-vacio');
  if (!porTipo.length) {
    document.getElementById('tabla-por-tipo').style.display = 'none';
    vacio.classList.remove('hidden');
    return;
  }
  document.getElementById('tabla-por-tipo').style.display = '';
  vacio.classList.add('hidden');

  body.innerHTML = porTipo.map(t => `
    <tr>
      <td>${window.sanitize(t.tipo_evento)}${t.sin_listener ? ' <span class="badge-sin-listener" title="Sin listener asignado — queda en pendiente por diseño, es trazabilidad">sin listener</span>' : ''}</td>
      <td class="num">${t.total}</td>
      <td class="num">${t.pendiente}</td>
      <td class="num">${t.procesado}</td>
      <td class="num">${t.error}</td>
      <td class="num">${_msALegible(t.tiempo_promedio_procesamiento_ms)}</td>
    </tr>
  `).join('');
}

function renderEnError(eventos) {
  const body  = document.getElementById('tabla-error-body');
  const vacio = document.getElementById('tabla-error-vacio');
  if (!eventos.length) {
    document.getElementById('tabla-error').style.display = 'none';
    vacio.classList.remove('hidden');
    return;
  }
  document.getElementById('tabla-error').style.display = '';
  vacio.classList.add('hidden');

  body.innerHTML = eventos.map(ev => `
    <tr>
      <td><span class="badge-estado badge-error">${window.sanitize(ev.tipo_evento)}</span></td>
      <td>${window.sanitize(ev.origen || '—')}</td>
      <td>${_fechaCorta(ev.procesado_en)}</td>
    </tr>
  `).join('');
}

function renderPedidosPorHora(serie) {
  const cont  = document.getElementById('barras-pedidos');
  const vacio = document.getElementById('barras-pedidos-vacio');
  if (!serie.length) {
    cont.style.display = 'none';
    vacio.classList.remove('hidden');
    return;
  }
  cont.style.display = 'flex';
  vacio.classList.add('hidden');

  const max = Math.max(...serie.map(s => s.cantidad), 1);
  cont.innerHTML = serie.map(s => {
    const hora = new Date(s.hora).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit' });
    const pct  = Math.round((s.cantidad / max) * 100);
    return `<div class="obs-barra-fila">
      <span class="obs-barra-hora">${hora}h</span>
      <span class="obs-barra-track"><span class="obs-barra-fill" style="width:${pct}%"></span></span>
      <span class="obs-barra-cant">${s.cantidad}</span>
    </div>`;
  }).join('');
}

function renderTiempoFacturacion(datos) {
  const cont = document.getElementById('card-tiempo-facturacion');
  const muestras = datos?.muestras || 0;
  const prom = datos?.promedio_minutos;
  cont.innerHTML = `
    <div class="obs-card"><div class="valor">${muestras}</div><div class="label">Pedidos facturados (con dato)</div></div>
    <div class="obs-card"><div class="valor">${prom != null ? `${prom} min` : '—'}</div><div class="label">Promedio pedido → factura</div></div>
  `;
}
