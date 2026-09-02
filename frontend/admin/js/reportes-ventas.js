// Estado global
let estadoReportesVentas = {
    periodoActual: 'mes',
    fechaInicio: null,
    fechaFin: null,
    vendedorSeleccionado: '',
    zonaSeleccionada: '',
    datos: {}
};

let chartsInstancias = {};

// Setea el ancho de la barra de magnitud de una línea del manifiesto de KPIs
// (0-100, ya clampeado). Tolerante a que el elemento no exista todavía.
function setBarraKpi(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    const val = Math.max(0, Math.min(100, isFinite(pct) ? pct : 0));
    el.style.setProperty('--bar', val + '%');
}


// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await window.authReady;

        // Validar auth y rol
        if (!window.authCtx || !window.authCtx.perfil) {
            window.location.href = '/admin/login';
            return;
        }
        if (!['dueno', 'admin', 'contador'].includes(window.authCtx.perfil.rol)) {
            window.location.href = '/admin/dashboard';
            return;
        }

        // Cargar datos iniciales
        await cargarVendedores();
        await cargarZonas();
        await cargarReportes();

        // Event listeners
        document.getElementById('filtroPeriodon').addEventListener('change', (e) => {
            estadoReportesVentas.periodoActual = e.target.value;
            if (e.target.value === 'personalizado') {
                document.getElementById('filtroPersonalizadoContainer').style.display = 'flex';
            } else {
                document.getElementById('filtroPersonalizadoContainer').style.display = 'none';
                calcularFechas();
            }
        });

        document.getElementById('btnAplicarFiltros').addEventListener('click', cargarReportes);
        document.getElementById('btnExportarVentas').addEventListener('click', exportarReportes);
        document.getElementById('cerrarSesion')?.addEventListener('click', cerrarSesion);

    } catch (error) {
        console.error('Error en inicialización:', error);
        if (!window.authCtx || !window.authCtx.perfil) {
            window.location.href = '/admin/login';
        } else {
            console.error('Error cargando reportes de ventas:', error.message);
        }
    }
});

// Calcular fechas según período
function calcularFechas() {
    const hoy = new Date();
    let inicio, fin;

    switch (estadoReportesVentas.periodoActual) {
        case 'hoy':
            inicio = new Date(hoy);
            fin = new Date(hoy);
            break;
        case 'semana':
            inicio = new Date(hoy);
            inicio.setDate(hoy.getDate() - hoy.getDay());
            fin = new Date(hoy);
            break;
        case 'mes':
            inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
            fin = new Date(hoy);
            break;
        case 'trimestre':
            const trimestre = Math.floor(hoy.getMonth() / 3);
            inicio = new Date(hoy.getFullYear(), trimestre * 3, 1);
            fin = new Date(hoy);
            break;
        case 'año':
            inicio = new Date(hoy.getFullYear(), 0, 1);
            fin = new Date(hoy);
            break;
        case 'personalizado':
            inicio = new Date(document.getElementById('filtroFechaInicio').value);
            fin = new Date(document.getElementById('filtroFechaFin').value);
            break;
    }

    estadoReportesVentas.fechaInicio = inicio;
    estadoReportesVentas.fechaFin = fin;
}

