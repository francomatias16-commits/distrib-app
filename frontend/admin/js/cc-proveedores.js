// frontend/admin/js/cc-proveedores.js
// Etapa 8.5 — Cuentas corrientes con proveedores
// Cruza OC recibida ↔ factura proveedor, registra pagos, muestra balance


// FIX v125: eliminado window.supabase.createClient() propio → usa window.authCtx.sb (patrón unificado)

// ── Cliente Supabase ──────────────────────────────────────────────────────────
let sb = null;   // asignado en init() desde window.authCtx.sb

// ── Estado local ──────────────────────────────────────────────────────────────
let facturas     = [];   // todas las facturas cargadas
let proveedores  = [];   // lista de proveedores
let facturaEdit  = null; // factura abierta en el modal
let itemsFactura = [];   // ítems del modal (líneas de la factura nueva)

// ── Helpers ───────────────────────────────────────────────────────────────────
const moneda = v => '$' + Number(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtFecha = s => {
  if (!s) return '—';
  // Tomar solo la parte de fecha (YYYY-MM-DD) por si viene como ISO timestamp completo
  const dateOnly = String(s).slice(0, 10);
  return new Date(dateOnly + 'T12:00:00').toLocaleDateString('es-AR');
};

// ── Avatar circular con iniciales del proveedor (estilo TravelBox) ─────────
const PROV_PALETTE = ['#8B5CF6', '#F59E0B', '#3B82F6', '#0D9488', '#EF4444'];
function avatarProveedor(nombre) {
  const n = (nombre || '?').trim();
  const iniciales = n.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';
  let hash = 0;
  for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) >>> 0;
  const color = PROV_PALETTE[hash % PROV_PALETTE.length];
  return `<span class="prov-fila">
    <span class="prov-avatar" style="background:${color}">${iniciales}</span>
    <span>${window.sanitize ? window.sanitize(n) : n}</span>
  </span>`;
}

function badgeEstado(f) {
  const hoy = new Date().toISOString().slice(0, 10);
  if (f.estado === 'pagada')  return `<span class="badge-fx badge-pagada">Pagada</span>`;
  if (f.estado === 'anulada') return `<span class="badge-fx badge-anulada">Anulada</span>`;
  if (f.estado === 'parcial'  && f.fecha_vencimiento < hoy) return `<span class="badge-fx badge-vencida">Vencida (parcial)</span>`;
  if (f.estado === 'pendiente'&& f.fecha_vencimiento < hoy) return `<span class="badge-fx badge-vencida">Vencida</span>`;
  if (f.estado === 'parcial') return `<span class="badge-fx badge-parcial">Parcial</span>`;
  return `<span class="badge-fx badge-pendiente">Pendiente</span>`;
}
function badge(txt, cls) { return `<span style="font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600" class="${cls}">${txt}</span>`; }

