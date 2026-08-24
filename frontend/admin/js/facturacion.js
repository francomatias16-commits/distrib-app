// frontend/admin/js/facturacion.js
// Auto-extraído y adaptado al repo integrado.


// ── Config ─────────────────────────────────────────────────────────────────
let sb = null;   // asignado en init() cuando authCtx ya existe

// ── Estado ─────────────────────────────────────────────────────────────────
let usuario     = null;
let empresaData = null;
let facturas    = []; // página actual (ver fn_facturas_lista, migración 262) — ya no es el dataset completo
let filtradas   = []; // alias de `facturas`: se mantiene el nombre para no tocar renderTabla/abrirModal/etc.
let filtroEstado  = '';
let modalFacturaId = null;
let accionEnCurso  = false;

let paginaActualFacturas = 1;
const ITEMS_POR_PAGINA_FACTURAS = 200;
let totalFacturasFiltradas = 0;

// Contadores de las 4 tarjetas KPI (fn_facturas_contadores, migración 262):
// se calculan sobre TODO el universo de facturas de la empresa, no sobre la
// página cargada — antes se calculaban sobre `facturas` cuando esa variable
// contenía el recorte fijo de 300, así que no cambian con cada filtro/
// búsqueda, solo cuando el dato subyacente cambia (alta, reintentar, anular).
let contadoresFacturas = { cant_pendientes: 0, cant_error_afip: 0, cant_emitidas_mes: 0, monto_emitidas_mes: 0 };

// ── Inicialización ────────────────────────────────────────────────────────
async function init() {
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }
  sb          = window.authCtx.sb;
  usuario     = window.authCtx.perfil;
  empresaData = window.authCtx.perfil?.empresas || { id: window.authCtx.perfil?.empresa_id, nombre: '', config: {} };

  if (empresaData) {
    document.title = `Facturación — ${sanitize(empresaData.nombre)}`;
  }

  try { inyectarControlesPaginacionFacturas(); } catch(e) { console.warn('[facturacion] paginacion init:', e.message); }

  // Buscador con debounce (250ms, mismo criterio que clientes.js/cheques.js):
  // la búsqueda pega contra Supabase (fn_facturas_lista) — FIX auditoría
  // etapa 4: antes llamaba a aplicarFiltros(), que solo filtraba en memoria
  // la página ya cargada (hasta 200 filas), no todo el universo de facturas
  // de la empresa. Con más de 200 facturas (el caso real: el tenant demo
  // tiene 1502), buscar algo fuera de la página cargada devolvía "sin
  // resultados" aunque la factura existiera. Mismo problema para los
  // filtros de estado/período (ver selFiltroEstado/onFiltroPeriodo abajo).
  const inputBusqueda = document.getElementById('input-busqueda');
  if (inputBusqueda) {
    let debounceBusquedaFacturas = null;
    inputBusqueda.addEventListener('input', () => {
      clearTimeout(debounceBusquedaFacturas);
      debounceBusquedaFacturas = setTimeout(() => { paginaActualFacturas = 1; cargarFacturas(); }, 250);
    });
  }

  await Promise.all([cargarContadoresFacturas(), cargarFacturas()]);
}

// Contadores de las 4 tarjetas KPI sobre TODO el universo de facturas de la
// empresa (fn_facturas_contadores, migración 262) — no sobre la página ni
// sobre el viejo recorte de 300.
async function cargarContadoresFacturas() {
  try {
    const { data, error } = await sb.rpc('fn_facturas_contadores').single();
    if (error) throw error;
    contadoresFacturas = data || contadoresFacturas;
    actualizarKpis();
  } catch (e) {
    console.error('[facturacion] Error cargando contadores:', e);
  }
}

