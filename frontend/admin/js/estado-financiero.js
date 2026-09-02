/**
 * estado-financiero.js — Estado Financiero Integral (pantalla única)
 *
 * Pedido de Ruben (ver 564_estado_financiero_integral.sql): una sola pantalla
 * con ingresos por canal + egresos por categoría + resultado (Día/Mes/Año) +
 * patrimonio neto aproximado. Reemplaza el cálculo 100% client-side de
 * reportes-financieros.js — acá todo el trabajo pesado ya viene resuelto por
 * una única RPC (obtener_estado_financiero_integral) vía
 * GET /api/admin/estado-financiero.
 *
 * Convenciones tomadas del resto del panel:
 *   - window.authReady / window.authCtx (auth-ready.js + auth.js)
 *   - window.api.get() (api-client.js) — maneja token, 401 y reintentos
 *   - crearGraficoECharts() (echarts-wrapper.js) para el gráfico de evolución
 *   - setBarraKpi() + CSS var --bar, mismo patrón que reportes-financieros.js
 *   - Formato de moneda inline con toLocaleString('es-AR'), sin depender de
 *     un helper global (no existe uno consolidado en el resto del panel).
 */

'use strict';

// ── Estado ──────────────────────────────────────────────────────────────
const EF = {
  agrupacion: 'mes',
  desde: null,
  hasta: null,
  datos: null,
};

let _chartEvolucion = null;

// Mismo mapeo de canales que dashboard.html (CANAL_LABEL) — se repite acá
// porque no hay todavía un módulo compartido de constantes de UI.
const CANAL_LABEL = {
  web: 'Tienda online', whatsapp: 'WhatsApp', portal_cliente: 'Pedido del cliente (online)',
  vendedor: 'Vendedor en ruta', telefono: 'Por teléfono', app: 'App', chofer: 'Reparto',
  admin: 'Carga manual (equipo)', pos: 'Venta de mostrador',
};

// ── Init ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await window.authReady;

    if (!window.PAGINA_ROLES_PERMITIDOS?.includes(window.authCtx?.perfil?.rol)) {
      window.location.href = '/admin/dashboard';
      return;
    }

    document.getElementById('btnAplicarFiltros')?.addEventListener('click', () => {
      EF.agrupacion = document.getElementById('filtroAgrupacion').value;
      EF.desde = document.getElementById('filtroFechaInicio').value || null;
      EF.hasta = document.getElementById('filtroFechaFin').value || null;
      cargarEstadoFinanciero();
    });

    document.getElementById('filtroAgrupacion')?.addEventListener('change', (e) => {
      EF.agrupacion = e.target.value;
      // Al cambiar la vista, se limpia el rango elegido a mano para que el
      // backend recalcule el default apropiado a esa vista (30 días / 12
      // meses / 5 años — ver rangoPorDefectoEstadoFinanciero en
      // lib/handlers/admin.js). Antes esto solo pasaba si los inputs ya
      // estaban vacíos, pero renderTodo() los rellena con el rango devuelto
      // en cada carga — así que nunca quedaban vacíos y cambiar la vista no
      // hacía nada.
      EF.desde = null;
      EF.hasta = null;
      document.getElementById('filtroFechaInicio').value = '';
      document.getElementById('filtroFechaFin').value = '';
      cargarEstadoFinanciero();
    });

    await cargarEstadoFinanciero();
  } catch (error) {
    console.error('[estado-financiero] error en inicialización:', error);
    window.mostrarToast?.('Error al cargar la página. Por favor, recarga.', 'danger');
  }
});

