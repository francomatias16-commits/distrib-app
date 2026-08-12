// frontend/admin/js/devoluciones.js — Innovación #2 (roadmap-innovaciones-distrib.md)
// Panel admin para revisar devoluciones registradas por el chofer.
// Backend: lib/handlers/pedidos.js → handleDevolucionesAdmin()
//   GET   /api/admin/devoluciones?accion=listar
//   GET   /api/admin/devoluciones?id=uuid
//   PATCH /api/admin/devoluciones  { accion: 'revisar', id, estado }

const ROLES_REVISION = ['dueno', 'admin', 'contador'];

let devolucionesPagina = [];   // solo la página actual (ver paginación abajo)
let devolucionActiva  = null;

// ── Estado para alta manual / selects auxiliares ───────────────────────────
let sb          = null;
let empresaId    = null;
let depositos    = [];         // para el selector de depósito al aprobar
let clientesCache = [];        // para el <select> de cliente en el alta manual
let ndItems      = [];         // ítems agregados en el modal de alta manual
let ndPicker     = null;       // instancia de ProductoPicker

// Paginación real (antes: se traían hasta 200 devoluciones sin filtro de
// búsqueda/motivo server-side —solo `estado` estaba soportado y el
// frontend ni lo mandaba— y se filtraba con Array.filter() en cada tecla,
// sin debounce; confirmado en AUDITORIA_FILTROS_v280 §5).
let paginaActualDevoluciones = 1;
const ITEMS_POR_PAGINA_DEVOLUCIONES = 50;
let totalDevolucionesFiltradas = 0;
let debounceBusquedaDevoluciones = null;