// ── Carga de facturas ────────────────────────────────────────────────────
// Trae la página actual ya filtrada/ordenada por Supabase (fn_facturas_lista,
// migración 262): búsqueda, estado y rango de fechas se resuelven en SQL,
// reusando el índice idx_facturas_empresa_estado_fecha. Antes traía hasta
// 300 facturas fijas y filtraba todo en el navegador — con 1.505 facturas
// en el tenant demo, "Todo el historial" mostraba en realidad las últimas
// 300 nomás.
async function cargarFacturas() {
  window.mostrarSkeletonTabla('tabla-body', 8);

  const busq    = document.getElementById('input-busqueda').value.trim();
  const periodo = document.getElementById('filtro-periodo').value;
  const fechaDesdeInput = document.getElementById('filtro-fecha-desde')?.value;
  const fechaHastaInput = document.getElementById('filtro-fecha-hasta')?.value;

  const hoy = new Date();
  const inicioMes    = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const inicioMesAnt = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const finMesAnt     = new Date(hoy.getFullYear(), hoy.getMonth(), 0); // último día del mes anterior

  let fechaDesde = null, fechaHasta = null;
  if (periodo === 'mes') {
    fechaDesde = fechaLocalISO(inicioMes);
  } else if (periodo === 'anterior') {
    fechaDesde = fechaLocalISO(inicioMesAnt);
    fechaHasta = fechaLocalISO(finMesAnt);
  } else if (periodo === 'rango') {
    fechaDesde = fechaDesdeInput || null;
    fechaHasta = fechaHastaInput || null;
  }
  // periodo === 'todos' -> sin límites de fecha

  const desde = (paginaActualFacturas - 1) * ITEMS_POR_PAGINA_FACTURAS;

  const { data, error } = await sb.rpc('fn_facturas_lista', {
    p_busqueda: busq || null,
    p_estado: filtroEstado || null,
    p_fecha_desde: fechaDesde,
    p_fecha_hasta: fechaHasta,
    p_limit: ITEMS_POR_PAGINA_FACTURAS,
    p_offset: desde,
  });

  if (error) {
    console.error(error);
    window.mostrarEstadoVacio('tabla-body', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
      titulo: 'No se pudieron cargar las facturas',
      descripcion: 'Ocurrió un error al consultar las facturas. Intenta nuevamente.',
    });
    return;
  }

  filtradas = (data || []).map(f => ({
    ...f,
    clientes: (f.cliente_razon_social || f.cliente_telefono || f.cliente_email)
      ? { id: f.cliente_id, razon_social: f.cliente_razon_social, telefono: f.cliente_telefono, email: f.cliente_email }
      : null,
  }));
  facturas = filtradas; // misma referencia: abrirModal/verPdf/etc. siguen usando `facturas.find(...)` sobre la página actual
  totalFacturasFiltradas = data?.[0]?.total_count || 0;

  renderTabla();
  actualizarControlesPaginacionFacturas();
}

function fechaLocalISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Paginación ──────────────────────────────────────────────────────────
function inyectarControlesPaginacionFacturas() {
  if (document.getElementById('paginacion-facturas')) return; // ya existe
  const contenedor = document.getElementById('panel-facturas') || document.body;
  const div = document.createElement('div');
  div.id = 'paginacion-facturas';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-facturas" class="btn-pag" onclick="cambiarPaginaFacturas(-1)">Anterior</button>
      <span id="info-pag-facturas">Página 1</span>
      <button id="btn-next-facturas" class="btn-pag" onclick="cambiarPaginaFacturas(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionFacturas() {
  const totalPaginas = Math.max(1, Math.ceil(totalFacturasFiltradas / ITEMS_POR_PAGINA_FACTURAS));
  const info = document.getElementById('info-pag-facturas');
  if (info) info.textContent = `Página ${paginaActualFacturas} de ${totalPaginas} (${totalFacturasFiltradas} comprobantes)`;
  const btnPrev = document.getElementById('btn-prev-facturas');
  const btnNext = document.getElementById('btn-next-facturas');
  if (btnPrev) btnPrev.disabled = paginaActualFacturas <= 1;
  if (btnNext) btnNext.disabled = paginaActualFacturas >= totalPaginas;
}

function cambiarPaginaFacturas(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalFacturasFiltradas / ITEMS_POR_PAGINA_FACTURAS));
  const nueva = paginaActualFacturas + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualFacturas = nueva;
  cargarFacturas();
}
window.cambiarPaginaFacturas = cambiarPaginaFacturas;