// ── Carga de datos ──────────────────────────────────────────────────────
async function cargarEstadoFinanciero() {
  const params = new URLSearchParams({ agrupacion: EF.agrupacion });
  if (EF.desde) params.set('desde', new Date(EF.desde).toISOString());
  if (EF.hasta) params.set('hasta', new Date(EF.hasta + 'T23:59:59').toISOString());

  mostrarCargando();

  try {
    const datos = await window.api.get(`/api/admin/estado-financiero?${params.toString()}`);
    EF.datos = datos;
    renderTodo(datos);
  } catch (err) {
    console.error('[estado-financiero] error cargando datos:', err);
    window.mostrarToast?.('No se pudo cargar el estado financiero.', 'danger');
    mostrarError();
  }
}
window.cargarEstadoFinanciero = cargarEstadoFinanciero;

function mostrarCargando() {
  document.getElementById('tbodyCanal').innerHTML = '<tr><td colspan="4" class="loading">Cargando datos...</td></tr>';
  document.getElementById('tbodyEgresosCategoria').innerHTML = '<tr><td colspan="3" class="loading">Cargando datos...</td></tr>';
  document.getElementById('tbodySerie').innerHTML = '<tr><td colspan="5" class="loading">Cargando datos...</td></tr>';
}

function mostrarError() {
  document.getElementById('tbodyCanal').innerHTML = '<tr><td colspan="4" class="tabla-empty">No se pudo cargar — <a href="javascript:void(0)" onclick="cargarEstadoFinanciero()">reintentar</a></td></tr>';
  document.getElementById('tbodyEgresosCategoria').innerHTML = '<tr><td colspan="3" class="tabla-empty">No se pudo cargar</td></tr>';
  document.getElementById('tbodySerie').innerHTML = '<tr><td colspan="5" class="tabla-empty">No se pudo cargar</td></tr>';
}

// ── Render orquestador ──────────────────────────────────────────────────
function renderTodo(datos) {
  // Reflejar en los filtros el rango efectivamente usado (si el backend
  // aplicó el default porque no vinieron desde/hasta).
  if (datos.desde) document.getElementById('filtroFechaInicio').value = datos.desde.slice(0, 10);
  if (datos.hasta) document.getElementById('filtroFechaFin').value = datos.hasta.slice(0, 10);

  renderResultadoPeriodo(datos.totales);
  renderPatrimonioNeto(datos.patrimonio_neto);
  renderGraficoEvolucion(datos.serie, datos.agrupacion);
  renderTablaCanal(datos.ingresos_por_canal);
  renderTablaEgresosCategoria(datos.egresos_por_categoria);
  renderTablaSerie(datos.serie, datos.agrupacion);
}

// ── Resultado del período (3 KPIs) ──────────────────────────────────────
function renderResultadoPeriodo(t) {
  t = t || { ingresos: 0, egresos: 0, resultado: 0 };
  const maxGrupo = Math.max(t.ingresos, t.egresos, Math.abs(t.resultado), 1);

  document.getElementById('kpiIngresos').textContent = formatMoneda(t.ingresos);
  document.getElementById('kpiEgresos').textContent = formatMoneda(t.egresos);

  const elResultado = document.getElementById('kpiResultado');
  elResultado.textContent = formatMoneda(t.resultado);
  elResultado.classList.remove('valor-positivo', 'valor-negativo');
  elResultado.classList.add(t.resultado >= 0 ? 'valor-positivo' : 'valor-negativo');

  setBarraKpi('kpiBarIngresos', t.ingresos / maxGrupo * 100);
  setBarraKpi('kpiBarEgresos', t.egresos / maxGrupo * 100);
  setBarraKpi('kpiBarResultado', Math.abs(t.resultado) / maxGrupo * 100);
}

