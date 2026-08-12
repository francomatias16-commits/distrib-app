// frontend/admin/js/rutas-resumen.js
// Tab "Resumen" de Repartos — dashboard con datos reales (rutas, entregas,
// choferes, cta_cte). Réplica visual del layout tipo "Logistic Dashboard".

let sb = null;
let empresaId = null;
let _mapaResumen = null;
let _mapaResumenMarkers = [];
let _clienteCobroSeleccionado = null;
let _clientesHoy = [];

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
function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
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

  document.getElementById('resumen-badge-fecha').textContent =
    new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  document.getElementById('resumen-rutas-semana-sub').textContent =
    `${total} pedido${total !== 1 ? 's' : ''} en 7 días`;

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
        id, fecha, estado, created_at, chofer_id,
        usuarios(nombre),
        entregas(
          id, estado, orden, fecha_confirmacion,
          pedidos(id, total, clientes(id, razon_social, domicilio, lat, lng))
        )
      `)
      .eq('empresa_id', empresaId)
      .eq('fecha', hoy)
      .order('created_at', { ascending: false }),
    sb.from('rutas').select('id').eq('empresa_id', empresaId).eq('fecha', ayer),
  ]);

  if (error || !rutasHoy) return;

  renderGaugeEntregas(rutasHoy);
  renderCargaChoferes(rutasHoy);
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

  if (typeof inicializarTemaECharts === 'function') inicializarTemaECharts();

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
      itemStyle: { borderColor: '#FCFAF5', borderWidth: 2 },
      emphasis: { scaleSize: 4 },
      data: total
        ? [
            { name: 'Entregadas', value: entregadas, itemStyle: { color: '#B87A00' } },
            { name: 'Pendientes', value: total - entregadas, itemStyle: { color: '#DAD3C0' } },
          ]
        : [{ name: 'Sin datos', value: 1, itemStyle: { color: '#DAD3C0' } }],
    }],
    graphic: {
      elements: [{
        type: 'text', left: 'center', top: 'center',
        style: { text: total ? `${pct}%` : '—', fontSize: 20, fontWeight: 800, fill: '#16181D' },
      }],
    },
  }, { notMerge: true });

  document.getElementById('resumen-gauge-ok').textContent = `${entregadas} entregada${entregadas !== 1 ? 's' : ''}`;
  document.getElementById('resumen-gauge-pend').textContent = `${total - entregadas} pendiente${(total - entregadas) !== 1 ? 's' : ''}`;
}

function renderCargaChoferes(rutas) {
  const el = document.getElementById('resumen-carga-choferes');
  if (!rutas.length) {
    el.innerHTML = '<div class="empty-state" style="padding:12px;">Sin rutas hoy</div>';
    return;
  }
  const cargas = rutas.map(r => ({
    nombre: r.usuarios?.nombre || 'Sin chofer',
    n: r.entregas?.length || 0,
  }));
  const max = Math.max(1, ...cargas.map(c => c.n));

  el.innerHTML = cargas.slice(0, 5).map(c => {
    const pct = Math.max(6, Math.round((c.n / max) * 100));
    return `
      <div class="resumen-cap-row">
        <span class="resumen-cap-label" title="${esc(c.nombre)}">${esc(c.nombre)}</span>
        <div class="resumen-cap-track"><div class="resumen-cap-fill" style="width:${pct}%;"></div></div>
        <span class="resumen-cap-pct">${c.n}</span>
      </div>`;
  }).join('');
}

function renderChoferesEnCalle(rutas, ayerCount) {
  document.getElementById('resumen-choferes-count').textContent = rutas.length;

  const delta = rutas.length - ayerCount;
  const deltaEl = document.getElementById('resumen-choferes-delta');
  if (ayerCount === 0 && rutas.length === 0) {
    deltaEl.textContent = 'Sin datos de ayer';
    deltaEl.className = 'resumen-choferes-delta';
  } else {
    const signo = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
    deltaEl.textContent = `${signo} ${Math.abs(delta)} que ayer`;
    deltaEl.className = 'resumen-choferes-delta' + (delta >= 0 ? ' pos' : '');
  }

  const enCamino = rutas.filter(r => r.estado === 'en_camino').length;
  const pendiente = rutas.filter(r => r.estado === 'pendiente').length;
  const completada = rutas.filter(r => r.estado === 'completada').length;
  document.getElementById('resumen-leg-en-camino').textContent = `● En ruta ${enCamino}`;
  document.getElementById('resumen-leg-pendiente').textContent = `● Pendiente ${pendiente}`;
  document.getElementById('resumen-leg-completada').textContent = `● Completada ${completada}`;

  const listEl = document.getElementById('resumen-chofer-list');
  if (!rutas.length) {
    listEl.innerHTML = '<div class="empty-state" style="padding:20px;">No hay rutas creadas para hoy</div>';
    return;
  }
  const chipMap = { pendiente: 'chip-pendiente', en_camino: 'chip-en-camino', completada: 'chip-completada', cancelada: 'chip-cancelada' };
  const labelMap = { pendiente: 'Pendiente', en_camino: 'En camino', completada: 'Completada', cancelada: 'Cancelada' };
  listEl.innerHTML = rutas.map(r => {
    const n = r.entregas?.length || 0;
    const hora = new Date(r.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="resumen-chofer-item">
        <div class="resumen-chofer-info">
          <span class="resumen-chofer-nombre">${esc(r.usuarios?.nombre || 'Sin chofer')}</span>
          <span class="resumen-chofer-sub">${n} pedido${n !== 1 ? 's' : ''}</span>
        </div>
        <span class="chip ${chipMap[r.estado] || 'chip-pendiente'}">${labelMap[r.estado] || r.estado}</span>
        <span class="resumen-chofer-eta">Salió ${hora}</span>
      </div>`;
  }).join('');
}

