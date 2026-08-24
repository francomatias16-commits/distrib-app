// frontend/admin/js/rutas-resumen.js
// Tab "Resumen" de Repartos — dashboard con datos reales (rutas, entregas,
// choferes, cta_cte). Réplica visual del layout tipo "Logistic Dashboard".

let sb = null;
let empresaId = null;
let _mapaResumen = null;
let _mapaResumenMarkers = [];
let _clienteCobroSeleccionado = null;
let _clientesHoy = [];
let _rutasResumenHoy = [];
let _filtroResumenActual = 'all';

document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady?.catch(() => {});
  if (!window.authCtx) return; // rutas.js ya redirige a login si corresponde
  sb        = window.authCtx.sb;
  empresaId = window.authCtx.perfil.empresa_id;
  await cargarResumenRepartos();
  animarCamionResumen();
});

function animarCamionResumen() {
  const wrap = document.getElementById('resumen-truck-wrap');
  if (!wrap) return;
  wrap.classList.remove('animar');
  void wrap.offsetWidth; // fuerza reflow para poder repetir la animación
  wrap.classList.add('animar');
}
window.animarCamionResumen = animarCamionResumen;

async function cargarResumenRepartos() {
  if (!sb || !empresaId) {
    if (!window.authCtx) return;
    sb        = window.authCtx.sb;
    empresaId = window.authCtx.perfil.empresa_id;
  }
  await Promise.all([
    cargarPedidosSemana(),
    cargarDetalleHoy(),
    cargarCobrosSemana(),
    cargarCobrosHoy(),
  ]);
}

// ── Helpers de fecha ─────────────────────────────────────────────────────
function fechaISO(d) { return d.toISOString().split('T')[0]; }
// FIX (auditoría UX etapa 16, Hallazgo 1): fechaISO(new Date()) usaba
// toISOString() (UTC) -- de 21:00 a 00:00 hora Argentina la Torre de
// Control se veía vacía/desactualizada. fechaISO(d) sigue igual para
// convertir fechas ya construidas en hora local (ej. restarDias), donde
// no tiene este problema.
function hoyISO() { return window.hoyLocalISO ? window.hoyLocalISO() : fechaISO(new Date()); }
function restarDias(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return fechaISO(d);
}
function formatARS(n) {
  return window.formatARS ? window.formatARS(n) : '$' + (n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
}
function formatNumero(n) {
  return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 1 });
}
function textoFechaCorta(iso) {
  return new Date(iso + 'T00:00:00')
    .toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' })
    .replace('.', '');
}
function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
function estadoRutaUi(estado) {
  // Supabase conserva `en_curso`; la interfaz lo presenta como En tránsito.
  return estado === 'en_curso' ? 'en_camino' : estado;
}
function estadoPedidoUi(estado) {
  if (estado === 'en_curso') return 'en_camino';
  return estado || 'pendiente';
}
function entregasOrdenadas(entregas) {
  return [...(entregas || [])].sort((a, b) => {
    const ordenA = Number.isFinite(Number(a?.orden)) ? Number(a.orden) : Number.MAX_SAFE_INTEGER;
    const ordenB = Number.isFinite(Number(b?.orden)) ? Number(b.orden) : Number.MAX_SAFE_INTEGER;
    return ordenA - ordenB;
  });
}
function nombreClientePedido(entrega) {
  return entrega?.pedidos?.clientes?.razon_social ||
    entrega?.pedidos?.clientes?.nombre_fantasia ||
    'Cliente sin nombre';
}