// Cargar vendedores
async function cargarVendedores() {
    try {
        const { data, error } = await window.conTimeoutRed(window.authCtx.sb
            .from('usuarios')
            .select('id, nombre, rol')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('rol', 'vendedor')
            .eq('activo', true)
            .order('nombre'), 10000);

        if (error) throw error;

        const select = document.getElementById('filtroVendedor');
        data.forEach(vendedor => {
            const option = document.createElement('option');
            option.value = vendedor.id;
            option.textContent = vendedor.nombre;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error cargando vendedores:', error);
    }
}

// Cargar zonas
async function cargarZonas() {
    try {
        const { data, error } = await window.conTimeoutRed(window.authCtx.sb
            .from('zonas')
            .select('id, nombre')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('activa', true)
            .order('nombre'), 10000);

        if (error) throw error;

        const select = document.getElementById('filtroZona');
        data.forEach(zona => {
            const option = document.createElement('option');
            option.value = zona.id;
            option.textContent = zona.nombre;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error cargando zonas:', error);
    }
}

// Cargar reportes
async function cargarReportes() {
    try {
        calcularFechas();

        // Actualizar filtros
        estadoReportesVentas.vendedorSeleccionado = document.getElementById('filtroVendedor').value;
        estadoReportesVentas.zonaSeleccionada = document.getElementById('filtroZona').value;

        // Cargar datos
        await Promise.all([
            cargarKPIs(),
            cargarVentasDiarias(),
            cargarVentasCategorias(),
            cargarRankingVendedores(),
            cargarRankingClientes(),
            cargarRankingProductos(),
            cargarVentasPorZona()
        ]);

    } catch (error) {
        console.error('Error cargando reportes:', error);
        window.toast('Error al cargar los reportes', 'danger');
    }
}

// Cargar KPIs
async function cargarKPIs() {
    try {
        let query = window.authCtx.sb
            .from('pedidos')
            .select('id, total, estado, fecha_pedido, cliente_id, vendedor_id', { count: 'exact' })
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.vendedorSeleccionado) {
            query = query.eq('vendedor_id', estadoReportesVentas.vendedorSeleccionado);
        }

        const { data: pedidos, error } = await window.conTimeoutRed(query, 10000);
        if (error) throw error;

        // Ventas de mostrador (POS) del mismo período — mismo criterio que usa
        // el dashboard ejecutivo. Si hay un vendedor seleccionado, se excluyen:
        // el filtro de vendedor no aplica a ventas de mostrador.
        let ventasPos = [];
        if (!estadoReportesVentas.vendedorSeleccionado) {
            const { data } = await window.conTimeoutRed(window.authCtx.sb
                .from('ventas_pos')
                .select('id, total, cliente_id', { count: 'exact' })
                .eq('empresa_id', window.authCtx.perfil.empresa_id)
                .eq('estado', 'completada')
                .gte('created_at', estadoReportesVentas.fechaInicio.toISOString())
                .lte('created_at', estadoReportesVentas.fechaFin.toISOString()), 10000);
            ventasPos = data || [];
        }

        // Calcular KPIs
        const totalVentas = (pedidos || []).reduce((sum, p) => sum + (p.total || 0), 0)
            + ventasPos.reduce((sum, v) => sum + (v.total || 0), 0);
        const cantidadPedidos = (pedidos || []).length + ventasPos.length;
        const ticketPromedio = cantidadPedidos > 0 ? totalVentas / cantidadPedidos : 0;
        const clientesUnicos = new Set([
            ...(pedidos || []).map(p => p.cliente_id),
            ...ventasPos.filter(v => v.cliente_id).map(v => v.cliente_id),
        ]).size;

        // Calcular período anterior
        const diasDiferencia = Math.floor((estadoReportesVentas.fechaFin - estadoReportesVentas.fechaInicio) / (1000 * 60 * 60 * 24)) + 1;
        const fechaInicioAnterior = new Date(estadoReportesVentas.fechaInicio);
        fechaInicioAnterior.setDate(fechaInicioAnterior.getDate() - diasDiferencia);
        const fechaFinAnterior = new Date(estadoReportesVentas.fechaInicio);
        fechaFinAnterior.setDate(fechaFinAnterior.getDate() - 1);

        let queryAnterior = window.authCtx.sb
            .from('pedidos')
            .select('id, total')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', fechaInicioAnterior.toISOString())
            .lte('fecha_pedido', fechaFinAnterior.toISOString());

        if (estadoReportesVentas.vendedorSeleccionado) {
            queryAnterior = queryAnterior.eq('vendedor_id', estadoReportesVentas.vendedorSeleccionado);
        }

        const { data: pedidosAnterior } = await window.conTimeoutRed(queryAnterior, 10000);

        let ventasPosAnterior = [];
        if (!estadoReportesVentas.vendedorSeleccionado) {
            const { data } = await window.conTimeoutRed(window.authCtx.sb
                .from('ventas_pos')
                .select('id, total')
                .eq('empresa_id', window.authCtx.perfil.empresa_id)
                .eq('estado', 'completada')
                .gte('created_at', fechaInicioAnterior.toISOString())
                .lte('created_at', fechaFinAnterior.toISOString()), 10000);
            ventasPosAnterior = data || [];
        }

        const totalVentasAnterior = (pedidosAnterior || []).reduce((sum, p) => sum + (p.total || 0), 0)
            + ventasPosAnterior.reduce((sum, v) => sum + (v.total || 0), 0);
        const cantidadAnterior = (pedidosAnterior || []).length + ventasPosAnterior.length;
        const cambioVentas = totalVentasAnterior > 0 ? ((totalVentas - totalVentasAnterior) / totalVentasAnterior * 100).toFixed(1) : 0;
        const cambioPedidos = cantidadAnterior > 0 ? cantidadPedidos - cantidadAnterior : 0;
        const cambioTicket = totalVentasAnterior > 0 && cantidadAnterior > 0 ? (((totalVentas / cantidadPedidos) - (totalVentasAnterior / cantidadAnterior)) / (totalVentasAnterior / cantidadAnterior) * 100).toFixed(1) : 0;

        // Actualizar UI
        document.getElementById('kpiTotalVentas').textContent = `$${totalVentas.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioVentas').textContent = `${cambioVentas > 0 ? '+' : ''}${cambioVentas}%`;
        document.getElementById('kpiCambioVentas').className = `linea-delta kpi-change ${cambioVentas >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiCantidadPedidos').textContent = cantidadPedidos;
        document.getElementById('kpiCambioPedidos').textContent = `${cambioPedidos > 0 ? '+' : ''}${cambioPedidos}`;
        document.getElementById('kpiCambioPedidos').className = `linea-delta kpi-change ${cambioPedidos >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiTicketPromedio').textContent = `$${ticketPromedio.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioTicket').textContent = `${cambioTicket > 0 ? '+' : ''}${cambioTicket}%`;
        document.getElementById('kpiCambioTicket').className = `linea-delta kpi-change ${cambioTicket >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiClientesActivos').textContent = clientesUnicos;

        // Barras de magnitud del manifiesto "Resumen de ventas" — proporción
        // real entre sí (Ventas/Pedidos/Ticket/Clientes no comparten unidad,
        // por eso cada una se referencia contra su propio máximo esperable
        // implícito: usamos el valor actual vs. el máximo del grupo de montos
        // para Ventas/Ticket, y una escala de conteo para Pedidos/Clientes).
        const maxMonto = Math.max(totalVentas, ticketPromedio, 1);
        setBarraKpi('kpiBarVentas', totalVentas / maxMonto * 100);
        setBarraKpi('kpiBarTicket', ticketPromedio / maxMonto * 100);
        const maxConteo = Math.max(cantidadPedidos, clientesUnicos, 1);
        setBarraKpi('kpiBarPedidos', cantidadPedidos / maxConteo * 100);
        setBarraKpi('kpiBarClientes', clientesUnicos / maxConteo * 100);


        estadoReportesVentas.datos.totalVentas = totalVentas;
        estadoReportesVentas.datos.cantidadPedidos = cantidadPedidos;
        estadoReportesVentas.datos.pedidos = pedidos;

    } catch (error) {
        console.error('Error cargando KPIs:', error);
    }
}

// Cargar ventas diarias
async function cargarVentasDiarias() {
    try {
        let query = window.authCtx.sb
            .from('pedidos')
            .select('id, total, fecha_pedido')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.vendedorSeleccionado) {
            query = query.eq('vendedor_id', estadoReportesVentas.vendedorSeleccionado);
        }

        const { data: pedidos, error } = await window.conTimeoutRed(query, 10000);
        if (error) throw error;

        // Ventas de mostrador (POS); no aplica si hay un vendedor seleccionado
        let ventasPos = [];
        if (!estadoReportesVentas.vendedorSeleccionado) {
            const { data } = await window.conTimeoutRed(window.authCtx.sb
                .from('ventas_pos')
                .select('id, total, created_at')
                .eq('empresa_id', window.authCtx.perfil.empresa_id)
                .eq('estado', 'completada')
                .gte('created_at', estadoReportesVentas.fechaInicio.toISOString())
                .lte('created_at', estadoReportesVentas.fechaFin.toISOString()), 10000);
            ventasPos = data || [];
        }

        // Agrupar por día
        const ventasPorDia = {};
        (pedidos || []).forEach(p => {
            const fecha = new Date(p.fecha_pedido).toLocaleDateString('es-AR');
            ventasPorDia[fecha] = (ventasPorDia[fecha] || 0) + (p.total || 0);
        });

        ventasPos.forEach(v => {
            const fecha = new Date(v.created_at).toLocaleDateString('es-AR');
            ventasPorDia[fecha] = (ventasPorDia[fecha] || 0) + (v.total || 0);
        });

        const fechas = Object.keys(ventasPorDia).sort();
        const valores = fechas.map(f => ventasPorDia[f]);

        const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
        const colorVentas = tokens.teal || '#6A9873';

        if (!fechas.length) {
            chartsInstancias.ventasDiarias = crearGraficoECharts(chartsInstancias.ventasDiarias, 'chartVentasDiarias', null);
            return;
        }

        chartsInstancias.ventasDiarias = crearGraficoECharts(chartsInstancias.ventasDiarias, 'chartVentasDiarias', {
            tooltip: {
                trigger: 'axis',
                valueFormatter: (v) => '$' + Number(v).toLocaleString('es-AR'),
            },
            legend: { show: false },
            xAxis: {
                type: 'category',
                data: fechas,
                boundaryGap: false,
            },
            yAxis: {
                type: 'value',
                axisLabel: { formatter: (v) => '$' + Number(v).toLocaleString('es-AR') },
            },
            // dataZoom: permite explorar rangos largos de fechas arrastrando o
            // con la rueda del mouse, sin perder el detalle diario — algo que
            // Chart.js no ofrece de fábrica.
            dataZoom: fechas.length > 14 ? [
                { type: 'inside', start: 50, end: 100 },
                { type: 'slider', height: 18, bottom: 4 },
            ] : undefined,
            grid: { bottom: fechas.length > 14 ? 48 : 8 },
            series: [{
                name: 'Ventas Diarias',
                type: 'line',
                data: valores,
                smooth: true,
                showSymbol: fechas.length <= 30,
                areaStyle: {
                    color: {
                        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [
                            { offset: 0, color: colorVentas + '55' },
                            { offset: 1, color: colorVentas + '05' },
                        ],
                    },
                },
                itemStyle: { color: colorVentas },
                lineStyle: { color: colorVentas },
            }],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando ventas diarias:', error);
    }
}

// Cargar ventas por categoría
async function cargarVentasCategorias() {
    try {
        let query = window.authCtx.sb
            .from('pedidos')
            .select('pedido_items(cantidad, precio_unitario, producto_id), fecha_pedido')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.vendedorSeleccionado) {
            query = query.eq('vendedor_id', estadoReportesVentas.vendedorSeleccionado);
        }

        const { data: pedidos, error } = await window.conTimeoutRed(query, 10000);
        if (error) throw error;

        // Ventas de mostrador (POS); no aplica si hay un vendedor seleccionado
        let ventasPos = [];
        if (!estadoReportesVentas.vendedorSeleccionado) {
            const { data } = await window.conTimeoutRed(window.authCtx.sb
                .from('ventas_pos')
                .select('venta_pos_items(cantidad, precio_unitario, producto_id)')
                .eq('empresa_id', window.authCtx.perfil.empresa_id)
                .eq('estado', 'completada')
                .gte('created_at', estadoReportesVentas.fechaInicio.toISOString())
                .lte('created_at', estadoReportesVentas.fechaFin.toISOString()), 10000);
            ventasPos = data || [];
        }

        // Obtener categorías de productos
        const productosIds = new Set();
        (pedidos || []).forEach(p => {
            (p.pedido_items || []).forEach(item => {
                if (item.producto_id) productosIds.add(item.producto_id);
            });
        });
        ventasPos.forEach(v => {
            (v.venta_pos_items || []).forEach(item => {
                if (item.producto_id) productosIds.add(item.producto_id);
            });
        });

        const { data: productos } = await window.conTimeoutRed(window.authCtx.sb
            .from('productos')
            .select('id, categoria_id')
            .in('id', Array.from(productosIds)), 10000);

        const { data: categorias } = await window.conTimeoutRed(window.authCtx.sb
            .from('categorias')
            .select('id, nombre')
            .eq('empresa_id', window.authCtx.perfil.empresa_id), 10000);

        // Mapear productos a categorías
        const productoCategoria = {};
        (productos || []).forEach(p => {
            productoCategoria[p.id] = p.categoria_id;
        });

        // Agrupar ventas por categoría
        const ventasPorCategoria = {};
        (pedidos || []).forEach(p => {
            (p.pedido_items || []).forEach(item => {
                const categoriaId = productoCategoria[item.producto_id];
                const categoria = (categorias || []).find(c => c.id === categoriaId);
                const nombreCategoria = categoria ? categoria.nombre : 'Sin categoría';
                const monto = item.cantidad * item.precio_unitario;
                ventasPorCategoria[nombreCategoria] = (ventasPorCategoria[nombreCategoria] || 0) + monto;
            });
        });

        ventasPos.forEach(v => {
            (v.venta_pos_items || []).forEach(item => {
                const categoriaId = productoCategoria[item.producto_id];
                const categoria = (categorias || []).find(c => c.id === categoriaId);
                const nombreCategoria = categoria ? categoria.nombre : 'Sin categoría';
                const monto = item.cantidad * item.precio_unitario;
                ventasPorCategoria[nombreCategoria] = (ventasPorCategoria[nombreCategoria] || 0) + monto;
            });
        });

        const categoriasNombres = Object.keys(ventasPorCategoria);
        const valoresCategoria = Object.values(ventasPorCategoria);

        if (!categoriasNombres.length) {
            chartsInstancias.ventasCategorias = crearGraficoECharts(chartsInstancias.ventasCategorias, 'chartVentasCategorias', null);
            return;
        }

        chartsInstancias.ventasCategorias = crearGraficoECharts(chartsInstancias.ventasCategorias, 'chartVentasCategorias', {
            tooltip: {
                trigger: 'item',
                valueFormatter: (v) => '$' + Number(v).toLocaleString('es-AR'),
            },
            legend: { orient: 'vertical', right: 8, top: 'middle', type: 'scroll' },
            series: [{
                name: 'Ventas por categoría',
                type: 'pie',
                radius: ['45%', '72%'], // donut, igual look que antes pero con hueco más marcado
                center: ['38%', '50%'],
                avoidLabelOverlap: true,
                itemStyle: { borderRadius: 4 },
                label: {
                    formatter: '{b}\n{d}%',
                    fontSize: 11,
                },
                labelLine: { length: 10, length2: 8 },
                data: categoriasNombres.map((nombre, i) => ({
                    name: nombre,
                    value: valoresCategoria[i],
                })),
            }],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando ventas por categoría:', error);
    }
}

// Cargar ranking de vendedores
async function cargarRankingVendedores() {
    try {
        let query = window.authCtx.sb
            .from('pedidos')
            .select('id, total, vendedor_id, usuarios!pedidos_vendedor_id_fkey(nombre)', { count: 'exact' })
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.vendedorSeleccionado) {
            query = query.eq('vendedor_id', estadoReportesVentas.vendedorSeleccionado);
        }

        const { data: pedidos, error } = await window.conTimeoutRed(query, 10000);
        if (error) throw error;

        // Agrupar por vendedor
        const ventasPorVendedor = {};
        (pedidos || []).forEach(p => {
            const vendedorId = p.vendedor_id;
            const vendedorNombre = p.usuarios?.nombre || 'Sin vendedor';
            if (!ventasPorVendedor[vendedorId]) {
                ventasPorVendedor[vendedorId] = {
                    nombre: vendedorNombre,
                    total: 0,
                    cantidad: 0
                };
            }
            ventasPorVendedor[vendedorId].total += p.total || 0;
            ventasPorVendedor[vendedorId].cantidad += 1;
        });

        const totalGeneral = Object.values(ventasPorVendedor).reduce((sum, v) => sum + v.total, 0);

        // Ordenar y obtener top 10
        const ranking = Object.entries(ventasPorVendedor)
            .map(([id, data]) => ({
                id,
                nombre: data.nombre,
                total: data.total,
                cantidad: data.cantidad,
                ticketPromedio: data.cantidad > 0 ? data.total / data.cantidad : 0,
                porcentaje: totalGeneral > 0 ? (data.total / totalGeneral * 100).toFixed(2) : 0
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);

        // Renderizar tabla
        const tbody = document.getElementById('tbodyVendedores');
        tbody.innerHTML = ranking.length ? ranking.map((v, idx) => `
            <tr>
                <td data-label="Posición">${idx + 1}</td>
                <td data-label="Vendedor">${sanitize(v.nombre)}</td>
                <td data-label="Total Vendido">$${v.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="Cantidad Pedidos">${v.cantidad}</td>
                <td data-label="Ticket Promedio">$${v.ticketPromedio.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="% del Total">${v.porcentaje}%</td>
            </tr>
        `).join('') : '<tr><td colspan="6" class="tabla-empty">No hay ventas de vendedores en el período seleccionado.</td></tr>';

    } catch (error) {
        console.error('Error cargando ranking de vendedores:', error);
    }
}

// Cargar ranking de clientes
async function cargarRankingClientes() {
    try {
        let query = window.authCtx.sb
            .from('pedidos')
            .select('id, total, cliente_id, clientes(razon_social)', { count: 'exact' })
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.zonaSeleccionada) {
            const { data: clientesZona } = await window.conTimeoutRed(window.authCtx.sb
                .from('clientes')
                .select('id')
                .eq('zona_id', estadoReportesVentas.zonaSeleccionada), 10000);
            const clientesIds = (clientesZona || []).map(c => c.id);
            query = query.in('cliente_id', clientesIds);
        }

        const { data: pedidos, error } = await window.conTimeoutRed(query, 10000);
        if (error) throw error;

        // Ventas de mostrador (POS) con cliente identificado — las ventas
        // anónimas de mostrador (cliente_id null) no se pueden atribuir a
        // ningún cliente y quedan fuera del ranking.
        let queryPos = window.authCtx.sb
            .from('ventas_pos')
            .select('id, total, cliente_id, clientes(razon_social)')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'completada')
            .not('cliente_id', 'is', null)
            .gte('created_at', estadoReportesVentas.fechaInicio.toISOString())
            .lte('created_at', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.zonaSeleccionada) {
            const { data: clientesZona } = await window.conTimeoutRed(window.authCtx.sb
                .from('clientes')
                .select('id')
                .eq('zona_id', estadoReportesVentas.zonaSeleccionada), 10000);
            const clientesIds = (clientesZona || []).map(c => c.id);
            queryPos = queryPos.in('cliente_id', clientesIds);
        }

        const { data: ventasPos } = await window.conTimeoutRed(queryPos, 10000);

        // Agrupar por cliente
        const ventasPorCliente = {};
        (pedidos || []).forEach(p => {
            const clienteId = p.cliente_id;
            const clienteNombre = p.clientes?.razon_social || 'Sin cliente';
            if (!ventasPorCliente[clienteId]) {
                ventasPorCliente[clienteId] = {
                    nombre: clienteNombre,
                    total: 0,
                    cantidad: 0
                };
            }
            ventasPorCliente[clienteId].total += p.total || 0;
            ventasPorCliente[clienteId].cantidad += 1;
        });

        (ventasPos || []).forEach(v => {
            const clienteId = v.cliente_id;
            const clienteNombre = v.clientes?.razon_social || 'Sin cliente';
            if (!ventasPorCliente[clienteId]) {
                ventasPorCliente[clienteId] = {
                    nombre: clienteNombre,
                    total: 0,
                    cantidad: 0
                };
            }
            ventasPorCliente[clienteId].total += v.total || 0;
            ventasPorCliente[clienteId].cantidad += 1;
        });

        const totalGeneral = Object.values(ventasPorCliente).reduce((sum, c) => sum + c.total, 0);

        // Ordenar y obtener top 10
        const ranking = Object.entries(ventasPorCliente)
            .map(([id, data]) => ({
                id,
                nombre: data.nombre,
                total: data.total,
                cantidad: data.cantidad,
                ticketPromedio: data.cantidad > 0 ? data.total / data.cantidad : 0,
                porcentaje: totalGeneral > 0 ? (data.total / totalGeneral * 100).toFixed(2) : 0
            }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);

        // Renderizar tabla
        const tbody = document.getElementById('tbodyClientes');
        tbody.innerHTML = ranking.length ? ranking.map((c, idx) => `
            <tr>
                <td data-label="Posición">${idx + 1}</td>
                <td data-label="Cliente">${sanitize(c.nombre)}</td>
                <td data-label="Total Comprado">$${c.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="Cantidad Pedidos">${c.cantidad}</td>
                <td data-label="Ticket Promedio">$${c.ticketPromedio.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="% del Total">${c.porcentaje}%</td>
            </tr>
        `).join('') : '<tr><td colspan="6" class="tabla-empty">No hay compras de clientes en el período seleccionado.</td></tr>';

    } catch (error) {
        console.error('Error cargando ranking de clientes:', error);
    }
}

// Cargar ranking de productos
async function cargarRankingProductos() {
    try {
        let query = window.authCtx.sb
            .from('pedidos')
            .select('pedido_items(cantidad, precio_unitario, producto_id)')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString());

        if (estadoReportesVentas.vendedorSeleccionado) {
            query = query.eq('vendedor_id', estadoReportesVentas.vendedorSeleccionado);
        }

        const { data: pedidos, error } = await window.conTimeoutRed(query, 10000);
        if (error) throw error;

        // Ventas de mostrador (POS); no aplica si hay un vendedor seleccionado
        let ventasPos = [];
        if (!estadoReportesVentas.vendedorSeleccionado) {
            const { data } = await window.conTimeoutRed(window.authCtx.sb
                .from('ventas_pos')
                .select('venta_pos_items(cantidad, precio_unitario, producto_id)')
                .eq('empresa_id', window.authCtx.perfil.empresa_id)
                .eq('estado', 'completada')
                .gte('created_at', estadoReportesVentas.fechaInicio.toISOString())
                .lte('created_at', estadoReportesVentas.fechaFin.toISOString()), 10000);
            ventasPos = data || [];
        }

        // Agrupar por producto
        const ventasPorProducto = {};
        (pedidos || []).forEach(p => {
            (p.pedido_items || []).forEach(item => {
                if (!ventasPorProducto[item.producto_id]) {
                    ventasPorProducto[item.producto_id] = {
                        cantidad: 0,
                        ingresos: 0
                    };
                }
                ventasPorProducto[item.producto_id].cantidad += item.cantidad;
                ventasPorProducto[item.producto_id].ingresos += item.cantidad * item.precio_unitario;
            });
        });

        ventasPos.forEach(v => {
            (v.venta_pos_items || []).forEach(item => {
                if (!ventasPorProducto[item.producto_id]) {
                    ventasPorProducto[item.producto_id] = {
                        cantidad: 0,
                        ingresos: 0
                    };
                }
                ventasPorProducto[item.producto_id].cantidad += item.cantidad;
                ventasPorProducto[item.producto_id].ingresos += item.cantidad * item.precio_unitario;
            });
        });

        // Obtener datos de productos
        const productosIds = Object.keys(ventasPorProducto);
        const { data: productos } = await window.conTimeoutRed(window.authCtx.sb
            .from('productos')
            .select('id, nombre, costo')
            .in('id', productosIds), 10000);

        const totalIngresos = Object.values(ventasPorProducto).reduce((sum, p) => sum + p.ingresos, 0);

        // Crear ranking
        const ranking = productos
            .map(p => {
                const datos = ventasPorProducto[p.id];
                const margenPromedio = datos.ingresos > 0 ? ((datos.ingresos - (p.costo * datos.cantidad)) / datos.ingresos * 100).toFixed(2) : 0;
                return {
                    id: p.id,
                    nombre: p.nombre,
                    cantidad: datos.cantidad,
                    ingresos: datos.ingresos,
                    margenPromedio,
                    porcentaje: totalIngresos > 0 ? (datos.ingresos / totalIngresos * 100).toFixed(2) : 0
                };
            })
            .sort((a, b) => b.ingresos - a.ingresos)
            .slice(0, 10);

        // Renderizar tabla
        const tbody = document.getElementById('tbodyProductos');
        tbody.innerHTML = ranking.length ? ranking.map((p, idx) => `
            <tr>
                <td data-label="Posición">${idx + 1}</td>
                <td data-label="Producto">${sanitize(p.nombre)}</td>
                <td data-label="Cantidad Vendida">${p.cantidad}</td>
                <td data-label="Ingresos">$${p.ingresos.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="Margen Promedio">${p.margenPromedio}%</td>
                <td data-label="% del Total">${p.porcentaje}%</td>
            </tr>
        `).join('') : '<tr><td colspan="6" class="tabla-empty">No hay productos vendidos en el período seleccionado.</td></tr>';

    } catch (error) {
        console.error('Error cargando ranking de productos:', error);
    }
}

// Cargar ventas por zona
async function cargarVentasPorZona() {
    try {
        let query = window.conTimeoutRed(window.authCtx.sb
            .from('pedidos')
            .select('id, total, cliente_id, clientes(zona_id, zonas(nombre))')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesVentas.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesVentas.fechaFin.toISOString()), 10000);

        const { data: pedidos, error } = await query;
        if (error) throw error;

        // Agrupar por zona
        const ventasPorZona = {};
        (pedidos || []).forEach(p => {
            const zonaNombre = p.clientes?.zonas?.nombre || 'Sin zona';
            if (!ventasPorZona[zonaNombre]) {
                ventasPorZona[zonaNombre] = {
                    total: 0,
                    cantidad: 0
                };
            }
            ventasPorZona[zonaNombre].total += p.total || 0;
            ventasPorZona[zonaNombre].cantidad += 1;
        });

        const totalGeneral = Object.values(ventasPorZona).reduce((sum, z) => sum + z.total, 0);

        // Crear ranking
        const ranking = Object.entries(ventasPorZona)
            .map(([nombre, data]) => ({
                nombre,
                total: data.total,
                cantidad: data.cantidad,
                ticketPromedio: data.cantidad > 0 ? data.total / data.cantidad : 0,
                porcentaje: totalGeneral > 0 ? (data.total / totalGeneral * 100).toFixed(2) : 0
            }))
            .sort((a, b) => b.total - a.total);

        // Renderizar tabla
        const tbody = document.getElementById('tbodyZonas');
        tbody.innerHTML = ranking.length ? ranking.map((z, idx) => `
            <tr>
                <td data-label="Zona">${sanitize(z.nombre)}</td>
                <td data-label="Total Vendido">$${z.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="Cantidad Pedidos">${z.cantidad}</td>
                <td data-label="Ticket Promedio">$${z.ticketPromedio.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td data-label="% del Total">${z.porcentaje}%</td>
            </tr>
        `).join('') : '<tr><td colspan="5" class="tabla-empty">No hay ventas por zona en el período seleccionado.</td></tr>';

    } catch (error) {
        console.error('Error cargando ventas por zona:', error);
    }
}

// Exportar reportes
async function exportarReportes() {
    const fecha = new Date().toISOString().split('T')[0];
    // Mostrar menú de opciones de exportación
    mostrarMenuExport(fecha, 'ventas');
}

function mostrarMenuExport(fecha, tipo) {
    // Eliminar menú anterior si existe
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

function exportarExcel_ventas(fecha) {
    document.getElementById('export-menu-overlay')?.remove();
    try {
        if (typeof XLSX === 'undefined') {
            exportarCSV_ventas(fecha);
            window.toast('SheetJS no disponible — se descargó CSV como alternativa.', 'warning');
            return;
        }
        const wb = XLSX.utils.book_new();

        // Hoja KPIs
        const kpiData = [
            ['Reporte de Ventas'],
            [`Período: ${estadoReportesVentas.fechaInicio.toLocaleDateString('es-AR')} - ${estadoReportesVentas.fechaFin.toLocaleDateString('es-AR')}`],
            [],
            ['KPI', 'Valor'],
            ['Total de Ventas', document.getElementById('kpiTotalVentas').textContent],
            ['Cantidad de Pedidos', document.getElementById('kpiCantidadPedidos').textContent],
            ['Ticket Promedio', document.getElementById('kpiTicketPromedio').textContent],
            ['Clientes Activos', document.getElementById('kpiClientesActivos').textContent],
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiData), 'KPIs');

        // Hoja Top Vendedores
        const vendedoresRows = [['Posición','Vendedor','Total Vendido','Cant. Pedidos','Ticket Promedio','% del Total']];
        document.querySelectorAll('#tbodyVendedores tr').forEach(r => {
            vendedoresRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vendedoresRows), 'Vendedores');

        // Hoja Top Clientes
        const clientesRows = [['Posición','Cliente','Total Comprado','Cant. Pedidos','Ticket Promedio','% del Total']];
        document.querySelectorAll('#tbodyClientes tr').forEach(r => {
            clientesRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(clientesRows), 'Clientes');

        // Hoja Top Productos
        const productosRows = [['Posición','Producto','Cant. Vendida','Ingresos','Margen Promedio','% del Total']];
        document.querySelectorAll('#tbodyProductos tr').forEach(r => {
            productosRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(productosRows), 'Productos');

        // Hoja Zonas
        const zonasRows = [['Zona','Total Vendido','Cant. Pedidos','Ticket Promedio','% del Total']];
        document.querySelectorAll('#tbodyZonas tr').forEach(r => {
            zonasRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zonasRows), 'Zonas');

        XLSX.writeFile(wb, `reportes-ventas-${fecha}.xlsx`);
    } catch (e) {
        console.error('Error exportando Excel:', e);
        window.toast('Error al exportar Excel', 'danger');
    }
}

function exportarCSV_ventas(fecha) {
    document.getElementById('export-menu-overlay')?.remove();
    try {
        const csv = generarCSVVentas();
        descargarCSV(csv, `reportes-ventas-${fecha}.csv`);
    } catch (e) {
        console.error('Error exportando CSV:', e);
        window.toast('Error al exportar CSV', 'danger');
    }
}

function exportarPDF_ventas() {
    document.getElementById('export-menu-overlay')?.remove();
    window.print();
}

// Generar CSV
function generarCSVVentas() {
    let csv = 'Reporte de Ventas\n';
    csv += `Período: ${estadoReportesVentas.fechaInicio.toLocaleDateString('es-AR')} - ${estadoReportesVentas.fechaFin.toLocaleDateString('es-AR')}\n\n`;

    csv += 'KPIs Principales\n';
    csv += `Total de Ventas,$${document.getElementById('kpiTotalVentas').textContent.replace('$', '')}\n`;
    csv += `Cantidad de Pedidos,${document.getElementById('kpiCantidadPedidos').textContent}\n`;
    csv += `Ticket Promedio,$${document.getElementById('kpiTicketPromedio').textContent.replace('$', '')}\n`;
    csv += `Clientes Activos,${document.getElementById('kpiClientesActivos').textContent}\n\n`;

    csv += 'Top Vendedores\n';
    csv += 'Posición,Vendedor,Total Vendido,Cantidad Pedidos,Ticket Promedio,% del Total\n';
    document.querySelectorAll('#tbodyVendedores tr').forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent).join(',') + '\n';
    });

    csv += '\nTop Clientes\n';
    csv += 'Posición,Cliente,Total Comprado,Cantidad Pedidos,Ticket Promedio,% del Total\n';
    document.querySelectorAll('#tbodyClientes tr').forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent).join(',') + '\n';
    });

    csv += '\nTop Productos\n';
    csv += 'Posición,Producto,Cantidad Vendida,Ingresos,Margen Promedio,% del Total\n';
    document.querySelectorAll('#tbodyProductos tr').forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent).join(',') + '\n';
    });

    csv += '\nVentas por Zona\n';
    csv += 'Zona,Total Vendido,Cantidad Pedidos,Ticket Promedio,% del Total\n';
    document.querySelectorAll('#tbodyZonas tr').forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent).join(',') + '\n';
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