async function api(path, opts = {}) {
  const sess = (await sb.auth.getSession()).data.session;
  if (!sess) return null;
  const r = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${sess.access_token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r.json();
}

// ── Inicialización ────────────────────────────────────────────────────────────
async function init() {
  // Obtener cliente Supabase desde authCtx (garantizado después de authReady)
  if (!window.authCtx) { window.location.href = '/admin/login'; return; }
  sb = window.authCtx.sb;

  // Actualizar usuario en topbar
  const sess = (await sb.auth.getSession()).data.session;
  if (!sess) { location.href = '/admin/login'; return; }

  const { data: perfil } = await sb.from('usuarios').select('nombre,rol,empresa_id').eq('id', sess.user.id).single();
  (document.getElementById('topbar-usuario') || {}).textContent = perfil?.nombre || '';

  // Fecha hoy en campos de pago
  document.getElementById('pago-fecha').value = new Date().toISOString().slice(0, 10);
  document.getElementById('f-fecha').value    = new Date().toISOString().slice(0, 10);

  try { inyectarControlesPaginacionFacturas(); } catch (e) { console.warn('[cc-proveedores] paginacion init:', e.message); }

  initFiltroTabsCCProveedores();

  await cargarProveedores();
  await cargarFacturas();
  await cargarKPIs();

  // Leer QS: ?proveedor=uuid para abrir directamente filtrado
  const qs = new URLSearchParams(location.search);
  if (qs.get('proveedor')) {
    document.getElementById('filtro-proveedor').value = qs.get('proveedor');
    aplicarFiltros();
  }
  if (qs.get('factura')) {
    // Abrir directamente la factura indicada. FIX: `facturas` ahora solo
    // trae la página visible (antes traía hasta 500), así que si no está
    // en la página actual se pide puntualmente al backend por ?id= en vez
    // de asumir que siempre está en el array cargado.
    let f = facturas.find(x => x.id === qs.get('factura'));
    if (!f) {
      const data = await api(`/api/proveedores?_svc=cc-proveedores&accion=facturas&id=${qs.get('factura')}`);
      f = data?.facturas?.[0] || null;
    }
    if (f) abrirFacturaExistente(f);
  } else if (qs.get('proveedor') && qs.get('orden')) {
    // Viene del botón "📄 Factura" de Compras: abrir modal de nueva factura
    // precargado con el proveedor y la OC recibida.
    abrirModalFactura(qs.get('proveedor'), qs.get('orden'));
  }
}

// ── Proveedores ───────────────────────────────────────────────────────────────
async function cargarProveedores() {
  const data = await api('/api/proveedores?activo=true');
  proveedores = data?.proveedores || [];

  const sel = document.getElementById('filtro-proveedor');
  const fProv = document.getElementById('f-proveedor');
  proveedores.forEach(p => {
    const label = p.nombre_fantasia || p.razon_social;
    [sel, fProv].forEach(s => {
      const o = new Option(label, p.id);
      s.add(o);
    });
  });
}

// ── Facturas ─────────────────────────────────────────────────────────────────
// FIX (continuación AUDITORIA_FILTROS_v280, mismo patrón que
// Cheques/Riesgo de cheques/Facturación): antes traía hasta 500 facturas
// sin filtro de fecha server-side y aplicarFiltros() filtraba
// proveedor/estado/fecha con Array.filter() sobre ese recorte fijo. Ahora
// los 4 filtros + page/limit viajan al backend, que resuelve con
// .range()/count:'exact'. No lleva debounce: esta pantalla no tiene
// input de texto, los filtros son selects/fechas con onchange.
let paginaActualFacturas = 1;
const ITEMS_POR_PAGINA_FACTURAS = 50;
let totalFacturasFiltradas = 0;

async function cargarFacturas() {
  const prov   = document.getElementById('filtro-proveedor')?.value || '';
  const estado = document.getElementById('filtro-estado')?.value    || '';
  const desde  = document.getElementById('filtro-desde')?.value     || '';
  const hasta  = document.getElementById('filtro-hasta')?.value     || '';
  const soloDif = document.getElementById('filtro-solo-diferencias')?.checked || false;

  const params = new URLSearchParams({
    _svc: 'cc-proveedores', accion: 'facturas',
    page: paginaActualFacturas, limit: ITEMS_POR_PAGINA_FACTURAS,
  });
  if (prov)   params.set('proveedor_id', prov);
  if (estado) params.set('estado', estado);
  if (desde)  params.set('desde', desde);
  if (hasta)  params.set('hasta', hasta);
  if (soloDif) params.set('solo_diferencias', 'true');

  const data = await api(`/api/proveedores?${params.toString()}`);
  facturas = data?.facturas || [];
  totalFacturasFiltradas = data?.total ?? facturas.length;
  indexarFacturas();
  renderTabla(facturas);
  actualizarControlesPaginacionFacturas();
}

function inyectarControlesPaginacionFacturas() {
  if (document.getElementById('paginacion-facturas')) return; // ya existe
  const contenedor = document.getElementById('tbody-facturas')?.closest('table')?.parentElement || document.body;
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
  if (info) info.textContent = `Página ${paginaActualFacturas} de ${totalPaginas} (${totalFacturasFiltradas} facturas)`;
  const btnPrev = document.getElementById('btn-prev-facturas');
  const btnNext = document.getElementById('btn-next-facturas');
  if (btnPrev) btnPrev.disabled = paginaActualFacturas <= 1;
  if (btnNext) btnNext.disabled = paginaActualFacturas >= totalPaginas;
}

window.cambiarPaginaFacturas = function (delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalFacturasFiltradas / ITEMS_POR_PAGINA_FACTURAS));
  const nueva = paginaActualFacturas + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualFacturas = nueva;
  cargarFacturas();
};

