/* admin/js/rentabilidad-zona.js — Punto 2: Rentabilidad por Zona/Ruta
   Lee /api/rutas-live?accion=rentabilidad-zona → v_rentabilidad_zona_ruta (069).
   Vista doble: agrupada por zona (default) y por ruta individual.
   Incluye gráfico de barras por zona, exportación CSV y configuración de costo_km. */

const ROLES_RENTABILIDAD = ['dueno', 'admin', 'contador'];

let filasActuales = [];    // filas crudas de v_rentabilidad_zona_ruta
let vistaActual   = 'zona'; // 'zona' | 'ruta'
let _chart        = null;  // instancia Chart.js

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await window.authReady;

  const hoy = new Date();
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const user = window.authCtx?.perfil;
  if (!user) return;
  (document.getElementById('topbar-usuario') || {}).textContent = user.nombre || user.email;

  if (!ROLES_RENTABILIDAD.includes(user.rol)) {
    document.getElementById('contenido-rentabilidad').classList.add('hidden');
    document.getElementById('sin-permiso').classList.remove('hidden');
    return;
  }

  // Últimos 30 días por defecto
  const hasta = new Date();
  const desde = new Date(); desde.setDate(desde.getDate() - 30);
  document.getElementById('filtro-hasta').value = fmtFechaInput(hasta);
  document.getElementById('filtro-desde').value = fmtFechaInput(desde);

  await cargarCostoKm(user.rol);
  await cargarRentabilidad();
});

