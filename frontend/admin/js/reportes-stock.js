// Estado global
let estadoReportesStock = {
    depositoSeleccionado: '',
    categoriaSeleccionada: '',
    estadoSeleccionado: '',
    datos: {}
};

// Paginación de la tabla "Estado de Stock por Producto" (server-side, vía .range())
const PAGINACION_STOCK = {
    porPagina: 50,
    paginaActual: 1,
    totalRegistros: 0
};

// Paginación de "Productos con Stock Crítico" (server-side, vía .range()).
// Antes traía TODO el universo de productos con cantidad<10 sin límite —
// con un catálogo grande esto quedaba como una sola lista interminable
// igual que le pasaba a Estado de Stock antes de paginarla.
const PAGINACION_CRITICOS = {
    porPagina: 50,
    paginaActual: 1,
    totalRegistros: 0
};

// Paginación de "Movimientos de Stock" (server-side, vía .range()). Antes
// tenía un .limit(50) fijo sin forma de ver movimientos más viejos dentro
// de la ventana de 30 días.
const PAGINACION_MOVIMIENTOS = {
    porPagina: 50,
    paginaActual: 1,
    totalRegistros: 0
};

// Filtros y paginación de "Historial de Conteos de Stock" (server-side, vía .range())
let estadoConteos = {
    depositoId: '',
    motivo: '',
    desde: '',
    hasta: '',
    soloConDiferencia: false
};

const PAGINACION_CONTEOS = {
    porPagina: 50,
    paginaActual: 1,
    totalRegistros: 0
};

let chartsInstancias = {};

// Lista de depósitos ya cargada (para los avatares de la card de cobertura,
// trasladada desde /admin/stock) y gráfico de movimientos (ECharts).
let _depositosList = [];
let _ovChart = null;

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Botón "Reabastecer" de la tabla "Productos con Stock Crítico": esta página
// es de solo lectura (analítica), el ajuste de stock en sí vive en
// /admin/stock. Deep-link con ?abrirAjuste=<producto_id>, que stock.js lee
// al iniciar y abre directo el modal de ajuste para ese producto (mismo
// mecanismo que abrirModalDesdeProductoId, ya usado desde el modal de
// proyección de stock).
function reabastecerProducto(productoId) {
    if (!productoId) return;
    window.location.href = `/admin/stock?abrirAjuste=${encodeURIComponent(productoId)}`;
}

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await window.authReady;
        
        // Validar rol
        if (!['dueno', 'admin', 'depositero'].includes(window.authCtx.perfil.rol)) {
            window.location.href = '/admin/dashboard';
            return;
        }

        // Cargar datos iniciales
        await cargarDepositos();
        await cargarCategorias();
        await cargarReportes();
        await cargarConteos();

        // Event listeners
        document.getElementById('btnAplicarFiltros').addEventListener('click', () => {
            PAGINACION_STOCK.paginaActual = 1;
            cargarReportes();
        });
        document.getElementById('btnExportarStock').addEventListener('click', exportarReportes);
        document.getElementById('cerrarSesion')?.addEventListener('click', cerrarSesion);
        document.getElementById('btnStockAnterior')?.addEventListener('click', () => cambiarPaginaStock(-1));
        document.getElementById('btnStockSiguiente')?.addEventListener('click', () => cambiarPaginaStock(1));
        document.getElementById('selectStockPorPagina')?.addEventListener('change', (e) => {
            PAGINACION_STOCK.porPagina = Number(e.target.value) || 50;
            PAGINACION_STOCK.paginaActual = 1;
            cargarEstadoStock();
        });

        document.getElementById('btnCriticosAnterior')?.addEventListener('click', () => cambiarPaginaCriticos(-1));
        document.getElementById('btnCriticosSiguiente')?.addEventListener('click', () => cambiarPaginaCriticos(1));
        document.getElementById('selectCriticosPorPagina')?.addEventListener('change', (e) => {
            PAGINACION_CRITICOS.porPagina = Number(e.target.value) || 50;
            PAGINACION_CRITICOS.paginaActual = 1;
            cargarProductosCriticos();
        });

        document.getElementById('btnMovimientosAnterior')?.addEventListener('click', () => cambiarPaginaMovimientos(-1));
        document.getElementById('btnMovimientosSiguiente')?.addEventListener('click', () => cambiarPaginaMovimientos(1));
        document.getElementById('selectMovimientosPorPagina')?.addEventListener('change', (e) => {
            PAGINACION_MOVIMIENTOS.porPagina = Number(e.target.value) || 50;
            PAGINACION_MOVIMIENTOS.paginaActual = 1;
            cargarMovimientos();
        });

        // Event listeners — Historial de Conteos de Stock
        document.getElementById('btnAplicarFiltrosConteos')?.addEventListener('click', () => {
            PAGINACION_CONTEOS.paginaActual = 1;
            cargarConteos();
        });
        document.getElementById('btnConteosAnterior')?.addEventListener('click', () => cambiarPaginaConteos(-1));
        document.getElementById('btnConteosSiguiente')?.addEventListener('click', () => cambiarPaginaConteos(1));
        document.getElementById('selectConteosPorPagina')?.addEventListener('change', (e) => {
            PAGINACION_CONTEOS.porPagina = Number(e.target.value) || 50;
            PAGINACION_CONTEOS.paginaActual = 1;
            cargarConteosStock();
        });

    } catch (error) {
        console.error('Error en inicialización:', error);
        window.toast('Error al cargar la página. Por favor, recarga.', 'danger');
    }
});

// Cargar depósitos
async function cargarDepositos() {
    try {
        const { data, error } = await window.authCtx.sb
            .from('depositos')
            .select('id, nombre')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .order('nombre');

        if (error) throw error;

        _depositosList = data || [];

        const select = document.getElementById('filtroDeposito');
        const selectConteos = document.getElementById('conteosFiltroDeposito');
        data.forEach(deposito => {
            const option = document.createElement('option');
            option.value = deposito.id;
            option.textContent = deposito.nombre;
            select.appendChild(option);

            if (selectConteos) {
                selectConteos.appendChild(option.cloneNode(true));
            }
        });

        renderAvataresDepositos();
    } catch (error) {
        console.error('Error cargando depósitos:', error);
    }
}