// ── Patrimonio Neto ──────────────────────────────────────────────────────
function renderPatrimonioNeto(p) {
  p = p || {};
  const activo = p.activo || { caja: 0, por_cobrar: 0, stock_valorizado: 0, total: 0 };
  const pasivo = p.pasivo || { deuda_proveedores: 0, total: 0 };
  const neto = p.neto ?? (activo.total - pasivo.total);
  const maxGrupo = Math.max(activo.total, pasivo.total, Math.abs(neto), 1);

  document.getElementById('kpiActivo').textContent = formatMoneda(activo.total);
  document.getElementById('kpiPasivo').textContent = formatMoneda(pasivo.total);

  const elNeto = document.getElementById('kpiPatrimonioNeto');
  elNeto.textContent = formatMoneda(neto);
  elNeto.classList.remove('valor-positivo', 'valor-negativo');
  elNeto.classList.add(neto >= 0 ? 'valor-positivo' : 'valor-negativo');

  setBarraKpi('kpiBarActivo', activo.total / maxGrupo * 100);
  setBarraKpi('kpiBarPasivo', pasivo.total / maxGrupo * 100);
  setBarraKpi('kpiBarPatrimonioNeto', Math.abs(neto) / maxGrupo * 100);

  const tabla = document.getElementById('patrimonioDetalleTabla');
  if (tabla) {
    tabla.innerHTML = `
      <div><span>Caja (turnos POS)</span><span>${formatMoneda(activo.caja)}</span></div>
      <div><span>Cuentas por cobrar</span><span>${formatMoneda(activo.por_cobrar)}</span></div>
      <div><span>Stock valorizado</span><span>${formatMoneda(activo.stock_valorizado)}</span></div>
      <div><span>Total Activo</span><span>${formatMoneda(activo.total)}</span></div>
      <div><span>Deuda a proveedores</span><span>${formatMoneda(pasivo.deuda_proveedores)}</span></div>
      <div><span>Total Pasivo</span><span>${formatMoneda(pasivo.total)}</span></div>
    `;
  }
}

// ── Gráfico de evolución (ECharts) ──────────────────────────────────────
function renderGraficoEvolucion(serie, agrupacion) {
  serie = serie || [];

  if (serie.length === 0) {
    _chartEvolucion = crearGraficoECharts(_chartEvolucion, 'chartEvolucion', null, {
      htmlVacio: '<div class="echarts-vacio">Sin movimientos en el rango elegido.</div>',
    });
    return;
  }

  if (typeof inicializarTemaECharts === 'function') inicializarTemaECharts();

  const labels = serie.map((p) => formatPeriodo(p.periodo, agrupacion));
  const ingresos = serie.map((p) => p.ingresos);
  const egresos = serie.map((p) => p.egresos);
  const resultado = serie.map((p) => p.resultado);

  const tema = getComputedStyle(document.documentElement);
  const colorTeal = (tema.getPropertyValue('--ge-teal') || '#6A9873').trim();
  const colorRed = (tema.getPropertyValue('--ge-red') || '#B8402E').trim();
  const colorBlue = (tema.getPropertyValue('--ge-blue') || '#33507A').trim();

  _chartEvolucion = crearGraficoECharts(_chartEvolucion, 'chartEvolucion', {
    grid: { top: 34, bottom: 26, left: 8, right: 10, containLabel: true },
    legend: { top: 0, textStyle: { fontSize: 11 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        if (!params.length) return '';
        let html = `<strong style="font-size:11px;opacity:.7">${escapeHtml(params[0].axisValueLabel)}</strong><br>`;
        params.forEach((p) => {
          html += `<span style="color:${p.color}">●</span> ${escapeHtml(p.seriesName)}: <strong>${formatMonedaCorto(p.value)}</strong><br>`;
        });
        return html;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: '#DDE1DC' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 10, color: '#3A423E' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, color: '#3A423E', formatter: formatMonedaCorto },
      splitLine: { lineStyle: { color: '#DDE1DC', type: 'dashed' } },
    },
    series: [
      { name: 'Ingresos', type: 'bar', data: ingresos, itemStyle: { color: colorTeal }, barMaxWidth: 26 },
      { name: 'Egresos', type: 'bar', data: egresos, itemStyle: { color: colorRed }, barMaxWidth: 26 },
      { name: 'Resultado', type: 'line', data: resultado, showSymbol: false, lineStyle: { color: colorBlue, width: 2.5 }, itemStyle: { color: colorBlue } },
    ],
  }, { notMerge: true });
}