function renderTabla(lista) {
  const tbody = document.getElementById('tbody-facturas');
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="vacio">Sin facturas registradas.</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(f => {
    const saldo      = f.total - f.total_pagado;
    const nomProv    = f.proveedores?.nombre_fantasia || f.proveedores?.razon_social || '—';
    const numOC      = f.ordenes_compra?.numero || '—';
    const hoy        = new Date().toISOString().slice(0, 10);
    const vencida    = f.fecha_vencimiento && f.fecha_vencimiento < hoy && f.estado !== 'pagada';
    const venceCell  = f.fecha_vencimiento
      ? `<span style="${vencida ? 'color:var(--color-danger,#7A1E19);font-weight:600' : ''}">${fmtFecha(f.fecha_vencimiento)}</span>`
      : '<span style="color:var(--color-text-muted)">—</span>';

    const badgeDif = f.tiene_diferencias
      ? `<span title="Tiene diferencias vs. la OC" style="display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:1px 6px;border-radius:10px;background:var(--color-danger-bg,#F3DAD8);color:var(--color-danger,#7A1E19);font-size:10px;font-weight:700;vertical-align:middle">⚠ Dif.</span>`
      : '';

    return `<tr>
      <td style="font-weight:600">${window.sanitize(f.numero_factura)}${badgeDif}<br><span style="font-size:11px;color:var(--color-text-muted)">${window.sanitize(f.tipo)}</span></td>
      <td>${avatarProveedor(nomProv)}</td>
      <td>${f.orden_id
        ? `<a href="/admin/compras?orden=${f.orden_id}" style="color:var(--color-primary);text-decoration:none">${numOC}</a>`
        : '<span style="color:var(--color-text-muted)">Sin OC</span>'}</td>
      <td>${fmtFecha(f.fecha_factura)}</td>
      <td>${venceCell}</td>
      <td style="text-align:left;font-weight:600">${moneda(f.total)}</td>
      <td style="text-align:left;color:var(--color-success,#17402F)">${moneda(f.total_pagado)}</td>
      <td style="text-align:left;font-weight:600;color:${saldo > 0 ? 'var(--color-warning,#7A4A00)' : 'var(--color-text-muted)'}">${saldo > 0 ? moneda(saldo) : '—'}</td>
      <td>${badgeEstado(f)}</td>
      <td class="col-sticky-end">
        <div style="display:flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end">
          <button class="btn-tabla" onclick="abrirFacturaExistente(facturasPorId['${f.id}'])" title="Ver detalle">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            Ver
          </button>
          ${(f.orden_id || (f.estado !== 'pagada' && f.estado !== 'anulada')) ? `<button type="button" class="btn-tabla btn-kebab-fila" data-factura-id="${f.id}" data-orden-id="${f.orden_id ? '1' : ''}" data-pagable="${(f.estado !== 'pagada' && f.estado !== 'anulada') ? '1' : ''}" title="Más acciones" aria-label="Más acciones" aria-haspopup="menu" aria-expanded="false"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Menú "⋮" de acciones secundarias por fila (Cruce OC / Registrar pago) ──
// Un solo menú flotante compartido, reposicionado por JS, en vez de listar
// hasta 3 botones fijos por fila: con 3 botones la columna Acciones no
// entraba en pantallas de ~1366-1440px (quedaba cortada aun con el fix de
// scroll horizontal, porque el <td> sticky terminaba más ancho que el hueco
// visible). Con "Ver" + "⋮" la columna tiene ancho fijo, entra siempre.
(function iniciarMenuAccionesFila() {
  const menu = document.getElementById('menu-acciones-fila');
  if (!menu) return;

  const cerrar = () => {
    menu.hidden = true;
    document.querySelectorAll('.btn-kebab-fila[aria-expanded="true"]')
      .forEach(b => b.setAttribute('aria-expanded', 'false'));
  };

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.btn-kebab-fila');
    if (!btn) { if (!ev.target.closest('#menu-acciones-fila')) cerrar(); return; }
    ev.stopPropagation();

    const yaAbiertoParaEsteBtn = !menu.hidden && menu.dataset.facturaId === btn.dataset.facturaId;
    cerrar();
    if (yaAbiertoParaEsteBtn) return; // click de nuevo sobre el mismo botón = toggle a cerrado

    const facturaId = btn.dataset.facturaId;
    const items = [];
    if (btn.dataset.ordenId) {
      items.push(`<button type="button" class="dropdown-item" role="menuitem" onclick="verCruce('${facturaId}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
        Cruce OC
      </button>`);
    }
    if (btn.dataset.pagable) {
      items.push(`<button type="button" class="dropdown-item" role="menuitem" onclick="abrirPago('${facturaId}')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
        Registrar pago
      </button>`);
    }
    if (!items.length) return;

    menu.innerHTML = items.join('');
    menu.dataset.facturaId = facturaId;

    // Posicionar debajo del botón, alineado a la derecha (el botón suele
    // estar pegado al borde derecho por ser columna sticky).
    const r = btn.getBoundingClientRect();
    menu.style.top  = `${r.bottom + 4}px`;
    menu.style.left = 'auto';
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
  document.getElementById('tbody-facturas')?.addEventListener('scroll', cerrar);
  document.querySelector('.tabla-wrap')?.addEventListener('scroll', cerrar);
})();

// Índice rápido por id (usado en onclick inline)
window.facturasPorId = {};
function indexarFacturas() { facturas.forEach(f => { window.facturasPorId[f.id] = f; }); }

// ── KPIs ──────────────────────────────────────────────────────────────────────
async function cargarKPIs() {
  const data = await api('/api/proveedores?_svc=cc-proveedores&accion=balance');
  const bal  = data?.balance || [];

  const totalFact  = bal.reduce((s, b) => s + Number(b.total_facturado  || 0), 0);
  const totalPag   = bal.reduce((s, b) => s + Number(b.total_pagado     || 0), 0);
  const totalSaldo = bal.reduce((s, b) => s + Number(b.saldo_pendiente  || 0), 0);
  const conSaldo   = bal.filter(b => Number(b.saldo_pendiente) > 0).length;

  document.getElementById('kv-proveedores').textContent = conSaldo;
  document.getElementById('kv-facturado').textContent   = moneda(totalFact);
  document.getElementById('kv-pagado').textContent      = moneda(totalPag);
  document.getElementById('kv-saldo').textContent       = moneda(totalSaldo);

  // "Todas" no tiene un total de facturas fiable acá (este endpoint agrega
  // por proveedor, no por factura) — mismo criterio que cheques.js: no se
  // inventa un número parcial, se deja sin contador. Solo se alimenta la
  // pestaña "Con diferencias", que sí viene contada por el backend.
  FiltroTabs.actualizarContadores(document.getElementById('filtro-tabs-cc-proveedores'), {
    con_diferencias: data?.facturas_con_diferencias ?? 0,
  });
}

function initFiltroTabsCCProveedores() {
  FiltroTabs.crear(document.getElementById('filtro-tabs-cc-proveedores'), [
    { key: 'todas',           label: 'Todas' },
    { key: 'con_diferencias', label: 'Con diferencias' },
  ], 'todas', (key) => {
    const chk = document.getElementById('filtro-solo-diferencias');
    if (chk) chk.checked = key === 'con_diferencias';
    aplicarFiltros();
  });
}

// Atajo desde el menú de la fila / campanita: activa el filtro y la
// pestaña "Con diferencias", y vuelve a página 1 — igual que aplicarFiltros().
window.filtrarSoloDiferencias = function () {
  const chk = document.getElementById('filtro-solo-diferencias');
  if (chk) chk.checked = true;
  const cont = document.getElementById('filtro-tabs-cc-proveedores');
  const tab = cont?.querySelector('[data-key="con_diferencias"]');
  if (tab) {
    cont.querySelectorAll('.filtro-tab').forEach(b => { b.classList.remove('activa'); b.setAttribute('aria-selected', 'false'); });
    tab.classList.add('activa');
    tab.setAttribute('aria-selected', 'true');
  }
  paginaActualFacturas = 1;
  cargarFacturas();
};

// ── Filtros ───────────────────────────────────────────────────────────────────
// Ya no filtra en memoria: los 4 filtros se resuelven server-side en
// cargarFacturas() (ver arriba). aplicarFiltros() solo resetea a página 1
// y vuelve a pedir al backend.
window.aplicarFiltros = function () {
  paginaActualFacturas = 1;
  cargarFacturas();
};

// ── Modal: nueva factura ──────────────────────────────────────────────────────
window.abrirModalFactura = function (proveedorId = null, ordenId = null) {
  facturaEdit  = null;
  itemsFactura = [];
  document.getElementById('modal-factura-titulo').textContent = 'Nueva factura de proveedor';
  document.getElementById('btn-guardar-factura').style.display = '';
  document.getElementById('f-proveedor').value  = proveedorId || '';
  document.getElementById('f-orden').value      = '';
  document.getElementById('f-numero').value     = '';
  document.getElementById('f-tipo').value       = 'A';
  document.getElementById('f-fecha').value      = new Date().toISOString().slice(0, 10);
  document.getElementById('f-vencimiento').value = '';
  document.getElementById('f-iva-pct').value    = '21';
  document.getElementById('f-notas').value      = '';
  document.getElementById('tab-cruce').hidden = true;
  document.getElementById('tab-pagos').hidden = true;
  renderItemsFactura();
  recalcularTotales();

  if (proveedorId) onProveedorChange(ordenId);

  cambiarTab('datos');
  abrirModal('modal-factura');
};

window.abrirFacturaExistente = function (f) {
  if (!f) return;
  facturaEdit  = f;
  itemsFactura = (f.facturas_proveedor_items || []).map(i => ({ ...i }));

  document.getElementById('modal-factura-titulo').textContent = `Factura ${f.numero_factura}`;
  document.getElementById('btn-guardar-factura').style.display =
    (f.estado === 'anulada' || Number(f.total_pagado) > 0) ? 'none' : '';

  document.getElementById('f-proveedor').value   = f.proveedor_id;
  document.getElementById('f-orden').value       = f.orden_id || '';
  document.getElementById('f-numero').value      = f.numero_factura;
  document.getElementById('f-tipo').value        = f.tipo;
  document.getElementById('f-fecha').value       = f.fecha_factura;
  document.getElementById('f-vencimiento').value = f.fecha_vencimiento || '';
  document.getElementById('f-iva-pct').value     = String(f.iva_pct);
  document.getElementById('f-notas').value       = f.notas || '';

  // Mostrar tabs de cruce y pagos — usar .hidden (no style.display), porque
  // el <button hidden> del HTML no se desactiva con style.display='' y las
  // pestañas quedaban invisibles aunque la lógica creyera que las mostraba.
  document.getElementById('tab-cruce').hidden = !f.orden_id;
  document.getElementById('tab-pagos').hidden = false;

  renderItemsFactura();
  recalcularTotales();
  cambiarTab('datos');
  onProveedorChange(f.orden_id);
  abrirModal('modal-factura');
};

// ── Proveedor change: cargar OCs recibidas y aún no facturadas ────────────────
window.onProveedorChange = async function (preselect = null) {
  const provId = document.getElementById('f-proveedor').value;
  const sel    = document.getElementById('f-orden');
  sel.innerHTML = '<option value="">Sin OC</option>';
  document.getElementById('btn-importar-oc').style.display = 'none';

  if (!provId) return;

  // sin_facturar=1: no listar OCs que ya tienen una factura de proveedor
  // (pendiente/parcial/pagada) — evita facturar dos veces la misma compra.
  // excluir_factura_id: si estamos editando una factura existente, que no
  // se oculte a sí misma la OC que ya tiene vinculada.
  let url = `/api/proveedores?_svc=compras&proveedor_id=${provId}&estado=recibida&sin_facturar=1`;
  if (facturaEdit?.id) url += `&excluir_factura_id=${facturaEdit.id}`;

  const data = await api(url);
  const ocs  = data?.ordenes || [];
  ocs.forEach(oc => {
    sel.add(new Option(`OC ${oc.numero} — ${fmtFecha(oc.fecha_pedido)} — ${moneda(oc.total)}`, oc.id));
  });

  if (preselect) sel.value = preselect;
  if (sel.value) document.getElementById('btn-importar-oc').style.display = '';
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('f-orden').addEventListener('change', () => {
    const val = document.getElementById('f-orden').value;
    document.getElementById('btn-importar-oc').style.display = val ? '' : 'none';
  });
  // Recalcular totales al cambiar el IVA%
  document.getElementById('f-iva-pct').addEventListener('change', () => recalcularTotales());
});

// ── Ítems factura ─────────────────────────────────────────────────────────────
window.agregarItemFactura = function () {
  itemsFactura.push({ descripcion: '', cantidad: 1, precio_unitario: 0, producto_id: null });
  renderItemsFactura();
};

window.importarItemsDesdeOC = async function () {
  const ordenId = document.getElementById('f-orden').value;
  if (!ordenId) { mostrarToast('Seleccioná una OC primero', 'error'); return; }

  const data = await api(`/api/proveedores?_svc=compras&id=${ordenId}`);
  // El backend devuelve la OC directamente en la raíz (no dentro de data.orden)
  // Los ítems vienen como ordenes_compra_items (nombre del join de Supabase)
  const oc = data?.id ? data : data?.orden;
  const rawItems = oc?.ordenes_compra_items || oc?.items || [];
  if (!rawItems.length) { mostrarToast('La OC no tiene ítems', 'error'); return; }

  // Si la OC está parcialmente recibida, facturamos lo efectivamente recibido
  // (cantidad_recibida), no lo pedido — evita facturar mercadería que todavía
  // no llegó. Si aún no hay recepción registrada (cantidad_recibida en 0/null,
  // p.ej. factura antes de recepcionar), se usa la cantidad pedida como fallback.
  const esParcial = oc?.estado === 'recibida_parcial';
  itemsFactura = rawItems
    .map(i => {
      const recibida = Number(i.cantidad_recibida || 0);
      const cantidad = esParcial && recibida > 0 ? recibida : i.cantidad;
      return {
        producto_id:     i.producto_id,
        descripcion:     i.descripcion || i.productos?.nombre || i.producto_nombre || i.nombre || '—',
        cantidad,
        precio_unitario: i.precio_unitario,
      };
    })
    .filter(i => Number(i.cantidad) > 0); // no incluir ítems sin nada recibido aún

  renderItemsFactura();
  recalcularTotales();
  const nota = esParcial ? ' (cantidades según lo recibido)' : '';
  mostrarToast(`${itemsFactura.length} ítems importados de la OC${nota}`, 'exito');
  cambiarTab('items');
};

function renderItemsFactura() {
  const tbody = document.getElementById('tbody-items-factura');
  if (!itemsFactura.length) {
    tbody.innerHTML = '<tr id="fila-vacia-items"><td colspan="5" style="padding:20px;text-align:center;color:var(--color-text-muted)">Todavía no hay ítems. Agregá uno o importalos desde la OC.</td></tr>';
    return;
  }

  tbody.innerHTML = itemsFactura.map((item, idx) => {
    const sub = (item.cantidad || 0) * (item.precio_unitario || 0);
    // Usar value="" vacío cuando precio es 0 para que el usuario tipee directamente
    const precioVal = item.precio_unitario > 0 ? item.precio_unitario : '';
    return `<tr class="item-row" data-idx="${idx}">
      <td><input type="text" class="fi-desc" data-idx="${idx}" value="${window.sanitize(item.descripcion || '')}" style="width:100%;min-width:160px" placeholder="Descripción"/></td>
      <td><input type="number" class="fi-cant" data-idx="${idx}" value="${item.cantidad}" min="0.001" step="any" style="width:75px;text-align:left"/></td>
      <td><input type="number" class="fi-precio" data-idx="${idx}" value="${precioVal !== '' ? Math.round(precioVal) : ''}" min="0" step="1" data-money placeholder="0" style="width:100px;text-align:left"/></td>
      <td class="fi-sub" id="sub-${idx}" style="text-align:left;font-weight:500;padding:0 8px">${moneda(sub)}</td>
      <td style="text-align:center"><button class="fi-del" data-idx="${idx}" style="border:none;background:none;cursor:pointer;color:var(--color-text-muted);font-size:16px;padding:2px 6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></td>
    </tr>`;
  }).join('');

  // Event delegation en tbody — más robusto que oninput inline con type="module"
  tbody.oninput = (e) => {
    const idx = +e.target.dataset.idx;
    if (isNaN(idx)) return;
    if (e.target.classList.contains('fi-desc'))   itemsFactura[idx].descripcion = e.target.value;
    if (e.target.classList.contains('fi-cant'))   itemsFactura[idx].cantidad = +e.target.value || 0;
    if (e.target.classList.contains('fi-precio')) itemsFactura[idx].precio_unitario = +e.target.value || 0;
    if (e.target.classList.contains('fi-cant') || e.target.classList.contains('fi-precio')) {
      const sub = (itemsFactura[idx].cantidad || 0) * (itemsFactura[idx].precio_unitario || 0);
      const cell = document.getElementById(`sub-${idx}`);
      if (cell) cell.textContent = moneda(sub);
      recalcularTotales();
    }
  };
  tbody.onclick = (e) => {
    const btn = e.target.closest('.fi-del');
    if (!btn) return;
    const idx = +btn.dataset.idx;
    if (!isNaN(idx)) { itemsFactura.splice(idx, 1); renderItemsFactura(); recalcularTotales(); }
  };
}

window.recalcItemTd = function (input, idx) {
  const sub = (itemsFactura[idx].cantidad || 0) * (itemsFactura[idx].precio_unitario || 0);
  const cell = document.getElementById(`sub-${idx}`);
  if (cell) cell.textContent = moneda(sub);
  recalcularTotales();
};

window.quitarItem = function (idx) {
  itemsFactura.splice(idx, 1);
  renderItemsFactura();
  recalcularTotales();
};

window.recalcularTotales = function () {
  const subtotal = itemsFactura.reduce((s, i) => s + (i.cantidad || 0) * (i.precio_unitario || 0), 0);
  const ivaPct   = Number(document.getElementById('f-iva-pct').value) || 0;
  const iva      = subtotal * ivaPct / 100;
  const total    = subtotal + iva;

  // Actualizar totales en tab Datos
  document.getElementById('resumen-subtotal').textContent = moneda(subtotal);
  document.getElementById('resumen-iva').textContent      = moneda(iva);
  document.getElementById('resumen-total').textContent    = moneda(total);

  // Actualizar totales en tab Ítems (duplicado para UX)
  const si = document.getElementById('resumen-subtotal-items');
  const ii = document.getElementById('resumen-iva-items');
  const ti = document.getElementById('resumen-total-items');
  if (si) si.textContent = moneda(subtotal);
  if (ii) ii.textContent = moneda(iva);
  if (ti) ti.textContent = moneda(total);
};

// ── Guardar factura ───────────────────────────────────────────────────────────
window.guardarFactura = async function () {
  const proveedor_id = document.getElementById('f-proveedor').value;
  const numero       = document.getElementById('f-numero').value.trim();
  const fecha        = document.getElementById('f-fecha').value;

  if (!proveedor_id || !numero || !fecha) {
    mostrarToast('Completá proveedor, número y fecha', 'error'); return;
  }

  const btn = document.getElementById('btn-guardar-factura');
  btn.disabled = true; btn.textContent = '⏳ Guardando...';

  const ivaPct  = Number(document.getElementById('f-iva-pct').value) || 0;
  const sub     = itemsFactura.reduce((s, i) => s + (i.cantidad || 0) * (i.precio_unitario || 0), 0);
  const ivaMon  = sub * ivaPct / 100;
  const total   = sub + ivaMon;

  const body = {
    proveedor_id,
    orden_id:         document.getElementById('f-orden').value || null,
    numero_factura:   numero,
    tipo:             document.getElementById('f-tipo').value,
    fecha_factura:    fecha,
    fecha_vencimiento:document.getElementById('f-vencimiento').value || null,
    subtotal:         sub,
    iva_pct:          ivaPct,
    iva_monto:        ivaMon,
    total,
    notas:            document.getElementById('f-notas').value || null,
    items:            itemsFactura,
  };

  let url = '/api/proveedores?_svc=cc-proveedores&accion=factura';
  let method = 'POST';

  if (facturaEdit) {
    url    = '/api/proveedores?_svc=cc-proveedores&accion=factura';
    method = 'PATCH';
    body.id = facturaEdit.id;
  }

  const data = await api(url, { method, body: JSON.stringify(body) });

  btn.disabled = false; btn.textContent = 'Guardar factura';

  if (!data?.ok && !data?.factura) {
    mostrarToast(data?.error || 'No se pudo guardar la factura', 'error'); return;
  }

  mostrarToast(facturaEdit ? 'Factura actualizada' : 'Factura registrada', 'exito');
  cerrarModal('modal-factura');
  await cargarFacturas();
  await cargarKPIs();
  indexarFacturas();

  // Si hay conciliación disponible, mostrarla
  if (data?.conciliacion?.discrepancias?.length > 0) {
    mostrarToast(`${data.conciliacion.discrepancias.length} diferencias encontradas con la OC`, 'error');
  }
};

// ── Cruce OC ↔ Factura ────────────────────────────────────────────────────────
window.verCruce = async function (facturaId) {
  const f = window.facturasPorId[facturaId];
  if (!f?.orden_id) { mostrarToast('Esta factura no tiene OC vinculada', 'error'); return; }

  document.getElementById('cruce-modal-body').innerHTML = '<p style="padding:30px;text-align:center">Calculando cruce...</p>';
  abrirModal('modal-cruce');

  const data = await api('/api/proveedores?_svc=cc-proveedores&accion=conciliar', {
    method: 'POST',
    body: JSON.stringify({ orden_id: f.orden_id, factura_id: facturaId })
  });

  if (!data?.ok) {
    document.getElementById('cruce-modal-body').innerHTML = `<p style="color:red;padding:20px">${sanitize(data?.error || 'Error')}</p>`;
    return;
  }

  const items = data.items || [];
  const disc  = data.discrepancias || [];

  // Banner resumen
  const resumen = disc.length === 0
    ? `<div style="background:var(--color-success-bg,#DCEDE3);color:var(--color-success,#17402F);padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Sin diferencias — OC y factura coinciden</div>`
    : `<div style="background:var(--color-warning-bg,#FBEBC7);color:var(--color-warning,#7A4A00);padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600">⚠ ${disc.length} ítem${disc.length > 1 ? 's' : ''} con diferencias respecto a la OC</div>`;

  const filas = items.map(it => {
    const difCant  = it.diff_cant_pct  > 0;
    const difPrecio= it.diff_precio_pct > 0;
    const noMatch  = !it.match;

    return `<tr>
      <td style="padding:8px 10px">${window.sanitize(it.nombre || it.descripcion || '—')}</td>
      <td style="padding:8px 10px;text-align:left">${it.cant_oc}</td>
      <td style="padding:8px 10px;text-align:left;${noMatch?'color:var(--color-text-muted)':''}">${it.cant_fac ?? '—'}</td>
      <td style="padding:8px 10px;text-align:left;${difCant?'color:var(--color-danger,#7A1E19);font-weight:600':''}">${it.diff_cant_pct}%</td>
      <td style="padding:8px 10px;text-align:left">${moneda(it.precio_oc)}</td>
      <td style="padding:8px 10px;text-align:left;${noMatch?'color:var(--color-text-muted)':''}">${it.precio_fac ? moneda(it.precio_fac) : '—'}</td>
      <td style="padding:8px 10px;text-align:left;${difPrecio?'color:var(--color-danger,#7A1E19);font-weight:600':''}">${it.diff_precio_pct}%</td>
      <td style="padding:8px 10px;text-align:center">
        ${noMatch
          ? '<span style="color:var(--color-danger,#7A1E19)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>No encontrado</span>'
          : it.alerta
            ? '<span style="color:var(--color-warning,#7A4A00);font-weight:600">⚠ Dif.</span>'
            : '<span style="color:var(--color-success,#17402F)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg></span>'}
      </td>
    </tr>`;
  }).join('');

  document.getElementById('cruce-modal-body').innerHTML = `
    ${resumen}
    <div style="overflow-x:auto">
      <table class="cruce-table">
        <thead>
          <tr>
            <th>Producto</th>
            <th style="text-align:left">Cant. OC</th>
            <th style="text-align:left">Cant. Fac.</th>
            <th style="text-align:left">Dif. %</th>
            <th style="text-align:left">Precio OC</th>
            <th style="text-align:left">Precio Fac.</th>
            <th style="text-align:left">Dif. %</th>
            <th style="text-align:center">Estado</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <div style="margin-top:16px;font-size:12px;color:var(--color-text-muted)">
      Umbral de alerta: 5% de diferencia en cantidad o precio.
    </div>`;
};

// ── Pagos ─────────────────────────────────────────────────────────────────────
window.abrirPago = function (facturaId) {
  const f = window.facturasPorId[facturaId];
  if (!f) return;
  abrirFacturaExistente(f);
  setTimeout(() => { cambiarTab('pagos'); cargarPagosTab(facturaId); }, 100);
};

async function cargarPagosTab(facturaId) {
  const cont = document.getElementById('pagos-contenido');
  cont.innerHTML = '<p style="text-align:center;padding:20px">Cargando...</p>';

  const f    = window.facturasPorId[facturaId];
  const data = await api(`/api/proveedores?_svc=cc-proveedores&accion=pagos&factura_id=${facturaId}`);
  const pagos = data?.pagos || [];

  if (!pagos.length) {
    cont.innerHTML = '<p style="text-align:center;padding:20px;color:var(--color-text-muted)">Sin pagos registrados.</p>';
  } else {
    cont.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:var(--color-surface-2,#EAE4D6);font-size:11px;text-transform:uppercase;color:var(--color-text-muted)">
          <th style="padding:7px 10px;text-align:left">Fecha</th>
          <th style="padding:7px 10px;text-align:left">Medio</th>
          <th style="padding:7px 10px;text-align:left">Referencia</th>
          <th style="padding:7px 10px;text-align:left">Monto</th>
          <th style="padding:7px 10px;text-align:left">Usuario</th>
        </tr></thead>
        <tbody>
          ${pagos.map(p => `<tr style="border-bottom:1px solid var(--color-border)">
            <td style="padding:7px 10px">${fmtFecha(p.fecha_pago)}</td>
            <td style="padding:7px 10px;text-transform:capitalize">${p.medio_pago}</td>
            <td style="padding:7px 10px;color:var(--color-text-muted)">${window.sanitize(p.referencia || '—')}</td>
            <td style="padding:7px 10px;text-align:left;font-weight:600;color:var(--color-success,#17402F)">${moneda(p.monto)}</td>
            <td style="padding:7px 10px;font-size:12px">${window.sanitize(p.usuarios?.nombre || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--color-border);display:flex;justify-content:space-between;font-size:13px">
        <span>Saldo pendiente:</span>
        <span style="font-weight:700;color:${(f.total - f.total_pagado) > 0 ? 'var(--color-warning,#7A4A00)' : 'var(--color-success,#17402F)'}">${moneda(f.total - f.total_pagado)}</span>
      </div>`;
  }

  // Pre-completar monto sugerido (saldo restante) / ocultar form si ya está saldada
  const saldo = f ? (f.total - f.total_pagado) : 0;
  const formWrapper = document.getElementById('pago-form-wrapper');
  const mensajeSaldada = document.getElementById('pago-form-saldada');
  if (saldo > 0) {
    document.getElementById('pago-monto').value = saldo.toFixed(2);
    document.getElementById('pago-monto').max = saldo.toFixed(2);
    if (formWrapper) formWrapper.style.display = '';
    if (mensajeSaldada) mensajeSaldada.style.display = 'none';
  } else {
    if (formWrapper) formWrapper.style.display = 'none';
    if (mensajeSaldada) mensajeSaldada.style.display = '';
  }
}

// ── Selector de cheque en cartera (pago a proveedor con cheque de tercero) ──
async function cargarChequesDisponibles() {
  const sel = document.getElementById('pago-cheque-id');
  sel.innerHTML = '<option value="">Cargando...</option>';
  const { data, error } = await sb
    .from('cheques')
    .select('id, banco, numero, monto, fecha_vto, cliente_id, clientes(razon_social)')
    .in('estado', ['pendiente', 'en_cartera'])
    .order('fecha_vto', { ascending: true });

  if (error || !data?.length) {
    sel.innerHTML = '<option value="">No hay cheques en cartera disponibles</option>';
    return;
  }
  sel.innerHTML = '<option value="">Elegí un cheque...</option>' + data.map(c =>
    `<option value="${c.id}" data-monto="${c.monto}">${escHtml(c.banco)} N° ${escHtml(c.numero)} — ${moneda(c.monto)} — ${escHtml(c.clientes?.razon_social || 'sin cliente')} (vto. ${c.fecha_vto || '—'})</option>`
  ).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  const medioSel = document.getElementById('pago-medio');
  const wrapper  = document.getElementById('pago-cheque-wrapper');
  if (!medioSel || !wrapper) return;

  medioSel.addEventListener('change', () => {
    if (medioSel.value === 'cheque') {
      wrapper.style.display = '';
      cargarChequesDisponibles();
    } else {
      wrapper.style.display = 'none';
    }
  });

  document.getElementById('pago-cheque-id')?.addEventListener('change', (ev) => {
    const opt = ev.target.selectedOptions[0];
    const montoInput = document.getElementById('pago-monto');
    if (opt?.dataset.monto) montoInput.value = Number(opt.dataset.monto).toFixed(2);
  });
});

window.guardarPago = async function () {
  if (!facturaEdit) return;
  const monto = Number(document.getElementById('pago-monto').value);
  if (!monto || monto <= 0) { mostrarToast('Ingresá un monto válido', 'error'); return; }

  const btn = document.querySelector('[onclick="guardarPago()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Registrando...'; }

  const medioSel = document.getElementById('pago-medio').value;
  const chequeId = medioSel === 'cheque' ? (document.getElementById('pago-cheque-id').value || null) : null;

  const data = await api('/api/proveedores?_svc=cc-proveedores&accion=pago', {
    method: 'POST',
    body: JSON.stringify({
      proveedor_id: facturaEdit.proveedor_id,
      factura_id:   facturaEdit.id,
      monto,
      medio_pago:   medioSel,
      fecha_pago:   document.getElementById('pago-fecha').value,
      referencia:   document.getElementById('pago-referencia').value || null,
      cheque_id:    chequeId,
    })
  });

  if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Registrar pago'; }

  if (!data?.ok) { mostrarToast(data?.error || 'No se pudo registrar el pago', 'error'); return; }

  mostrarToast(`Pago de ${moneda(monto)} registrado`, 'exito');
  document.getElementById('pago-monto').value = '';
  document.getElementById('pago-referencia').value = '';

  // Actualizar factura local
  facturaEdit.total_pagado = data.total_pagado;
  facturaEdit.estado       = data.estado;
  window.facturasPorId[facturaEdit.id] = facturaEdit;

  cargarPagosTab(facturaEdit.id);
  await cargarFacturas();
  await cargarKPIs();
  indexarFacturas();
};

// ── Tab navigation ────────────────────────────────────────────────────────────
window.cambiarTab = function (tab) {
  ['datos','items','cruce','pagos'].forEach(t => {
    document.getElementById(`panel-${t}`).style.display = (t === tab) ? '' : 'none';
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
  });
  if (tab === 'pagos' && facturaEdit)  cargarPagosTab(facturaEdit.id);
  if (tab === 'cruce' && facturaEdit)  mostrarCruceEnTab(facturaEdit);
};

async function mostrarCruceEnTab(f) {
  const cont = document.getElementById('cruce-contenido');
  if (!f.orden_id) {
    cont.innerHTML = '<p style="text-align:center;padding:30px;color:var(--color-text-muted)">Esta factura no tiene OC vinculada.</p>';
    return;
  }

  if (f.conciliacion) {
    renderCruceEnContenedor(f.conciliacion, 'cruce-contenido');
    return;
  }

  cont.innerHTML = '<p style="text-align:center;padding:30px">Calculando cruce...</p>';
  const data = await api('/api/proveedores?_svc=cc-proveedores&accion=conciliar', {
    method: 'POST',
    body: JSON.stringify({ orden_id: f.orden_id, factura_id: f.id })
  });
  if (data?.ok) renderCruceEnContenedor(data, 'cruce-contenido');
  else cont.innerHTML = `<p style="color:red;padding:20px">${sanitize(data?.error || 'Error')}</p>`;
}

function renderCruceEnContenedor(data, containerId) {
  const items = data.items || [];
  const disc  = data.discrepancias || [];
  const cont  = document.getElementById(containerId);

  const banner = disc.length === 0
    ? `<div style="background:var(--color-success-bg,#DCEDE3);color:var(--color-success,#17402F);padding:10px 14px;border-radius:8px;margin-bottom:14px;font-weight:600"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Sin diferencias</div>`
    : `<div style="background:var(--color-warning-bg,#FBEBC7);color:var(--color-warning,#7A4A00);padding:10px 14px;border-radius:8px;margin-bottom:14px;font-weight:600">⚠ ${disc.length} diferencia(s)</div>`;

  const filas = items.map(it => `<tr>
    <td style="padding:7px 10px">${sanitize(it.nombre || '—')}</td>
    <td style="padding:7px 10px;text-align:left">${it.cant_oc}</td>
    <td style="padding:7px 10px;text-align:left">${it.cant_fac ?? '—'}</td>
    <td style="padding:7px 10px;text-align:left;${it.diff_cant_pct > 0 ? 'color:var(--color-danger,#7A1E19);font-weight:600' : ''}">${it.diff_cant_pct}%</td>
    <td style="padding:7px 10px;text-align:left">${moneda(it.precio_oc)}</td>
    <td style="padding:7px 10px;text-align:left">${it.precio_fac ? moneda(it.precio_fac) : '—'}</td>
    <td style="padding:7px 10px;text-align:left;${it.diff_precio_pct > 0 ? 'color:var(--color-danger,#7A1E19);font-weight:600' : ''}">${it.diff_precio_pct}%</td>
    <td style="padding:7px 10px;text-align:center">${it.alerta ? '⚠' : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>'}</td>
  </tr>`).join('');

  cont.innerHTML = `${banner}
    <div style="overflow-x:auto">
      <table class="cruce-table">
        <thead><tr>
          <th>Producto</th><th style="text-align:left">Cant.OC</th><th style="text-align:left">Cant.Fac</th><th style="text-align:left">Δ%</th>
          <th style="text-align:left">Precio OC</th><th style="text-align:left">Precio Fac</th><th style="text-align:left">Δ%</th><th style="text-align:center">OK</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function abrirModal(id) { document.getElementById(id).classList.add('active'); }
window.cerrarModal = id => { document.getElementById(id).classList.remove('active'); };
window.cerrarSiFondo = (ev, id) => { if (ev.target.id === id) cerrarModal(id); };

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// ── Arranque ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.authReady
    .then(() => init().then(() => indexarFacturas()))
    .catch((err) => {
  console.error('[auth] authReady falló:', err?.message);
  if (!window.authCtx || !window.authCtx.perfil) {
    window.location.href = '/admin/login';
  }
});
});
