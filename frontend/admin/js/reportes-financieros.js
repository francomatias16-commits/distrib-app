// Estado global
let estadoReportesFinancieros = {
    periodoActual: 'mes',
    fechaInicio: null,
    fechaFin: null,
    datos: {}
};

let chartsInstancias = {};

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await window.authReady;
        
        // Validar rol
        if (!['dueno', 'admin', 'contador'].includes(window.authCtx.perfil.rol)) {
            window.location.href = '/admin/dashboard';
            return;
        }

        // Cargar datos iniciales
        await cargarReportes();

        // Event listeners
        document.getElementById('filtroPeriodon').addEventListener('change', (e) => {
            estadoReportesFinancieros.periodoActual = e.target.value;
            if (e.target.value === 'personalizado') {
                document.getElementById('filtroPersonalizadoContainer').style.display = 'flex';
            } else {
                document.getElementById('filtroPersonalizadoContainer').style.display = 'none';
                calcularFechas();
            }
        });

        document.getElementById('btnAplicarFiltros').addEventListener('click', cargarReportes);
        document.getElementById('btnExportarFinanzas').addEventListener('click', exportarReportes);
        document.getElementById('cerrarSesion')?.addEventListener('click', cerrarSesion);

    } catch (error) {
        console.error('Error en inicialización:', error);
        window.toast('Error al cargar la página. Por favor, recarga.', 'danger');
    }
});