// ── Helper de fetch autenticado contra nuestro propio backend ─────────────
async function api(path, opts = {}) {
  const sess = (await window.authCtx.sb.auth.getSession()).data.session;
  if (!sess) return null;
  const r = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${sess.access_token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return r.json();
}

document.addEventListener('DOMContentLoaded', () => {
  window.authReady
    .then(() => init())
    .catch((err) => {
      console.error('[auth] authReady falló:', err?.message);
      if (!window.authCtx || !window.authCtx.perfil) window.location.href = '/admin/login';
    });
});

async function init() {
  const hoy = new Date();
  const elFechaTopbar = document.getElementById('topbar-fecha');
  if (elFechaTopbar) {
    elFechaTopbar.textContent =
      hoy.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const user = window.authCtx?.perfil;
  if (!user) return;
  document.getElementById('topbar-usuario').textContent = user.nombre || user.email;

  sb       = window.authCtx.sb;
  empresaId = window.authCtx.perfil?.empresa_id;

  initFiltroTabsDevoluciones();
  await cargarDevoluciones();
  await cargarKPIs();
  try { inyectarControlesPaginacionDevoluciones(); } catch (e) { console.warn('[devoluciones] paginacion init:', e.message); }
  try { await cargarDepositos(); } catch (e) { console.warn('[devoluciones] depositos init:', e.message); }
  try { await cargarClientes(); } catch (e) { console.warn('[devoluciones] clientes init:', e.message); }
}

// ── Depósitos (para el selector al aprobar) ────────────────────────────────
async function cargarDepositos() {
  if (!sb || !empresaId) return;
  const { data } = await sb.from('depositos').select('id, nombre, es_principal').eq('empresa_id', empresaId);
  depositos = data || [];
}

// ── Clientes (para el <select> del alta manual) ────────────────────────────
async function cargarClientes() {
  if (!sb || !empresaId) return;
  const { data } = await sb.from('clientes')
    .select('id, razon_social, nombre_fantasia')
    .eq('empresa_id', empresaId)
    .order('razon_social');
  clientesCache = data || [];
  const sel = document.getElementById('nd-cliente');
  if (!sel) return;
  sel.innerHTML = '<option value="">Seleccionar cliente...</option>' +
    clientesCache.map(c => `<option value="${c.id}">${s(c.nombre_fantasia || c.razon_social)}</option>`).join('');
}

// ── Listado ─────────────────────────────────────────────────────────────
async function cargarDevoluciones() {
  try {
    const q      = document.getElementById('buscar-dev').value.trim();
    const estado = document.getElementById('filtro-estado').value;
    const motivo = document.getElementById('filtro-motivo').value;
    const fDesde = document.getElementById('filtro-fecha-desde')?.value || '';
    const fHasta = document.getElementById('filtro-fecha-hasta')?.value || '';

    const params = new URLSearchParams({
      accion: 'listar',
      page:   paginaActualDevoluciones,
      limit:  ITEMS_POR_PAGINA_DEVOLUCIONES,
    });
    if (q)      params.set('q', q);
    if (estado) params.set('estado', estado);
    if (motivo) params.set('motivo', motivo);
    if (fDesde) params.set('fecha_desde', fDesde);
    if (fHasta) params.set('fecha_hasta', fHasta);

    const data = await api(`/api/admin/devoluciones?${params.toString()}`);
    devolucionesPagina = data?.devoluciones || [];
    totalDevolucionesFiltradas = data?.total ?? devolucionesPagina.length;
    renderTabla(devolucionesPagina);
    actualizarControlesPaginacionDevoluciones();
  } catch (e) {
    console.error(e);
    mostrarToast('No se pudieron cargar las devoluciones', 'err');
    const tbody = document.getElementById('tbody-devoluciones');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No se pudieron cargar las devoluciones. Recargá la página o intentá de nuevo en unos minutos.</div></td></tr>`;
    }
  }
}

// KPIs globales (pendientes/aprobadas/rechazadas) — independientes de la
// búsqueda/página actual de la tabla, igual que en Puntos/Cta-cte.
async function cargarKPIs() {
  try {
    const data = await api('/api/admin/devoluciones?accion=kpis');
    const pendientes = data?.pendientes || 0;
    const aprobadas  = data?.aprobadas  || 0;
    const rechazadas = data?.rechazadas || 0;
    FiltroTabs.actualizarContadores(document.getElementById('filtro-tabs-devoluciones'), {
      todas: pendientes + aprobadas + rechazadas,
      pendiente: pendientes,
      aprobada: aprobadas,
      rechazada: rechazadas,
    });
  } catch (e) {
    console.warn('[Devoluciones] no se pudieron cargar los KPIs:', e.message);
  }
}

function initFiltroTabsDevoluciones() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-devoluciones'), [
    { key: 'todas',      label: 'Todas' },
    { key: 'pendiente',  label: 'Pendientes de revisión' },
    { key: 'aprobada',   label: 'Aprobadas' },
    { key: 'rechazada',  label: 'Rechazadas' },
  ], 'todas', (key) => {
    document.getElementById('filtro-estado').value = key === 'todas' ? '' : key;
    paginaActualDevoluciones = 1;
    cargarDevoluciones();
  });
}

function renderTabla(lista) {
  const tbody = document.getElementById('tbody-devoluciones');
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No hay devoluciones registradas todavía. Se cargan desde el detalle de un pedido entregado.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(d => {
    const cliente = d.clientes?.nombre_fantasia || d.clientes?.razon_social || '—';
    return `<tr data-testid="dev-fila" data-id="${d.id}" onclick="abrirDetalle('${d.id}')">
      <td>${formatFecha(d.created_at)}</td>
      <td>${s(cliente)}</td>
      <td>${s(motivoLabel(d.motivo))}</td>
      <td>${d.foto_url
        ? `<a href="${d.foto_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Ver foto"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></a>`
        : '<span style="color:var(--color-text-light)">—</span>'}</td>
      <td>${chipEstado(d.estado)}</td>
      <td class="col-sticky-end">
        <button class="btn-icon" title="Ver detalle" onclick="event.stopPropagation(); abrirDetalle('${d.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
}

function filtrarDevoluciones() {
  clearTimeout(debounceBusquedaDevoluciones);
  debounceBusquedaDevoluciones = setTimeout(() => {
    paginaActualDevoluciones = 1;
    cargarDevoluciones();
  }, 250);
}

// ── Paginación ────────────────────────────────────────────────────────────
function inyectarControlesPaginacionDevoluciones() {
  if (document.getElementById('paginacion-devoluciones')) return; // ya existe
  const contenedor = document.querySelector('.tabla-wrap') || document.body;
  const div = document.createElement('div');
  div.id = 'paginacion-devoluciones';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-dev" class="btn-pag" onclick="cambiarPaginaDevoluciones(-1)">Anterior</button>
      <span id="info-pag-dev">Página 1</span>
      <button id="btn-next-dev" class="btn-pag" onclick="cambiarPaginaDevoluciones(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionDevoluciones() {
  const totalPaginas = Math.max(1, Math.ceil(totalDevolucionesFiltradas / ITEMS_POR_PAGINA_DEVOLUCIONES));
  const info = document.getElementById('info-pag-dev');
  if (info) info.textContent = `Página ${paginaActualDevoluciones} de ${totalPaginas} (${totalDevolucionesFiltradas} devoluciones)`;
  const btnPrev = document.getElementById('btn-prev-dev');
  const btnNext = document.getElementById('btn-next-dev');
  if (btnPrev) btnPrev.disabled = paginaActualDevoluciones <= 1;
  if (btnNext) btnNext.disabled = paginaActualDevoluciones >= totalPaginas;
}

window.cambiarPaginaDevoluciones = function (delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalDevolucionesFiltradas / ITEMS_POR_PAGINA_DEVOLUCIONES));
  const nueva = paginaActualDevoluciones + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualDevoluciones = nueva;
  cargarDevoluciones();
};

// ── Panel de detalle ────────────────────────────────────────────────────
async function abrirDetalle(id) {
  document.getElementById('panel-dev-titulo').textContent = 'Cargando...';
  document.getElementById('panel-dev-body').innerHTML =
    '<div style="padding:20px;color:var(--color-text-muted);font-size:13px">Cargando devolución...</div>';
  document.getElementById('panel-dev-footer').innerHTML = '';
  document.getElementById('panel-devolucion').classList.add('open');

  try {
    const dev = await api(`/api/admin/devoluciones?id=${id}`);
    if (!dev || dev.error) throw new Error(dev?.error || 'No se pudo cargar la devolución');
    devolucionActiva = dev;
    renderPanel(dev);
  } catch (e) {
    console.error(e);
    document.getElementById('panel-dev-body').innerHTML =
      `<div class="alerta-inline danger">No pudimos cargar esta devolución. Probá de nuevo en un momento.</div>`;
  }
}

function cerrarPanel() {
  document.getElementById('panel-devolucion').classList.remove('open');
  devolucionActiva = null;
}

function renderPanel(d) {
  const cliente = d.clientes?.nombre_fantasia || d.clientes?.razon_social || '—';
  document.getElementById('panel-dev-titulo').textContent = cliente;

  const items = d.devolucion_items || [];
  const pendientePararevisar = d.estado === 'pendiente';
  const filasItems = items.map(it => `
    <div class="detalle-fila">
      <span class="detalle-fila-label">
        ${pendientePararevisar ? `<input type="checkbox" class="chk-item-reponer" data-item-id="${it.id}" checked style="margin-right:6px">` : ''}
        ${s(it.productos?.nombre || '—')} <span style="color:var(--color-text-light)">(${s(it.productos?.codigo || '—')})</span>
      </span>
      <span class="detalle-fila-val">${it.cantidad} × ${formatPeso(it.precio_unitario)}</span>
    </div>`).join('') || '<p style="color:var(--color-text-muted);font-size:13px">Sin ítems.</p>';

  const notasDebito = d.notas_debito || [];
  const seccionNotasDebito = notasDebito.length ? `
    <div class="detalle-seccion">
      <h4>Notas de débito al proveedor</h4>
      ${notasDebito.map(nd => `
        <div class="detalle-fila">
          <span class="detalle-fila-label">${s(nd.proveedores?.razon_social || '—')} <span style="color:var(--color-text-light)">(${s(nd.estado)})</span></span>
          <span class="detalle-fila-val">${formatPeso(nd.monto)}</span>
        </div>`).join('')}
    </div>` : '';

  document.getElementById('panel-dev-body').innerHTML = `
    <div class="detalle-seccion">
      <h4>Datos generales</h4>
      <div class="detalle-fila"><span class="detalle-fila-label">Fecha</span><span class="detalle-fila-val">${formatFecha(d.created_at)}</span></div>
      <div class="detalle-fila"><span class="detalle-fila-label">Motivo</span><span class="detalle-fila-val">${s(motivoLabel(d.motivo))}</span></div>
      <div class="detalle-fila"><span class="detalle-fila-label">Estado</span><span class="detalle-fila-val">${chipEstado(d.estado)}</span></div>
      ${d.foto_url ? `<div style="margin-top:8px"><a href="${d.foto_url}" target="_blank" rel="noopener"><img src="${d.foto_url}" alt="Foto de la devolución" style="width:100%;max-height:220px;object-fit:cover;border-radius:var(--radius-md);border:1px solid var(--color-border)"></a></div>` : ''}
    </div>
    <div class="detalle-seccion">
      <h4>Ítems devueltos</h4>
      ${filasItems}
    </div>
    ${seccionNotasDebito}
    <div class="detalle-seccion">
      <h4>Notas internas</h4>
      <textarea id="panel-notas-edit" rows="2" style="width:100%" placeholder="Sin notas...">${d.notas || ''}</textarea>
      <button type="button" class="btn btn--ghost" style="margin-top:6px;font-size:12px;padding:4px 10px" onclick="guardarNotasDevolucion()">Guardar notas</button>
    </div>
  `;

  renderFooter(d);
}

function renderFooter(d) {
  const footer = document.getElementById('panel-dev-footer');
  const rol = window.authCtx?.perfil?.rol;

  if (d.estado !== 'pendiente') {
    footer.innerHTML = `<span style="font-size:12px;color:var(--color-text-muted)">Ya revisada — ${chipEstado(d.estado)}</span>`;
    return;
  }

  const btnEliminar = ['dueno', 'admin'].includes(rol)
    ? `<button class="btn btn--ghost" style="margin-right:auto;color:var(--color-danger)" onclick="eliminarDevolucion()">Eliminar</button>`
    : '';

  if (!ROLES_REVISION.includes(rol)) {
    footer.innerHTML = `
      <div style="display:flex;align-items:center;width:100%">
        ${btnEliminar}
        <span style="font-size:12px;color:var(--color-text-muted)">Tu rol no tiene permiso para revisar devoluciones.</span>
      </div>`;
    return;
  }

  const opcionesDeposito = depositos.map(dep =>
    `<option value="${dep.id}" ${dep.es_principal ? 'selected' : ''}>${s(dep.nombre)}${dep.es_principal ? ' (principal)' : ''}</option>`
  ).join('');

  footer.innerHTML = `
    <div style="display:flex;width:100%;align-items:center">${btnEliminar}</div>
    <div class="detalle-panel-opciones" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;font-size:12px;color:var(--color-text-muted)">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="chk-reponer-stock" checked> Reponer stock — solo los ítems tildados arriba, en:
      </label>
      <select id="sel-deposito-reponer" style="width:100%">${opcionesDeposito}</select>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="chk-generar-nc" checked> Generar nota de crédito para el cliente
      </label>
      <span style="font-size:11px">Solo aplica si aprobás. La NC queda pendiente de emisión en Facturación → Notas de crédito.</span>
    </div>
    <button class="btn btn-danger" onclick="revisarDevolucion('rechazada')">Rechazar</button>
    <button class="btn btn-success" onclick="revisarDevolucion('aprobada')">Aprobar</button>
  `;
}

async function revisarDevolucion(estado) {
  if (!devolucionActiva) return;
  const footer = document.getElementById('panel-dev-footer');
  footer.querySelectorAll('button').forEach(b => b.disabled = true);

  const reponer_stock = estado === 'aprobada' && (document.getElementById('chk-reponer-stock')?.checked ?? false);
  const generar_nc    = estado === 'aprobada' && (document.getElementById('chk-generar-nc')?.checked ?? false);
  const deposito_id   = document.getElementById('sel-deposito-reponer')?.value || null;
  const items_reponer = Array.from(document.querySelectorAll('.chk-item-reponer:checked')).map(el => el.dataset.itemId);

  try {
    const data = await api('/api/admin/devoluciones?accion=revisar', {
      method: 'PATCH',
      body: JSON.stringify({ id: devolucionActiva.id, estado, reponer_stock, generar_nc, deposito_id, items_reponer }),
    });
    if (!data?.ok) throw new Error(data?.error || 'Error al revisar la devolución');

    // FIX (auditoría etapa 9): antes solo mostraba "aprobada/rechazada" sin
    // decir qué había pasado realmente con el stock o la NC — ahora se
    // arma un mensaje según lo que el backend efectivamente hizo.
    const partes = [estado === 'aprobada' ? 'Devolución aprobada' : 'Devolución rechazada'];
    if (data.stock_repuesto?.length) partes.push(`stock repuesto (${data.stock_repuesto.length} ítem(s))`);
    if (data.nota_credito?.id) partes.push('NC generada (pendiente de emisión)');
    if (data.stock_errores?.length) {
      mostrarToast(`${partes.join(', ')}. Atención: ${data.stock_errores.join(' / ')}`, 'err');
    } else {
      mostrarToast(partes.join(', '), 'ok');
    }

    devolucionActiva.estado = estado;
    renderFooter(devolucionActiva);
    await cargarDevoluciones();
    await cargarKPIs();
  } catch (e) {
    console.error(e);
    mostrarToast('No se pudo registrar la revisión. Probá de nuevo.', 'err');
    footer.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}

// ── Exportar CSV ──────────────────────────────────────────────────────────
async function exportarDevolucionesCSV() {
  try {
    const estado = document.getElementById('filtro-estado').value;
    const motivo = document.getElementById('filtro-motivo').value;
    const q      = document.getElementById('buscar-dev').value.trim();
    const fDesde = document.getElementById('filtro-fecha-desde')?.value || '';
    const fHasta = document.getElementById('filtro-fecha-hasta')?.value || '';

    const params = new URLSearchParams({ accion: 'listar', page: 1, limit: 1000 });
    if (q)      params.set('q', q);
    if (estado) params.set('estado', estado);
    if (motivo) params.set('motivo', motivo);
    if (fDesde) params.set('fecha_desde', fDesde);
    if (fHasta) params.set('fecha_hasta', fHasta);

    const data = await api(`/api/admin/devoluciones?${params.toString()}`);
    const lista = data?.devoluciones || [];
    if (!lista.length) { mostrarToast('No hay devoluciones para exportar con estos filtros.', 'info'); return; }

    const cols = ['Fecha', 'Cliente', 'Motivo', 'Estado', 'Notas'];
    const filas = lista.map(d => [
      formatFecha(d.created_at),
      d.clientes?.nombre_fantasia || d.clientes?.razon_social || '',
      motivoLabel(d.motivo),
      d.estado,
      d.notas || '',
    ]);
    const csv = [cols, ...filas]
      .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `devoluciones_${new Date().toISOString().slice(0, 10)}.csv`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    mostrarToast('No se pudo exportar el CSV.', 'err');
  }
}

// ── Alta manual (modal) ─────────────────────────────────────────────────
async function abrirModalNuevaDevolucion() {
  ndItems = [];
  document.getElementById('nd-cliente').value = '';
  document.getElementById('nd-pedido').innerHTML = '<option value="">Sin vincular a un pedido</option>';
  document.getElementById('nd-motivo').value = 'producto_defectuoso';
  document.getElementById('nd-notas').value = '';
  document.getElementById('nd-foto').value = '';
  renderNdItems();

  document.getElementById('modal-backdrop-devolucion').style.display = 'block';
  document.getElementById('modal-nueva-devolucion').style.display = 'block';
  document.body.style.overflow = 'hidden';

  if (!ndPicker) {
    ndPicker = new window.ProductoPicker(document.getElementById('nd-picker-container'), {
      onAgregar(item) {
        const existente = ndItems.find(i => i.producto_id === item.producto_id);
        if (existente) existente.cantidad = (+existente.cantidad || 0) + (+item.cantidad || 1);
        else ndItems.push({
          producto_id: item.producto_id, nombre: item.descripcion,
          cantidad: item.cantidad, precio_unitario: item.precio_unitario,
        });
        renderNdItems();
      },
    });
  }
  await ndPicker.init(sb, empresaId);
  ndPicker.reset();
}

function cerrarModalNuevaDevolucion() {
  document.getElementById('modal-backdrop-devolucion').style.display = 'none';
  document.getElementById('modal-nueva-devolucion').style.display = 'none';
  document.body.style.overflow = '';
}

// Trae los pedidos entregados de un cliente para vincular la devolución
// (opcional — si no se elige ninguno, queda sin pedido de origen).
async function ndCargarPedidosCliente() {
  const clienteId = document.getElementById('nd-cliente').value;
  const sel = document.getElementById('nd-pedido');
  sel.innerHTML = '<option value="">Sin vincular a un pedido</option>';
  if (!clienteId || !sb) return;
  const { data } = await sb.from('pedidos')
    .select('id, created_at, entregado_at')
    .eq('empresa_id', empresaId)
    .eq('cliente_id', clienteId)
    .not('entregado_at', 'is', null)
    .order('entregado_at', { ascending: false })
    .limit(30);
  (data || []).forEach(p => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `Pedido ${p.id.slice(0, 8)} — entregado ${formatFecha(p.entregado_at)}`;
    sel.appendChild(o);
  });
}

function renderNdItems() {
  const cont = document.getElementById('nd-items-container');
  if (!ndItems.length) {
    cont.innerHTML = '<p style="color:var(--color-text-muted);font-size:13px">Sin ítems agregados todavía. Usá el buscador de arriba.</p>';
    return;
  }
  cont.innerHTML = `
    <div style="font-size:11px;color:var(--color-text-muted);display:grid;grid-template-columns:2fr .8fr 1fr 28px;gap:6px;padding:0 2px 4px">
      <span>Producto</span><span>Cant.</span><span>Precio unit.</span><span></span>
    </div>
    ${ndItems.map((it, i) => `
      <div style="display:grid;grid-template-columns:2fr .8fr 1fr 28px;gap:6px;align-items:center;margin-bottom:4px">
        <span style="font-size:13px">${s(it.nombre)}</span>
        <input type="number" min="0.001" step="1" value="${it.cantidad}" style="width:100%"
          onchange="ndActualizarItem(${i}, 'cantidad', this.value)">
        <input type="number" min="0" step="0.01" value="${it.precio_unitario}" style="width:100%"
          onchange="ndActualizarItem(${i}, 'precio_unitario', this.value)">
        <button type="button" class="btn-icon" title="Quitar" onclick="ndQuitarItem(${i})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join('')}`;
}

function ndActualizarItem(i, campo, valor) {
  if (!ndItems[i]) return;
  ndItems[i][campo] = parseFloat(valor) || 0;
}

function ndQuitarItem(i) {
  ndItems.splice(i, 1);
  renderNdItems();
}

// Convierte el <input type=file> a base64 y sube la foto vía el endpoint
// admin (mismo bucket 'devoluciones' que usa el chofer).
async function ndSubirFotoSiCorresponde() {
  const input = document.getElementById('nd-foto');
  const file  = input?.files?.[0];
  if (!file) return null;

  if (file.size > 8 * 1024 * 1024) {
    mostrarToast('La imagen no puede superar 8MB.', 'err');
    throw new Error('imagen demasiado grande');
  }

  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(new Error('No se pudo leer la imagen'));
    r.readAsDataURL(file);
  });

  const data = await api('/api/admin/devoluciones?accion=foto', {
    method: 'POST',
    body: JSON.stringify({ foto_base64: base64 }),
  });
  if (!data?.ok) throw new Error(data?.error || 'No se pudo subir la foto');
  return data.foto_url;
}