// ── KPIs ──────────────────────────────────────────────────────────────────
// FIX auditoría etapa 4: esta función recalculaba los 4 números a partir del
// array `facturas` (la página cargada en pantalla, hasta 200 filas), pese a
// que ya existía `contadoresFacturas` — cargado en init() desde la RPC
// fn_facturas_lista_lista fn_facturas_contadores(), que sí suma sobre TODO
// el universo de facturas de la empresa (migración 262, pensada
// específicamente para que las tarjetas KPI no dependieran de cuántas filas
// hubiera cargadas). La variable se llenaba y quedaba sin usar: las 4
// tarjetas mostraban conteos de la página visible, no de la empresa — con
// 1502 facturas en el tenant demo (200 por página), "pendientes"/"con
// error"/"emitidas del mes" podían estar groseramente subcontados o en cero
// según qué página estuviera cargada.
function actualizarKpis() {
  const c = contadoresFacturas || {};
  const pendientesCant = c.cant_pendientes    ?? 0;
  const errorCant      = c.cant_error_afip    ?? 0;
  const emitidasCant   = c.cant_emitidas_mes  ?? 0;
  const totalMes        = c.monto_emitidas_mes ?? 0;

  document.getElementById('kpi-pendientes').textContent = pendientesCant;
  document.getElementById('kpi-error').textContent      = errorCant;
  document.getElementById('kpi-emitidas').textContent   = emitidasCant;
  document.getElementById('kpi-total').textContent      = formatPeso(totalMes);

  const banner = document.getElementById('banner-error');
  if (errorCant > 0) {
    banner.style.display = 'flex';
    document.getElementById('banner-error-txt').innerHTML =
      `<strong>${errorCant}</strong> factura${errorCant > 1 ? 's' : ''} con error de ARCA. ` +
      `Verificá los datos del cliente o el certificado y reintentá la emisión.`;
  } else {
    banner.style.display = 'none';
  }
}

// ── Filtros ───────────────────────────────────────────────────────────────
// FIX auditoría etapa 4: esta función existía en paralelo a cargarFacturas()
// y hacía exactamente lo que la migración 262 dice haber eliminado —
// filtrar en memoria sobre el recorte cargado en el navegador. Búsqueda,
// selector de estado y período la llamaban a ELLA en vez de a
// cargarFacturas() (la que sí pega contra fn_facturas_lista con los
// filtros aplicados en SQL). Se eliminó: los tres disparadores ahora llaman
// directo a cargarFacturas() reseteando a página 1 — ver el listener de
// input-busqueda en init(), selFiltroEstado() y onFiltroPeriodo() abajo.
function aplicarFiltros() {
  paginaActualFacturas = 1;
  cargarFacturas();
}

// FIX (bug real, no solo de UX): las tarjetas de estado (Pendientes/
// Emitidas/Con error/Anuladas) cuentan sobre TODO el historial de la
// empresa (fn_facturas_contadores no tiene filtro de fecha), pero la
// tabla de abajo seguía respetando el período elegido en el otro filtro
// ("Este mes" por defecto). Resultado: el botón "Con error" podía decir
// "1" y la tabla mostrar "Sin facturas" si esa factura era de un mes
// anterior — los dos filtros se combinan con Y, no reemplazan uno al
// otro. Al elegir un estado específico, se pasa a "Todo el historial"
// para que la tabla siempre pueda mostrar lo que el número promete.
function selFiltroEstado(estado, btn) {
  filtroEstado = estado;
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));

  const pillCorrespondiente = document.querySelector(`.e-pill[data-f="${estado}"]`);
  if (pillCorrespondiente) pillCorrespondiente.classList.add('activa');

  if (estado) {
    const selPeriodo = document.getElementById('filtro-periodo');
    if (selPeriodo && selPeriodo.value !== 'todos') {
      selPeriodo.value = 'todos';
      const wrap = document.getElementById('filtro-rango-wrap');
      if (wrap) wrap.style.display = 'none';
    }
  }

  aplicarFiltros();
}

function onFiltroPeriodo() {
  const val = document.getElementById('filtro-periodo').value;
  const wrap = document.getElementById('filtro-rango-wrap');
  if (wrap) wrap.style.display = val === 'rango' ? 'flex' : 'none';
  aplicarFiltros();
}