// ── Costo / km ────────────────────────────────────────────────────────────
async function cargarCostoKm(rol) {
  try {
    const token = await getToken();
    const r     = await fetch('/api/rutas-live?accion=costo-km', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data  = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar el costo por km');

    const puedeEditar = ['dueno', 'admin'].includes(rol);

    if (puedeEditar) {
      document.getElementById('costo-km-edicion').classList.remove('hidden');
      document.getElementById('input-costo-km').value = data.costo_km > 0 ? data.costo_km : '';
    } else {
      document.getElementById('costo-km-lectura').classList.remove('hidden');
      document.getElementById('costo-km-lectura').textContent =
        data.costo_km > 0 ? fmtPeso(data.costo_km) + ' / km' : 'Sin configurar';
    }
  } catch (e) {
    console.error('[RENT] costo-km:', e);
    const el = document.getElementById('costo-km-lectura');
    el.classList.remove('hidden');
    el.textContent = '—';
  }
}

async function guardarCostoKm() {
  const input  = document.getElementById('input-costo-km');
  const status = document.getElementById('costo-km-status');
  const boton  = document.getElementById('btn-guardar-costo-km');
  const valor  = Number(input.value);

  if (!Number.isFinite(valor) || valor < 0) {
    status.textContent = 'Ingresá un número válido (≥ 0)';
    status.style.color = 'var(--color-danger)';
    return;
  }

  const ok = await window.confirmar(`¿Confirmás actualizar el costo por km a $${valor}?`, { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;

  boton.disabled       = true;
  status.textContent   = 'Guardando…';
  status.style.color   = 'var(--color-text-light)';

  try {
    const token = await getToken();
    const r     = await fetch('/api/rutas-live?accion=costo-km', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ costo_km: valor }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al guardar');

    status.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Guardado';
    status.style.color = 'var(--color-success)';
    window.toast('Costo por km actualizado', 'ok');
    await cargarRentabilidad();
  } catch (e) {
    console.error('[RENT] guardar costo-km:', e);
    status.textContent = 'No se pudo guardar';
    status.style.color = 'var(--color-danger)';
    window.toast('Error al guardar el costo por km', 'err');
  } finally {
    boton.disabled = false;
  }
}

// ── Carga principal ───────────────────────────────────────────────────────
async function cargarRentabilidad() {
  const tbodyZona = document.getElementById('tbody-por-zona');
  const tbodyRuta = document.getElementById('tbody-por-ruta');
  const placeholder = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--color-text-light);">Cargando…</td></tr>`;
  if (tbodyZona) tbodyZona.innerHTML = placeholder;
  if (tbodyRuta) tbodyRuta.innerHTML = placeholder;
  document.getElementById('kpis-grid').innerHTML = '';

  try {
    const token = await getToken();
    const desde = document.getElementById('filtro-desde').value;
    const hasta = document.getElementById('filtro-hasta').value;
    const zona  = document.getElementById('filtro-zona').value;

    const qs = new URLSearchParams({ accion: 'rentabilidad-zona' });
    if (desde) qs.set('desde', desde);
    if (hasta) qs.set('hasta', hasta);
    if (zona)  qs.set('zona_id', zona);

    const r    = await fetch(`/api/rutas-live?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al cargar el reporte');

    filasActuales = data.rentabilidad || [];

    poblarFiltroZonas(filasActuales);
    renderKpis(filasActuales);
    renderChartZonas(filasActuales);
    renderVista();

  } catch (e) {
    console.error('[RENT] cargar:', e);
    const msg = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--color-danger);">No se pudo cargar el reporte.</td></tr>`;
    if (tbodyZona) tbodyZona.innerHTML = msg;
    if (tbodyRuta) tbodyRuta.innerHTML = msg;
    window.toast('Error al cargar rentabilidad por zona', 'err');
  }
}

// ── Poblar filtro de zonas ────────────────────────────────────────────────
function poblarFiltroZonas(filas) {
  const select = document.getElementById('filtro-zona');
  const actual = select.value;
  const zonas  = new Map();
  for (const f of filas) {
    if (f.zona_id && f.zona_nombre) zonas.set(f.zona_id, f.zona_nombre);
  }
  select.innerHTML = `<option value="">Todas las zonas</option>` +
    [...zonas.entries()].map(([id, nombre]) =>
      `<option value="${id}"${id === actual ? ' selected' : ''}>${esc(nombre)}</option>`
    ).join('');
}

// ── KPI Cards ─────────────────────────────────────────────────────────────
function renderKpis(filas) {
  const cont = document.getElementById('kpis-grid');

  if (!filas.length) {
    cont.className = 'kpis-grid kpis-grid--summary kpis-grid--empty';
    cont.innerHTML = `
      <div class="kpi-empty-state">
        <span class="kpi-empty-state__eyebrow">Sin actividad</span>
        <strong>No hay rutas con entregas en el rango seleccionado.</strong>
        <span>Probá ampliar el período o quitar el filtro de zona.</span>
      </div>`;
    return;
  }

  const totalEntregas    = filas.reduce((s, f) => s + (+f.entregas_completadas || 0), 0);
  const totalFacturado   = filas.reduce((s, f) => s + (+f.facturado_total       || 0), 0);
  const totalMargenBruto = filas.reduce((s, f) => s + (+f.margen_total          || 0), 0);
  const totalCostoLog    = filas.reduce((s, f) => s + (+f.costo_logistico_estimado || 0), 0);
  const totalMargenNeto  = filas.reduce((s, f) => s + (+f.margen_neto_estimado  || 0), 0);
  const totalKm          = filas.reduce((s, f) => s + (+f.km_recorridos         || 0), 0);
  const totalRutas       = new Set(filas.map(f => f.ruta_id)).size;

  const margenNetoPorKm  = totalKm > 0 ? totalMargenNeto / totalKm : null;

  const conKm  = filas.filter(f => (+f.km_recorridos || 0) > 0 && f.margen_neto_por_km != null);
  let peorTxt  = '—';
  let mejorTxt = '—';
  let peorMargenKm = null;
  if (conKm.length) {
    const peor  = conKm.reduce((a, b) => +a.margen_neto_por_km < +b.margen_neto_por_km ? a : b);
    const mejor = conKm.reduce((a, b) => +a.margen_neto_por_km > +b.margen_neto_por_km ? a : b);
    peorMargenKm = +peor.margen_neto_por_km;
    peorTxt  = `${peor.zona_nombre  || 'Sin zona'} (${fmtPeso(peor.margen_neto_por_km)}/km)`;
    mejorTxt = `${mejor.zona_nombre || 'Sin zona'} (${fmtPeso(mejor.margen_neto_por_km)}/km)`;
  }

  const pctMargen = totalFacturado > 0 ? ((totalMargenNeto / totalFacturado) * 100).toFixed(1) : null;

  const peorZona = conKm.length ? peorTxt.split(' (')[0] : 'Sin datos';
  const peorValor = conKm.length ? fmtPeso(peorMargenKm) + '/km' : '—';
  const mejorZona = conKm.length ? mejorTxt.split(' (')[0] : 'Sin datos';
  const margenClase = totalMargenNeto >= 0 ? 'kpi-card--positive' : 'kpi-card--negative';
  const revisionClase = conKm.length && peorMargenKm < 0
    ? 'kpi-card--negative'
    : 'kpi-card--attention';

  cont.className = 'kpis-grid kpis-grid--summary';
  cont.innerHTML = `
    <article class="kpi-card kpi-card--routes" tabindex="0" title="Con entregas en el período">
      <span class="kpi-card__eyebrow">Cobertura</span>
      <strong class="kpi-card__value">${totalRutas}</strong>
      <span class="kpi-card__label">Rutas analizadas</span>
      <span class="kpi-card__detail">Con entregas completadas</span>
    </article>
    <article class="kpi-card kpi-card--billing" tabindex="0" title="Pedidos entregados en esas rutas">
      <span class="kpi-card__eyebrow">Volumen</span>
      <strong class="kpi-card__value">${fmtPeso(totalFacturado)}</strong>
      <span class="kpi-card__label">Facturado entregado</span>
      <span class="kpi-card__detail">Ventas del período elegido</span>
    </article>
    <article class="kpi-card kpi-card--hero ${margenClase}" tabindex="0" title="Facturado menos costo y logística">
      <span class="kpi-card__eyebrow">Resultado principal</span>
      <strong class="kpi-card__value ${claseTamanioValor(fmtPeso(totalMargenNeto))}">${fmtPeso(totalMargenNeto)}</strong>
      <span class="kpi-card__label">Margen neto${pctMargen != null ? ` <small>(${pctMargen}%)</small>` : ''}</span>
      <span class="kpi-card__detail">Después del costo logístico</span>
    </article>
    <article class="kpi-card kpi-card--cost" tabindex="0" title="Estimado según kilómetros y paradas">
      <span class="kpi-card__eyebrow">Eficiencia</span>
      <strong class="kpi-card__value">${fmtPeso(totalCostoLog)}</strong>
      <span class="kpi-card__label">Costo logístico est.</span>
      <span class="kpi-card__detail">${totalKm > 0 ? `${Number(totalKm).toLocaleString('es-AR', { maximumFractionDigits: 1 })} km recorridos` : 'Sin kilómetros cargados'}</span>
    </article>
    <article class="kpi-card kpi-card--km" tabindex="0" title="Rentabilidad promedio por kilómetro recorrido">
      <span class="kpi-card__eyebrow">Rendimiento</span>
      <strong class="kpi-card__value">${margenNetoPorKm != null ? fmtPeso(margenNetoPorKm) : '—'}</strong>
      <span class="kpi-card__label">Margen neto / km</span>
      <span class="kpi-card__detail">Promedio del período</span>
    </article>
    <article class="kpi-card kpi-card--review ${revisionClase}" tabindex="0" title="La zona con peor margen neto por kilómetro">
      <span class="kpi-card__eyebrow">Decisión sugerida</span>
      <strong class="kpi-card__value kpi-card__value--text">${esc(peorZona)}</strong>
      <span class="kpi-card__label">Zona a revisar</span>
      <span class="kpi-card__detail">${esc(peorValor)} · Mejor: ${esc(mejorZona)}</span>
    </article>
  `;
}

// ── Gráfico de barras ─────────────────────────────────────────────────────
function renderChartZonas(filas) {
  const wrap = document.getElementById('chart-wrap');

  if (!filas.length) { wrap.classList.add('hidden'); return; }

  // Agregar por zona
  const zonaMap = new Map();
  for (const f of filas) {
    const key  = f.zona_id || '__sin_zona__';
    const prev = zonaMap.get(key) || { nombre: f.zona_nombre || 'Sin zona', margen: 0, facturado: 0, km: 0 };
    prev.margen    += +f.margen_neto_estimado || 0;
    prev.facturado += +f.facturado_total      || 0;
    prev.km        += +f.km_recorridos        || 0;
    zonaMap.set(key, prev);
  }

  const zonas = [...zonaMap.values()].sort((a, b) => b.margen - a.margen);
  const labels  = zonas.map(z => z.nombre);
  const valores = zonas.map(z => Math.round(z.margen));

  const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
  const colorPositivo = tokens.teal || '#6A9873';
  const colorNegativo = tokens.red  || '#B8402E';

  _chart = crearGraficoECharts(_chart, 'chart-zonas', {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const p = params[0];
        return `${p.axisValue}<br/>Margen neto: ${fmtPeso(p.value)}`;
      },
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 12 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v) => fmtPeso(v), fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(22,24,29,.05)' } },
    },
    series: [{
      name: 'Margen neto estimado ($)',
      type: 'bar',
      data: valores,
      barMaxWidth: 42,
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: (params) => params.value >= 0 ? colorPositivo : colorNegativo,
      },
    }],
  }, { notMerge: true });

  wrap.classList.remove('hidden');
}