// ── 1. Pedidos despachados — últimos 7 días (mini bar chart) ────────────
async function cargarPedidosSemana() {
  const hoy   = hoyISO();
  const desde = restarDias(hoy, 6);

  const { data, error } = await sb
    .from('rutas')
    .select('id, fecha, entregas(id)')
    .eq('empresa_id', empresaId)
    .gte('fecha', desde)
    .lte('fecha', hoy);

  const wrap = document.getElementById('resumen-minibar-wrap');
  if (error || !data) {
    wrap.innerHTML = '<div class="empty-state" style="padding:20px;">No se pudo cargar</div>';
    return;
  }

  // Contar pedidos (entregas) por día
  const porDia = {};
  for (let i = 0; i <= 6; i++) porDia[restarDias(hoy, 6 - i)] = 0;
  data.forEach(r => {
    const n = r.entregas?.length || 0;
    if (porDia[r.fecha] !== undefined) porDia[r.fecha] += n;
  });

  const valores = Object.values(porDia);
  const max = Math.max(1, ...valores);
  const total = valores.reduce((a, b) => a + b, 0);
  const pico = Math.max(...valores);
  const fechaPico = Object.entries(porDia).find(([, n]) => n === pico)?.[0];

  document.getElementById('resumen-badge-fecha').textContent =
    new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  document.getElementById('resumen-rutas-semana-sub').textContent =
    `${total} pedido${total !== 1 ? 's' : ''} en 7 días`;
  document.getElementById('resumen-pedidos-promedio').textContent =
    `${formatNumero(total / 7)} por día`;
  document.getElementById('resumen-pedidos-pico').textContent =
    pico > 0 ? `${textoFechaCorta(fechaPico)} · ${pico}` : 'Sin despachos';

  wrap.innerHTML = Object.entries(porDia).map(([fecha, n]) => {
    const pct = Math.max(4, Math.round((n / max) * 100));
    const esHoy = fecha === hoy;
    const label = new Date(fecha + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', '');
    return `
      <div class="resumen-minibar-col ${esHoy ? 'is-today' : ''}">
        ${esHoy ? `<div class="resumen-minibar-tooltip">${n}</div>` : ''}
        <div class="resumen-minibar" style="height:${pct}%;" title="${n} pedidos"></div>
        <div class="resumen-minibar-label">${label}</div>
      </div>`;
  }).join('');
}

// ── 2. Detalle de hoy: gauge, carga por chofer, choferes en calle, tracking ─
async function cargarDetalleHoy() {
  const hoy = hoyISO();
  const ayer = restarDias(hoy, 1);

  const [{ data: rutasHoy, error }, { data: rutasAyer }] = await Promise.all([
    sb.from('rutas')
      .select(`
        id, fecha, estado, created_at, chofer_id, notas,
        usuarios(nombre),
        entregas(
          id, pedido_id, estado, orden, fecha_confirmacion,
          pedidos(id, total, clientes(id, razon_social, nombre_fantasia, domicilio, lat, lng, zonas(nombre)))
        )
      `)
      .eq('empresa_id', empresaId)
      .eq('fecha', hoy)
      .order('created_at', { ascending: false }),
    sb.from('rutas').select('id').eq('empresa_id', empresaId).eq('fecha', ayer),
  ]);

  if (error || !rutasHoy) return;

  _rutasResumenHoy = rutasHoy;
  renderGaugeEntregas(rutasHoy);
  renderChoferesEnCalle(rutasHoy, rutasAyer?.length || 0);
  renderTrackingHoy(rutasHoy);
  prepararClientesCobroRapido(rutasHoy);
}

let _gaugeEntregasChart = null;
function renderGaugeEntregas(rutas) {
  const todas = rutas.flatMap(r => r.entregas || []);
  const total = todas.length;
  const entregadas = todas.filter(e => e.estado === 'entregado').length;
  const pct = total ? Math.round((entregadas / total) * 100) : 0;
  const choferes = new Set(rutas.map(r => r.chofer_id).filter(Boolean)).size;

  if (typeof inicializarTemaECharts === 'function') inicializarTemaECharts();

  const css = getComputedStyle(document.documentElement);
  const colorSuccess = css.getPropertyValue('--color-success').trim();
  const colorBorder = css.getPropertyValue('--color-border').trim();
  const colorText = css.getPropertyValue('--color-text').trim();

  _gaugeEntregasChart = crearGraficoECharts(_gaugeEntregasChart, 'resumen-gauge', {
    tooltip: {
      trigger: 'item',
      formatter: () => total ? `${entregadas} de ${total} entregas` : 'Sin entregas hoy',
    },
    series: [{
      type: 'pie',
      radius: ['76%', '100%'],
      center: ['50%', '50%'],
      silent: false,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: css.getPropertyValue('--color-surface').trim(), borderWidth: 2 },
      emphasis: { scaleSize: 4 },
      data: total
        ? [
            { name: 'Entregadas', value: entregadas, itemStyle: { color: colorSuccess } },
            { name: 'Pendientes', value: total - entregadas, itemStyle: { color: colorBorder } },
          ]
        : [{ name: 'Sin datos', value: 1, itemStyle: { color: colorBorder } }],
    }],
    graphic: {
      elements: [{
        type: 'text', left: 'center', top: 'center',
        style: { text: total ? `${pct}%` : '—', fontSize: 20, fontWeight: 800, fill: colorText },
      }],
    },
  }, { notMerge: true });

  document.getElementById('resumen-gauge-ok').textContent = `${entregadas} entregada${entregadas !== 1 ? 's' : ''}`;
  document.getElementById('resumen-gauge-pend').textContent = `${total - entregadas} pendiente${(total - entregadas) !== 1 ? 's' : ''}`;
  document.getElementById('resumen-entregas-avance').textContent =
    total ? `${entregadas}/${total} · ${pct}%` : 'Sin entregas';
  document.getElementById('resumen-entregas-rutas').textContent =
    `${rutas.length} ruta${rutas.length !== 1 ? 's' : ''} · ${choferes} chofer${choferes !== 1 ? 'es' : ''}`;
}