function limpiarFiltros() {
  document.getElementById('input-busqueda').value = '';
  document.getElementById('filtro-periodo').value = 'mes';
  const wrap = document.getElementById('filtro-rango-wrap');
  if (wrap) {
    wrap.style.display = 'none';
    document.getElementById('filtro-fecha-desde').value = '';
    document.getElementById('filtro-fecha-hasta').value = '';
  }
  selFiltroEstado('', document.querySelector('.e-pill[data-f=""]'));
}

// ── Render tabla ──────────────────────────────────────────────────────────
function renderTabla() {
  const tbody = document.getElementById('tabla-body');
  if (!tbody) return;

  if (filtradas.length === 0) {
    window.mostrarEstadoVacio('tabla-body', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
      titulo: 'Sin facturas',
      descripcion: 'No se encontraron facturas con los filtros aplicados.',
    });
    return;
  }

  window.renderTbody(tbody, filtradas, (f) => {
    const cliente  = f.clientes?.razon_social || '—';
    const numero   = f.numero ? `${f.tipo || 'B'} ${f.numero}` : `${f.tipo || 'B'} (sin número)`;
    const pedidoRef = f.pedido_id ? `Pedido #${f.pedido_id.substring(0,8)}` : '—';
    const cae      = f.cae || '—';
    const caeVto   = f.cae_vto
      ? new Date(f.cae_vto).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
      : null;
    const vencimiento = f.vencimiento
      ? new Date(f.vencimiento).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
      : '—';
    const vencido  = f.vencimiento && f.estado === 'emitida' && new Date(f.vencimiento) < new Date();
    const fecha    = f.fecha_emision
      ? new Date(f.fecha_emision).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
      : '—';
    const total    = formatPeso(f.total);
    const est      = estadoInfo(f.estado);

    // Fila de acciones canónica (texto + kebab, patrón Productos/Stock/
    // cc-proveedores): "Ver" siempre visible como botón de texto; las
    // acciones secundarias (Reintentar emisión / Ver PDF, mutuamente
    // excluyentes según el estado) van en el menú "⋮" flotante compartido
    // — ver iniciarMenuAccionesFactura() más abajo.
    const tieneSecundaria = f.estado === 'pendiente' || f.estado === 'error_afip' || f.estado === 'emitida' || f.estado === 'anulada';
    const acciones = `
      <span class="fila-acciones">
        <button type="button" class="btn-tabla" onclick="abrirModal('${f.id}'); event.stopPropagation();">Ver</button>
        ${tieneSecundaria ? `<button type="button" class="btn-kebab btn-kebab-factura" data-factura-id="${f.id}" data-estado="${f.estado}" title="Más acciones" aria-label="Más acciones" aria-haspopup="menu" aria-expanded="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>` : ''}
      </span>`;

    return `
      <tr class="fila-factura" data-testid="factura-fila" data-id="${f.id}" onclick="if (!event.target.closest('.fila-acciones')) abrirModal('${f.id}')">
        <td class="td-comprobante" data-label="Comprobante">
          <span class="factura-numero">${numero}</span>
          <span class="factura-pedido">${pedidoRef}</span>
        </td>
        <td class="td-cliente" data-label="Cliente">${escHtml(cliente)}</td>
        <td class="td-text" data-label="Fecha emisión">${fecha}</td>
        <td class="td-cae" data-label="CAE">${cae}${caeVto ? `<br><span class="factura-pedido">CAE vto ${caeVto}</span>` : ''}</td>
        <td class="td-text" data-label="Vencimiento" style="${vencido ? 'color:var(--color-danger,#7A2820);font-weight:600;' : ''}">${vencimiento}</td>
        <td class="td-total" data-label="Total">${total}</td>
        <td data-label="Estado">${ComponentesAdmin.renderBadgeEstado(est.label, est.variante)}</td>
        <td class="col-sticky-end" data-label="Acciones">${acciones}</td>
      </tr>`;
  }, 8, 'No se encontraron facturas con esos filtros. Las facturas se generan automáticamente al confirmar un pedido o cerrar una venta en el POS.'); // 8 es el colspan para la tabla de facturas (agregado: columna Vencimiento)
}

// ── Menú "⋮" de acciones secundarias por fila (Reintentar emisión / Ver PDF) ──
// Un solo menú flotante compartido, reposicionado por JS — mismo patrón que
// el piloto cc-proveedores (ver PLAN_UNIFICACION_UX_ADMIN.md §2 y §5).
(function iniciarMenuAccionesFactura() {
  const menu = document.getElementById('menu-acciones-factura');
  if (!menu) return;

  const cerrar = () => {
    menu.hidden = true;
    document.querySelectorAll('.btn-kebab-factura[aria-expanded="true"]')
      .forEach(b => b.setAttribute('aria-expanded', 'false'));
  };

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.btn-kebab-factura');
    if (!btn) { if (!ev.target.closest('#menu-acciones-factura')) cerrar(); return; }
    ev.stopPropagation();

    const yaAbiertoParaEsteBtn = !menu.hidden && menu.dataset.facturaId === btn.dataset.facturaId;
    cerrar();
    if (yaAbiertoParaEsteBtn) return;

    const facturaId = btn.dataset.facturaId;
    const estado = btn.dataset.estado;
    const items = [];
    if (estado === 'pendiente' || estado === 'error_afip') {
      items.push(`<button type="button" class="dropdown-item" role="menuitem" id="btn-reintentar-${facturaId}" onclick="reintentar('${facturaId}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        Reintentar emisión
      </button>`);
    }
    if (estado === 'emitida' || estado === 'anulada') {
      items.push(`<button type="button" class="dropdown-item" role="menuitem" id="btn-pdf-${facturaId}" onclick="verPdf('${facturaId}', event)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Ver / descargar PDF
      </button>`);
    }
    if (!items.length) return;

    menu.innerHTML = items.join('');
    menu.dataset.facturaId = facturaId;

    const r = btn.getBoundingClientRect();
    menu.style.top   = `${r.bottom + 4}px`;
    menu.style.left  = 'auto';
    menu.style.right = `${window.innerWidth - r.right}px`;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });

  menu.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target.closest('.dropdown-item')) cerrar();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') cerrar(); });
  window.addEventListener('resize', cerrar);
  document.getElementById('tabla-body')?.addEventListener('scroll', cerrar);
})();

function estadoInfo(estado) {
  const map = {
    pendiente:  { label: 'Pendiente',   variante: 'pendiente' },
    emitida:    { label: 'Emitida',     variante: 'ok' },
    error_afip: { label: 'Error ARCA',  variante: 'critico' },
    anulada:    { label: 'Anulada',     variante: 'inactivo' },
  };
  return map[estado] || { label: estado, variante: 'inactivo' };
}

// ── Modal de detalle ──────────────────────────────────────────────────────
function abrirModal(facturaId) {
  const f = facturas.find(x => x.id === facturaId);
  if (!f) return;

  modalFacturaId = facturaId;

  const numero = f.numero ? `${f.tipo || 'B'} ${f.numero}` : `Comprobante tipo ${f.tipo || 'B'}`;
  document.getElementById('modal-titulo').textContent    = numero;
  document.getElementById('modal-subtitulo').textContent = f.clientes?.razon_social || '';

  // Estado (usa la variante canónica, no el estado crudo: badge-pendiente/
  // badge-emitida/badge-error_afip/badge-anulada no existen en el componente
  // canónico, las variantes válidas son ok/critico/inactivo/pendiente)
  const est = estadoInfo(f.estado);
  document.getElementById('modal-estado-box').innerHTML = `
    <span class="badge-estado badge-${est.variante}" style="font-size:13px;padding:5px 14px">
      <span class="badge-dot"></span>${est.label}
    </span>`;

  // Error AFIP
  const errSeccion = document.getElementById('modal-error-seccion');
  if (f.estado === 'error_afip') {
    errSeccion.style.display = 'flex';
    document.getElementById('modal-error-box').innerHTML = `
      <strong>No se pudo emitir el comprobante en ARCA</strong>
      ${escHtml(f.notas_error || 'ARCA rechazó la solicitud. Verificá el CUIT del cliente, el punto de venta y la vigencia del certificado, y reintentá.')}
    `;
  } else {
    errSeccion.style.display = 'none';
  }

  // Datos
  document.getElementById('md-cliente').textContent = f.clientes?.razon_social || '—';
  document.getElementById('md-pedido').textContent  = f.pedido_id ? `#${f.pedido_id.substring(0,8)}` : '—';
  document.getElementById('md-numero').textContent  = f.numero ? `${f.tipo || 'B'} — ${f.numero}` : `Tipo ${f.tipo || 'B'} (sin asignar)`;
  document.getElementById('md-cae').textContent     = f.cae || '—';
  document.getElementById('md-cae-vto').textContent = f.cae_vto
    ? new Date(f.cae_vto).toLocaleDateString('es-AR') : '—';
  document.getElementById('md-fecha').textContent   = f.fecha_emision
    ? new Date(f.fecha_emision).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' }) : '—';
  document.getElementById('md-vencimiento').textContent = f.vencimiento
    ? new Date(f.vencimiento).toLocaleDateString('es-AR') : '—';

  // Importes
  document.getElementById('md-neto').textContent  = formatPeso(f.neto);
  document.getElementById('md-iva').textContent   = formatPeso(f.iva);
  document.getElementById('md-total').textContent = formatPeso(f.total);

  // Cobrado / saldo
  const cobrado = Number(f.total_cobrado || 0);
  const saldo   = Number(f.total || 0) - cobrado;
  document.getElementById('md-cobrado').textContent = formatPeso(cobrado);
  const saldoEl = document.getElementById('md-saldo');
  saldoEl.textContent = formatPeso(saldo);
  saldoEl.style.color = saldo <= 0 ? 'var(--color-success, #487050)' : saldo < Number(f.total) ? 'var(--color-warning, #8A5F13)' : 'var(--color-danger, #7A2820)';

  // Ítems del pedido
  cargarItemsFactura(f);

  // Reset confirmación de anulación
  document.getElementById('confirm-anular-seccion').style.display = 'none';
  document.getElementById('motivo-anulacion').value = '';

  renderAcciones(f);

  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-detalle').classList.add('open');
  document.body.style.overflow = 'hidden';
}

async function cargarItemsFactura(f) {
  const seccion = document.getElementById('md-items-seccion');
  const lista   = document.getElementById('md-items-lista');
  if (!seccion || !lista) return;

  if (!f.pedido_id) {
    seccion.style.display = 'none';
    return;
  }

  seccion.style.display = 'block';
  lista.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:12px;color:var(--color-text-muted);font-size:12px">Cargando ítems…</td></tr>';

  const { data } = await sb.from('pedido_items')
    .select('cantidad, precio_unitario, descuento_pct, subtotal, productos(nombre, unidad)')
    .eq('pedido_id', f.pedido_id)
    .order('productos(nombre)');

  if (!data?.length) {
    lista.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:10px;color:var(--color-text-muted);font-size:12px">Sin ítems disponibles</td></tr>';
    return;
  }

  lista.innerHTML = data.map(it => `
    <tr style="border-bottom:1px solid var(--color-border)">
      <td style="padding:6px 8px;font-size:12px">${escHtml(it.productos?.nombre || '—')}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:left">${Number(it.cantidad).toLocaleString('es-AR')} ${escHtml(it.productos?.unidad || '')}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:left">${formatPeso(it.precio_unitario)}${Number(it.descuento_pct) > 0 ? ` <span style="color:var(--color-success,#487050);font-size:10px">-${it.descuento_pct}%</span>` : ''}</td>
      <td style="padding:6px 8px;font-size:12px;text-align:left;font-weight:600">${formatPeso(it.subtotal)}</td>
    </tr>`).join('');
}

async function enviarEmailFactura(facturaId) {
  const f = facturas.find(x => x.id === facturaId);
  if (!f?.pdf_url) {
    window.toast('Primero generá el PDF para poder enviar la factura');
    return;
  }
  const email = f.clientes?.email;
  if (!email) {
    window.toast('El cliente no tiene email registrado');
    return;
  }
  const btn = document.getElementById('btn-email-factura');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch('/api/facturas/enviar-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ factura_id: facturaId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al enviar');
    window.toast(`Factura enviada a ${email}`);
  } catch (err) {
    console.error('[facturacion] enviar email falló:', err);
    window.toast('No se pudo enviar el email');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar por email'; }
  }
}


function cerrarModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-detalle').classList.remove('open');
  document.body.style.overflow = '';
  modalFacturaId = null;
}

function renderAcciones(f) {
  const cont = document.getElementById('modal-acciones');

  if (f.estado === 'pendiente' || f.estado === 'error_afip') {
    cont.innerHTML = `
      <button class="btn-secundario" onclick="cerrarModal()">Cerrar</button>
      <button class="btn-primario" id="btn-modal-reintentar" onclick="reintentar('${f.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        Reintentar emisión
      </button>`;
    return;
  }

  if (f.estado === 'emitida') {
    const tieneEmail = f.clientes?.email;
    cont.innerHTML = `
      <button class="btn-primario" id="btn-pdf-modal" onclick="verPdf('${f.id}', event)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Ver / descargar PDF
      </button>
      ${tieneEmail ? `<button class="btn-secundario" id="btn-email-factura" onclick="enviarEmailFactura('${f.id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        Enviar por email
      </button>` : ''}
      <button class="btn-anular" onclick="mostrarConfirmAnular()">Anular</button>`;
    return;
  }

  // Anulada
  cont.innerHTML = `
    <button class="btn-primario" id="btn-pdf-modal" onclick="verPdf('${f.id}', event)">Ver / descargar PDF</button>
    <button class="btn-secundario" onclick="cerrarModal()">Cerrar</button>`;
}

