/* admin/js/rentabilidad-producto-vendedor.js — Etapa 2 (Comercial y precios), ítem 2/3
   Lee /api/rutas-live?accion=rentabilidad-producto|rentabilidad-vendedor →
   v_rentabilidad_producto / v_rentabilidad_vendedor (245). Vista doble,
   igual patrón que rentabilidad-zona.js. Combina pedidos entregados +
   ventas de mostrador (POS). */

const ROLES_RENTABILIDAD = ['dueno', 'admin', 'contador'];

let filasProducto  = [];   // filas crudas de v_rentabilidad_producto (ya agregadas por producto)
let filasVendedor  = [];   // filas crudas de v_rentabilidad_vendedor (ya agregadas por vendedor)
let vistaActual    = 'producto'; // 'producto' | 'vendedor'
let _chart         = null;

// ── Paginación de las tablas de detalle (client-side: los datos ya vienen
// completos del backend y se agregan en JS, así que no hace falta pedir
// páginas al servidor — solo cortar el arreglo ya calculado) ───────────────
const PAGINACION = {
  porPagina: 20,
  paginaProducto: 1,
  paginaVendedor: 1,
};

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

  await cargarRentabilidad();
});

// ── Carga principal (ambas vistas en paralelo) ───────────────────────────
async function cargarRentabilidad() {
  const tbodyProd = document.getElementById('tbody-por-producto');
  const tbodyVend = document.getElementById('tbody-por-vendedor');
  const placeholder = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-text-light);">Cargando…</td></tr>`;
  if (tbodyProd) tbodyProd.innerHTML = placeholder;
  if (tbodyVend) tbodyVend.innerHTML = placeholder;
  document.getElementById('kpis-grid').innerHTML = '';

  // Datos nuevos → siempre se vuelve a la página 1 en ambas vistas.
  PAGINACION.paginaProducto = 1;
  PAGINACION.paginaVendedor = 1;

  try {
    const token = await getToken();
    const desde = document.getElementById('filtro-desde').value;
    const hasta = document.getElementById('filtro-hasta').value;

    const qs = new URLSearchParams();
    if (desde) qs.set('desde', desde);
    if (hasta) qs.set('hasta', hasta);

    const [rProd, rVend] = await Promise.all([
      fetch(`/api/rutas-live?accion=rentabilidad-producto&${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`/api/rutas-live?accion=rentabilidad-vendedor&${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const dataProd = await rProd.json();
    const dataVend = await rVend.json();
    if (!rProd.ok) throw new Error(dataProd.error || 'Error al cargar rentabilidad por producto');
    if (!rVend.ok) throw new Error(dataVend.error || 'Error al cargar rentabilidad por vendedor');

    filasProducto = dataProd.rentabilidad || [];
    filasVendedor = dataVend.rentabilidad || [];

    poblarFiltroCategorias(filasProducto);
    renderKpis();
    renderChart();
    renderVista();

  } catch (e) {
    console.error('[RENT-PROD-VEND] cargar:', e);
    const msg = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--color-danger);">No se pudo cargar el reporte.</td></tr>`;
    if (tbodyProd) tbodyProd.innerHTML = msg;
    if (tbodyVend) tbodyVend.innerHTML = msg;
    window.toast('Error al cargar rentabilidad', 'error');
  }
}

// ── Agregación por dimensión (las vistas traen una fila por fecha/origen) ──
function agregarPorProducto(filas) {
  const map = new Map();
  for (const f of filas) {
    const key  = f.producto_id;
    const prev = map.get(key) || {
      producto_id: f.producto_id,
      producto_nombre: f.producto_nombre,
      categoria_id: f.categoria_id,
      categoria_nombre: f.categoria_nombre,
      cantidad: 0, facturado: 0, margen: 0,
      origenes: new Set(),
    };
    prev.cantidad  += +f.cantidad_vendida || 0;
    prev.facturado += +f.facturado_total  || 0;
    prev.margen    += +f.margen_total     || 0;
    prev.origenes.add(f.origen);
    map.set(key, prev);
  }
  return [...map.values()].sort((a, b) => b.margen - a.margen);
}

function agregarPorVendedor(filas) {
  const map = new Map();
  for (const f of filas) {
    const key  = f.vendedor_id || '__sin_vendedor__';
    const prev = map.get(key) || {
      vendedor_id: f.vendedor_id,
      vendedor_nombre: f.vendedor_nombre,
      documentos: 0, facturado: 0, margen: 0,
      origenes: new Set(),
    };
    prev.documentos += +f.documentos      || 0;
    prev.facturado  += +f.facturado_total || 0;
    prev.margen     += +f.margen_total    || 0;
    prev.origenes.add(f.origen);
    map.set(key, prev);
  }
  return [...map.values()].sort((a, b) => b.margen - a.margen);
}

// ── Filtro de categoría (solo aplica a la vista por producto) ─────────────
function poblarFiltroCategorias(filas) {
  const select = document.getElementById('filtro-categoria');
  const actual = select.value;
  const cats = new Map();
  for (const f of filas) {
    if (f.categoria_id && f.categoria_nombre) cats.set(f.categoria_id, f.categoria_nombre);
  }
  select.innerHTML = `<option value="">Todas las categorías</option>` +
    [...cats.entries()].map(([id, nombre]) =>
      `<option value="${id}"${id === actual ? ' selected' : ''}>${esc(nombre)}</option>`
    ).join('');
}

// ── KPIs (combinan ambas dimensiones, mismo total de negocio) ─────────────
function renderKpis() {
  const cont = document.getElementById('kpis-grid');

  if (!filasProducto.length && !filasVendedor.length) {
    cont.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--color-text-light);">Sin ventas (pedidos entregados o POS) en el rango seleccionado.</div>`;
    return;
  }

  const totalFacturado = filasProducto.reduce((s, f) => s + (+f.facturado_total || 0), 0);
  const totalMargen    = filasProducto.reduce((s, f) => s + (+f.margen_total    || 0), 0);
  const productos       = agregarPorProducto(filasProducto);
  const vendedores       = agregarPorVendedor(filasVendedor);
  const pctMargen        = totalFacturado > 0 ? ((totalMargen / totalFacturado) * 100).toFixed(1) : null;

  const mejorProducto = productos[0];
  const mejorVendedor  = vendedores[0];

  cont.className = 'franja-resumen-sololectura';
  cont.innerHTML = `
    <div class="dato-sello" title="Con al menos una venta en el período"><div class="dato-sello-valor">${productos.length}</div><div class="dato-sello-etiqueta">Productos con ventas</div></div>
    <div class="dato-sello" title="Suma de ventas del período"><div class="dato-sello-valor">${fmtPeso(totalFacturado)}</div><div class="dato-sello-etiqueta">Facturado total</div></div>
    <div class="dato-sello" data-tono="verde" title="Facturado menos costo de mercadería"><div class="dato-sello-valor">${fmtPeso(totalMargen)}</div><div class="dato-sello-etiqueta">Margen${pctMargen != null ? ` (${pctMargen}%)` : ''}</div></div>
    <div class="dato-sello" title="Con al menos un pedido asignado"><div class="dato-sello-valor">${vendedores.length}</div><div class="dato-sello-etiqueta">Vendedores con ventas</div></div>
    <div class="dato-sello" title="Producto con mayor margen acumulado"><div class="dato-sello-valor">${mejorProducto ? esc(mejorProducto.producto_nombre) : '—'}</div><div class="dato-sello-etiqueta">Producto top</div></div>
    <div class="dato-sello" title="Vendedor con mayor margen acumulado"><div class="dato-sello-valor">${mejorVendedor ? esc(mejorVendedor.vendedor_nombre || 'Sin vendedor asignado') : '—'}</div><div class="dato-sello-etiqueta">Vendedor top</div></div>
  `;
}

// ── Gráfico de barras (top 15 de la vista activa) ─────────────────────────
function renderChart() {
  const wrap = document.getElementById('chart-wrap');
  const titulo = document.getElementById('chart-titulo');

  const datos = vistaActual === 'producto' ? agregarPorProducto(filasProducto) : agregarPorVendedor(filasVendedor);
  if (!datos.length) { wrap.classList.add('hidden'); return; }

  titulo.textContent = vistaActual === 'producto' ? 'Margen por producto' : 'Margen por vendedor';

  const top    = datos.slice(0, 15);
  const labels = top.map(d => vistaActual === 'producto' ? d.producto_nombre : (d.vendedor_nombre || 'Sin vendedor'));
  const valores = top.map(d => Math.round(d.margen));

  const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
  const colorPositivo = tokens.teal || '#6A9873';
  const colorNegativo = tokens.red  || '#B8402E';

  _chart = crearGraficoECharts(_chart, 'chart-rentabilidad', {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const p = params[0];
        return `${p.axisValue}<br/>Margen: ${fmtPeso(p.value)}`;
      },
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 11, rotate: labels.length > 8 ? 30 : 0 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v) => fmtPeso(v), fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(22,24,29,.05)' } },
    },
    series: [{
      name: 'Margen ($)',
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

// ── Vista por producto ─────────────────────────────────────────────────────
function renderVistaPorProducto() {
  const tbody = document.getElementById('tbody-por-producto');
  if (!tbody) return;

  const categoriaFiltro = document.getElementById('filtro-categoria').value;
  let productos = agregarPorProducto(filasProducto);
  if (categoriaFiltro) productos = productos.filter(p => p.categoria_id === categoriaFiltro);

  if (!productos.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--color-text-light);">Sin datos en el período seleccionado</td></tr>`;
    renderPaginacion('producto', 0);
    return;
  }

  // Clamp por si cambió el filtro y la página actual quedó fuera de rango
  const totalPaginas = Math.max(1, Math.ceil(productos.length / PAGINACION.porPagina));
  if (PAGINACION.paginaProducto > totalPaginas) PAGINACION.paginaProducto = totalPaginas;

  const mejorMargen = Math.max(...productos.map(p => p.margen));
  const peorMargen  = Math.min(...productos.map(p => p.margen));

  const inicio = (PAGINACION.paginaProducto - 1) * PAGINACION.porPagina;
  const pagina = productos.slice(inicio, inicio + PAGINACION.porPagina);

  tbody.innerHTML = pagina.map(p => {
    const margenPct = p.facturado > 0 ? ((p.margen / p.facturado) * 100).toFixed(1) : null;
    const claseMargen = p.margen >= 0 ? 'monto-verde' : 'monto-rojo';
    const trClass = p.margen === mejorMargen && productos.length > 1 ? 'fila-mejor'
                  : p.margen === peorMargen  && productos.length > 1 ? 'fila-peor' : '';
    const origenChips = [...p.origenes].map(o =>
      `<span class="chip ${o === 'pos' ? 'chip-origen-pos' : 'chip-origen-pedido'}">${o === 'pos' ? 'POS' : 'Pedidos'}</span>`
    ).join(' ');

    return `<tr class="${trClass}">
      <td data-label="Producto"><strong>${esc(p.producto_nombre)}</strong></td>
      <td data-label="Categoría">${p.categoria_nombre ? esc(p.categoria_nombre) : '<span style="color:var(--color-text-light);">Sin categoría</span>'}</td>
      <td data-label="Cantidad vendida">${fmtNum(p.cantidad)}</td>
      <td data-label="Facturado">${fmtPeso(p.facturado)}</td>
      <td class="${claseMargen}" data-label="Margen">${fmtPeso(p.margen)}</td>
      <td class="${claseMargen}" data-label="Margen %">${margenPct != null ? margenPct + '%' : '—'}</td>
      <td data-label="Origen">${origenChips}</td>
    </tr>`;
  }).join('');

  renderPaginacion('producto', productos.length);
}

// ── Vista por vendedor ──────────────────────────────────────────────────────
function renderVistaPorVendedor() {
  const tbody = document.getElementById('tbody-por-vendedor');
  if (!tbody) return;

  const vendedores = agregarPorVendedor(filasVendedor);

  if (!vendedores.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--color-text-light);">Sin datos en el período seleccionado</td></tr>`;
    renderPaginacion('vendedor', 0);
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(vendedores.length / PAGINACION.porPagina));
  if (PAGINACION.paginaVendedor > totalPaginas) PAGINACION.paginaVendedor = totalPaginas;

  const mejorMargen = Math.max(...vendedores.map(v => v.margen));
  const peorMargen  = Math.min(...vendedores.map(v => v.margen));

  const inicio = (PAGINACION.paginaVendedor - 1) * PAGINACION.porPagina;
  const pagina = vendedores.slice(inicio, inicio + PAGINACION.porPagina);

  tbody.innerHTML = pagina.map(v => {
    const margenPct = v.facturado > 0 ? ((v.margen / v.facturado) * 100).toFixed(1) : null;
    const claseMargen = v.margen >= 0 ? 'monto-verde' : 'monto-rojo';
    const trClass = v.margen === mejorMargen && vendedores.length > 1 ? 'fila-mejor'
                  : v.margen === peorMargen  && vendedores.length > 1 ? 'fila-peor' : '';
    const origenChips = [...v.origenes].map(o =>
      `<span class="chip ${o === 'pos' ? 'chip-origen-pos' : 'chip-origen-pedido'}">${o === 'pos' ? 'POS' : 'Pedidos'}</span>`
    ).join(' ');

    return `<tr class="${trClass}">
      <td data-label="Vendedor"><strong>${v.vendedor_nombre ? esc(v.vendedor_nombre) : '<span style="color:var(--color-text-light);">Sin vendedor asignado</span>'}</strong></td>
      <td data-label="Documentos">${fmtNum(v.documentos)}</td>
      <td data-label="Facturado">${fmtPeso(v.facturado)}</td>
      <td class="${claseMargen}" data-label="Margen">${fmtPeso(v.margen)}</td>
      <td class="${claseMargen}" data-label="Margen %">${margenPct != null ? margenPct + '%' : '—'}</td>
      <td data-label="Origen">${origenChips}</td>
    </tr>`;
  }).join('');

  renderPaginacion('vendedor', vendedores.length);
}

// ── Controles de paginación (compartidos por ambas vistas) ────────────────
// Genera "‹ Anterior  1 2 3 … 8  Siguiente ›" + "Mostrando X-Y de Z".
// `vista` es 'producto' | 'vendedor', usa PAGINACION.pagina<Vista> como fuente
// de verdad y llama de vuelta a renderVista() al cambiar de página.
function renderPaginacion(vista, totalRegistros) {
  const cont = document.getElementById(`paginacion-${vista}`);
  if (!cont) return;

  const clavePagina = vista === 'producto' ? 'paginaProducto' : 'paginaVendedor';
  const paginaActual = PAGINACION[clavePagina];
  const totalPaginas = Math.max(1, Math.ceil(totalRegistros / PAGINACION.porPagina));

  if (totalRegistros === 0) { cont.innerHTML = ''; return; }

  const desde = (paginaActual - 1) * PAGINACION.porPagina + 1;
  const hasta = Math.min(paginaActual * PAGINACION.porPagina, totalRegistros);
  const etiqueta = vista === 'producto' ? 'productos' : 'vendedores';

  // Números de página a mostrar: siempre 1 y la última, la actual y sus
  // vecinas, el resto como "…" — evita una fila de 50 botones si hay
  // muchas páginas.
  const paginas = [];
  for (let n = 1; n <= totalPaginas; n++) {
    if (n === 1 || n === totalPaginas || Math.abs(n - paginaActual) <= 1) paginas.push(n);
    else if (paginas[paginas.length - 1] !== '…') paginas.push('…');
  }

  const botonesNumero = paginas.map(n =>
    n === '…'
      ? `<span class="paginacion-ellipsis">…</span>`
      : `<button type="button" class="paginacion-btn${n === paginaActual ? ' activa' : ''}" onclick="irAPaginaRentabilidad('${vista}', ${n})">${n}</button>`
  ).join('');

  cont.innerHTML = `
    <div class="paginacion-info">Mostrando ${desde}-${hasta} de ${totalRegistros} ${etiqueta} (página ${paginaActual} de ${totalPaginas})</div>
    <div class="paginacion-controles">
      <button type="button" class="paginacion-btn" onclick="irAPaginaRentabilidad('${vista}', ${paginaActual - 1})" ${paginaActual <= 1 ? 'disabled' : ''}>‹ Anterior</button>
      ${botonesNumero}
      <button type="button" class="paginacion-btn" onclick="irAPaginaRentabilidad('${vista}', ${paginaActual + 1})" ${paginaActual >= totalPaginas ? 'disabled' : ''}>Siguiente ›</button>
    </div>
  `;
}

function irAPaginaRentabilidad(vista, n) {
  const clavePagina = vista === 'producto' ? 'paginaProducto' : 'paginaVendedor';
  PAGINACION[clavePagina] = n;
  if (vista === 'producto') renderVistaPorProducto();
  else renderVistaPorVendedor();
}

// ── Toggle vista producto / vendedor ────────────────────────────────────
function cambiarVista(vista) {
  vistaActual = vista;
  document.getElementById('vista-producto').classList.toggle('hidden', vista !== 'producto');
  document.getElementById('vista-vendedor').classList.toggle('hidden', vista !== 'vendedor');
  document.getElementById('btn-vista-producto').classList.toggle('active', vista === 'producto');
  document.getElementById('btn-vista-vendedor').classList.toggle('active', vista === 'vendedor');
  document.getElementById('filtro-categoria').classList.toggle('hidden', vista !== 'producto');
  renderChart();
  renderVista();
}

// ── Filtro de categoría: cambia el conjunto de filas → vuelve a página 1 ──
function filtrarPorCategoria() {
  PAGINACION.paginaProducto = 1;
  renderVista();
}

function renderVista() {
  renderVistaPorProducto();
  renderVistaPorVendedor();
}

// ── Exportar CSV (de la vista activa) ─────────────────────────────────────
function exportarCSV() {
  const datos = vistaActual === 'producto' ? agregarPorProducto(filasProducto) : agregarPorVendedor(filasVendedor);
  if (!datos.length) {
    window.toast('No hay datos para exportar', 'error');
    return;
  }

  let cols, filas;
  if (vistaActual === 'producto') {
    cols = ['Producto', 'Categoría', 'Cantidad vendida', 'Facturado', 'Margen', 'Margen %', 'Origen'];
    filas = datos.map(p => [
      p.producto_nombre,
      p.categoria_nombre || 'Sin categoría',
      p.cantidad.toFixed(2),
      p.facturado.toFixed(2),
      p.margen.toFixed(2),
      p.facturado > 0 ? ((p.margen / p.facturado) * 100).toFixed(2) : '',
      [...p.origenes].join('/'),
    ]);
  } else {
    cols = ['Vendedor', 'Documentos', 'Facturado', 'Margen', 'Margen %', 'Origen'];
    filas = datos.map(v => [
      v.vendedor_nombre || 'Sin vendedor asignado',
      v.documentos,
      v.facturado.toFixed(2),
      v.margen.toFixed(2),
      v.facturado > 0 ? ((v.margen / v.facturado) * 100).toFixed(2) : '',
      [...v.origenes].join('/'),
    ]);
  }

  const csv = [cols, ...filas].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `rentabilidad-${vistaActual}-${fmtFechaInput(new Date())}.csv`;
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
window.cargarRentabilidad     = cargarRentabilidad;
window.cambiarVista           = cambiarVista;
window.exportarCSV            = exportarCSV;
window.filtrarPorCategoria    = filtrarPorCategoria;
window.irAPaginaRentabilidad  = irAPaginaRentabilidad;