function formatPeriodo(iso, agrupacion) {
  if (!iso) return '';
  const d = new Date(iso);
  if (agrupacion === 'anio') return String(d.getUTCFullYear());
  if (agrupacion === 'mes') return d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}

// ── Tabla: ingresos por canal ────────────────────────────────────────────
function renderTablaCanal(lista) {
  const tbody = document.getElementById('tbodyCanal');
  lista = lista || [];
  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="tabla-empty">Sin ingresos en el rango elegido</td></tr>';
    return;
  }
  const total = lista.reduce((acc, c) => acc + (c.total || 0), 0) || 1;
  tbody.innerHTML = lista.map((c) => {
    const pct = (c.total || 0) / total * 100;
    return `
      <tr>
        <td>${escapeHtml(CANAL_LABEL[c.canal] || c.canal)}</td>
        <td class="col-fit dato-mono">${c.cantidad ?? 0}</td>
        <td class="col-fit dato-mono">${formatMoneda(c.total)}</td>
        <td class="col-fit">${renderPctBar(pct)}</td>
      </tr>
    `;
  }).join('');
}

// ── Tabla: egresos por categoría ─────────────────────────────────────────
function renderTablaEgresosCategoria(lista) {
  const tbody = document.getElementById('tbodyEgresosCategoria');
  lista = lista || [];
  if (lista.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="tabla-empty">Sin egresos por categoría en el rango elegido</td></tr>';
    return;
  }
  const total = lista.reduce((acc, c) => acc + (c.total || 0), 0) || 1;
  tbody.innerHTML = lista.map((c) => {
    const pct = (c.total || 0) / total * 100;
    return `
      <tr>
        <td>${escapeHtml(c.categoria || '—')}</td>
        <td class="col-fit dato-mono">${formatMoneda(c.total)}</td>
        <td class="col-fit">${renderPctBar(pct)}</td>
      </tr>
    `;
  }).join('');
}

// ── Tabla: detalle por período ───────────────────────────────────────────
function renderTablaSerie(serie, agrupacion) {
  const tbody = document.getElementById('tbodySerie');
  serie = serie || [];
  if (serie.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="tabla-empty">Sin movimientos en el rango elegido</td></tr>';
    return;
  }
  // Más reciente primero, igual que el resto de las tablas de detalle del panel.
  const ordenado = [...serie].sort((a, b) => new Date(b.periodo) - new Date(a.periodo));
  tbody.innerHTML = ordenado.map((p) => `
    <tr>
      <td>${escapeHtml(formatPeriodo(p.periodo, agrupacion))}</td>
      <td class="col-fit dato-mono">${p.cantidad_ventas ?? 0}</td>
      <td class="col-fit dato-mono">${formatMoneda(p.ingresos)}</td>
      <td class="col-fit dato-mono">${formatMoneda(p.egresos)}</td>
      <td class="col-fit dato-mono ${p.resultado >= 0 ? 'valor-positivo' : 'valor-negativo'}">${formatMoneda(p.resultado)}</td>
    </tr>
  `).join('');
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Setea el ancho de la barra de magnitud de una línea del manifiesto de KPIs
// (0-100, clampeado) — mismo patrón que reportes-financieros.js.
function setBarraKpi(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const val = Math.max(0, Math.min(100, isFinite(pct) ? pct : 0));
  el.style.setProperty('--bar', val + '%');
}

function renderPctBar(pct) {
  const val = Math.max(0, Math.min(100, isFinite(pct) ? pct : 0));
  return `
    <span class="pct-bar-wrap">
      <span class="pct-bar-track"><span class="pct-bar-fill" style="width:${val}%"></span></span>
      <span class="pct-bar-label">${val.toFixed(0)}%</span>
    </span>
  `;
}

function formatMoneda(valor) {
  const n = Number(valor) || 0;
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMonedaCorto(valor) {
  const n = Number(valor) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function escapeHtml(str) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(str);
}