function mostrarConfirmAnular() {
  document.getElementById('confirm-anular-seccion').style.display = 'flex';
  const cont = document.getElementById('modal-acciones');
  cont.innerHTML = `
    <button class="btn-secundario" onclick="cerrarModal()">Cancelar</button>
    <button class="btn-anular" id="btn-confirmar-anular" onclick="anular('${modalFacturaId}')">
      Confirmar anulación
    </button>`;
}

// ── Ver/descargar PDF ────────────────────────────────────────────────────
// El PDF normalmente ya está listo (lib/facturas.js lo genera en background
// apenas se emite el comprobante), pero por si la generación en background
// todavía no corrió o falló, este botón siempre funciona: si no hay pdf_url
// en caché, le pega a GET /api/facturas?accion=pdf, que regenera el PDF al
// toque con pdfkit y devuelve la URL — la facturación es lo más importante
// del sistema, así que esto no puede ser un callejón sin salida.
async function verPdf(facturaId, ev) {
  if (ev) ev.stopPropagation();

  const f = facturas.find(x => x.id === facturaId);
  if (f?.pdf_url) {
    window.open(f.pdf_url, '_blank', 'noopener');
    return;
  }

  const btn = ev?.currentTarget;
  const htmlOriginal = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = btn.id === 'btn-pdf-modal' ? 'Generando PDF…' : '…'; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`/api/facturas?id=${facturaId}&accion=pdf`, {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.url) {
      window.toast(data.error || 'No se pudo generar el PDF del comprobante');
      return;
    }

    if (f) f.pdf_url = data.url; // cachear en memoria para no regenerarlo de nuevo
    window.open(data.url, '_blank', 'noopener');
  } catch (err) {
    console.error(err);
    window.toast('Error de conexión al generar el PDF');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = htmlOriginal; }
  }
}