// ── Vista por zona (agrupada) ─────────────────────────────────────────────
function renderVistaPorZona(filas) {
  const tbody = document.getElementById('tbody-por-zona');
  if (!tbody) return;

  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--color-text-light);">Sin datos en el período seleccionado</td></tr>`;
    return;
  }

  // Agrupar por zona_id
  const zonaMap = new Map();
  for (const f of filas) {
    const key  = f.zona_id || '__sin_zona__';
    const prev = zonaMap.get(key) || {
      zona_nombre: f.zona_nombre || null,
      rutas: new Set(),
      entregas: 0, km: 0,
      facturado: 0, margen: 0,
      costoLog: 0, margenNeto: 0,
      sinCostoKm: false,
    };
    prev.rutas.add(f.ruta_id);
    prev.entregas    += +f.entregas_completadas       || 0;
    prev.km          += +f.km_recorridos              || 0;
    prev.facturado   += +f.facturado_total            || 0;
    prev.margen      += +f.margen_total               || 0;
    prev.costoLog    += +f.costo_logistico_estimado   || 0;
    prev.margenNeto  += +f.margen_neto_estimado       || 0;
    if (!(+f.costo_km_configurado > 0)) prev.sinCostoKm = true;
    zonaMap.set(key, prev);
  }

  const zonas = [...zonaMap.values()].sort((a, b) => b.margenNeto - a.margenNeto);

  // Mejor y peor para resaltar
  const mejorMargen = Math.max(...zonas.map(z => z.margenNeto));
  const peorMargen  = Math.min(...zonas.map(z => z.margenNeto));

  tbody.innerHTML = zonas.map(z => {
    const margenNetoPorKm = z.km > 0 ? z.margenNeto / z.km : null;
    const claseMargen = z.margenNeto >= 0 ? 'monto-verde' : 'monto-rojo';
    const trClass = z.margenNeto === mejorMargen && zonas.length > 1 ? 'zona-mejor'
                  : z.margenNeto === peorMargen  && zonas.length > 1 ? 'zona-peor' : '';

    const rendBadge = z.margenNeto === mejorMargen && zonas.length > 1
      ? `<span class="chip chip-completada">Mejor zona</span>`
      : z.margenNeto === peorMargen  && zonas.length > 1
      ? `<span class="chip chip-cancelada">Zona a revisar</span>`
      : '';

    return `<tr class="${trClass}">
      <td><strong>${z.zona_nombre ? esc(z.zona_nombre) : '<span style="color:var(--color-text-light);">Sin zona</span>'}</strong></td>
      <td>${z.rutas.size}</td>
      <td>${z.entregas.toLocaleString('es-AR')}</td>
      <td>${fmtNum(z.km)} km</td>
      <td>${fmtPeso(z.facturado)}</td>
      <td>${fmtPeso(z.margen)}</td>
      <td>${z.sinCostoKm
            ? `<span class="badge-aviso">Sin configurar</span>`
            : fmtPeso(z.costoLog)}</td>
      <td class="${claseMargen}">${fmtPeso(z.margenNeto)}</td>
      <td class="${claseMargen}">${margenNetoPorKm != null ? fmtPeso(margenNetoPorKm) + '/km' : '—'}</td>
      <td>${rendBadge}</td>
    </tr>`;
  }).join('');
}