// ── Tracking / mapa de la ruta más relevante de hoy ─────────────────────
function renderTrackingHoy(rutas) {
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
  const ruta = rutas.find(r => r.estado === 'en_camino') || rutas[0];
  const entregas = ruta.entregas || [];
  const entregadas = entregas.filter(e => e.estado === 'entregado').length;

  sub.textContent = `${esc(ruta.usuarios?.nombre || 'Sin chofer')} · ${entregadas}/${entregas.length} entregadas`;
  idEl.innerHTML = `Ruta <strong>#${ruta.id.slice(0, 8)}</strong>`;

  // Timeline basado en eventos reales
  const items = [];
  items.push({ done: true, titulo: 'Ruta creada', sub: new Date(ruta.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) });
  const primeraConfirmacion = entregas.map(e => e.fecha_confirmacion).filter(Boolean).sort()[0];
  if (primeraConfirmacion) {
    items.push({ done: true, titulo: 'Primera entrega confirmada', sub: new Date(primeraConfirmacion).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) });
  } else if (ruta.estado === 'en_camino' || ruta.estado === 'completada') {
    items.push({ done: true, titulo: 'En tránsito', sub: '—' });
  } else {
    items.push({ done: false, titulo: 'Aún sin salir', sub: '—' });
  }
  if (ruta.estado === 'completada') {
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
    .filter(p => p.lat && p.lng);

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

  const colores = { entregado: '#1F5B4A', no_entregado: '#B3261E', pendiente: '#8F5F00', en_camino: '#2E6088' };
  const bounds = [];
  puntos.forEach(({ e, lat, lng }) => {
    const color = colores[e.estado] || colores.pendiente;
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.3);"></div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const m = L.marker([lat, lng], { icon }).addTo(_mapaResumen);
    _mapaResumenMarkers.push(m);
    bounds.push([lat, lng]);
  });
  if (bounds.length === 1) _mapaResumen.setView(bounds[0], 13);
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
    return `<div class="resumen-avatar" data-cliente="${c.id}" title="${esc(c.razon_social)}" onclick="seleccionarClienteCobro('${c.id}')">${iniciales}</div>`;
  }).join('');
  btn.disabled = true;
}

function seleccionarClienteCobro(clienteId) {
  _clienteCobroSeleccionado = _clientesHoy.find(c => c.id === clienteId) || null;
  document.querySelectorAll('#resumen-avatares .resumen-avatar').forEach(a => {
    a.classList.toggle('selected', a.dataset.cliente === clienteId);
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
  data.forEach(c => { if (porDia[c.fecha_date] !== undefined) porDia[c.fecha_date] += (c.monto || 0); });

  const total = Object.values(porDia).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...Object.values(porDia));

  valEl.textContent = formatARS(total);
  subEl.textContent = `${data.length} cobro${data.length !== 1 ? 's' : ''} registrados`;

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
    return;
  }
  if (!data.length) {
    gridEl.innerHTML = '<div class="empty-state" style="padding:12px;grid-column:span 2;">Sin cobros hoy</div>';
    listEl.innerHTML = '<div class="resumen-pago-activity-item"><span class="resumen-pago-activity-cliente">Sin actividad hoy</span></div>';
    return;
  }

  const totales = {};
  data.forEach(c => { const m = c.medio_pago || 'otro'; totales[m] = (totales[m] || 0) + (c.monto || 0); });
  const labelMedio = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', otro: 'Otro' };

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