// ── Reintentar emisión ────────────────────────────────────────────────────
async function reintentar(facturaId) {
  if (accionEnCurso) return;
  accionEnCurso = true;

  const btnFila   = document.getElementById(`btn-reintentar-${facturaId}`);
  const btnModal  = document.getElementById('btn-modal-reintentar');
  [btnFila, btnModal].forEach(b => {
    if (!b) return;
    b.disabled = true;
    b.classList.add('spin');
  });

  try {
    const { data: { session } } = await sb.auth.getSession();

    const res = await fetch('/api/facturas/reintentar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ factura_id: facturaId }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (data?.codigo === 'sin_configuracion_facturacion') {
        const ir = await window.confirmar(
          'Todavía no configuraste la facturación electrónica (ARCA/AFIP) de esta empresa.<br><br>' +
          'Necesitás cargar el CUIT, el punto de venta y el certificado antes de poder emitir comprobantes.',
          { labelOk: 'Ir a configurar', labelCancel: 'Cerrar' }
        );
        if (ir) window.location.href = '/admin/facturacion-config';
      } else {
        window.toast(data.error || 'ARCA volvió a rechazar el comprobante');
      }
    } else {
      window.toast('Factura emitida correctamente');
      sb.rpc('registrar_auditoria', {
        p_tabla: 'facturas', p_accion: 'UPDATE',
        p_registro_id: facturaId, p_datos_despues: { accion: 'reintentar' },
      }).then(() => {}, () => {});
    }

    await Promise.all([cargarFacturas(), cargarContadoresFacturas()]);
    if (modalFacturaId === facturaId) {
      const actualizada = facturas.find(x => x.id === facturaId);
      if (actualizada) abrirModal(facturaId); else cerrarModal();
    }

  } catch (err) {
    console.error(err);
    window.toast('Error de conexión al reintentar');
  } finally {
    accionEnCurso = false;
    [btnFila, btnModal].forEach(b => {
      if (!b) return;
      b.disabled = false;
      b.classList.remove('spin');
    });
  }
}