// ── Vista por ruta individual ─────────────────────────────────────────────
function renderVistaPorRuta(filas) {
  const tbody = document.getElementById('tbody-por-ruta');
  if (!tbody) return;

  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--color-text-light);">Sin datos en el período seleccionado</td></tr>`;
    return;
  }

  tbody.innerHTML = filas.map(f => {
    const margenNeto  = +f.margen_neto_estimado || 0;
    const claseMargen = margenNeto >= 0 ? 'monto-verde' : 'monto-rojo';
    const sinCostoKm  = !(+f.costo_km_configurado > 0);
    const margenPorKm = f.margen_neto_por_km != null ? fmtPeso(f.margen_neto_por_km) + '/km' : '—';

    return `<tr>
      <td><strong>${window.formatFecha ? window.formatFecha(f.ruta_fecha) : f.ruta_fecha}</strong></td>
      <td>${f.zona_nombre ? esc(f.zona_nombre) : '<span style="color:var(--color-text-light);">Sin zona</span>'}</td>
      <td style="font-size:12px;color:var(--color-text-muted);">${f.chofer_id ? '—' : '—'}</td>
      <td>${+f.entregas_completadas || 0}</td>
      <td>${fmtNum(f.km_recorridos)} km</td>
      <td>${fmtPeso(f.facturado_total)}</td>
      <td>${fmtPeso(f.margen_total)}</td>
      <td>${sinCostoKm
            ? `<span class="badge-aviso">Sin configurar</span>`
            : fmtPeso(f.costo_logistico_estimado)}</td>
      <td class="${claseMargen}">${fmtPeso(margenNeto)}</td>
      <td class="${claseMargen}">${margenPorKm}</td>
    </tr>`;
  }).join('');
}