function renderChoferesEnCalle(rutas, ayerCount) {
  const totalRutas = rutas.length;
  const enCamino = rutas.filter(r => estadoRutaUi(r.estado) === 'en_camino').length;
  const pendiente = rutas.filter(r => estadoRutaUi(r.estado) === 'pendiente').length;
  const completada = rutas.filter(r => estadoRutaUi(r.estado) === 'completada').length;
  const cancelada = rutas.filter(r => estadoRutaUi(r.estado) === 'cancelada').length;
  const riesgo = pendiente + cancelada;

  document.getElementById('resumen-choferes-count').textContent = totalRutas;
  document.getElementById('resumen-signal-en-ruta')?.replaceChildren(document.createTextNode(enCamino));
  document.getElementById('resumen-signal-riesgo')?.replaceChildren(document.createTextNode(riesgo));
  document.getElementById('resumen-signal-completada')?.replaceChildren(document.createTextNode(completada));
  document.getElementById('resumen-signal-total')?.replaceChildren(document.createTextNode(totalRutas));

  const delta = totalRutas - ayerCount;
  const deltaEl = document.getElementById('resumen-choferes-delta');
  if (ayerCount === 0 && totalRutas === 0) {
    deltaEl.textContent = 'Sin datos de ayer';
  } else {
    const signo = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
    deltaEl.textContent = `${signo} ${Math.abs(delta)} ruta${Math.abs(delta) === 1 ? '' : 's'} vs. ayer`;
  }

  document.getElementById('resumen-leg-en-camino').textContent = `● En ruta ${enCamino}`;
  document.getElementById('resumen-leg-pendiente').textContent = cancelada ? `● Pendiente ${pendiente} · Cancelada ${cancelada}` : `● Pendiente ${pendiente}`;
  document.getElementById('resumen-leg-completada').textContent = `● Completada ${completada}`;

  const listEl = document.getElementById('resumen-chofer-list');
  if (!rutas.length) {
    listEl.innerHTML = '<div class="empty-state" style="padding:24px;">No hay rutas creadas para hoy</div>';
    document.getElementById('resumen-chofer-filter-empty').hidden = true;
    actualizarIndicadorScrollPedidos();
    return;
  }

  const labelMap = { pendiente: 'Pendiente', en_camino: 'En tránsito', completada: 'Completada', cancelada: 'Cancelada' };
  const stateIcon = { pendiente: '!', en_camino: '→', completada: '✓', cancelada: '×' };
  listEl.innerHTML = rutas.map((r, index) => {
    const entregas = r.entregas || [];
    const n = entregas.length;
    const entregadas = entregas.filter(e => e.estado === 'entregado').length;
    const estadoUi = estadoRutaUi(r.estado || 'pendiente');
    const progress = n ? Math.round((entregadas / n) * 100) : (estadoUi === 'completada' ? 100 : 0);
    const hora = r.created_at ? new Date(r.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—';
    const zonas = [...new Set(entregas.map(e => e.pedidos?.clientes?.zonas?.nombre).filter(Boolean))];
    const zonaLabel = zonas.length ? zonas.slice(0, 2).join(' · ') : 'Zona sin asignar';
    const nota = r.notas ? esc(r.notas) : 'Sin observaciones';
    const routeId = String(r.id || '').replace(/'/g, "\\'");
    const riskClass = estadoUi === 'pendiente' ? ' route-row--risk' : estadoUi === 'cancelada' ? ' route-row--danger' : '';
    const pedidosOrdenados = entregasOrdenadas(entregas);
    return `
      <article class="route-row route-row--${esc(estadoUi)}${riskClass}" data-route-state="${esc(estadoUi)}" data-route-id="${esc(r.id || '')}">
        <div class="route-group-head">
          <button type="button" class="route-group-select" onclick="seleccionarRutaResumen('${routeId}')" aria-label="Seguir ${labelMap[estadoUi] || 'reparto'} ${esc(r.id?.slice(0, 8) || 'sin ID')}">
            <span class="route-row-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
            <span class="route-group-identity">
              <span class="route-row-eyebrow">Reparto <b>#${esc(r.id?.slice(0, 8) || '—')}</b></span>
              <strong>${esc(r.usuarios?.nombre || 'Sin repartidor')}</strong>
              <small><b class="route-group-order-count">${n}</b> pedido${n !== 1 ? 's' : ''} · Salió ${hora}</small>
            </span>
          </button>
          <div class="route-row-context">
            <span class="route-row-label">Ruta / zona</span>
            <strong>${esc(zonaLabel)}</strong>
            <small>${nota}</small>
          </div>
          <div class="route-row-progress">
            <div class="route-row-progress-head"><span class="route-state route-state--${esc(estadoUi)}"><i>${stateIcon[estadoUi] || '•'}</i>${labelMap[estadoUi] || esc(estadoUi || 'Pendiente')}</span><b>${progress}%</b></div>
            <div class="route-flow-track" aria-hidden="true"><span style="width:${progress}%;"></span></div>
            <small>${entregadas}/${n} entregadas${estadoUi === 'cancelada' ? ' · requiere revisión' : ''}</small>
          </div>
          <span class="route-row-chevron" aria-hidden="true">↗</span>
        </div>
        <div class="route-order-list" aria-label="Pedidos del reparto ${esc(r.id?.slice(0, 8) || 'sin ID')}">
          ${pedidosOrdenados.map((e, orderIndex) => {
            const pedido = e.pedidos || {};
            const pedidoId = pedido.id || e.pedido_id || '';
            const orderState = estadoPedidoUi(e.estado);
            const orderLabelMap = { pendiente: 'Pendiente', en_camino: 'En tránsito', entregado: 'Entregado', no_entregado: 'No entregado', cancelado: 'Cancelado' };
            const orderIconMap = { pendiente: '!', en_camino: '→', entregado: '✓', no_entregado: '×', cancelado: '×' };
            const cliente = pedido.clientes || {};
            const domicilio = cliente.domicilio || 'Domicilio sin registrar';
            const zona = cliente.zonas?.nombre || 'Zona sin asignar';
            const monto = pedido.total == null ? '—' : formatARS(Number(pedido.total));
            return `
              <button type="button" class="pedido-line pedido-line--${esc(orderState)}" data-order-state="${esc(orderState)}" data-entrega-id="${esc(String(e.id || pedidoId || ''))}" onclick="seleccionarPedidoResumen('${routeId}', '${String(e.id || pedidoId || '').replace(/'/g, "\\'")}')" aria-label="Pedido ${esc(String(pedidoId).slice(0, 8) || 'sin ID')} de ${esc(nombreClientePedido(e))}, ${esc(orderLabelMap[orderState] || orderState)}">
                <span class="pedido-line-seq" aria-hidden="true">${String(orderIndex + 1).padStart(2, '0')}</span>
                <span class="pedido-line-main"><strong>${esc(nombreClientePedido(e))}</strong><small>#${esc(String(pedidoId).slice(0, 8) || 'sin ID')} · ${esc(domicilio)}</small></span>
                <span class="pedido-line-zone"><small>${esc(zona)}</small><strong>${esc(orderLabelMap[orderState] || orderState)}</strong></span>
                <strong class="pedido-line-total">${esc(monto)}</strong>
                <span class="pedido-line-mark" aria-hidden="true">${orderIconMap[orderState] || '•'}</span>
              </button>`;
          }).join('') || '<div class="pedido-line-empty">Sin pedidos asociados a este reparto.</div>'}
        </div>
      </article>`;
  }).join('');
  filtrarResumenRutas(_filtroResumenActual, false);
  requestAnimationFrame(actualizarIndicadorScrollPedidos);
}

function actualizarIndicadorScrollPedidos() {
  const listEl = document.getElementById('resumen-chofer-list');
  const hintEl = document.getElementById('resumen-queue-scroll-hint');
  if (!listEl || !hintEl) return;

  if (!listEl.dataset.scrollHintReady) {
    listEl.addEventListener('scroll', actualizarIndicadorScrollPedidos, { passive: true });
    window.addEventListener('scroll', actualizarIndicadorScrollPedidos, { passive: true });
    window.addEventListener('resize', actualizarIndicadorScrollPedidos, { passive: true });
    listEl.dataset.scrollHintReady = 'true';
  }

  const hasInnerScroll = listEl.scrollHeight > listEl.clientHeight + 1;
  const pageContinues = listEl.getBoundingClientRect().bottom > window.innerHeight + 4 &&
    document.documentElement.scrollHeight > window.innerHeight + 4;
  const copyEl = hintEl.querySelector('[data-scroll-copy]');
  const countEl = document.getElementById('resumen-queue-scroll-count');
  const orderCount = listEl.querySelectorAll('.pedido-line').length;

  hintEl.hidden = !(hasInnerScroll || pageContinues);
  hintEl.classList.toggle('is-inner-scroll', hasInnerScroll);
  if (copyEl) copyEl.textContent = hasInnerScroll
    ? 'Deslizá dentro de la cola para ver más pedidos'
    : 'Deslizá la página para seguir viendo pedidos';
  if (countEl) countEl.textContent = orderCount ? `${orderCount} pedido${orderCount !== 1 ? 's' : ''} en la cola` : '';
}

function filtrarResumenRutas(filtro = 'all', announce = true) {
  _filtroResumenActual = filtro;
  const rows = document.querySelectorAll('#resumen-chofer-list .route-row');
  let visibles = 0;
  rows.forEach(row => {
    const show = filtro === 'all' || row.dataset.routeState === filtro || (filtro === 'risk' && ['pendiente', 'cancelada'].includes(row.dataset.routeState));
    row.hidden = !show;
    if (show) visibles += 1;
  });
  document.querySelectorAll('[data-summary-filter]').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.summaryFilter === filtro ? 'true' : 'false');
  });
  const empty = document.getElementById('resumen-chofer-filter-empty');
  if (empty) empty.hidden = visibles !== 0 || rows.length === 0;
  if (announce && typeof window.toast === 'function') {
    const label = filtro === 'all' ? 'Todos los repartos' : (filtro === 'en_camino' ? 'En tránsito' : filtro === 'risk' ? 'Riesgo e incidencias' : 'Completados');
    window.toast(`${label}: ${visibles}`);
  }
}