// ── Anular factura ────────────────────────────────────────────────────────
async function anular(facturaId) {
  if (accionEnCurso) return;

  const motivo = document.getElementById('motivo-anulacion').value.trim();
  if (!motivo) { window.toast('Indicá el motivo de la anulación'); return; }

  accionEnCurso = true;
  const btn = document.getElementById('btn-confirmar-anular');
  if (btn) { btn.disabled = true; btn.textContent = 'Anulando...'; }

  try {
    const { data: { session } } = await sb.auth.getSession();

    // Timeout explícito: la emisión AFIP puede tardar >30s (límite Hobby de Vercel).
    // Si la conexión se corta, la operación puede haber terminado igual en el backend.
    // Por eso usamos AbortController con 45s y tratamos el abort como "verificar estado".
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 45_000);

    let res, data;
    try {
      res  = await fetch('/api/facturas/anular', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ factura_id: facturaId, motivo }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      data = await res.json();
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      // Timeout o corte de red: la NC puede haberse emitido igual en ARCA.
      // Recargamos y mostramos mensaje acorde en lugar de "Error de conexión".
      console.warn('[anular] Timeout o corte de red — verificando estado en BD...', fetchErr.message);
      cerrarModal();
      await Promise.all([cargarFacturas(), cargarContadoresFacturas()]);
      window.toast('La operación tardó más de lo esperado. Verificá el estado en la lista.');
      return;
    }

    if (!res.ok) {
      window.toast(data.error || 'No se pudo anular el comprobante');
      return;
    }

    window.toast('Comprobante anulado y nota de crédito generada');
    sb.rpc('registrar_auditoria', {
      p_tabla: 'facturas', p_accion: 'UPDATE',
      p_registro_id: facturaId, p_datos_despues: { accion: 'anular', motivo },
    }).then(() => {}, () => {});
    cerrarModal();
    await Promise.all([cargarFacturas(), cargarContadoresFacturas()]);

  } catch (err) {
    console.error(err);
    window.toast('Error de conexión al anular');
  } finally {
    accionEnCurso = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar anulación'; }

  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function formatPeso(n) {
  return '$\u202F' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function escHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js). Antes
  // esta copia no escapaba comillas de ningún tipo.
  return window.sanitize(s);
}

async function cerrarSesion() {
  await sb.auth.signOut();
  window.location.href = '/admin/login';
}

// ── Arranque ──────────────────────────────────────────────────────────────
window.authReady.then(() => init()).catch((err) => {
  console.error('[facturacion] authReady falló:', err?.message);
  if (!window.authCtx || !window.authCtx.perfil) {
    window.location.href = '/admin/login';
  }
});