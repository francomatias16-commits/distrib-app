/**
 * dashboard-ejecutivo.js — Panel ejecutivo (Etapa 5: BI/Reportes)
 *
 * Módulo aparte y aditivo a dashboard-optimizado.js (no lo toca) para no
 * arriesgar el flujo de carga ya afinado del panel principal. Se engancha
 * a los mismos controles (#select-periodo, #btn-refrescar) vía sus propios
 * listeners, en vez de meterse dentro de bindEventos() de ese archivo.
 *
 * Qué hace:
 *   - Pide GET /api/admin/dashboard-ejecutivo?periodo=X (cobranza,
 *     rentabilidad, stock crítico detallado, resumen de ventas).
 *   - Pide GET /api/admin/comparativa-mensual (serie diaria mes actual vs.
 *     mismo tramo del mes anterior).
 *   - Renderiza ambas cosas dentro de #panel-ejecutivo-card (ver dashboard.html).
 *   - Maneja el export consolidado (ventas + cobranza + stock + rentabilidad)
 *     a Excel (.xlsx real, vía SheetJS) y a PDF (vía jsPDF + autotable),
 *     cargando esas librerías por CDN recién al primer click — no penalizan
 *     la carga inicial del panel.
 */

'use strict';

const PE = {
  ultimoResumen: null,
  ultimaComparativa: null,
  ultimoStockDetalle: [], // se completa al exportar (no se duplica la tarjeta de arriba)
};