// ── Toggle vista zona / ruta ──────────────────────────────────────────────
function cambiarVista(vista) {
  vistaActual = vista;
  document.getElementById('vista-zona').classList.toggle('hidden', vista !== 'zona');
  document.getElementById('vista-ruta').classList.toggle('hidden', vista !== 'ruta');
  document.getElementById('btn-vista-zona').classList.toggle('active', vista === 'zona');
  document.getElementById('btn-vista-ruta').classList.toggle('active', vista === 'ruta');
  renderVista();
}

function renderVista() {
  renderVistaPorZona(filasActuales);
  renderVistaPorRuta(filasActuales);
}

// ── Exportar CSV ──────────────────────────────────────────────────────────
function exportarCSV() {
  if (!filasActuales.length) {
    window.toast('No hay datos para exportar', 'err');
    return;
  }

  const cols = [
    'Fecha ruta', 'Zona', 'Entregas completadas', 'KM recorridos',
    'Facturado', 'Margen bruto', 'Costo logístico est.', 'Margen neto est.', 'Margen neto por km',
  ];

  const filas = filasActuales.map(f => [
    f.ruta_fecha,
    f.zona_nombre || 'Sin zona',
    f.entregas_completadas ?? 0,
    (+f.km_recorridos || 0).toFixed(2),
    (+f.facturado_total || 0).toFixed(2),
    (+f.margen_total || 0).toFixed(2),
    (+f.costo_logistico_estimado || 0).toFixed(2),
    (+f.margen_neto_estimado || 0).toFixed(2),
    f.margen_neto_por_km != null ? (+f.margen_neto_por_km).toFixed(2) : '',
  ]);

  const csv = [cols, ...filas].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `rentabilidad-zona-${fmtFechaInput(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  window.toast('CSV exportado', 'ok');
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtPeso(n) {
  return '$' + Math.round(+n || 0).toLocaleString('es-AR');
}
// Elige un tamaño de fuente más chico cuando el número formateado es largo,
// para que la tarjeta "Resultado principal" nunca corte el valor con "...".
function claseTamanioValor(texto) {
  const len = String(texto || '').length;
  if (len > 13) return 'kpi-card__value--size-sm';
  if (len > 10) return 'kpi-card__value--size-md';
  return '';
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 1 });
}
function fmtFechaInput(d) {
  return d.toISOString().slice(0, 10);
}
function esc(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}
async function getToken() {
  const { data: { session } } = await window.authCtx.sb.auth.getSession();
  return session?.access_token || '';
}

// Exponer para onclick inline
window.guardarCostoKm    = guardarCostoKm;
window.cargarRentabilidad = cargarRentabilidad;
window.cambiarVista       = cambiarVista;
window.exportarCSV        = exportarCSV;