async function guardarNuevaDevolucion() {
  const cliente_id = document.getElementById('nd-cliente').value;
  const pedido_id  = document.getElementById('nd-pedido').value || null;
  const motivo     = document.getElementById('nd-motivo').value;
  const notas      = document.getElementById('nd-notas').value.trim();

  if (!cliente_id) { mostrarToast('Elegí un cliente.', 'err'); return; }
  if (!ndItems.length) { mostrarToast('Agregá al menos un ítem.', 'err'); return; }

  const btn = document.getElementById('nd-btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    const foto_url = await ndSubirFotoSiCorresponde();

    const data = await api('/api/admin/devoluciones', {
      method: 'POST',
      body: JSON.stringify({
        cliente_id, pedido_id, motivo, notas: notas || null, foto_url,
        items: ndItems.map(it => ({
          producto_id: it.producto_id, cantidad: it.cantidad, precio_unitario: it.precio_unitario,
        })),
      }),
    });
    if (!data?.ok) throw new Error(data?.error || 'No se pudo registrar la devolución');

    mostrarToast('Devolución registrada. Queda pendiente de revisión.', 'ok');
    cerrarModalNuevaDevolucion();
    paginaActualDevoluciones = 1;
    await cargarDevoluciones();
    await cargarKPIs();
  } catch (e) {
    console.error(e);
    mostrarToast(e.message || 'No se pudo registrar la devolución.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar devolución';
  }
}

// ── Editar notas internas (en cualquier momento, no solo al revisar) ─────
async function guardarNotasDevolucion() {
  if (!devolucionActiva) return;
  const notas = document.getElementById('panel-notas-edit')?.value ?? '';
  try {
    const data = await api('/api/admin/devoluciones?accion=notas', {
      method: 'PATCH',
      body: JSON.stringify({ id: devolucionActiva.id, notas }),
    });
    if (!data?.ok) throw new Error(data?.error || 'No se pudieron guardar las notas');
    devolucionActiva.notas = notas;
    mostrarToast('Notas actualizadas.', 'ok');
  } catch (e) {
    console.error(e);
    mostrarToast(e.message || 'No se pudieron guardar las notas.', 'err');
  }
}

// ── Eliminar (solo pendientes) ────────────────────────────────────────────
async function eliminarDevolucion() {
  if (!devolucionActiva) return;
  const ok = await (window.confirmar
    ? window.confirmar('¿Eliminar esta devolución pendiente? Esta acción no se puede deshacer.', { labelOk: 'Eliminar', labelCancel: 'Cancelar' })
    : Promise.resolve(confirm('¿Eliminar esta devolución pendiente?')));
  if (!ok) return;

  try {
    const data = await api(`/api/admin/devoluciones?id=${devolucionActiva.id}`, { method: 'DELETE' });
    if (!data?.ok) throw new Error(data?.error || 'No se pudo eliminar');
    mostrarToast('Devolución eliminada.', 'ok');
    cerrarPanel();
    await cargarDevoluciones();
    await cargarKPIs();
  } catch (e) {
    console.error(e);
    mostrarToast(e.message || 'No se pudo eliminar la devolución.', 'err');
  }
}

// ── Helpers de formato ──────────────────────────────────────────────────
function motivoLabel(m) {
  return ({
    producto_defectuoso: 'Producto defectuoso',
    error_pedido:        'Error de pedido',
    cliente_arrepentido: 'Cliente arrepentido',
    vencido:              'Vencido',
    otro:                  'Otro',
  })[m] || m || '—';
}

function chipEstado(estado) {
  const map = {
    pendiente:  ['chip-amarillo', 'Pendiente'],
    aprobada:   ['chip-verde',    'Aprobada'],
    rechazada:  ['chip-rojo',     'Rechazada'],
  };
  const [cls, labelRaw] = map[estado] || ['chip-gris', estado || '—'];
  const label = map[estado] ? labelRaw : (typeof sanitize === 'function' ? sanitize(labelRaw) : labelRaw);
  return `<span class="chip ${cls}">${label}</span>`;
}

function formatPeso(n) {
  return '$' + (+n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFecha(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// Exponer al scope global (requerido por los onclick inline del HTML)
window.filtrarDevoluciones = filtrarDevoluciones;

// Exponer al scope global (requerido por los onclick inline del HTML)
window.filtrarDevoluciones = filtrarDevoluciones;
window.abrirDetalle        = abrirDetalle;
window.cerrarPanel         = cerrarPanel;
window.revisarDevolucion   = revisarDevolucion;