// ── Avatares de depósitos (card "Cobertura de catálogo con stock",
// trasladada desde /admin/stock) ────────────────────────────────────────────
function renderAvataresDepositos() {
    const cont = document.getElementById('ov-avatares-depositos');
    if (!cont) return;
    const colores = ['#00AE70', '#fd7e14', '#6f42c1', '#17a2b8', '#e83e8c', '#007bff'];
    const visibles = _depositosList.slice(0, 4);
    cont.innerHTML = visibles.map((d, i) => {
        const iniciales = (d.nombre || '?').trim().slice(0, 2).toUpperCase();
        return `<span class="stock-ov-avatar" style="background:${colores[i % colores.length]}" title="${escHtml(d.nombre || '')}">${iniciales}</span>`;
    }).join('');
    const restantes = _depositosList.length - visibles.length;
    if (restantes > 0) {
        cont.innerHTML += `<span class="stock-ov-avatar stock-ov-avatar--more">+${restantes}</span>`;
    }
}

// ── Gráfico de movimientos (ingresos vs egresos, últimos 6 meses), trasladado
// desde /admin/stock. Usa ECharts con el tema 'gentelella' compartido, igual
// que el resto de los gráficos de esta página. -->
async function cargarOverviewChart() {
    const el = document.getElementById('stock-ov-chart');
    if (!el || typeof echarts === 'undefined') return;

    try {
        const desde = new Date();
        desde.setMonth(desde.getMonth() - 5);
        desde.setDate(1);
        desde.setHours(0, 0, 0, 0);

        const { data, error } = await window.authCtx.sb
            .from('movimientos_stock')
            .select('tipo, cantidad, created_at')
            .gte('created_at', desde.toISOString());
        if (error) throw error;

        // Armar los últimos 6 meses como buckets, en orden
        const buckets = [];
        const cursor = new Date(desde);
        for (let i = 0; i < 6; i++) {
            buckets.push({
                key: `${cursor.getFullYear()}-${cursor.getMonth()}`,
                label: cursor.toLocaleDateString('es-AR', { month: 'short' }),
                ingreso: 0,
                egreso: 0
            });
            cursor.setMonth(cursor.getMonth() + 1);
        }
        const porKey = Object.fromEntries(buckets.map(b => [b.key, b]));

        (data || []).forEach(m => {
            const d = new Date(m.created_at);
            const key = `${d.getFullYear()}-${d.getMonth()}`;
            const b = porKey[key];
            if (!b) return;
            const cant = Math.abs(Number(m.cantidad) || 0);
            if (m.tipo === 'ingreso') b.ingreso += cant;
            else if (m.tipo === 'egreso') b.egreso += cant;
        });

        const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
        const colorIngreso = tokens.teal   || '#6A9873';
        const colorEgreso   = tokens.orange || '#8A5F13';

        _ovChart = crearGraficoECharts(_ovChart, 'stock-ov-chart', {
            tooltip: { trigger: 'axis' },
            legend: { show: false }, // la leyenda ya la dibuja el HTML (.stock-ov-legend)
            xAxis: {
                type: 'category',
                data: buckets.map(b => b.label),
            },
            yAxis: { type: 'value' },
            series: [
                {
                    name: 'Ingresos',
                    type: 'line',
                    data: buckets.map(b => b.ingreso),
                    areaStyle: { color: colorIngreso, opacity: 0.08 },
                    itemStyle: { color: colorIngreso },
                    lineStyle: { color: colorIngreso },
                },
                {
                    name: 'Egresos',
                    type: 'line',
                    data: buckets.map(b => b.egreso),
                    areaStyle: { color: colorEgreso, opacity: 0.08 },
                    itemStyle: { color: colorEgreso },
                    lineStyle: { color: colorEgreso },
                },
            ],
        }, { notMerge: true });
    } catch (error) {
        console.error('Error cargando gráfico de movimientos:', error);
    }
}