function _peEsperarAuth(cb) {
  if (window.authCtx && window.authCtx.perfil) { cb(); return; }
  window.authReady?.then(cb).catch(() => {
    // Si authReady falla, dashboard-optimizado.js ya avisa con un toast —
    // acá simplemente no cargamos el panel ejecutivo, sin duplicar el error.
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const card = document.getElementById('panel-ejecutivo-card');
  if (!card) return; // página sin este panel (defensivo)

  _peEsperarAuth(async () => {
    // Secuencial, no en paralelo — ver comentario en ejecutarConLimite()
    // de dashboard-optimizado.js: estas 2 se sumaban a las 10 de ahí y
    // agravaban el pico de invocaciones concurrentes contra admin.js.
    await cargarPanelEjecutivo();
    await cargarComparativaMensual();
  });

  document.getElementById('select-periodo')?.addEventListener('change', () => {
    cargarPanelEjecutivo(); // la comparativa mensual no depende del período, no hace falta recargarla
  });

  document.getElementById('btn-refrescar')?.addEventListener('click', () => {
    cargarPanelEjecutivo();
    cargarComparativaMensual();
  });

  document.getElementById('btn-export-excel')?.addEventListener('click', exportarExcel);
  document.getElementById('btn-export-pdf')?.addEventListener('click', exportarPDF);
});

// ══════════════════════════════════════════════════════════════════════
// CARGA DE DATOS
// ══════════════════════════════════════════════════════════════════════

async function cargarPanelEjecutivo() {
  const periodo = document.getElementById('select-periodo')?.value || '30d';
  try {
    const data = await window.api.get(`/api/admin/dashboard-ejecutivo?periodo=${periodo}`);
    PE.ultimoResumen = data;
    renderCobranza(data.cobranza);
    renderRentabilidad(data.rentabilidad);
  } catch (err) {
    console.error('[panel-ejecutivo] error cargando resumen:', err);
    document.getElementById('pe-cobranza-tabla').innerHTML =
      '<tr><td colspan="4" class="td-empty">No se pudo cargar — <a href="javascript:void(0)" onclick="cargarPanelEjecutivo()">reintentar</a></td></tr>';
  }
}
window.cargarPanelEjecutivo = cargarPanelEjecutivo;

async function cargarComparativaMensual() {
  try {
    const data = await window.api.get('/api/admin/comparativa-mensual');
    PE.ultimaComparativa = data;
    renderComparativaMensual(data);
  } catch (err) {
    console.error('[panel-ejecutivo] error cargando comparativa mensual:', err);
    const cont = document.getElementById('pe-comparativa-grafico');
    if (cont) cont.innerHTML = '<p class="td-empty">No se pudo cargar la comparativa mensual.</p>';
  }
}

// ══════════════════════════════════════════════════════════════════════
// RENDER — Cobranza
// ══════════════════════════════════════════════════════════════════════

function renderCobranza(c) {
  const kpisEl = document.getElementById('pe-cobranza-kpis');
  const tablaEl = document.getElementById('pe-cobranza-tabla');
  if (!c) { kpisEl.innerHTML = ''; tablaEl.innerHTML = '<tr><td colspan="4" class="td-empty">Sin datos</td></tr>'; return; }

  kpisEl.innerHTML = `
    <div class="pe-kpi-chip">
      <span class="pe-kpi-valor">$${window.formatMonedaCorto(c.total_pendiente || 0)}</span>
      <span class="pe-kpi-label">Total pendiente</span>
    </div>
    <div class="pe-kpi-chip pe-kpi-chip--danger">
      <span class="pe-kpi-valor">$${window.formatMonedaCorto(c.monto_accion_urgente || 0)}</span>
      <span class="pe-kpi-label">Acción urgente (${c.facturas_urgentes_count || 0})</span>
    </div>
    <div class="pe-kpi-chip">
      <span class="pe-kpi-valor">$${window.formatMonedaCorto(c.monto_seguimiento || 0)}</span>
      <span class="pe-kpi-label">Seguimiento</span>
    </div>
  `;

  const top = c.top_urgentes || [];
  if (top.length === 0) {
    tablaEl.innerHTML = '<tr><td colspan="4" class="td-empty"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="16 9 10.5 15 8 12.5"/></svg>Sin facturas en estado de acción urgente</td></tr>';
  } else {
    tablaEl.innerHTML = top.map(f => `
      <tr>
        <td>${escapeHtml(f.cliente_nombre || '—')}</td>
        <td>${escapeHtml(f.numero_factura || '—')}</td>
        <td class="td-center">${f.dias_vencida ?? 0} días</td>
        <td class="td-right">$${window.formatMoneda(f.saldo_pendiente || 0)}</td>
      </tr>
    `).join('');
  }
}

// ══════════════════════════════════════════════════════════════════════
// RENDER — Rentabilidad
// ══════════════════════════════════════════════════════════════════════

function renderRentabilidad(r) {
  const kpisEl = document.getElementById('pe-rentabilidad-kpis');
  const tablaEl = document.getElementById('pe-rentabilidad-tabla');
  if (!r) { kpisEl.innerHTML = ''; tablaEl.innerHTML = '<tr><td colspan="3" class="td-empty">Sin datos</td></tr>'; return; }

  kpisEl.innerHTML = `
    <div class="pe-kpi-chip">
      <span class="pe-kpi-valor">$${window.formatMonedaCorto(r.margen_neto_total || 0)}</span>
      <span class="pe-kpi-label">Margen neto (período)</span>
    </div>
    <div class="pe-kpi-chip">
      <span class="pe-kpi-valor">${r.mejor_zona?.zona_nombre || '—'}</span>
      <span class="pe-kpi-label">Zona más rentable</span>
    </div>
    <div class="pe-kpi-chip">
      <span class="pe-kpi-valor">${(r.km_recorridos_total || 0).toFixed ? r.km_recorridos_total.toFixed(0) : r.km_recorridos_total} km</span>
      <span class="pe-kpi-label">Recorridos</span>
    </div>
  `;

  const zonas = r.por_zona || [];
  if (zonas.length === 0) {
    tablaEl.innerHTML = '<tr><td colspan="3" class="td-empty">Sin rutas entregadas en el período</td></tr>';
  } else {
    tablaEl.innerHTML = zonas.map(z => `
      <tr>
        <td>${escapeHtml(z.zona_nombre || '—')}</td>
        <td class="td-right">$${window.formatMoneda(z.facturado_zona || 0)}</td>
        <td class="td-right">$${window.formatMoneda(z.margen_neto_zona || 0)}</td>
      </tr>
    `).join('');
  }
}

// ══════════════════════════════════════════════════════════════════════
// RENDER — Comparativa mensual (ECharts: line + area, mismo criterio que
// renderProgresoPedidos/renderGraficoVentas en dashboard-optimizado.js)
// ══════════════════════════════════════════════════════════════════════

let _comparativaChart = null;
function renderComparativaMensual(data) {
  const cont = document.getElementById('pe-comparativa-grafico');
  const legendEl = document.getElementById('pe-comparativa-legend');
  const titulo = document.getElementById('pe-comparativa-titulo');
  const deltaBadge = document.getElementById('pe-comparativa-delta');
  const nota = document.getElementById('pe-nota-historial');
  if (!cont || !data) return;

  titulo.textContent = `${data.mes_actual_label} vs. ${data.mes_anterior_label}`;

  if (data.delta_pct === null || data.delta_pct === undefined) {
    deltaBadge.textContent = '';
  } else {
    const positivo = data.delta_pct >= 0;
    deltaBadge.textContent = `${positivo ? '▲' : '▼'} ${Math.abs(data.delta_pct)}%`;
    deltaBadge.className = `pe-delta-badge ${positivo ? 'pe-delta-badge--up' : 'pe-delta-badge--down'}`;
  }

  if (nota) nota.style.display = (data.total_anterior || 0) === 0 ? 'block' : 'none';

  const actual   = data.serie_actual   || [];
  const anterior = data.serie_anterior || [];

  if (actual.length === 0) {
    _comparativaChart = crearGraficoECharts(_comparativaChart, 'pe-comparativa-grafico', null, {
      htmlVacio: '<div class="pe-chart-wrap"><p class="td-empty" style="padding:32px">Sin ventas registradas este mes.</p></div>',
    });
    if (legendEl) legendEl.innerHTML = '';
    return;
  }

  const n    = actual.length;
  const nAnt = anterior.length;
  const fmt  = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${v}`;

  const labels     = actual.map((_, i) => i + 1);
  const dataActual = actual.map(s => s.total);
  // Alinea la serie del mes anterior por índice de día; null donde no hay dato
  // (connectNulls la mantiene como línea continua igual que antes).
  const dataAnterior = nAnt > 0 ? labels.map((_, i) => (anterior[i] ? anterior[i].total : null)) : null;

  if (typeof inicializarTemaECharts === 'function') inicializarTemaECharts();

  _comparativaChart = crearGraficoECharts(_comparativaChart, 'pe-comparativa-grafico', {
    grid: { top: 14, bottom: 22, left: 8, right: 10, containLabel: true },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        if (!params.length) return '';
        let html = `<strong style="font-size:11px;opacity:.7">Día ${params[0].axisValueLabel}</strong><br>`;
        params.forEach((p) => {
          if (p.value === null || p.value === undefined) return;
          html += `<span style="color:${p.color}">●</span> ${escapeHtml(p.seriesName)}: <strong>${window.formatMonedaCorto(p.value)}</strong><br>`;
        });
        return html;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#DAD3C0' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 10, color: '#6B695F' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, color: '#6B695F', formatter: fmt },
      splitLine: { lineStyle: { color: '#DAD3C0', type: 'dashed' } },
    },
    series: [
      ...(dataAnterior ? [{
        name: data.mes_anterior_label,
        type: 'line',
        data: dataAnterior,
        connectNulls: true,
        showSymbol: false,
        lineStyle: { color: '#C8D0D4', width: 2, type: [5, 4] },
        itemStyle: { color: '#C8D0D4' },
      }] : []),
      {
        name: data.mes_actual_label,
        type: 'line',
        data: dataActual,
        showSymbol: false,
        lineStyle: { color: '#B87A00', width: 2.5 },
        itemStyle: { color: '#B87A00' },
        emphasis: { focus: 'series' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(184,122,0,0.28)' },
              { offset: 1, color: 'rgba(184,122,0,0.02)' },
            ],
          },
        },
      },
    ],
  }, { notMerge: true });

  if (legendEl) {
    legendEl.innerHTML = `
      <span><i style="background:#B87A00"></i>${escapeHtml(data.mes_actual_label)} (${window.formatMonedaCorto(data.total_actual || 0)})</span>
      ${nAnt > 0 ? `<span><i style="background:#C8D0D4;border:1px dashed #aaa"></i>${escapeHtml(data.mes_anterior_label)} (${window.formatMonedaCorto(data.total_anterior || 0)})</span>` : ''}
    `;
  }
}

// ══════════════════════════════════════════════════════════════════════
// EXPORT — Excel (.xlsx real, SheetJS) y PDF (jsPDF + autotable)
// Ambos cargan su librería por CDN recién al primer uso.
// ══════════════════════════════════════════════════════════════════════

let _xlsxCargado = null;
function _cargarXLSX() {
  if (_xlsxCargado) return _xlsxCargado;
  _xlsxCargado = new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('No se pudo cargar la librería de Excel'));
    document.head.appendChild(script);
  });
  return _xlsxCargado;
}

let _jspdfCargado = null;
function _cargarJsPDF() {
  if (_jspdfCargado) return _jspdfCargado;
  _jspdfCargado = new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) return resolve(window.jspdf);
    const s1 = document.createElement('script');
    s1.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
      s2.onload = () => resolve(window.jspdf);
      s2.onerror = () => reject(new Error('No se pudo cargar el plugin de tablas de PDF'));
      document.head.appendChild(s2);
    };
    s1.onerror = () => reject(new Error('No se pudo cargar la librería de PDF'));
    document.head.appendChild(s1);
  });
  return _jspdfCargado;
}

// Trae el detalle de stock crítico completo para el export (la tarjeta de
// arriba ya lo muestra en pantalla, pero solo hasta 10 ítems vía
// /api/admin/stock/bajo — se reusa ese mismo endpoint, no se duplica lógica).
async function _traerStockParaExport() {
  try {
    const data = await window.api.get('/api/admin/stock/bajo?limit=50');
    return data.items || [];
  } catch {
    return [];
  }
}

function _fechaArchivo() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function exportarExcel() {
  const btn = document.getElementById('btn-export-excel');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Generando…';
  try {
    const [XLSX] = await Promise.all([_cargarXLSX()]);
    if (!PE.ultimoResumen) await cargarPanelEjecutivo();
    if (!PE.ultimaComparativa) await cargarComparativaMensual();
    const stock = await _traerStockParaExport();

    const r = PE.ultimoResumen || {};
    const cmp = PE.ultimaComparativa || {};

    const wb = XLSX.utils.book_new();

    // Hoja 1: Resumen
    const resumen = [
      ['Panel ejecutivo — Fluxo', ''],
      ['Generado', new Date().toLocaleString('es-AR')],
      ['Período', r.desde && r.hasta ? `${r.desde.slice(0, 10)} a ${r.hasta.slice(0, 10)}` : ''],
      [],
      ['Ventas', ''],
      ['Total del período', r.ventas?.total || 0],
      ['Variación vs. período anterior', r.ventas?.delta_pct != null ? `${r.ventas.delta_pct}%` : 's/d'],
      ['Pedidos', r.ventas?.pedidos || 0],
      ['Clientes activos', r.ventas?.clientes_activos || 0],
      [],
      ['Cobranza', ''],
      ['Total pendiente', r.cobranza?.total_pendiente || 0],
      ['Monto en acción urgente', r.cobranza?.monto_accion_urgente || 0],
      ['Monto en seguimiento', r.cobranza?.monto_seguimiento || 0],
      [],
      ['Rentabilidad', ''],
      ['Margen neto del período', r.rentabilidad?.margen_neto_total || 0],
      ['Facturado del período', r.rentabilidad?.facturado_total || 0],
      ['Km recorridos', r.rentabilidad?.km_recorridos_total || 0],
      [],
      ['Stock', ''],
      ['Ítems en stock crítico', r.stock?.criticos_count ?? stock.length],
      [],
      ['Comparativa mensual', ''],
      ['Mes actual', `${cmp.mes_actual_label || ''} — $${cmp.total_actual || 0}`],
      ['Mes anterior', `${cmp.mes_anterior_label || ''} — $${cmp.total_anterior || 0}`],
      ['Variación', cmp.delta_pct != null ? `${cmp.delta_pct}%` : 's/d'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');

    // Hoja 2: Cobranza (detalle de urgentes)
    const cobranzaRows = (r.cobranza?.top_urgentes || []).map(f => ({
      Cliente: f.cliente_nombre, Factura: f.numero_factura,
      'Días vencida': f.dias_vencida, 'Saldo pendiente': f.saldo_pendiente,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cobranzaRows), 'Cobranza');

    // Hoja 3: Rentabilidad por zona
    const rentRows = (r.rentabilidad?.por_zona || []).map(z => ({
      Zona: z.zona_nombre, Facturado: z.facturado_zona, 'Margen neto': z.margen_neto_zona,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rentRows), 'Rentabilidad');

    // Hoja 4: Stock crítico
    const stockRows = stock.map(s => ({
      Código: s.codigo, Producto: s.nombre,
      Disponible: s.cantidad_disponible, 'Stock mínimo': s.stock_minimo,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stockRows), 'Stock crítico');

    // Hoja 5: Comparativa mensual (serie diaria)
    const dias = Math.max((cmp.serie_actual || []).length, (cmp.serie_anterior || []).length);
    const cmpRows = [];
    for (let i = 0; i < dias; i++) {
      cmpRows.push({
        'Día del mes': i + 1,
        [cmp.mes_actual_label || 'Mes actual']: cmp.serie_actual?.[i]?.total ?? '',
        [cmp.mes_anterior_label || 'Mes anterior']: cmp.serie_anterior?.[i]?.total ?? '',
      });
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cmpRows), 'Comparativa mensual');

    XLSX.writeFile(wb, `panel-ejecutivo-${_fechaArchivo()}.xlsx`);
    window.mostrarToast?.('Excel generado correctamente', 'success');
  } catch (err) {
    console.error('[panel-ejecutivo] error exportando Excel:', err);
    window.mostrarToast?.('No se pudo generar el Excel', 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

async function exportarPDF() {
  const btn = document.getElementById('btn-export-pdf');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Generando…';
  try {
    const { jsPDF } = await _cargarJsPDF();
    if (!PE.ultimoResumen) await cargarPanelEjecutivo();
    if (!PE.ultimaComparativa) await cargarComparativaMensual();

    const r = PE.ultimoResumen || {};
    const cmp = PE.ultimaComparativa || {};

    const doc = new jsPDF();
    const empresaNombre = window.authCtx?.perfil?.empresa_nombre || document.title;

    doc.setFontSize(16);
    doc.text('Panel ejecutivo', 14, 18);
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`${empresaNombre} — generado ${new Date().toLocaleString('es-AR')}`, 14, 24);
    doc.setTextColor(0);

    doc.autoTable({
      startY: 32,
      head: [['Indicador', 'Valor']],
      body: [
        ['Ventas del período', `$${window.formatMoneda(r.ventas?.total || 0)}`],
        ['Variación vs. período anterior', r.ventas?.delta_pct != null ? `${r.ventas.delta_pct}%` : 's/d'],
        ['Total pendiente de cobranza', `$${window.formatMoneda(r.cobranza?.total_pendiente || 0)}`],
        ['En acción urgente', `$${window.formatMoneda(r.cobranza?.monto_accion_urgente || 0)}`],
        ['Margen neto (rentabilidad)', `$${window.formatMoneda(r.rentabilidad?.margen_neto_total || 0)}`],
        ['Ítems en stock crítico', r.stock?.criticos_count ?? 0],
        ['Comparativa mensual', `${cmp.mes_actual_label || ''} $${window.formatMoneda(cmp.total_actual || 0)} vs. ${cmp.mes_anterior_label || ''} $${window.formatMoneda(cmp.total_anterior || 0)}`],
      ],
      theme: 'striped',
      headStyles: { fillColor: [15, 61, 44] },
    });

    let y = doc.lastAutoTable.finalY + 12;
    doc.setFontSize(12);
    doc.text('Cobranza — facturas en acción urgente', 14, y);
    doc.autoTable({
      startY: y + 4,
      head: [['Cliente', 'Factura', 'Días vencida', 'Saldo']],
      body: (r.cobranza?.top_urgentes || []).map(f => [
        f.cliente_nombre, f.numero_factura, f.dias_vencida, `$${window.formatMoneda(f.saldo_pendiente || 0)}`,
      ]),
      theme: 'striped',
      headStyles: { fillColor: [15, 61, 44] },
    });

    y = doc.lastAutoTable.finalY + 12;
    doc.setFontSize(12);
    doc.text('Rentabilidad por zona', 14, y);
    doc.autoTable({
      startY: y + 4,
      head: [['Zona', 'Facturado', 'Margen neto']],
      body: (r.rentabilidad?.por_zona || []).map(z => [
        z.zona_nombre, `$${window.formatMoneda(z.facturado_zona || 0)}`, `$${window.formatMoneda(z.margen_neto_zona || 0)}`,
      ]),
      theme: 'striped',
      headStyles: { fillColor: [15, 61, 44] },
    });

    doc.save(`panel-ejecutivo-${_fechaArchivo()}.pdf`);
    window.mostrarToast?.('PDF generado correctamente', 'success');
  } catch (err) {
    console.error('[panel-ejecutivo] error exportando PDF:', err);
    window.mostrarToast?.('No se pudo generar el PDF', 'error');
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}

// ══════════════════════════════════════════════════════════════════════
function escapeHtml(str) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(str);
}