function seleccionarRutaResumen(routeId) {
  seleccionarPedidoResumen(routeId, null);
}

function seleccionarPedidoResumen(routeId, entregaId = null) {
  const ruta = _rutasResumenHoy.find(r => String(r.id) === String(routeId));
  if (!ruta) return;
  renderTrackingHoy([ruta], entregaId);
  document.querySelectorAll('#resumen-chofer-list .route-row').forEach(row => {
    row.classList.toggle('is-selected', row.dataset.routeId === String(routeId));
  });
  document.querySelectorAll('#resumen-chofer-list .pedido-line').forEach(line => {
    line.classList.toggle('is-selected', entregaId !== null && line.dataset.entregaId === String(entregaId));
  });
  if (entregaId !== null) {
    document.querySelector('.control-panel--tracking')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Tracking / mapa de la ruta más relevante de hoy ─────────────────────
function renderTrackingHoy(rutas, focusEntregaId = null) {
  const sub = document.getElementById('resumen-tracking-sub');
  const idEl = document.getElementById('resumen-tracking-id');
  const timelineEl = document.getElementById('resumen-timeline');
  const mapaDiv = document.getElementById('mapa-resumen');

  if (!rutas.length) {
    sub.textContent = 'Sin rutas hoy';
    idEl.textContent = 'Ruta #—';
    timelineEl.innerHTML = '<div class="resumen-timeline-item"><div class="resumen-timeline-dot"></div><div class="resumen-timeline-txt">No hay rutas creadas para hoy</div></div>';
    if (_mapaResumen) { _mapaResumen.remove(); _mapaResumen = null; }
    mapaDiv.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-light);font-size:13px;">Sin ruta activa hoy</div>';
    return;
  }

  // Preferir una ruta "en_camino"; si no hay, la más reciente
  const ruta = rutas.find(r => estadoRutaUi(r.estado) === 'en_camino') || rutas[0];
  const estadoRuta = estadoRutaUi(ruta.estado);
  const entregas = ruta.entregas || [];
  const entregadas = entregas.filter(e => e.estado === 'entregado').length;
  const focusEntrega = focusEntregaId !== null
    ? entregas.find(e => String(e.id || e.pedido_id) === String(focusEntregaId))
    : null;
  const focusPedido = focusEntrega?.pedidos || {};
  const focusPedidoId = focusPedido.id || focusEntrega?.pedido_id || 'sin ID';
  const choferNombre = ruta.usuarios?.nombre || 'Sin chofer';

  sub.textContent = focusEntrega
    ? `${choferNombre} · Pedido #${String(focusPedidoId).slice(0, 8)} · ${entregadas}/${entregas.length} entregadas`
    : `${choferNombre} · ${entregadas}/${entregas.length} entregadas`;
  idEl.innerHTML = `Ruta <strong>#${ruta.id.slice(0, 8)}</strong>`;

  // Timeline basado en eventos reales
  const items = [];
  items.push({ done: true, titulo: 'Ruta creada', sub: new Date(ruta.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) });
  const primeraConfirmacion = entregas.map(e => e.fecha_confirmacion).filter(Boolean).sort()[0];
  if (primeraConfirmacion) {
    items.push({ done: true, titulo: 'Primera entrega confirmada', sub: new Date(primeraConfirmacion).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) });
  } else if (estadoRuta === 'en_camino' || estadoRuta === 'completada') {
    items.push({ done: true, titulo: 'En tránsito', sub: '—' });
  } else {
    items.push({ done: false, titulo: 'Aún sin salir', sub: '—' });
  }
  if (estadoRuta === 'completada') {
    items.push({ done: true, titulo: 'Ruta completada', sub: `${entregadas}/${entregas.length} entregadas` });
  } else {
    items.push({ done: false, titulo: 'Ruta en curso', sub: `${entregas.length - entregadas} pendientes` });
  }

  timelineEl.innerHTML = items.map(it => `
    <div class="resumen-timeline-item ${it.done ? 'done' : ''}">
      <div class="resumen-timeline-dot"></div>
      <div class="resumen-timeline-txt"><strong>${it.titulo}</strong>${it.sub}</div>
    </div>`).join('');

  // Mapa con las posiciones de los clientes de la ruta
  const puntos = entregas
    .map(e => ({ e, lat: e.pedidos?.clientes?.lat, lng: e.pedidos?.clientes?.lng }))
    .filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
    .map(p => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) }));

  if (!puntos.length || typeof L === 'undefined') {
    if (_mapaResumen) { _mapaResumen.remove(); _mapaResumen = null; }
    mapaDiv.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-light);font-size:13px;padding:0 16px;text-align:center;">Sin coordenadas registradas para esta ruta</div>';
    return;
  }

  if (!_mapaResumen) {
    mapaDiv.innerHTML = '';
    _mapaResumen = L.map(mapaDiv, { zoomControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(_mapaResumen);
  }
  _mapaResumenMarkers.forEach(m => m.remove());
  _mapaResumenMarkers = [];

  const css = getComputedStyle(document.documentElement);
  const colores = {
    entregado: css.getPropertyValue('--color-success').trim(),
    pendiente: css.getPropertyValue('--color-warning').trim(),
    en_camino: css.getPropertyValue('--color-info').trim(),
    no_entregado: css.getPropertyValue('--color-danger').trim(),
    cancelado: css.getPropertyValue('--color-danger').trim(),
  };
  const surface = css.getPropertyValue('--color-surface').trim();
  const ink = css.getPropertyValue('--color-text').trim();
  const bounds = [];
  puntos.forEach(({ e, lat, lng }) => {
    const estadoPedido = estadoPedidoUi(e.estado);
    const pedido = e.pedidos || {};
    const pedidoId = pedido.id || e.pedido_id || 'sin ID';
    const color = colores[estadoPedido] || colores.pendiente;
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid ${surface};box-shadow:0 2px 5px color-mix(in srgb, ${ink} 22%, transparent);"></div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const m = L.marker([lat, lng], { icon }).addTo(_mapaResumen);
    m.bindTooltip(`#${esc(String(pedidoId).slice(0, 8))} · ${esc(nombreClientePedido(e))}`, { direction: 'top', offset: [0, -10] });
    _mapaResumenMarkers.push(m);
    bounds.push([lat, lng]);
    if (focusEntregaId !== null && String(e.id || e.pedido_id) === String(focusEntregaId)) {
      m.openTooltip();
    }
  });
  const focusedPoint = puntos.find(({ e }) => focusEntregaId !== null && String(e.id || e.pedido_id) === String(focusEntregaId));
  if (focusedPoint) _mapaResumen.setView([focusedPoint.lat, focusedPoint.lng], 15);
  else if (bounds.length === 1) _mapaResumen.setView(bounds[0], 13);
  else _mapaResumen.fitBounds(bounds, { padding: [24, 24] });
  setTimeout(() => _mapaResumen.invalidateSize(), 150);
}

// ── Cobro rápido: preparar lista de clientes de las rutas de hoy ────────
function prepararClientesCobroRapido(rutas) {
  const map = new Map();
  rutas.forEach(r => (r.entregas || []).forEach(e => {
    const c = e.pedidos?.clientes;
    if (c && !map.has(c.id)) map.set(c.id, c);
  }));
  _clientesHoy = [...map.values()];
  _clienteCobroSeleccionado = null;

  const el = document.getElementById('resumen-avatares');
  const btn = document.getElementById('resumen-cobro-btn');
  if (!_clientesHoy.length) {
    el.innerHTML = '<div class="resumen-card-sub">No hay clientes en rutas de hoy</div>';
    btn.disabled = true;
    return;
  }
  el.innerHTML = _clientesHoy.slice(0, 8).map(c => {
    const iniciales = (c.razon_social || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return `<button type="button" class="resumen-avatar" data-cliente="${c.id}" title="${esc(c.razon_social)}" aria-label="Seleccionar cliente ${esc(c.razon_social)}" aria-pressed="false" onclick="seleccionarClienteCobro('${c.id}')">${iniciales}</button>`;
  }).join('');
  btn.disabled = true;
}

function seleccionarClienteCobro(clienteId) {
  _clienteCobroSeleccionado = _clientesHoy.find(c => c.id === clienteId) || null;
  document.querySelectorAll('#resumen-avatares .resumen-avatar').forEach(a => {
    a.classList.toggle('selected', a.dataset.cliente === clienteId);
    a.setAttribute('aria-pressed', a.dataset.cliente === clienteId ? 'true' : 'false');
  });
  const btn = document.getElementById('resumen-cobro-btn');
  btn.disabled = !_clienteCobroSeleccionado;
  btn.textContent = _clienteCobroSeleccionado
    ? `Registrar cobro a ${_clienteCobroSeleccionado.razon_social}`
    : 'Registrar cobro';
}

async function registrarCobroRapido() {
  if (!_clienteCobroSeleccionado) { window.toast?.('Elegí un cliente'); return; }
  const monto = parseFloat(document.getElementById('resumen-cobro-monto').value);
  const medio = document.getElementById('resumen-cobro-medio').value;
  if (!monto || monto <= 0) { window.toast?.('Ingresá un monto válido'); return; }

  const btn = document.getElementById('resumen-cobro-btn');
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = 'Guardando...';

  try {
    const { data, error } = await sb.rpc('registrar_cobro_completo', {
      p_empresa_id: empresaId,
      p_cliente_id: _clienteCobroSeleccionado.id,
      p_usuario_id: window.authCtx.perfil.id,
      p_monto: monto,
      p_medio: medio,
      p_referencia: null,
      p_notas: 'Cobro contra entrega — registrado desde Resumen de repartos',
    });
    if (error) throw new Error(error.message);
    if (data && data.ok === false) throw new Error(data.error || 'Error desconocido');

    window.toast?.('Cobro registrado');
    document.getElementById('resumen-cobro-monto').value = '';
    await cargarCobrosHoy();
  } catch (e) {
    console.error('[resumen] registrarCobroRapido', e);
    window.toast?.(e.message || 'Error al registrar el cobro');
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

// ── 3. Total cobrado — últimos 7 días (income chart) ────────────────────
async function cargarCobrosSemana() {
  const hoy = hoyISO();
  const desde = restarDias(hoy, 6);

  const { data, error } = await sb
    .from('cta_cte')
    .select('monto, fecha_date')
    .eq('empresa_id', empresaId)
    .eq('tipo', 'cobro')
    .gte('fecha_date', desde)
    .lte('fecha_date', hoy);

  const valEl = document.getElementById('resumen-income-val');
  const subEl = document.getElementById('resumen-income-sub');
  const chartEl = document.getElementById('resumen-income-chart');

  if (error || !data) {
    valEl.textContent = '—';
    subEl.textContent = 'No se pudo cargar';
    return;
  }

  const porDia = {};
  for (let i = 0; i <= 6; i++) porDia[restarDias(hoy, 6 - i)] = 0;
   data.forEach(c => { if (porDia[c.fecha_date] !== undefined) porDia[c.fecha_date] += (Number(c.monto) || 0); });

  const total = Object.values(porDia).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...Object.values(porDia));
  const diasConCobros = Object.values(porDia).filter(monto => monto > 0).length;
  const mejorDia = Object.entries(porDia).find(([, monto]) => monto === max && monto > 0);

  valEl.textContent = formatARS(total);
  subEl.textContent = `${data.length} cobro${data.length !== 1 ? 's' : ''} · ${diasConCobros} día${diasConCobros !== 1 ? 's' : ''} con actividad`;
  document.getElementById('resumen-income-promedio').textContent =
    formatARS(total / 7) + ' por día';
  document.getElementById('resumen-income-mejor-dia').textContent =
    mejorDia ? `${textoFechaCorta(mejorDia[0])} · ${formatARS(mejorDia[1])}` : 'Sin cobros';

  chartEl.innerHTML = Object.entries(porDia).map(([fecha, monto]) => {
    const pct = Math.max(4, Math.round((monto / max) * 100));
    const esMax = monto === max && monto > 0;
    const label = new Date(fecha + 'T00:00:00').toLocaleDateString('es-AR', { day: 'numeric' });
    return `
      <div class="resumen-income-bar-col ${esMax ? 'is-max' : ''}">
        <div class="resumen-income-bar" style="height:${pct}%;" title="${formatARS(monto)}"></div>
        <div class="resumen-income-bar-label">${label}</div>
      </div>`;
  }).join('');
}

// ── 4. Cobranzas de hoy por medio de pago + actividad reciente ──────────
async function cargarCobrosHoy() {
  const hoy = hoyISO();
  const { data, error } = await sb
    .from('cta_cte')
    .select('monto, medio_pago, fecha, clientes(razon_social)')
    .eq('empresa_id', empresaId)
    .eq('tipo', 'cobro')
    .eq('fecha_date', hoy)
    .order('fecha', { ascending: false });

  const gridEl = document.getElementById('resumen-pago-grid');
  const listEl = document.getElementById('resumen-pago-activity-list');

  if (error || !data) {
    gridEl.innerHTML = '<div class="empty-state" style="padding:12px;grid-column:span 2;">No se pudo cargar</div>';
    document.getElementById('resumen-pago-total-hoy').textContent = '—';
    document.getElementById('resumen-pago-operaciones').textContent = '—';
    document.getElementById('resumen-pago-ultimo').textContent = 'No disponible';
    return;
  }
  if (!data.length) {
    gridEl.innerHTML = '<div class="empty-state" style="padding:12px;grid-column:span 2;">Sin cobros hoy</div>';
    listEl.innerHTML = '<div class="resumen-pago-activity-item"><span class="resumen-pago-activity-cliente">Sin actividad hoy</span></div>';
    document.getElementById('resumen-pago-total-hoy').textContent = '$0';
    document.getElementById('resumen-pago-operaciones').textContent = '0';
    document.getElementById('resumen-pago-ultimo').textContent = 'Sin cobros';
    return;
  }

  const totales = {};
  data.forEach(c => { const m = c.medio_pago || 'otro'; totales[m] = (totales[m] || 0) + (Number(c.monto) || 0); });
  const labelMedio = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', otro: 'Otro' };
  const totalHoy = data.reduce((sum, c) => sum + (Number(c.monto) || 0), 0);
  const ultimo = data[0];

  document.getElementById('resumen-pago-total-hoy').textContent = formatARS(totalHoy);
  document.getElementById('resumen-pago-operaciones').textContent =
    `${data.length} cobro${data.length !== 1 ? 's' : ''}`;
  document.getElementById('resumen-pago-ultimo').textContent =
    `${new Date(ultimo.fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} · ${formatARS(ultimo.monto)}`;

  gridEl.innerHTML = Object.entries(totales).map(([medio, monto]) => `
    <div class="resumen-pago-card">
      <div class="resumen-pago-label">${labelMedio[medio] || medio}</div>
      <div class="resumen-pago-val">${formatARS(monto)}</div>
    </div>`).join('');

  listEl.innerHTML = data.slice(0, 5).map(c => `
    <div class="resumen-pago-activity-item">
      <span class="resumen-pago-activity-cliente">${esc(c.clientes?.razon_social || 'Cliente')}</span>
      <span class="resumen-pago-activity-fecha">${new Date(c.fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="resumen-pago-activity-monto ok">${formatARS(c.monto)}</span>
    </div>`).join('');
}

// ── Exponer a window (para onclick= en el HTML y para mostrarTab en rutas.js) ─
window.cargarResumenRepartos = cargarResumenRepartos;
window.seleccionarClienteCobro = seleccionarClienteCobro;
window.registrarCobroRapido = registrarCobroRapido;
window.filtrarResumenRutas = filtrarResumenRutas;
window.seleccionarRutaResumen = seleccionarRutaResumen;
window.seleccionarPedidoResumen = seleccionarPedidoResumen;