// Calcular fechas según período
function calcularFechas() {
    const hoy = new Date();
    let inicio, fin;

    switch (estadoReportesFinancieros.periodoActual) {
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

    estadoReportesFinancieros.fechaInicio = inicio;
    estadoReportesFinancieros.fechaFin = fin;
}

// Cargar reportes
async function cargarReportes() {
    try {
        calcularFechas();

        // Cargar datos
        await Promise.all([
            cargarKPIsFinancieros(),
            cargarFlujoCaja(),
            cargarIngresosVsCostos(),
            cargarDeudaPorCliente(),
            cargarResumenCobranzas(),
            cargarEvolucionMargen()
        ]);

    } catch (error) {
        console.error('Error cargando reportes:', error);
        window.toast('Error al cargar los reportes', 'danger');
    }
}

// Cargar KPIs Financieros
async function cargarKPIsFinancieros() {
    try {
        // Obtener pedidos entregados en el período
        const { data: pedidos, error } = await window.authCtx.sb
            .from('pedidos')
            .select('id, total, pedido_items(cantidad, precio_unitario, producto_id)')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesFinancieros.fechaFin.toISOString());

        if (error) throw error;

        // Obtener costos de productos
        const productosIds = new Set();
        (pedidos || []).forEach(p => {
            (p.pedido_items || []).forEach(item => {
                if (item.producto_id) productosIds.add(item.producto_id);
            });
        });

        const { data: productos } = await window.authCtx.sb
            .from('productos')
            .select('id, costo')
            .in('id', Array.from(productosIds));

        const productoCosto = {};
        (productos || []).forEach(p => {
            productoCosto[p.id] = p.costo || 0;
        });

        // Calcular ingresos y costos
        let ingresos = 0;
        let costos = 0;

        (pedidos || []).forEach(p => {
            ingresos += p.total || 0;
            (p.pedido_items || []).forEach(item => {
                costos += (item.cantidad * (productoCosto[item.producto_id] || 0));
            });
        });

        const margenBruto = ingresos - costos;
        const porcentajeMargen = ingresos > 0 ? (margenBruto / ingresos * 100).toFixed(2) : 0;

        // Calcular período anterior
        const diasDiferencia = Math.floor((estadoReportesFinancieros.fechaFin - estadoReportesFinancieros.fechaInicio) / (1000 * 60 * 60 * 24)) + 1;
        const fechaInicioAnterior = new Date(estadoReportesFinancieros.fechaInicio);
        fechaInicioAnterior.setDate(fechaInicioAnterior.getDate() - diasDiferencia);
        const fechaFinAnterior = new Date(estadoReportesFinancieros.fechaInicio);
        fechaFinAnterior.setDate(fechaFinAnterior.getDate() - 1);

        const { data: pedidosAnterior } = await window.authCtx.sb
            .from('pedidos')
            .select('id, total, pedido_items(cantidad, precio_unitario, producto_id)')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', fechaInicioAnterior.toISOString())
            .lte('fecha_pedido', fechaFinAnterior.toISOString());

        let ingresosAnterior = 0;
        let costosAnterior = 0;

        (pedidosAnterior || []).forEach(p => {
            ingresosAnterior += p.total || 0;
            (p.pedido_items || []).forEach(item => {
                costosAnterior += (item.cantidad * (productoCosto[item.producto_id] || 0));
            });
        });

        const margenBrutoAnterior = ingresosAnterior - costosAnterior;
        const porcentajeMargenAnterior = ingresosAnterior > 0 ? (margenBrutoAnterior / ingresosAnterior * 100) : 0;

        // Calcular cambios
        const cambioIngresos = ingresosAnterior > 0 ? ((ingresos - ingresosAnterior) / ingresosAnterior * 100).toFixed(1) : 0;
        const cambioCostos = costosAnterior > 0 ? ((costos - costosAnterior) / costosAnterior * 100).toFixed(1) : 0;
        const cambioMargen = margenBrutoAnterior > 0 ? ((margenBruto - margenBrutoAnterior) / margenBrutoAnterior * 100).toFixed(1) : 0;
        const cambioPorcentajeMargen = porcentajeMargenAnterior > 0 ? (porcentajeMargen - porcentajeMargenAnterior).toFixed(1) : 0;

        // Actualizar UI - Ingresos y Costos
        document.getElementById('kpiIngresos').textContent = `$${ingresos.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioIngresos').textContent = `${cambioIngresos > 0 ? '+' : ''}${cambioIngresos}% vs período anterior`;
        document.getElementById('kpiCambioIngresos').className = `kpi-change ${cambioIngresos >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiCostos').textContent = `$${costos.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioCostos').textContent = `${cambioCostos > 0 ? '+' : ''}${cambioCostos}% vs período anterior`;
        document.getElementById('kpiCambioCostos').className = `kpi-change ${cambioCostos >= 0 ? 'negative' : 'positive'}`;

        document.getElementById('kpiMargen').textContent = `$${margenBruto.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioMargen').textContent = `${cambioMargen > 0 ? '+' : ''}${cambioMargen}% vs período anterior`;
        document.getElementById('kpiCambioMargen').className = `kpi-change ${cambioMargen >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiPorcentajeMargen').textContent = `${porcentajeMargen}%`;
        document.getElementById('kpiCambioPorcentajeMargen').textContent = `${cambioPorcentajeMargen > 0 ? '+' : ''}${cambioPorcentajeMargen}% vs período anterior`;
        document.getElementById('kpiCambioPorcentajeMargen').className = `kpi-change ${cambioPorcentajeMargen >= 0 ? 'positive' : 'negative'}`;

        // Cargar KPIs de Cobranza
        await cargarKPIsCobranza();

        estadoReportesFinancieros.datos.ingresos = ingresos;
        estadoReportesFinancieros.datos.costos = costos;
        estadoReportesFinancieros.datos.margenBruto = margenBruto;

    } catch (error) {
        console.error('Error cargando KPIs financieros:', error);
    }
}

// Cargar KPIs de Cobranza
async function cargarKPIsCobranza() {
    try {
        // Facturas emitidas
        const { data: facturas } = await window.authCtx.sb
            .from('facturas')
            .select('id, total, estado, vencimiento, total_cobrado')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .gte('fecha_emision', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha_emision', estadoReportesFinancieros.fechaFin.toISOString());

        const totalFacturado = (facturas || []).reduce((sum, f) => sum + (f.total || 0), 0);
        const cantidadFacturas = (facturas || []).length;

        // Cobros realizados
        const { data: cobros } = await window.authCtx.sb
            .from('cta_cte')
            .select('id, monto, tipo')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('tipo', 'cobro')
            .gte('fecha', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha', estadoReportesFinancieros.fechaFin.toISOString());

        const totalCobrado = (cobros || []).reduce((sum, c) => sum + (c.monto || 0), 0);

        // Deuda pendiente
        const { data: facturasPendientes } = await window.authCtx.sb
            .from('facturas')
            .select('id, total, total_cobrado, estado, vencimiento')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .in('estado', ['emitida', 'parcial']);

        let deudaPendiente = 0;
        let deudaVencida = 0;
        const hoy = new Date();

        (facturasPendientes || []).forEach(f => {
            const saldoPendiente = (f.total || 0) - (f.total_cobrado || 0);
            deudaPendiente += saldoPendiente;
            
            if (f.vencimiento && new Date(f.vencimiento) < hoy) {
                deudaVencida += saldoPendiente;
            }
        });

        // Calcular período anterior
        const diasDiferencia = Math.floor((estadoReportesFinancieros.fechaFin - estadoReportesFinancieros.fechaInicio) / (1000 * 60 * 60 * 24)) + 1;
        const fechaInicioAnterior = new Date(estadoReportesFinancieros.fechaInicio);
        fechaInicioAnterior.setDate(fechaInicioAnterior.getDate() - diasDiferencia);

        const { data: facturasAnterior } = await window.authCtx.sb
            .from('facturas')
            .select('id, total')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .gte('fecha_emision', fechaInicioAnterior.toISOString())
            .lt('fecha_emision', estadoReportesFinancieros.fechaInicio.toISOString());

        const totalFacturadoAnterior = (facturasAnterior || []).reduce((sum, f) => sum + (f.total || 0), 0);

        const { data: cobrosAnterior } = await window.authCtx.sb
            .from('cta_cte')
            .select('id, monto')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('tipo', 'cobro')
            .gte('fecha', fechaInicioAnterior.toISOString())
            .lt('fecha', estadoReportesFinancieros.fechaInicio.toISOString());

        const totalCobradoAnterior = (cobrosAnterior || []).reduce((sum, c) => sum + (c.monto || 0), 0);

        // Calcular cambios
        const cambioFacturas = cantidadFacturas;
        const cambioCobros = totalCobradoAnterior > 0 ? ((totalCobrado - totalCobradoAnterior) / totalCobradoAnterior * 100).toFixed(1) : 0;
        const cambioDeuda = totalFacturadoAnterior > 0 ? ((deudaPendiente - (totalFacturadoAnterior - totalCobradoAnterior)) / (totalFacturadoAnterior - totalCobradoAnterior) * 100).toFixed(1) : 0;

        // Actualizar UI
        document.getElementById('kpiFacturasEmitidas').textContent = `$${totalFacturado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioFacturas').textContent = `+${cantidadFacturas} vs período anterior`;
        document.getElementById('kpiCambioFacturas').className = 'kpi-change positive';

        document.getElementById('kpiCobrosRealizados').textContent = `$${totalCobrado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioCobros').textContent = `${cambioCobros > 0 ? '+' : ''}${cambioCobros}% vs período anterior`;
        document.getElementById('kpiCambioCobros').className = `kpi-change ${cambioCobros >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('kpiDeudaPendiente').textContent = `$${deudaPendiente.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioDeuda').textContent = `${cambioDeuda > 0 ? '+' : ''}${cambioDeuda}% vs período anterior`;
        document.getElementById('kpiCambioDeuda').className = `kpi-change ${cambioDeuda >= 0 ? 'negative' : 'positive'}`;

        document.getElementById('kpiDeudaVencida').textContent = `$${deudaVencida.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
        document.getElementById('kpiCambioDeudaVencida').className = 'kpi-change negative';

    } catch (error) {
        console.error('Error cargando KPIs de cobranza:', error);
    }
}

// Cargar flujo de caja
async function cargarFlujoCaja() {
    try {
        // Obtener movimientos diarios
        const { data: pedidos } = await window.authCtx.sb
            .from('pedidos')
            .select('id, total, fecha_pedido')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesFinancieros.fechaFin.toISOString());

        const { data: cobros } = await window.authCtx.sb
            .from('cta_cte')
            .select('id, monto, fecha')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('tipo', 'cobro')
            .gte('fecha', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha', estadoReportesFinancieros.fechaFin.toISOString());

        // Agrupar por día
        const flujoPorDia = {};
        (pedidos || []).forEach(p => {
            const fecha = new Date(p.fecha_pedido).toLocaleDateString('es-AR');
            flujoPorDia[fecha] = (flujoPorDia[fecha] || 0) + (p.total || 0);
        });

        (cobros || []).forEach(c => {
            const fecha = new Date(c.fecha).toLocaleDateString('es-AR');
            flujoPorDia[fecha] = (flujoPorDia[fecha] || 0) + (c.monto || 0);
        });

        const fechas = Object.keys(flujoPorDia).sort();
        const valores = fechas.map(f => flujoPorDia[f]);

        const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
        const colorPositivo = tokens.teal || '#B87A00';
        const colorNegativo = tokens.red || '#B3261E';

        if (!fechas.length) {
            chartsInstancias.flujoCaja = crearGraficoECharts(chartsInstancias.flujoCaja, 'chartFlujoCaja', null);
            return;
        }

        chartsInstancias.flujoCaja = crearGraficoECharts(chartsInstancias.flujoCaja, 'chartFlujoCaja', {
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                valueFormatter: (v) => '$' + Number(v).toLocaleString('es-AR'),
            },
            legend: { show: false },
            xAxis: { type: 'category', data: fechas },
            yAxis: {
                type: 'value',
                axisLabel: { formatter: (v) => '$' + Number(v).toLocaleString('es-AR') },
            },
            dataZoom: fechas.length > 14 ? [
                { type: 'inside', start: 50, end: 100 },
                { type: 'slider', height: 18, bottom: 4 },
            ] : undefined,
            grid: { bottom: fechas.length > 14 ? 48 : 8 },
            series: [{
                name: 'Flujo de Caja Diario',
                type: 'bar',
                data: valores,
                itemStyle: {
                    // cada barra toma color según sea flujo positivo o negativo
                    color: (params) => params.value >= 0 ? colorPositivo : colorNegativo,
                },
            }],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando flujo de caja:', error);
    }
}

// Cargar ingresos vs costos
async function cargarIngresosVsCostos() {
    try {
        const { data: pedidos } = await window.authCtx.sb
            .from('pedidos')
            .select('id, total, pedido_items(cantidad, precio_unitario, producto_id), fecha_pedido')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha_pedido', estadoReportesFinancieros.fechaFin.toISOString());

        // Obtener costos
        const productosIds = new Set();
        (pedidos || []).forEach(p => {
            (p.pedido_items || []).forEach(item => {
                if (item.producto_id) productosIds.add(item.producto_id);
            });
        });

        const { data: productos } = await window.authCtx.sb
            .from('productos')
            .select('id, costo')
            .in('id', Array.from(productosIds));

        const productoCosto = {};
        (productos || []).forEach(p => {
            productoCosto[p.id] = p.costo || 0;
        });

        // Agrupar por día
        const datoPorDia = {};
        (pedidos || []).forEach(p => {
            const fecha = new Date(p.fecha_pedido).toLocaleDateString('es-AR');
            if (!datoPorDia[fecha]) {
                datoPorDia[fecha] = { ingresos: 0, costos: 0 };
            }
            datoPorDia[fecha].ingresos += p.total || 0;
            (p.pedido_items || []).forEach(item => {
                datoPorDia[fecha].costos += item.cantidad * (productoCosto[item.producto_id] || 0);
            });
        });

        const fechas = Object.keys(datoPorDia).sort();
        const ingresos = fechas.map(f => datoPorDia[f].ingresos);
        const costos = fechas.map(f => datoPorDia[f].costos);

        const tokens = (typeof inicializarTemaECharts === 'function' && inicializarTemaECharts()) || {};
        const colorIngresos = tokens.teal || '#B87A00';
        const colorCostos = tokens.red || '#B3261E';

        if (!fechas.length) {
            chartsInstancias.ingresosVsCostos = crearGraficoECharts(chartsInstancias.ingresosVsCostos, 'chartIngresosVsCostos', null);
            return;
        }

        const construirArea = (color) => ({
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
                { offset: 0, color: color + '40' },
                { offset: 1, color: color + '05' },
            ],
        });

        chartsInstancias.ingresosVsCostos = crearGraficoECharts(chartsInstancias.ingresosVsCostos, 'chartIngresosVsCostos', {
            tooltip: {
                trigger: 'axis',
                valueFormatter: (v) => '$' + Number(v).toLocaleString('es-AR'),
            },
            legend: { data: ['Ingresos', 'Costos'], top: 0 },
            xAxis: { type: 'category', data: fechas, boundaryGap: false },
            yAxis: {
                type: 'value',
                axisLabel: { formatter: (v) => '$' + Number(v).toLocaleString('es-AR') },
            },
            dataZoom: fechas.length > 14 ? [
                { type: 'inside', start: 50, end: 100 },
                { type: 'slider', height: 18, bottom: 4 },
            ] : undefined,
            grid: { top: 40, bottom: fechas.length > 14 ? 48 : 8 },
            series: [
                {
                    name: 'Ingresos',
                    type: 'line',
                    data: ingresos,
                    smooth: true,
                    itemStyle: { color: colorIngresos },
                    lineStyle: { color: colorIngresos },
                    areaStyle: { color: construirArea(colorIngresos) },
                },
                {
                    name: 'Costos',
                    type: 'line',
                    data: costos,
                    smooth: true,
                    itemStyle: { color: colorCostos },
                    lineStyle: { color: colorCostos },
                    areaStyle: { color: construirArea(colorCostos) },
                },
            ],
        }, { notMerge: true });

    } catch (error) {
        console.error('Error cargando ingresos vs costos:', error);
    }
}

// Cargar deuda por cliente
async function cargarDeudaPorCliente() {
    try {
        const { data: facturas } = await window.authCtx.sb
            .from('facturas')
            .select('id, cliente_id, total, total_cobrado, vencimiento, clientes(razon_social)')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .in('estado', ['emitida', 'parcial']);

        // Agrupar por cliente
        const deudaPorCliente = {};
        const hoy = new Date();

        (facturas || []).forEach(f => {
            const clienteId = f.cliente_id;
            const clienteNombre = f.clientes?.razon_social || 'Sin cliente';
            const saldoPendiente = (f.total || 0) - (f.total_cobrado || 0);

            if (!deudaPorCliente[clienteId]) {
                deudaPorCliente[clienteId] = {
                    nombre: clienteNombre,
                    deudaTotal: 0,
                    deudaVencida: 0,
                    deudaPorVencer: 0,
                    diasPromedio: 0,
                    facturas: []
                };
            }

            deudaPorCliente[clienteId].deudaTotal += saldoPendiente;
            deudaPorCliente[clienteId].facturas.push({
                vencimiento: f.vencimiento,
                saldo: saldoPendiente
            });

            if (f.vencimiento && new Date(f.vencimiento) < hoy) {
                deudaPorCliente[clienteId].deudaVencida += saldoPendiente;
            } else {
                deudaPorCliente[clienteId].deudaPorVencer += saldoPendiente;
            }
        });

        // Calcular días promedio
        Object.values(deudaPorCliente).forEach(cliente => {
            if (cliente.facturas.length > 0) {
                const diasTotal = cliente.facturas.reduce((sum, f) => {
                    if (f.vencimiento) {
                        const dias = Math.floor((new Date(f.vencimiento) - hoy) / (1000 * 60 * 60 * 24));
                        return sum + dias;
                    }
                    return sum;
                }, 0);
                cliente.diasPromedio = Math.round(diasTotal / cliente.facturas.length);
            }
        });

        // Ordenar por deuda total
        const ranking = Object.values(deudaPorCliente)
            .sort((a, b) => b.deudaTotal - a.deudaTotal)
            .slice(0, 20);

        // Renderizar tabla
        const tbody = document.getElementById('tbodyDeuda');
        tbody.innerHTML = ranking.map(c => {
            const estado = c.deudaVencida > 0 ? 'Vencida' : (c.deudaPorVencer > 0 ? 'Por vencer' : 'Al día');
            const estadoClass = estado === 'Vencida' ? 'red' : (estado === 'Por vencer' ? 'yellow' : 'green');
            return `
                <tr>
                    <td>${sanitize(c.nombre)}</td>
                    <td>$${c.deudaTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                    <td>$${c.deudaVencida.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                    <td>$${c.deudaPorVencer.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                    <td>${c.diasPromedio} días</td>
                    <td><span class="status-badge ${estadoClass}">${estado}</span></td>
                </tr>
            `;
        }).join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="tabla-empty">No hay clientes con deuda registrada.</td></tr>';
        }

    } catch (error) {
        console.error('Error cargando deuda por cliente:', error);
    }
}

// Cargar resumen de cobranzas
async function cargarResumenCobranzas() {
    try {
        const { data: cobros } = await window.authCtx.sb
            .from('cta_cte')
            .select('id, monto, medio_pago')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('tipo', 'cobro')
            .gte('fecha', estadoReportesFinancieros.fechaInicio.toISOString())
            .lte('fecha', estadoReportesFinancieros.fechaFin.toISOString());

        // Agrupar por medio de pago
        const cobrosPorMedio = {};
        let totalCobros = 0;

        (cobros || []).forEach(c => {
            const medio = c.medio_pago || 'Sin especificar';
            if (!cobrosPorMedio[medio]) {
                cobrosPorMedio[medio] = {
                    cantidad: 0,
                    monto: 0
                };
            }
            cobrosPorMedio[medio].cantidad += 1;
            cobrosPorMedio[medio].monto += c.monto || 0;
            totalCobros += c.monto || 0;
        });

        // Renderizar tabla
        const tbody = document.getElementById('tbodyCobranzas');
        tbody.innerHTML = Object.entries(cobrosPorMedio).map(([medio, data]) => {
            const porcentaje = totalCobros > 0 ? (data.monto / totalCobros * 100).toFixed(2) : 0;
            return `
                <tr>
                    <td>${medio}</td>
                    <td>${data.cantidad}</td>
                    <td>$${data.monto.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                    <td>${porcentaje}%</td>
                </tr>
            `;
        }).join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="tabla-empty">No hay cobros registrados en el período seleccionado.</td></tr>';
        }

    } catch (error) {
        console.error('Error cargando resumen de cobranzas:', error);
    }
}

// Cargar evolución de margen
async function cargarEvolucionMargen() {
    try {
        // Obtener datos por mes
        const { data: pedidos, error: errPedidos } = await window.authCtx.sb
            .from('pedidos')
            .select('id, total, pedido_items(cantidad, precio_unitario, producto_id), fecha_pedido')
            .eq('empresa_id', window.authCtx.perfil.empresa_id)
            .eq('estado', 'entregado')
            .gte('fecha_pedido', new Date(new Date().getFullYear(), 0, 1).toISOString());

        if (errPedidos) {
            console.error('Error consultando pedidos para evolución de margen:', errPedidos);
        }

        // Obtener costos
        const productosIds = new Set();
        (pedidos || []).forEach(p => {
            (p.pedido_items || []).forEach(item => {
                if (item.producto_id) productosIds.add(item.producto_id);
            });
        });

        const { data: productos } = await window.authCtx.sb
            .from('productos')
            .select('id, costo')
            .in('id', Array.from(productosIds));

        const productoCosto = {};
        (productos || []).forEach(p => {
            productoCosto[p.id] = p.costo || 0;
        });

        // Agrupar por mes
        const datoPorMes = {};
        const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

        for (let i = 0; i < 12; i++) {
            datoPorMes[i] = { ingresos: 0, costos: 0 };
        }

        (pedidos || []).forEach(p => {
            const mes = new Date(p.fecha_pedido).getMonth();
            datoPorMes[mes].ingresos += p.total || 0;
            (p.pedido_items || []).forEach(item => {
                datoPorMes[mes].costos += item.cantidad * (productoCosto[item.producto_id] || 0);
            });
        });

        // Renderizar tabla
        const tbody = document.getElementById('tbodyMargen');
        tbody.innerHTML = Object.entries(datoPorMes)
            .filter(([mes, data]) => data.ingresos > 0 || data.costos > 0)
            .map(([mes, data]) => {
                const margenBruto = data.ingresos - data.costos;
                const porcentajeMargen = data.ingresos > 0 ? (margenBruto / data.ingresos * 100).toFixed(2) : 0;
                return `
                    <tr>
                        <td>${meses[parseInt(mes)]}</td>
                        <td>$${data.ingresos.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                        <td>$${data.costos.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                        <td>$${margenBruto.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                        <td>${porcentajeMargen}%</td>
                    </tr>
                `;
            }).join('');

        if (!tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="tabla-empty">No hay pedidos entregados este año para calcular el margen.</td></tr>';
        }

    } catch (error) {
        console.error('Error cargando evolución de margen:', error);
    }
}

// Exportar reportes — menú con Excel / CSV / PDF
async function exportarReportes() {
    const fecha = new Date().toISOString().split('T')[0];
    mostrarMenuExport(fecha, 'finanzas');
}

function mostrarMenuExport(fecha, tipo) {
    document.getElementById('export-menu-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'export-menu-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)';
    overlay.innerHTML = `
      <div style="background:var(--color-surface,#FCFAF5);border-radius:12px;padding:24px;min-width:260px;box-shadow:0 8px 32px rgba(0,0,0,.18)">
        <h3 style="margin:0 0 16px;font-size:16px;font-weight:600">Exportar reporte</h3>
        <button onclick="exportarExcel_${tipo}('${fecha}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;margin-bottom:8px;background:var(--color-success-bg,#DCEDE3);border:1px solid var(--color-success-mid,#1F5B4A);border-radius:8px;cursor:pointer;font-size:14px;color:var(--color-success,#17402F)">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 10 2.5 4L13 10m0 4-2.5-4M3 7h18"/></svg>
          Excel (.xlsx)
        </button>
        <button onclick="exportarCSV_${tipo}('${fecha}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;margin-bottom:8px;background:var(--pill-neutral-bg,#EAE4D6);border:1px solid var(--color-border-soft,#DAD3C0);border-radius:8px;cursor:pointer;font-size:14px;color:var(--pill-neutral-text,#4B4A45)">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          CSV (.csv)
        </button>
        <button onclick="exportarPDF_${tipo}()" style="display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;margin-bottom:16px;background:var(--color-danger-bg,#F3DAD8);border:1px solid var(--color-danger-mid,#B3261E);border-radius:8px;cursor:pointer;font-size:14px;color:var(--color-danger,#7A1E19)">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          PDF (imprimir)
        </button>
        <button onclick="document.getElementById('export-menu-overlay').remove()" style="width:100%;padding:8px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--color-text-muted,#4B4A45)">Cancelar</button>
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

function exportarExcel_finanzas(fecha) {
    document.getElementById('export-menu-overlay')?.remove();
    try {
        if (typeof XLSX === 'undefined') {
            exportarCSV_finanzas(fecha);
            window.toast('SheetJS no disponible — se descargó CSV como alternativa.', 'warning');
            return;
        }
        const wb = XLSX.utils.book_new();

        // Hoja KPIs Financieros
        const kpiData = [
            ['Reporte Financiero'],
            [`Período: ${estadoReportesFinancieros.fechaInicio.toLocaleDateString('es-AR')} - ${estadoReportesFinancieros.fechaFin.toLocaleDateString('es-AR')}`],
            [],
            ['KPI', 'Valor'],
            ['Ingresos Totales',    document.getElementById('kpiIngresos').textContent],
            ['Costos Totales',      document.getElementById('kpiCostos').textContent],
            ['Margen Bruto',        document.getElementById('kpiMargen').textContent],
            ['% Margen',            document.getElementById('kpiPorcentajeMargen').textContent],
            [],
            ['KPIs de Cobranza', ''],
            ['Facturas Emitidas',   document.getElementById('kpiFacturasEmitidas').textContent],
            ['Cobros Realizados',   document.getElementById('kpiCobrosRealizados').textContent],
            ['Deuda Pendiente',     document.getElementById('kpiDeudaPendiente').textContent],
            ['Deuda Vencida',       document.getElementById('kpiDeudaVencida').textContent],
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiData), 'KPIs');

        // Hoja Deuda por Cliente
        const deudaRows = [['Cliente','Deuda Total','Deuda Vencida','Deuda por Vencer','Días Promedio','Estado']];
        document.querySelectorAll('#tbodyDeuda tr').forEach(r => {
            deudaRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(deudaRows), 'Deuda por Cliente');

        // Hoja Cobranzas por medio de pago
        const cobRows = [['Medio de Pago','Cantidad','Monto Total','% del Total']];
        document.querySelectorAll('#tbodyCobranzas tr').forEach(r => {
            cobRows.push(Array.from(r.querySelectorAll('td')).map(c => c.textContent.trim()));
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cobRows), 'Cobranzas');

        XLSX.writeFile(wb, `reportes-financieros-${fecha}.xlsx`);
    } catch (e) {
        console.error('Error exportando Excel:', e);
        window.toast('Error al exportar Excel', 'danger');
    }
}

function exportarCSV_finanzas(fecha) {
    document.getElementById('export-menu-overlay')?.remove();
    try {
        const csv = generarCSVFinanzas();
        descargarCSV(csv, `reportes-financieros-${fecha}.csv`);
    } catch (e) {
        console.error('Error exportando CSV:', e);
        window.toast('Error al exportar CSV', 'danger');
    }
}

function exportarPDF_finanzas() {
    document.getElementById('export-menu-overlay')?.remove();
    window.print();
}

// Generar CSV
function generarCSVFinanzas() {
    let csv = 'Reporte Financiero\n';
    csv += `Período: ${estadoReportesFinancieros.fechaInicio.toLocaleDateString('es-AR')} - ${estadoReportesFinancieros.fechaFin.toLocaleDateString('es-AR')}\n\n`;

    csv += 'KPIs Financieros\n';
    csv += `Ingresos Totales,$${document.getElementById('kpiIngresos').textContent.replace('$', '')}\n`;
    csv += `Costos Totales,$${document.getElementById('kpiCostos').textContent.replace('$', '')}\n`;
    csv += `Margen Bruto,$${document.getElementById('kpiMargen').textContent.replace('$', '')}\n`;
    csv += `% Margen,${document.getElementById('kpiPorcentajeMargen').textContent}\n\n`;

    csv += 'KPIs de Cobranza\n';
    csv += `Facturas Emitidas,$${document.getElementById('kpiFacturasEmitidas').textContent.replace('$', '')}\n`;
    csv += `Cobros Realizados,$${document.getElementById('kpiCobrosRealizados').textContent.replace('$', '')}\n`;
    csv += `Deuda Pendiente,$${document.getElementById('kpiDeudaPendiente').textContent.replace('$', '')}\n`;
    csv += `Deuda Vencida,$${document.getElementById('kpiDeudaVencida').textContent.replace('$', '')}\n\n`;

    csv += 'Deuda por Cliente\n';
    csv += 'Cliente,Deuda Total,Deuda Vencida,Deuda por Vencer,Días Promedio,Estado\n';
    document.querySelectorAll('#tbodyDeuda tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(c => c.textContent).join(',') + '\n';
    });

    csv += '\nResumen de Cobranzas\n';
    csv += 'Medio de Pago,Cantidad,Monto Total,% del Total\n';
    document.querySelectorAll('#tbodyCobranzas tr').forEach((row) => {
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