// Cargar categorías
async function cargarCategorias() {
    try {
        const { data, error } = await window.authCtx.sb
            .from('categorias')
            .select('id, nombre')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .order('nombre');

        if (error) throw error;

        const select = document.getElementById('filtroCategoria');
        data.forEach(categoria => {
            const option = document.createElement('option');
            option.value = categoria.id;
            option.textContent = categoria.nombre;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error cargando categorías:', error);
    }
}

// Cargar reportes
async function cargarReportes() {
    try {
        // Actualizar filtros
        estadoReportesStock.depositoSeleccionado = document.getElementById('filtroDeposito').value;
        estadoReportesStock.categoriaSeleccionada = document.getElementById('filtroCategoria').value;
        estadoReportesStock.estadoSeleccionado = document.getElementById('filtroEstado').value;

        // Cargar datos
        await Promise.all([
            cargarKPIs(),
            cargarOverviewChart(),
            cargarDistribucionStock(),
            cargarRotacion(),
            cargarEstadoStock(),
            cargarProductosCriticos(),
            cargarValorizacion(),
            cargarMovimientos()
        ]);

    } catch (error) {
        console.error('Error cargando reportes:', error);
        window.toast('Error al cargar los reportes', 'danger');
    }
}

// Cargar KPIs
// OPTIMIZADO: antes traía TODA la tabla `stock` (miles de filas) + TODOS los `productos`,
// dos veces (actual y "anterior"), solo para sumar/contar en JS. Ahora un RPC hace las
// sumas y conteos en SQL y devuelve 1 fila.
async function cargarKPIs() {
    try {
        const { data, error } = await window.authCtx.sb.rpc('fn_reportes_stock_kpis', {
            p_deposito_id: estadoReportesStock.depositoSeleccionado || null,
            p_categoria_id: estadoReportesStock.categoriaSeleccionada || null
        });
        if (error) throw error;

        const kpis = (data && data[0]) || {
            valor_total: 0, productos_en_stock: 0, productos_criticos: 0,
            valor_total_global: 0, productos_en_stock_global: 0, rotacion_promedio: 0
        };

        const valorTotal = Number(kpis.valor_total) || 0;
        const productosEnStock = Number(kpis.productos_en_stock) || 0;
        const productosCriticos = Number(kpis.productos_criticos) || 0;
        const valorTotalGlobal = Number(kpis.valor_total_global) || 0;
        const productosEnStockGlobal = Number(kpis.productos_en_stock_global) || 0;
        const rotacionPromedio = Number(kpis.rotacion_promedio) || 0;

        const cambioValor = valorTotalGlobal > 0 ? ((valorTotal - valorTotalGlobal) / valorTotalGlobal * 100).toFixed(1) : 0;
        const cambioProductos = productosEnStock - productosEnStockGlobal;

        document.getElementById('kpiValorTotal').textContent = `$${valorTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioValor').textContent = `${cambioValor > 0 ? '+' : ''}${cambioValor}% vs total general`;
        document.getElementById('kpiCambioValor').className = `kpi-change ${cambioValor >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiProductosStock').textContent = productosEnStock;
        document.getElementById('kpiCambioProductos').textContent = `${cambioProductos > 0 ? '+' : ''}${cambioProductos} vs total general`;
        document.getElementById('kpiCambioProductos').className = `kpi-change ${cambioProductos >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiStockCritico').textContent = productosCriticos;
        document.getElementById('kpiCambioCritico').className = productosCriticos > 0 ? 'kpi-change negative' : 'kpi-change positive';

        document.getElementById('kpiRotacion').textContent = rotacionPromedio;

        estadoReportesStock.datos.valorTotal = valorTotal;

        // Card lateral "Cobertura de catálogo con stock" (trasladada desde /admin/stock)
        const totalCatalogo = productosEnStock + productosCriticos;
        const cobertura = totalCatalogo > 0 ? Math.round((productosEnStock / totalCatalogo) * 100) : 100;
        const elCobertura = document.getElementById('ov-cobertura');
        if (elCobertura) elCobertura.textContent = `${cobertura}%`;
        const elMiniCriticos = document.getElementById('ov-mini-criticos');
        if (elMiniCriticos) elMiniCriticos.textContent = productosCriticos.toLocaleString('es-AR');

        const badge = document.getElementById('ov-mini-badge');
        if (badge) {
            if (productosCriticos > 0) {
                badge.textContent = `${productosCriticos} activa${productosCriticos !== 1 ? 's' : ''}`;
                badge.classList.remove('ok');
            } else {
                badge.textContent = 'Al día';
                badge.classList.add('ok');
            }
        }

    } catch (error) {
        console.error('Error cargando KPIs:', error);
    }
}

// Cargar distribución de stock
// OPTIMIZADO: antes traía TODA la tabla `stock` + TODOS los `productos` + todas las
// `categorias` para agrupar y sumar en JS. Ahora un RPC agrupa y suma en SQL.
async function cargarDistribucionStock() {
    try {
        const { data: distribucion, error } = await window.authCtx.sb.rpc('fn_reportes_stock_distribucion', {
            p_deposito_id: estadoReportesStock.depositoSeleccionado || null
        });
        if (error) throw error;

        const categoriasNombres = (distribucion || []).map(d => d.categoria_nombre);
        const valoresCategoria = (distribucion || []).map(d => Number(d.valor_total) || 0);

        if (!categoriasNombres.length) {
            chartsInstancias.distribucion = crearGraficoECharts(chartsInstancias.distribucion, 'chartDistribucionStock', null);
            return;
        }

        chartsInstancias.distribucion = crearGraficoECharts(chartsInstancias.distribucion, 'chartDistribucionStock', {
            tooltip: {
                trigger: 'item',
                valueFormatter: (v) => '$' + Number(v).toLocaleString('es-AR'),
            },
            legend: { orient: 'vertical', right: 8, top: 'middle', type: 'scroll' },
            series: [{
                name: 'Distribución de stock',
                type: 'pie',
                radius: ['45%', '72%'],
                center: ['38%', '50%'],
                avoidLabelOverlap: true,
                itemStyle: { borderRadius: 4 },
                label: { formatter: '{b}\n{d}%', fontSize: 11 },
                labelLine: { length: 10, length2: 8 },
                data: categoriasNombres.map((nombre, i) => ({ name: nombre, value: valoresCategoria[i] })),
            }],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando distribución de stock:', error);
    }
}

// Cargar rotación
async function cargarRotacion() {
    try {
        const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const { data: movimientos } = await window.authCtx.sb
            .from('movimientos_stock')
            .select('id, cantidad, created_at')
            .gte('created_at', hace30Dias.toISOString());

        // Agrupar por día
        const movimientosPorDia = {};
        (movimientos || []).forEach(m => {
            const fecha = new Date(m.created_at).toLocaleDateString('es-AR');
            movimientosPorDia[fecha] = (movimientosPorDia[fecha] || 0) + Math.abs(m.cantidad);
        });

        const fechas = Object.keys(movimientosPorDia).sort();
        const valores = fechas.map(f => movimientosPorDia[f]);

        const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
        const colorRotacion = tokens.blue || '#33507A';

        if (!fechas.length) {
            chartsInstancias.rotacion = crearGraficoECharts(chartsInstancias.rotacion, 'chartRotacion', null);
            return;
        }

        chartsInstancias.rotacion = crearGraficoECharts(chartsInstancias.rotacion, 'chartRotacion', {
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { show: false },
            xAxis: { type: 'category', data: fechas },
            yAxis: { type: 'value' },
            dataZoom: fechas.length > 14 ? [
                { type: 'inside', start: 50, end: 100 },
                { type: 'slider', height: 18, bottom: 4 },
            ] : undefined,
            grid: { bottom: fechas.length > 14 ? 48 : 8 },
            series: [{
                name: 'Movimientos de Stock',
                type: 'bar',
                data: valores,
                itemStyle: { color: colorRotacion },
            }],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando rotación:', error);
    }
}

// Cargar estado de stock
// OPTIMIZADO: esta era la causa del cuelgue reportado — traía TODAS las filas de `stock`
// (miles, crecientes con cada depósito/producto nuevo) más TODOS los `productos` para
// cruzar en JS con .find() (O(n*m)), y las renderizaba TODAS en el DOM de una sola vez
// sin paginar. Ahora:
//  - el join con productos/categorías se hace embebido en la misma query (PostgREST),
//  - el filtro de categoría y de estado se aplican en la base, no después en JS,
//  - se pide una página a la vez con .range(), con count exacto para mostrar el total.
async function cargarEstadoStock() {
    const tbody = document.getElementById('tbodyStock');
    try {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">Cargando datos...</td></tr>';

        const desde = (PAGINACION_STOCK.paginaActual - 1) * PAGINACION_STOCK.porPagina;
        const hasta = desde + PAGINACION_STOCK.porPagina - 1;

        let query = window.authCtx.sb
            .from('stock')
            .select(`
                id, cantidad, cantidad_reservada, cantidad_disponible, costo_promedio, producto_id, deposito_id,
                productos!inner ( nombre, categoria_id, categorias ( nombre ) )
            `, { count: 'exact' });

        if (estadoReportesStock.depositoSeleccionado) {
            query = query.eq('deposito_id', estadoReportesStock.depositoSeleccionado);
        }
        if (estadoReportesStock.categoriaSeleccionada) {
            query = query.eq('productos.categoria_id', estadoReportesStock.categoriaSeleccionada);
        }

        // Filtro de estado aplicado en la base (antes existía el <select> en el HTML
        // pero no se usaba en ningún lado — quedaba muerto).
        switch (estadoReportesStock.estadoSeleccionado) {
            case 'critico':
                query = query.lt('cantidad', 5);
                break;
            case 'bajo':
                query = query.gte('cantidad', 5).lt('cantidad', 10);
                break;
            case 'normal':
                query = query.gte('cantidad', 10).lte('cantidad', 100);
                break;
            case 'exceso':
                query = query.gt('cantidad', 100);
                break;
        }

        query = query.order('cantidad', { ascending: false }).range(desde, hasta);

        const { data: stocks, error, count } = await query;
        if (error) throw error;

        PAGINACION_STOCK.totalRegistros = count || 0;

        tbody.innerHTML = (stocks || [])
            .map(s => {
                const nombreProducto = s.productos?.nombre || 'Sin nombre';
                const nombreCategoria = s.productos?.categorias?.nombre || 'Sin categoría';
                const disponible = s.cantidad_disponible ?? (s.cantidad - s.cantidad_reservada);
                const valorTotal = s.cantidad * s.costo_promedio;

                let estado = 'Normal';
                let estadoClass = 'green';
                if (s.cantidad < 5) {
                    estado = 'Crítico';
                    estadoClass = 'red';
                } else if (s.cantidad < 10) {
                    estado = 'Bajo';
                    estadoClass = 'yellow';
                } else if (s.cantidad > 100) {
                    estado = 'Exceso';
                    estadoClass = 'orange';
                }

                return `
                    <tr>
                        <td>${sanitize(nombreProducto)}</td>
                        <td>${sanitize(nombreCategoria)}</td>
                        <td>${s.cantidad}</td>
                        <td>${s.cantidad_reservada}</td>
                        <td>${disponible}</td>
                        <td>$${s.costo_promedio.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                        <td>$${valorTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                        <td><span class="status-badge ${estadoClass}">${estado}</span></td>
                    </tr>
                `;
            })
            .join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="tabla-empty">No hay stock cargado para estos filtros.</td></tr>';
        }

        renderPaginacionStock();

    } catch (error) {
        console.error('Error cargando estado de stock:', error);
        tbody.innerHTML = '<tr><td colspan="8" class="tabla-empty">Ocurrió un error al cargar el stock.</td></tr>';
    }
}

// Cambia de página y vuelve a pedir solo esa porción de datos al servidor
function cambiarPaginaStock(direccion) {
    const totalPaginas = Math.max(1, Math.ceil(PAGINACION_STOCK.totalRegistros / PAGINACION_STOCK.porPagina));
    const nuevaPagina = PAGINACION_STOCK.paginaActual + direccion;
    if (nuevaPagina < 1 || nuevaPagina > totalPaginas) return;
    PAGINACION_STOCK.paginaActual = nuevaPagina;
    cargarEstadoStock();
}

// Actualiza el texto y el estado de los botones "Anterior / Siguiente"
function renderPaginacionStock() {
    const info = document.getElementById('stockPaginacionInfo');
    const btnAnterior = document.getElementById('btnStockAnterior');
    const btnSiguiente = document.getElementById('btnStockSiguiente');
    if (!info || !btnAnterior || !btnSiguiente) return;

    const total = PAGINACION_STOCK.totalRegistros;
    const totalPaginas = Math.max(1, Math.ceil(total / PAGINACION_STOCK.porPagina));
    const desde = total === 0 ? 0 : (PAGINACION_STOCK.paginaActual - 1) * PAGINACION_STOCK.porPagina + 1;
    const hasta = Math.min(PAGINACION_STOCK.paginaActual * PAGINACION_STOCK.porPagina, total);

    info.textContent = `Mostrando ${desde}-${hasta} de ${total} productos (página ${PAGINACION_STOCK.paginaActual} de ${totalPaginas})`;
    btnAnterior.disabled = PAGINACION_STOCK.paginaActual <= 1;
    btnSiguiente.disabled = PAGINACION_STOCK.paginaActual >= totalPaginas;
}

// Cargar productos críticos
// OPTIMIZADO: traía TODO el universo de stock<10 de la empresa entera de una
// sola vez y lo renderizaba todo junto sin paginar — con un catálogo grande
// esto queda como una sola lista interminable (mismo problema que tenía
// Estado de Stock). Ahora usa el mismo patrón de paginación server-side.
// Usa fn_reportes_stock_criticos_lista (migración 441), que compara contra
// el stock_minimo real de cada producto (con piso de 5 si no tiene uno
// configurado) — mismo criterio que ya usa el KPI "Stock Crítico" de esta
// misma pantalla (fn_reportes_stock_kpis) y que stock.js/automatizacion.js.
// Antes esta tabla hacía un query directo `cantidad < 10` fijo (con "10"
// hardcodeado también en la columna Stock Mínimo), que quedó desalineado
// del KPI de arriba: un producto con stock_minimo=50 y cantidad=15 no
// aparecía acá aunque el KPI sí lo contara como crítico. La RPC ya existía
// desde el 441 pero nada del frontend la llamaba.
async function cargarProductosCriticos() {
    const tbody = document.getElementById('tbodyProductosCriticos');
    try {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando datos...</td></tr>';

        const desde = (PAGINACION_CRITICOS.paginaActual - 1) * PAGINACION_CRITICOS.porPagina;

        const { data: criticos, error } = await window.authCtx.sb.rpc('fn_reportes_stock_criticos_lista', {
            p_deposito_id: estadoReportesStock.depositoSeleccionado || null,
            p_categoria_id: estadoReportesStock.categoriaSeleccionada || null,
            p_limit: PAGINACION_CRITICOS.porPagina,
            p_offset: desde
        });
        if (error) throw error;

        PAGINACION_CRITICOS.totalRegistros = (criticos && criticos[0]?.total_count) || 0;

        const productosIds = (criticos || []).map(c => c.producto_id);

        // Últimas ventas SOLO para los productos de esta página (antes se
        // pedían hasta 500 filas de pedido_items para TODOS los productos
        // críticos de la empresa en cada carga, aunque después solo se
        // mostraran 6 en pantalla).
        const { data: pedidoItemsRaw } = productosIds.length
            ? await window.authCtx.sb
                .from('pedido_items')
                .select('id, producto_id, pedidos(fecha_pedido)')
                .in('producto_id', productosIds)
                .limit(500)
            : { data: [] };

        const pedidos = (pedidoItemsRaw || [])
            .filter(p => p.pedidos?.fecha_pedido)
            .sort((a, b) => new Date(b.pedidos.fecha_pedido) - new Date(a.pedidos.fecha_pedido));

        tbody.innerHTML = (criticos || [])
            .map(c => {
                const ultimaVenta = pedidos.find(p => p.producto_id === c.producto_id);
                const ultimaVentaFecha = ultimaVenta
                    ? new Date(ultimaVenta.pedidos.fecha_pedido).toLocaleDateString('es-AR')
                    : 'Nunca';

                return `
                    <tr>
                        <td>${sanitize(c.nombre || 'Sin nombre')}</td>
                        <td>${c.cantidad_disponible}</td>
                        <td>${c.stock_minimo}</td>
                        <td>${c.deficit}</td>
                        <td>${ultimaVentaFecha}</td>
                        <td><button type="button" class="status-badge status-badge--action red" onclick="reabastecerProducto('${c.producto_id}')">Reabastecer</button></td>
                    </tr>
                `;
            })
            .join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">No hay productos con stock crítico ahora mismo.</td></tr>';
        }

        renderPaginacionCriticos();

    } catch (error) {
        console.error('Error cargando productos críticos:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">Ocurrió un error al cargar los productos críticos.</td></tr>';
    }
}

function cambiarPaginaCriticos(direccion) {
    const totalPaginas = Math.max(1, Math.ceil(PAGINACION_CRITICOS.totalRegistros / PAGINACION_CRITICOS.porPagina));
    const nuevaPagina = PAGINACION_CRITICOS.paginaActual + direccion;
    if (nuevaPagina < 1 || nuevaPagina > totalPaginas) return;
    PAGINACION_CRITICOS.paginaActual = nuevaPagina;
    cargarProductosCriticos();
}

function renderPaginacionCriticos() {
    const info = document.getElementById('criticosPaginacionInfo');
    const btnAnterior = document.getElementById('btnCriticosAnterior');
    const btnSiguiente = document.getElementById('btnCriticosSiguiente');
    if (!info || !btnAnterior || !btnSiguiente) return;

    const total = PAGINACION_CRITICOS.totalRegistros;
    const totalPaginas = Math.max(1, Math.ceil(total / PAGINACION_CRITICOS.porPagina));
    const desde = total === 0 ? 0 : (PAGINACION_CRITICOS.paginaActual - 1) * PAGINACION_CRITICOS.porPagina + 1;
    const hasta = Math.min(PAGINACION_CRITICOS.paginaActual * PAGINACION_CRITICOS.porPagina, total);

    info.textContent = `Mostrando ${desde}-${hasta} de ${total} productos (página ${PAGINACION_CRITICOS.paginaActual} de ${totalPaginas})`;
    btnAnterior.disabled = PAGINACION_CRITICOS.paginaActual <= 1;
    btnSiguiente.disabled = PAGINACION_CRITICOS.paginaActual >= totalPaginas;
}

// Cargar valorización
// OPTIMIZADO (v775/494): antes traía TODA la tabla `stock` de la empresa
// (sin .range() ni límite) más TODOS los `depositos`, solo para agrupar y
// sumar en JS — mismo cuello de botella ya corregido para "Estado de
// Stock" y "Productos Críticos" en este archivo, pero que había quedado
// afuera de esa pasada. Ahora fn_reportes_stock_valorizacion (494) agrupa
// y suma en SQL, mismo patrón que fn_reportes_stock_distribucion.
async function cargarValorizacion() {
    try {
        const { data: filas, error } = await window.authCtx.sb.rpc('fn_reportes_stock_valorizacion');
        if (error) throw error;

        const totalCosto = (filas || []).reduce((sum, d) => sum + (Number(d.costo_total) || 0), 0);

        // Renderizar tabla
        const tbody = document.getElementById('tbodyValorizacion');
        tbody.innerHTML = (filas || [])
            .map(d => {
                const costo = Number(d.costo_total) || 0;
                const porcentaje = totalCosto > 0 ? (costo / totalCosto * 100).toFixed(2) : 0;
                return `
                    <tr>
                        <td>${sanitize(d.deposito_nombre)}</td>
                        <td>${d.cantidad_productos}</td>
                        <td>${d.unidades}</td>
                        <td>$${costo.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                        <td>${porcentaje}%</td>
                    </tr>
                `;
            })
            .join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="tabla-empty">No hay stock valorizado para mostrar.</td></tr>';
        }

    } catch (error) {
        console.error('Error cargando valorización:', error);
    }
}

// Cargar movimientos
async function cargarMovimientos() {
    const tbody = document.getElementById('tbodyMovimientos');
    try {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando datos...</td></tr>';

        const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const desde = (PAGINACION_MOVIMIENTOS.paginaActual - 1) * PAGINACION_MOVIMIENTOS.porPagina;
        const hasta = desde + PAGINACION_MOVIMIENTOS.porPagina - 1;

        const { data: movimientos, error, count } = await window.authCtx.sb
            .from('movimientos_stock')
            .select('id, producto_id, tipo, cantidad, deposito_id, usuario_id, created_at', { count: 'exact' })
            .gte('created_at', hace30Dias.toISOString())
            .order('created_at', { ascending: false })
            .range(desde, hasta);
        if (error) throw error;

        PAGINACION_MOVIMIENTOS.totalRegistros = count || 0;

        const productosIds = (movimientos || []).map(m => m.producto_id);
        const usuariosIds = (movimientos || []).map(m => m.usuario_id);

        const { data: productos } = productosIds.length
            ? await window.authCtx.sb.from('productos').select('id, nombre').in('id', productosIds)
            : { data: [] };

        const { data: usuarios } = usuariosIds.length
            ? await window.authCtx.sb.from('usuarios').select('id, nombre').in('id', usuariosIds)
            : { data: [] };

        // Renderizar tabla
        tbody.innerHTML = (movimientos || [])
            .map(m => {
                const producto = (productos || []).find(p => p.id === m.producto_id);
                const usuario = (usuarios || []).find(u => u.id === m.usuario_id);
                // _depositosList ya está cargado (cargarDepositos() corre antes que
                // cargarReportes() en el init) — antes esta columna mostraba la
                // palabra "Depósito" fija en texto, no el nombre real.
                const deposito = _depositosList.find(d => d.id === m.deposito_id);
                const fecha = new Date(m.created_at).toLocaleDateString('es-AR');

                return `
                    <tr>
                        <td>${fecha}</td>
                        <td>${sanitize(producto?.nombre || 'Sin nombre')}</td>
                        <td>${m.tipo}</td>
                        <td>${m.cantidad}</td>
                        <td>${sanitize(deposito?.nombre || 'Sin depósito')}</td>
                        <td>${sanitize(usuario?.nombre || 'Sin usuario')}</td>
                    </tr>
                `;
            })
            .join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">No hubo movimientos de stock en los últimos 30 días.</td></tr>';
        }

        renderPaginacionMovimientos();

    } catch (error) {
        console.error('Error cargando movimientos:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">Ocurrió un error al cargar los movimientos.</td></tr>';
    }
}

function cambiarPaginaMovimientos(direccion) {
    const totalPaginas = Math.max(1, Math.ceil(PAGINACION_MOVIMIENTOS.totalRegistros / PAGINACION_MOVIMIENTOS.porPagina));
    const nuevaPagina = PAGINACION_MOVIMIENTOS.paginaActual + direccion;
    if (nuevaPagina < 1 || nuevaPagina > totalPaginas) return;
    PAGINACION_MOVIMIENTOS.paginaActual = nuevaPagina;
    cargarMovimientos();
}

function renderPaginacionMovimientos() {
    const info = document.getElementById('movimientosPaginacionInfo');
    const btnAnterior = document.getElementById('btnMovimientosAnterior');
    const btnSiguiente = document.getElementById('btnMovimientosSiguiente');
    if (!info || !btnAnterior || !btnSiguiente) return;

    const total = PAGINACION_MOVIMIENTOS.totalRegistros;
    const totalPaginas = Math.max(1, Math.ceil(total / PAGINACION_MOVIMIENTOS.porPagina));
    const desde = total === 0 ? 0 : (PAGINACION_MOVIMIENTOS.paginaActual - 1) * PAGINACION_MOVIMIENTOS.porPagina + 1;
    const hasta = Math.min(PAGINACION_MOVIMIENTOS.paginaActual * PAGINACION_MOVIMIENTOS.porPagina, total);

    info.textContent = `Mostrando ${desde}-${hasta} de ${total} movimientos (página ${PAGINACION_MOVIMIENTOS.paginaActual} de ${totalPaginas})`;
    btnAnterior.disabled = PAGINACION_MOVIMIENTOS.paginaActual <= 1;
    btnSiguiente.disabled = PAGINACION_MOVIMIENTOS.paginaActual >= totalPaginas;
}

// ============================================================================
// Historial de Conteos de Stock (v344/v345)
// Los KPIs y el ranking de "top productos con más diferencia" se calculan en
// SQL vía RPC (fn_conteos_stock_kpis / fn_conteos_stock_top_productos) sobre
// TODO el conjunto filtrado — no solo la página visible. La tabla en sí usa
// una query directa contra conteos_stock (protegida por RLS de empresa),
// paginada con .range(), siguiendo el mismo patrón que cargarEstadoStock().
// ============================================================================

const MOTIVOS_CONTEO = {
    inventario: 'Corrección de inventario',
    conteo_fisico: 'Conteo físico'
};

function labelMotivoConteo(motivo) {
    return MOTIVOS_CONTEO[motivo] || motivo || 'Sin motivo';
}

// Orquesta la carga de toda la sección de conteos (KPIs + gráfico + tabla)
async function cargarConteos() {
    try {
        estadoConteos.depositoId = document.getElementById('conteosFiltroDeposito')?.value || '';
        estadoConteos.motivo = document.getElementById('conteosFiltroMotivo')?.value || '';
        estadoConteos.desde = document.getElementById('conteosFiltroDesde')?.value || '';
        estadoConteos.hasta = document.getElementById('conteosFiltroHasta')?.value || '';
        estadoConteos.soloConDiferencia = !!document.getElementById('conteosFiltroSoloDiferencia')?.checked;

        await Promise.all([
            cargarConteosKPIs(),
            cargarConteosTopProductos(),
            cargarConteosStock()
        ]);
    } catch (error) {
        console.error('Error cargando historial de conteos:', error);
        window.toast('Error al cargar el historial de conteos', 'danger');
    }
}

// KPIs agregados (sobre todo el conjunto filtrado, no solo la página actual)
async function cargarConteosKPIs() {
    try {
        const { data, error } = await window.authCtx.sb.rpc('fn_conteos_stock_kpis', {
            p_deposito_id: estadoConteos.depositoId || null,
            p_motivo: estadoConteos.motivo || null,
            p_desde: estadoConteos.desde || null,
            p_hasta: estadoConteos.hasta || null
        });
        if (error) throw error;

        const kpis = (data && data[0]) || { total_conteos: 0, con_diferencia: 0, diferencia_acumulada: 0 };
        const total = Number(kpis.total_conteos) || 0;
        const conDiferencia = Number(kpis.con_diferencia) || 0;
        const diferenciaAcumulada = Number(kpis.diferencia_acumulada) || 0;

        document.getElementById('kpiConteosTotal').textContent = total;
        document.getElementById('kpiConteosConDiferencia').textContent = conDiferencia;
        document.getElementById('kpiConteosConDiferenciaSub').textContent =
            total > 0 ? `${((conDiferencia / total) * 100).toFixed(1)}% del total` : 'Sistema ≠ contado';

        const diferenciaEl = document.getElementById('kpiConteosDiferenciaAcumulada');
        diferenciaEl.textContent = `${diferenciaAcumulada > 0 ? '+' : ''}${diferenciaAcumulada.toLocaleString('es-AR')}`;
        // El bloque de KPIs de esta sección migró de `.kpi-line`/`.kpi-line-item`
        // a `.franja-resumen-sololectura` (retiro de kpi-line.css en toda la
        // app) — ese componente no tiene variantes de color por ítem, así
        // que se deja de recolorear el contenedor según el signo. Antes
        // hubo un TypeError acá (`.kpi-icono` inexistente, después
        // `.kpi-line-item` inexistente); en vez de perseguir un wrapper que
        // vaya cambiando con cada rediseño visual, el signo del número
        // (+/−) ya comunica la dirección sin depender del markup externo.

    } catch (error) {
        console.error('Error cargando KPIs de conteos:', error);
    }
}

// Ranking de productos con más diferencia acumulada (valor absoluto), para el gráfico
async function cargarConteosTopProductos() {
    try {
        const { data, error } = await window.authCtx.sb.rpc('fn_conteos_stock_top_productos', {
            p_deposito_id: estadoConteos.depositoId || null,
            p_motivo: estadoConteos.motivo || null,
            p_desde: estadoConteos.desde || null,
            p_hasta: estadoConteos.hasta || null,
            p_limit: 10
        });
        if (error) throw error;

        const nombres = (data || []).map(d => d.producto_nombre);
        const diferencias = (data || []).map(d => Number(d.diferencia_neta) || 0);

        const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
        const colorPositivo = tokens.teal || '#6A9873';
        const colorNegativo = tokens.red || '#B8402E';

        if (!nombres.length) {
            chartsInstancias.conteosTopProductos = crearGraficoECharts(
                chartsInstancias.conteosTopProductos, 'chartConteosTopProductos', null,
                { htmlVacio: '<div class="echarts-vacio">No hay diferencias registradas para estos filtros.</div>' }
            );
            return;
        }

        chartsInstancias.conteosTopProductos = crearGraficoECharts(chartsInstancias.conteosTopProductos, 'chartConteosTopProductos', {
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { show: false },
            grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
            xAxis: { type: 'value' },
            yAxis: { type: 'category', data: nombres, inverse: true },
            series: [{
                name: 'Diferencia neta (contado − sistema)',
                type: 'bar',
                data: diferencias,
                itemStyle: {
                    color: (params) => params.value >= 0 ? colorPositivo : colorNegativo,
                },
            }],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando top productos de conteos:', error);
    }
}

// Tabla paginada de conteos (query directa, protegida por RLS de empresa)
async function cargarConteosStock() {
    const tbody = document.getElementById('tbodyConteos');
    try {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">Cargando datos...</td></tr>';

        const desde = (PAGINACION_CONTEOS.paginaActual - 1) * PAGINACION_CONTEOS.porPagina;
        const hasta = desde + PAGINACION_CONTEOS.porPagina - 1;

        let query = window.authCtx.sb
            .from('conteos_stock')
            .select(`
                id, cantidad_sistema, cantidad_contada, diferencia, motivo, created_at,
                productos ( nombre ),
                depositos ( nombre ),
                usuarios ( nombre )
            `, { count: 'exact' });

        if (estadoConteos.depositoId) {
            query = query.eq('deposito_id', estadoConteos.depositoId);
        }
        if (estadoConteos.motivo) {
            query = query.eq('motivo', estadoConteos.motivo);
        }
        if (estadoConteos.desde) {
            query = query.gte('created_at', `${estadoConteos.desde}T00:00:00`);
        }
        if (estadoConteos.hasta) {
            const hastaMasUnDia = new Date(`${estadoConteos.hasta}T00:00:00`);
            hastaMasUnDia.setDate(hastaMasUnDia.getDate() + 1);
            query = query.lt('created_at', hastaMasUnDia.toISOString());
        }
        if (estadoConteos.soloConDiferencia) {
            query = query.neq('diferencia', 0);
        }

        query = query.order('created_at', { ascending: false }).range(desde, hasta);

        const { data: conteos, error, count } = await query;
        if (error) throw error;

        PAGINACION_CONTEOS.totalRegistros = count || 0;

        tbody.innerHTML = (conteos || [])
            .map(c => {
                const fecha = new Date(c.created_at).toLocaleDateString('es-AR');
                const diferenciaClass = c.diferencia > 0 ? 'positive' : c.diferencia < 0 ? 'negative' : '';

                return `
                    <tr>
                        <td>${fecha}</td>
                        <td>${sanitize(c.productos?.nombre || 'Sin nombre')}</td>
                        <td>${sanitize(c.depositos?.nombre || 'Sin depósito')}</td>
                        <td>${c.cantidad_sistema}</td>
                        <td>${c.cantidad_contada}</td>
                        <td class="kpi-change ${diferenciaClass}">${c.diferencia > 0 ? '+' : ''}${c.diferencia}</td>
                        <td>${sanitize(labelMotivoConteo(c.motivo))}</td>
                        <td>${sanitize(c.usuarios?.nombre || 'Sin usuario')}</td>
                    </tr>
                `;
            })
            .join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="tabla-empty">No hay conteos registrados para estos filtros.</td></tr>';
        }

        renderPaginacionConteos();

    } catch (error) {
        console.error('Error cargando historial de conteos:', error);
        tbody.innerHTML = '<tr><td colspan="8" class="tabla-empty">Ocurrió un error al cargar el historial de conteos.</td></tr>';
    }
}

// Cambia de página y vuelve a pedir solo esa porción de datos al servidor
function cambiarPaginaConteos(direccion) {
    const totalPaginas = Math.max(1, Math.ceil(PAGINACION_CONTEOS.totalRegistros / PAGINACION_CONTEOS.porPagina));
    const nuevaPagina = PAGINACION_CONTEOS.paginaActual + direccion;
    if (nuevaPagina < 1 || nuevaPagina > totalPaginas) return;
    PAGINACION_CONTEOS.paginaActual = nuevaPagina;
    cargarConteosStock();
}

// Actualiza el texto y el estado de los botones "Anterior / Siguiente"
function renderPaginacionConteos() {
    const info = document.getElementById('conteosPaginacionInfo');
    const btnAnterior = document.getElementById('btnConteosAnterior');
    const btnSiguiente = document.getElementById('btnConteosSiguiente');
    if (!info || !btnAnterior || !btnSiguiente) return;

    const total = PAGINACION_CONTEOS.totalRegistros;
    const totalPaginas = Math.max(1, Math.ceil(total / PAGINACION_CONTEOS.porPagina));
    const desde = total === 0 ? 0 : (PAGINACION_CONTEOS.paginaActual - 1) * PAGINACION_CONTEOS.porPagina + 1;
    const hasta = Math.min(PAGINACION_CONTEOS.paginaActual * PAGINACION_CONTEOS.porPagina, total);

    info.textContent = `Mostrando ${desde}-${hasta} de ${total} conteos (página ${PAGINACION_CONTEOS.paginaActual} de ${totalPaginas})`;
    btnAnterior.disabled = PAGINACION_CONTEOS.paginaActual <= 1;
    btnSiguiente.disabled = PAGINACION_CONTEOS.paginaActual >= totalPaginas;
}

// Exportar reportes
async function exportarReportes() {
    const fecha = new Date().toISOString().split('T')[0];
    mostrarMenuExport(fecha, 'stock');
}

function mostrarMenuExport(fecha, tipo) {
    document.getElementById('export-menu-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'export-menu-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(22,24,29,.35)';
    overlay.innerHTML = `
      <div style="background:var(--color-surface,#FFFFFF);border-radius:12px;padding:24px;min-width:260px;box-shadow:0 8px 32px rgba(22,24,29,.18)">
        <h3 style="margin:0 0 16px;font-size:16px;font-weight:600">Exportar reporte</h3>
        <button onclick="exportarExcel_${tipo}('${fecha}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;margin-bottom:8px;background:var(--color-success-bg,#E2F0E5);border:1px solid var(--color-success-mid,#75A37D);border-radius:8px;cursor:pointer;font-size:14px;color:var(--color-success,#487050)">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 10 2.5 4L13 10m0 4-2.5-4M3 7h18"/></svg>
          Excel (.xlsx)
        </button>
        <button onclick="exportarCSV_${tipo}('${fecha}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;margin-bottom:8px;background:var(--pill-neutral-bg,#EAE4D6);border:1px solid var(--color-border-soft,#E7E9E4);border-radius:8px;cursor:pointer;font-size:14px;color:var(--pill-neutral-text,#4B4A45)">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          CSV (.csv)
        </button>
        <button onclick="exportarPDF_${tipo}()" style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;margin-bottom:16px;background:var(--color-danger-bg,#F5DDD8);border:1px solid var(--color-danger-mid,#D1594A);border-radius:8px;cursor:pointer;font-size:14px;color:var(--color-danger,#7A2820)">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          PDF (imprimir)
        </button>
        <button onclick="document.getElementById('export-menu-overlay').remove()" style="width:100%;padding:8px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--color-text-muted,#5B6660)">Cancelar</button>
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

function exportarExcel_stock(fecha) {
    document.getElementById('export-menu-overlay')?.remove();
    try {
        if (typeof XLSX === 'undefined') {
            exportarCSV_stock(fecha);
            window.toast('SheetJS no disponible — se descargó CSV como alternativa.', 'warning');
            return;
        }
        const wb = XLSX.utils.book_new();

        // Hoja KPIs
        const kpiData = [
            ['Reporte de Stock'],
            [`Generado: ${new Date().toLocaleDateString('es-AR')}`],
            [],
            ['KPI', 'Valor'],
            ['Valor Total Stock', document.getElementById('kpiValorTotal').textContent],
            ['Productos en Stock', document.getElementById('kpiProductosStock').textContent],
            ['Stock Crítico', document.getElementById('kpiStockCritico').textContent],
            ['Rotación Promedio', document.getElementById('kpiRotacion').textContent],
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiData), 'KPIs');

        // Hoja Estado de Stock
        const stockRows = [['Producto','Categoría','Stock Actual','Stock Reservado','Disponible','Costo Unitario','Valor Total','Estado']];
        document.querySelectorAll('#tbodyStock tr').forEach(r => {
            stockRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stockRows), 'Estado de Stock');

        // Hoja Productos Críticos
        const criticosRows = [['Producto','Stock Actual','Stock Mínimo','Déficit','Última Venta','Acción']];
        document.querySelectorAll('#tbodyProductosCriticos tr').forEach(r => {
            criticosRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(criticosRows), 'Productos Críticos');

        XLSX.writeFile(wb, `reportes-stock-${fecha}.xlsx`);
    } catch (e) {
        console.error('Error exportando Excel:', e);
        window.toast('Error al exportar Excel', 'danger');
    }
}

function exportarCSV_stock(fecha) {
    document.getElementById('export-menu-overlay')?.remove();
    try {
        const csv = generarCSVStock();
        descargarCSV(csv, `reportes-stock-${fecha}.csv`);
    } catch (e) {
        console.error('Error exportando CSV:', e);
        window.toast('Error al exportar CSV', 'danger');
    }
}

function exportarPDF_stock() {
    document.getElementById('export-menu-overlay')?.remove();
    window.print();
}

// Generar CSV
function generarCSVStock() {
    let csv = 'Reporte de Stock\n';
    csv += `Generado: ${new Date().toLocaleDateString('es-AR')}\n\n`;

    csv += 'KPIs\n';
    csv += `Valor Total Stock,${document.getElementById('kpiValorTotal').textContent}\n`;
    csv += `Productos en Stock,${document.getElementById('kpiProductosStock').textContent}\n`;
    csv += `Stock Crítico,${document.getElementById('kpiStockCritico').textContent}\n`;
    csv += `Rotación Promedio,${document.getElementById('kpiRotacion').textContent}\n\n`;

    csv += 'Estado de Stock\n';
    csv += 'Producto,Categoría,Stock Actual,Stock Reservado,Disponible,Costo Unitario,Valor Total,Estado\n';
    document.querySelectorAll('#tbodyStock tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent.trim()).join(',') + '\n';
    });

    csv += '\nProductos Críticos\n';
    csv += 'Producto,Stock Actual,Stock Mínimo,Déficit,Última Venta,Acción\n';
    document.querySelectorAll('#tbodyProductosCriticos tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent.trim()).join(',') + '\n';
    });

    return csv;
}

// Descargar CSV
function descargarCSV(csv, nombre) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', nombre);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Cerrar sesión
async function cerrarSesion() {
    try {
        await window.authCtx.sb.auth.signOut();
        window.location.href = '/admin/login';
    } catch (error) {
        console.error('Error cerrando sesión:', error);
    }
}
