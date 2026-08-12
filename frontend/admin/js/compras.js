// frontend/admin/js/compras.js
// Módulo de órdenes de compra — REQ-01

let sb = null, usuario = null;
let ordenesData = [], proveedoresData = [], productosData = [];
let filtros = { proveedor_id: '', estado: '', desde: '', hasta: '' };
let modalOrdenId = null;
let itemsOC = []; // items en construcción

// Paginación (el backend /api/compras ya soporta page/limit/total)
let paginaActualOC   = 1;
const itemsPorPaginaOC = 50;
let totalOrdenesOC   = 0;

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  sb      = window.authCtx.sb;
  usuario = window.authCtx.perfil;

  // Pre-filtrar por proveedor si viene de URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('proveedor')) {
    filtros.proveedor_id = params.get('proveedor');
    const sel = document.getElementById('filtro-proveedor');
    if (sel) sel.value = filtros.proveedor_id;
  }

  await Promise.all([cargarProveedores(), cargarProductos(), cargarOrdenes()]);

  // Abrir una OC puntual si viene por URL ?id=xxx (deep-link desde
  // Automatización/Stock al aprobar una orden automática). verDetalle trae
  // la orden directo del server, así que no depende de la página cargada.
  if (params.get('id')) {
    verDetalle(params.get('id'));
  }
}

// ── Carga de datos ────────────────────────────────────────────────────
async function cargarProveedores() {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch('/api/proveedores?activo=true', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la lista de proveedores.');
    const data = await res.json();
    proveedoresData = data.proveedores || [];

    const opciones = proveedoresData.map(p => `<option value="${p.id}">${sanitize(p.razon_social)}</option>`).join('');

    const sel = document.getElementById('filtro-proveedor');
    if (sel) {
      sel.innerHTML = '<option value="">Todos los proveedores</option>' + opciones;
      if (filtros.proveedor_id) sel.value = filtros.proveedor_id;
    }

    const selModal = document.getElementById('oc-proveedor');
    if (selModal) {
      const vacio = !proveedoresData.length;
      selModal.innerHTML =
        `<option value="">${vacio ? 'No hay proveedores cargados' : 'Seleccionar proveedor...'}</option>` +
        opciones +
        `<option value="__nuevo__">+ Nuevo proveedor...</option>`;
    }
  } catch (err) {
    window.toast?.(err.message || 'No se pudo cargar la lista de proveedores.', 'error');
  }
}

// Detecta si el usuario eligió "+ Nuevo proveedor..." en el combo de la OC
// y abre el alta rápida sin perder lo que ya cargó en la orden. Antes, si
// la empresa no tenía proveedores, este combo quedaba vacío y sin salida.
function onCambioProveedorOC(select) {
  if (select.value === '__nuevo__') {
    select.value = '';
    abrirModalProveedorRapido();
  }
}

function abrirModalProveedorRapido() {
  document.getElementById('pr-razon-social').value = '';
  document.getElementById('pr-cuit').value = '';
  document.getElementById('pr-telefono').value = '';
  document.getElementById('modal-proveedor-rapido').style.display = 'flex';
  setTimeout(() => document.getElementById('pr-razon-social')?.focus(), 50);
}

function cerrarModalProveedorRapido() {
  document.getElementById('modal-proveedor-rapido').style.display = 'none';
}

function cerrarModalProveedorRapidoSiFondo(event) {
  if (event.target.id === 'modal-proveedor-rapido') cerrarModalProveedorRapido();
}

async function guardarProveedorRapido() {
  const razon_social = document.getElementById('pr-razon-social').value.trim();
  if (!razon_social) {
    window.toast('La razón social es requerida', 'error');
    return;
  }

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/proveedores', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razon_social,
        cuit: document.getElementById('pr-cuit').value.trim(),
        telefono: document.getElementById('pr-telefono').value.trim(),
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo crear el proveedor', 'error');
      return;
    }

    const nuevo = await res.json();
    window.toast('Proveedor creado', 'exito');
    cerrarModalProveedorRapido();

    await cargarProveedores();
    const selModal = document.getElementById('oc-proveedor');
    if (selModal) selModal.value = nuevo.id;
  } catch (err) {
    window.toast(err.message || 'No se pudo crear el proveedor', 'error');
  }
}

window.onCambioProveedorOC          = onCambioProveedorOC;
window.abrirModalProveedorRapido    = abrirModalProveedorRapido;
window.cerrarModalProveedorRapido   = cerrarModalProveedorRapido;
window.cerrarModalProveedorRapidoSiFondo = cerrarModalProveedorRapidoSiFondo;
window.guardarProveedorRapido       = guardarProveedorRapido;

async function cargarProductos() {
  try {
    const { data, error } = await sb.from('productos')
      .select('id, nombre, codigo, costo, unidad')
      .eq('activo', true)
      .order('nombre');
    if (error) throw error;
    productosData = data || [];
  } catch (err) {
    window.toast?.(err.message || 'No se pudieron cargar los productos.', 'error');
  }
}

async function cargarOrdenes() {
  try {
    const token   = (await sb.auth.getSession()).data.session?.access_token;
    const params  = new URLSearchParams();
    Object.entries(filtros).forEach(([k, v]) => { if (v) params.set(k, v); });
    params.set('page', paginaActualOC);
    params.set('limit', itemsPorPaginaOC);

    const res  = await fetch(`/api/compras?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la lista de órdenes de compra.');
    const data = await res.json();
    ordenesData    = data.ordenes || [];
    totalOrdenesOC = data.total ?? ordenesData.length;
    renderTabla();
    renderPaginacionOC();
  } catch (err) {
    window.toast?.(err.message || 'No se pudo cargar la lista de órdenes de compra.', 'error');
  }
}

function renderPaginacionOC() {
  let cont = document.getElementById('paginacion-compras');
  if (!cont) {
    const host = document.getElementById('tbody-compras')?.closest('table')?.parentElement
              || document.querySelector('.content') || document.body;
    cont = document.createElement('div');
    cont.id = 'paginacion-compras';
    cont.className = 'paginacion-container';
    host.appendChild(cont);
  }
  const totalPaginas = Math.max(1, Math.ceil(totalOrdenesOC / itemsPorPaginaOC));
  cont.innerHTML = `
    <button class="btn-pag" ${paginaActualOC <= 1 ? 'disabled' : ''} onclick="cambiarPaginaOC(-1)">Anterior</button>
    <span class="info-pag">Página ${paginaActualOC} de ${totalPaginas} (${totalOrdenesOC} órdenes)</span>
    <button class="btn-pag" ${paginaActualOC >= totalPaginas ? 'disabled' : ''} onclick="cambiarPaginaOC(1)">Siguiente</button>
  `;
}

async function cambiarPaginaOC(delta) {
  paginaActualOC += delta;
  await cargarOrdenes();
}
window.cambiarPaginaOC = cambiarPaginaOC;

// ── Aprobar orden pendiente de aprobación (OC auto-generada) ───────────
async function aprobarOrdenCompras(id, btn) {
  const textoOriginal = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/stock-auto?accion=aprobar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orden_id: id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo aprobar la orden');

    mostrarToast('Orden aprobada y enviada al proveedor', 'exito');

    const modalAbierto = document.getElementById('modal-detalle')?.style.display === 'flex';
    if (modalAbierto) await verDetalle(id);
    await cargarOrdenes();
  } catch (err) {
    mostrarToast(err.message || 'No se pudo aprobar la orden', 'error');
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal || 'Aprobar'; }
  }
}
window.aprobarOrdenCompras = aprobarOrdenCompras;

// ── Eliminar orden (borrador/pendiente_aprobacion — nunca salió al proveedor) ──
async function eliminarOrdenCompra(id, btn) {
  const orden = ordenesData.find(o => String(o.id) === String(id));
  const okEliminar = await window.confirmar(
    `¿Eliminar la orden ${orden?.numero || ''}? Esta acción no se puede deshacer.`,
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!okEliminar) return;

  const textoOriginal = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch(`/api/compras?id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo eliminar la orden');

    mostrarToast('Orden eliminada', 'exito');
    const modalAbierto = document.getElementById('modal-detalle')?.style.display === 'flex';
    if (modalAbierto) document.getElementById('modal-detalle').style.display = 'none';
    await cargarOrdenes();
  } catch (err) {
    mostrarToast(err.message || 'No se pudo eliminar la orden', 'error');
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal || 'Eliminar'; }
  }
}
window.eliminarOrdenCompra = eliminarOrdenCompra;

// ── Cancelar orden (ya enviada/confirmada al proveedor — no se borra, se marca cancelada) ──
async function cancelarOrdenCompra(id, btn) {
  const orden = ordenesData.find(o => String(o.id) === String(id));
  const okCancelar = await window.confirmar(
    `¿Cancelar la orden ${orden?.numero || ''}? El proveedor ya la vio; se marcará como cancelada pero no se borrará.`,
    { labelOk: 'Cancelar orden', labelCancel: 'Volver', tipo: 'danger' }
  );
  if (!okCancelar) return;

  const textoOriginal = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/compras', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, estado: 'cancelada' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo cancelar la orden');

    mostrarToast('Orden cancelada', 'exito');
    const modalAbierto = document.getElementById('modal-detalle')?.style.display === 'flex';
    if (modalAbierto) await verDetalle(id);
    await cargarOrdenes();
  } catch (err) {
    mostrarToast(err.message || 'No se pudo cancelar la orden', 'error');
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal || 'Cancelar orden'; }
  }
}
window.cancelarOrdenCompra = cancelarOrdenCompra;

// ── Render ────────────────────────────────────────────────────────────
function renderTabla() {
  const tbody = document.getElementById('tbody-compras');
  if (!tbody) return;

  if (!ordenesData.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="vacio">Sin órdenes de compra</td></tr>';
    return;
  }

  tbody.innerHTML = ordenesData.map(o => {
    const fecha = new Date(o.fecha_pedido).toLocaleDateString('es-AR');
    const esperada = o.fecha_esperada
      ? new Date(o.fecha_esperada).toLocaleDateString('es-AR') : '—';

    return `
      <tr data-testid="oc-fila" data-id="${o.id}">
        <td style="font-weight:600">${o.numero}</td>
        <td>${sanitize(o.proveedores?.razon_social || '—')}</td>
        <td style="font-size:12px;color:var(--color-text-muted)">${fecha}</td>
        <td style="font-size:12px;color:var(--color-text-muted)">${esperada}</td>
        <td style="text-align:left;font-weight:600">$${Number(o.total).toLocaleString('es-AR', {minimumFractionDigits:2})}</td>
        <td><span class="badge badge-${o.estado}">${labelEstado(o.estado)}</span></td>
        <td class="col-sticky-end">
          <div class="acciones-td" style="white-space:nowrap">
            <button class="btn-tabla primario" onclick="verDetalle('${o.id}')">Ver</button>
            ${o.estado === 'pendiente_aprobacion'
              ? `<button class="btn-tabla" onclick="aprobarOrdenCompras('${o.id}',this)" style="background:var(--color-success-bg);color:var(--color-success)">Aprobar</button>`
              : ''
            }
            ${['borrador','enviada','confirmada','recibida_parcial'].includes(o.estado)
              ? `<button class="btn-tabla" onclick="abrirRecepcionar('${o.id}')">Recepcionar</button>`
              : ''
            }
            ${['borrador','pendiente_aprobacion'].includes(o.estado)
              ? `<button class="btn-tabla" onclick="eliminarOrdenCompra('${o.id}',this)" style="background:var(--color-danger-bg,#F8D7DA);color:var(--color-danger,#B02A37)">Eliminar</button>`
              : ''
            }
            ${['enviada','confirmada'].includes(o.estado)
              ? `<button class="btn-tabla" onclick="cancelarOrdenCompra('${o.id}',this)" style="background:var(--color-danger-bg,#F8D7DA);color:var(--color-danger,#B02A37)">Cancelar</button>`
              : ''
            }
            ${o.estado === 'recibida'
              ? `<button class="btn-tabla" onclick="irAFactura('${o.id}','${o.proveedor_id}')" title="Registrar / ver factura del proveedor" style="background:var(--color-surface-2,#EAE4D6);border:1px solid var(--color-border)">
                   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>Factura
                 </button>`
              : ''
            }
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function labelEstado(e) {
  const map = {
    borrador: 'Borrador', pendiente_aprobacion: 'Pendiente de aprobación', enviada: 'Enviada', confirmada: 'Confirmada',
    recibida_parcial: 'Parcial', recibida: 'Recibida', cancelada: 'Cancelada'
  };
  return map[e] || (typeof sanitize === 'function' ? sanitize(e) : e);
}

// ── Filtros ───────────────────────────────────────────────────────────
function aplicarFiltros() {
  filtros.proveedor_id = document.getElementById('filtro-proveedor')?.value || '';
  filtros.estado       = document.getElementById('filtro-estado')?.value || '';
  filtros.desde        = document.getElementById('filtro-desde')?.value || '';
  filtros.hasta        = document.getElementById('filtro-hasta')?.value || '';
  paginaActualOC = 1;
  cargarOrdenes();
}

// ── Modal nueva OC ────────────────────────────────────────────────────
function abrirModalNuevo() {
  modalOrdenId = null;
  itemsOC = [];
  document.getElementById('oc-proveedor').value = '';
  document.getElementById('oc-fecha-esperada').value = '';
  document.getElementById('oc-notas').value = '';
  renderItemsOC();
  actualizarTotalesOC();
  document.getElementById('modal-oc').style.display = 'flex';
}

function cerrarModalOC() {
  document.getElementById('modal-oc').style.display = 'none';
}

function cerrarModalSiFondo(event) {
  if (event.target.id === 'modal-oc' || event.target.id === 'modal-detalle') {
    event.target.style.display = 'none';
  }
}

// Items de la OC
function agregarItemOC() {
  itemsOC.push({ producto_id: '', nombre: '', cantidad: 1, precio_costo: 0, iva_pct: 21 });
  renderItemsOC();
}

function quitarItemOC(idx) {
  itemsOC.splice(idx, 1);
  renderItemsOC();
  actualizarTotalesOC();
}

function renderItemsOC() {
  const tbody = document.getElementById('tbody-items-oc');
  if (!tbody) return;

  if (!itemsOC.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:12px;color:var(--color-text-light);font-size:12px">Agregá productos a la orden</td></tr>`;
    return;
  }

  tbody.innerHTML = itemsOC.map((it, i) => `
    <tr>
      <td>
        <select onchange="seleccionarProductoOC(${i}, this.value)" style="width:100%;border:none;background:transparent;font-size:12px;color:var(--color-text)">
          <option value="">Seleccionar...</option>
          ${productosData.map(p => `<option value="${p.id}" ${p.id === it.producto_id ? 'selected' : ''}>${sanitize(p.nombre)}${p.codigo ? ' ('+p.codigo+')' : ''}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" min="0.001" step="any" value="${it.cantidad}" onchange="updateItemOC(${i},'cantidad',this.value)" /></td>
      <td><input type="number" min="0" step="1" data-money value="${Math.round(it.precio_costo)}" onchange="updateItemOC(${i},'precio_costo',this.value)" /></td>
      <td><input type="number" min="0" max="100" value="${it.iva_pct}" onchange="updateItemOC(${i},'iva_pct',this.value)" /></td>
      <td style="text-align:left;font-size:12px;font-weight:600">$${Number(it.cantidad * it.precio_costo).toLocaleString('es-AR',{minimumFractionDigits:2})}</td>
      <td><button class="btn-tabla peligro" onclick="quitarItemOC(${i})" style="padding:3px 8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></td>
    </tr>
  `).join('');
}

function seleccionarProductoOC(idx, productoId) {
  const prod = productosData.find(p => p.id === productoId);
  itemsOC[idx].producto_id  = productoId;
  itemsOC[idx].nombre       = prod?.nombre || '';
  itemsOC[idx].precio_costo = prod?.costo  || 0;
  renderItemsOC();
  actualizarTotalesOC();
}

function updateItemOC(idx, campo, valor) {
  itemsOC[idx][campo] = parseFloat(valor) || 0;
  actualizarTotalesOC();
}

function actualizarTotalesOC() {
  let subtotal = 0, iva = 0;
  itemsOC.forEach(it => {
    const sub = it.cantidad * it.precio_costo;
    subtotal += sub;
    iva      += sub * (it.iva_pct / 100);
  });
  const total = subtotal + iva;

  const el = id => document.getElementById(id);
  if (el('oc-subtotal')) el('oc-subtotal').textContent = `$${subtotal.toLocaleString('es-AR',{minimumFractionDigits:2})}`;
  if (el('oc-iva'))      el('oc-iva').textContent      = `$${iva.toLocaleString('es-AR',{minimumFractionDigits:2})}`;
  if (el('oc-total'))    el('oc-total').textContent    = `$${total.toLocaleString('es-AR',{minimumFractionDigits:2})}`;
}

async function guardarOC() {
  const btn = document.getElementById('btn-guardar-oc');
  if (!btn) return;

  const proveedorId = document.getElementById('oc-proveedor')?.value;
  if (!proveedorId) { mostrarToast('Seleccioná un proveedor', 'error'); return; }
  if (!itemsOC.length || !itemsOC.some(it => it.producto_id)) {
    mostrarToast('Agregá al menos un producto', 'error'); return;
  }

  const okOC = await window.confirmar(
    `¿Confirmás crear esta orden de compra (${itemsOC.filter(it => it.producto_id).length} producto${itemsOC.length === 1 ? '' : 's'})?`,
    { labelOk: 'Crear orden', labelCancel: 'Revisar' }
  );
  if (!okOC) return;

  btn.disabled = true; btn.textContent = 'Guardando...';

  try {
    const token  = (await sb.auth.getSession()).data.session?.access_token;
    const body   = {
      proveedor_id:   proveedorId,
      fecha_esperada: document.getElementById('oc-fecha-esperada')?.value || null,
      notas:          document.getElementById('oc-notas')?.value || null,
      items: itemsOC.filter(it => it.producto_id && it.cantidad > 0)
    };

    const res = await fetch('/api/compras', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    btn.disabled = false; btn.textContent = 'Crear orden';

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      mostrarToast(err.error || 'No se pudo crear la orden de compra', 'error');
      return;
    }

    mostrarToast('Orden de compra creada', 'exito');
    cerrarModalOC();
    await cargarOrdenes();
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Crear orden';
    mostrarToast(err.message || 'No se pudo crear la orden de compra', 'error');
  }
}

// ── Detalle y recepción ───────────────────────────────────────────────
async function verDetalle(id) {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch(`/api/compras?id=${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la orden de compra');
    const oc = await res.json();
    if (!oc?.id) { mostrarToast('No se pudo cargar la orden de compra', 'error'); return; }

    const el = (i) => document.getElementById(i);
    if (el('detalle-numero'))    el('detalle-numero').textContent    = oc.numero;
    if (el('detalle-proveedor')) el('detalle-proveedor').textContent = oc.proveedores?.razon_social || '—';
    if (el('detalle-estado'))    el('detalle-estado').innerHTML      = `<span class="badge badge-${sanitize(oc.estado)}">${labelEstado(oc.estado)}</span>`;
    if (el('detalle-fecha'))     el('detalle-fecha').textContent     = new Date(oc.fecha_pedido).toLocaleDateString('es-AR');
    if (el('detalle-total'))     el('detalle-total').textContent     = `$${Number(oc.total).toLocaleString('es-AR',{minimumFractionDigits:2})}`;

    const tbody = el('detalle-items-tbody');
    if (tbody) {
      tbody.innerHTML = (oc.ordenes_compra_items || []).map(it => {
        const pct  = it.cantidad > 0 ? Math.round((it.cantidad_recibida / it.cantidad) * 100) : 0;
        return `
          <tr>
            <td>${sanitize(it.productos?.nombre || '—')}</td>
            <td style="text-align:left">${Number(it.cantidad).toLocaleString('es-AR', {maximumFractionDigits:2})}</td>
            <td style="text-align:left">$${Number(it.precio_costo).toLocaleString('es-AR',{minimumFractionDigits:2})}</td>
            <td style="text-align:left">$${Number(it.subtotal).toLocaleString('es-AR',{minimumFractionDigits:2})}</td>
            <td>
              <div class="progreso-recepcion">
                <div class="barra-progreso"><div class="barra-progreso-fill" style="width:${pct}%"></div></div>
                <span>${Number(it.cantidad_recibida||0).toLocaleString('es-AR',{maximumFractionDigits:2})} / ${Number(it.cantidad).toLocaleString('es-AR',{maximumFractionDigits:2})}</span>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    // Guardar id para recepcionar
    if (el('btn-recepcionar-detalle')) {
      const puedeRecepcionar = ['borrador','enviada','confirmada','recibida_parcial'].includes(oc.estado);
      el('btn-recepcionar-detalle').style.display = puedeRecepcionar ? '' : 'none';
      el('btn-recepcionar-detalle').onclick = () => abrirRecepcionar(id);
    }

    if (el('btn-aprobar-detalle')) {
      const puedeAprobar = oc.estado === 'pendiente_aprobacion';
      el('btn-aprobar-detalle').style.display = puedeAprobar ? '' : 'none';
      el('btn-aprobar-detalle').onclick = () => aprobarOrdenCompras(id, el('btn-aprobar-detalle'));
    }

    if (el('btn-eliminar-detalle')) {
      const puedeEliminar = ['borrador', 'pendiente_aprobacion'].includes(oc.estado);
      el('btn-eliminar-detalle').style.display = puedeEliminar ? '' : 'none';
      el('btn-eliminar-detalle').onclick = () => eliminarOrdenCompra(id, el('btn-eliminar-detalle'));
    }

    if (el('btn-cancelar-detalle')) {
      const puedeCancelar = ['enviada', 'confirmada'].includes(oc.estado);
      el('btn-cancelar-detalle').style.display = puedeCancelar ? '' : 'none';
      el('btn-cancelar-detalle').onclick = () => cancelarOrdenCompra(id, el('btn-cancelar-detalle'));
    }

    if (el('modal-detalle')) el('modal-detalle').style.display = 'flex';
  } catch (err) {
    mostrarToast(err.message || 'No se pudo cargar la orden de compra', 'error');
  }
}

async function abrirRecepcionar(id) {
  // Cerrar detalle si está abierto
  const det = document.getElementById('modal-detalle');
  if (det) det.style.display = 'none';

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch(`/api/compras?id=${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la orden de compra');
    const oc = await res.json();
    if (!oc?.id) { mostrarToast('No se pudo cargar la orden de compra', 'error'); return; }

    const tbody = document.getElementById('tbody-recepcion');
    if (!tbody) return;

    tbody.innerHTML = (oc.ordenes_compra_items || []).map(it => {
      const pendiente = Math.max(0, it.cantidad - (it.cantidad_recibida || 0));
      return `
        <tr data-producto="${it.producto_id}" data-precio="${it.precio_costo}" data-pendiente="${pendiente}" data-nombre="${sanitize(it.productos?.nombre || '—')}">
          <td>${sanitize(it.productos?.nombre || '—')}</td>
          <td style="text-align:left">${Number(it.cantidad).toLocaleString('es-AR',{maximumFractionDigits:2})}</td>
          <td style="text-align:left;color:var(--color-warning)">${Number(pendiente).toLocaleString('es-AR',{maximumFractionDigits:2})}</td>
          <td><input type="number" min="0" max="${pendiente}" step="any" value="${pendiente}"
                style="width:80px;padding:4px 6px;border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:12px"
                data-campo="recibida" title="Máximo pendiente: ${pendiente}. Si el proveedor mandó más, se puede registrar el excedente por separado al confirmar." /></td>
          <td><input type="number" min="0" step="1" data-money value="${Math.round(it.precio_costo)}"
                style="width:90px;padding:4px 6px;border:1px solid var(--color-border);border-radius:var(--radius-sm);font-size:12px"
                data-campo="costo" /></td>
        </tr>
      `;
    }).join('');

    const modal = document.getElementById('modal-recepcion');
    if (modal) {
      modal.dataset.ocId = id;
      modal.dataset.numero = oc.numero || '';
      modal.style.display = 'flex';
      // Resetear zona OCR
      const ocEstado = document.getElementById('ocr-estado');
      const panelDiff = document.getElementById('panel-diff-ocr');
      if (ocEstado)  ocEstado.textContent = '';
      if (panelDiff) panelDiff.style.display = 'none';
      // Limpiar inputs y miniatura previa
      const inpImg    = document.getElementById('inp-remito-img');
      const inpCam    = document.getElementById('inp-remito-camara');
      const miniPrev  = document.getElementById('remito-miniatura');
      if (inpImg)   inpImg.value = '';
      if (inpCam)   inpCam.value = '';
      if (miniPrev) miniPrev.remove();
      const panelExc = document.getElementById('panel-excedente-recepcion');
      if (panelExc) panelExc.style.display = 'none';
      window._excedentesPendientes = null;
    }
  } catch (err) {
    mostrarToast(err.message || 'No se pudo cargar la orden de compra', 'error');
  }
}

async function confirmarRecepcion() {
  const modal = document.getElementById('modal-recepcion');
  if (!modal) return;

  const filas = document.querySelectorAll('#tbody-recepcion tr');

  const items = [];
  const excesos = [];
  filas.forEach(fila => {
    const productoId = fila.dataset.producto;
    const nombre     = fila.dataset.nombre || 'Producto';
    const pendiente  = parseFloat(fila.dataset.pendiente || 0);
    const cantRecib  = parseFloat(fila.querySelector('[data-campo="recibida"]')?.value || 0);
    const costo      = parseFloat(fila.querySelector('[data-campo="costo"]')?.value || 0);
    if (cantRecib <= 0) return;

    if (cantRecib > pendiente) {
      // No se manda a recepcionar_orden_compra más de lo pendiente — eso
      // rompería la trazabilidad de la OC. El exceso, si es real (el
      // proveedor mandó de más), se registra aparte como ajuste de stock
      // ("excedente de proveedor"), nunca inflando cantidad_recibida.
      excesos.push({ producto_id: productoId, nombre, exceso: cantRecib - pendiente });
      if (pendiente > 0) items.push({ producto_id: productoId, cantidad_recibida: pendiente, precio_costo: costo });
    } else {
      items.push({ producto_id: productoId, cantidad_recibida: cantRecib, precio_costo: costo });
    }
  });

  if (!items.length && !excesos.length) { mostrarToast('No hay cantidades a recepcionar', 'error'); return; }

  if (excesos.length) {
    mostrarPanelExcedente(excesos);
    // No se envía nada todavía: se espera confirmación explícita del
    // usuario en el panel de excedente (ver confirmarConExcedente()).
    return;
  }

  await _enviarRecepcion(items);
}

// ── Panel de excedente: cantidad recibida > pendiente de la OC ─────────
function mostrarPanelExcedente(excesos) {
  const panel = document.getElementById('panel-excedente-recepcion');
  const lista = document.getElementById('lista-excedente-recepcion');
  if (!panel || !lista) {
    // Fallback si el HTML del panel todavía no está en esta vista
    const detalle = excesos.map(e => `${e.nombre}: +${e.exceso}`).join(', ');
    mostrarToast(`Cantidad recibida supera lo pendiente (${detalle}). Ajustá la cantidad o registrá el excedente.`, 'error');
    return;
  }

  window._excedentesPendientes = excesos;

  lista.innerHTML = excesos.map(e => `
    <li>
      <strong>${sanitize(e.nombre)}</strong>: ${Number(e.exceso).toLocaleString('es-AR',{maximumFractionDigits:2})} unidad(es) por encima de lo pendiente en esta OC.
    </li>
  `).join('');
  panel.style.display = 'block';
}

async function confirmarConExcedente() {
  const excesos = window._excedentesPendientes || [];
  if (!excesos.length) return;

  const modal   = document.getElementById('modal-recepcion');
  const filas   = document.querySelectorAll('#tbody-recepcion tr');
  const numero  = modal?.dataset.numero || '';

  const items = [];
  filas.forEach(fila => {
    const productoId = fila.dataset.producto;
    const pendiente  = parseFloat(fila.dataset.pendiente || 0);
    const cantRecib  = parseFloat(fila.querySelector('[data-campo="recibida"]')?.value || 0);
    const costo      = parseFloat(fila.querySelector('[data-campo="costo"]')?.value || 0);
    if (cantRecib <= 0) return;
    const aRecepcionar = Math.min(cantRecib, pendiente);
    if (aRecepcionar > 0) items.push({ producto_id: productoId, cantidad_recibida: aRecepcionar, precio_costo: costo });
  });

  const btn = document.getElementById('btn-confirmar-excedente');
  if (btn) { btn.disabled = true; btn.textContent = 'Procesando...'; }

  try {
    // 1) Recepción "normal", capada a lo pendiente (nunca infla la OC).
    const resultado = await _enviarRecepcion(items, /*silencioso*/ true);
    if (!resultado?.ok) {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirmar de todos modos'; }
      return;
    }

    // 2) El excedente real se carga como ajuste de stock independiente,
    // con motivo "excedente_proveedor" y trazabilidad a la OC en las notas.
    // Usa la misma RPC (ajustar_stock) que ya usa el módulo de Stock para
    // ingresos/egresos manuales, vía sesión del usuario (no service_role).
    const depositoId = resultado.deposito_id;
    let excedentesOk = true, ultimoError = null;
    for (const e of excesos) {
      const { data, error } = await sb.rpc('ajustar_stock', {
        p_producto_id: e.producto_id,
        p_deposito_id: depositoId,
        p_delta: e.exceso,
        p_tipo: 'ingreso',
        p_motivo: 'excedente_proveedor',
        p_notas: `Excedente de proveedor — OC ${numero || ''} (recibido por encima de lo pedido)`,
      });
      if (error || !data?.ok) { excedentesOk = false; ultimoError = error?.message || data?.error; }
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar de todos modos'; }

    const panel = document.getElementById('panel-excedente-recepcion');
    if (panel) panel.style.display = 'none';
    window._excedentesPendientes = null;

    if (excedentesOk) {
      mostrarToast(`Recepcionados ${resultado.items_procesados} producto(s) y excedente registrado como ajuste de stock.`, 'exito');
    } else {
      mostrarToast(`Recepción confirmada, pero no se pudo registrar el excedente (${ultimoError || 'error desconocido'}). Registralo manualmente desde Stock.`, 'error');
    }

    modal.style.display = 'none';
    await cargarOrdenes();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar de todos modos'; }
    mostrarToast(err.message || 'No se pudo procesar la recepción con excedente.', 'error');
  }
}

async function _enviarRecepcion(items, silencioso = false) {
  const modal = document.getElementById('modal-recepcion');
  if (!modal) return { ok: false };

  const ocId        = modal.dataset.ocId;
  const recepcionId = modal.dataset.recepcionId || null;

  if (!items.length) { if (!silencioso) mostrarToast('No hay cantidades a recepcionar', 'error'); return { ok: false }; }

  const btn = document.getElementById('btn-confirmar-recepcion');
  if (btn && !silencioso) { btn.disabled = true; btn.textContent = 'Procesando...'; }

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch('/api/compras?accion=recepcionar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orden_id: ocId, items, recepcion_id: recepcionId })
    });

    if (btn && !silencioso) { btn.disabled = false; btn.textContent = 'Confirmar recepción'; }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      mostrarToast(err.error || 'No se pudo registrar la recepción', 'error');
      return { ok: false };
    }

    const data = await res.json();
    if (!silencioso) {
      mostrarToast(`Recepcionados ${data.items_procesados} producto(s). Stock actualizado.`, 'exito');
      modal.style.display = 'none';
      await cargarOrdenes();
    }
    return { ok: true, ...data };
  } catch (err) {
    if (btn && !silencioso) { btn.disabled = false; btn.textContent = 'Confirmar recepción'; }
    mostrarToast(err.message || 'No se pudo registrar la recepción', 'error');
    return { ok: false };
  }
}

function cancelarExcedenteRecepcion() {
  const panel = document.getElementById('panel-excedente-recepcion');
  if (panel) panel.style.display = 'none';
  window._excedentesPendientes = null;
}

// Fix hallazgo 4: 'descartada' existía en el CHECK constraint y en el badge
// de esta misma pantalla (línea ~606) pero nada la seteaba nunca — no había
// forma de rechazar un remito escaneado por OCR que no correspondía a la OC.
async function descartarRecepcion() {
  const modal = document.getElementById('modal-recepcion');
  if (!modal) return;

  const recepcionId = modal.dataset.recepcionId || null;
  if (!recepcionId) {
    // Sin recepción en borrador (nunca se escaneó remito) → no hay nada que
    // descartar en el servidor, solo cerrar el modal.
    modal.style.display = 'none';
    return;
  }

  const okDescartar = await window.confirmar(
    '¿Descartar este remito escaneado? La recepción quedará marcada como descartada.',
    { labelOk: 'Descartar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!okDescartar) return;

  const btn = document.getElementById('btn-descartar-recepcion');
  if (btn) { btn.disabled = true; btn.textContent = 'Descartando...'; }

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch('/api/compras?accion=descartar-recepcion', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recepcion_id: recepcionId })
    });

    if (btn) { btn.disabled = false; btn.textContent = 'Cancelar'; }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      mostrarToast(err.error || 'No se pudo descartar', 'error');
      return;
    }

    mostrarToast('Remito descartado', 'exito');
    modal.style.display = 'none';
    await cargarOrdenes();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Cancelar'; }
    mostrarToast(err.message || 'No se pudo descartar', 'error');
  }
}

// ── OCR Remito (Etapa 8.2) ────────────────────────────────────────────
async function escanearRemito(input) {
  const file = input.files[0];
  if (!file) return;

  const estado = document.getElementById('ocr-estado');
  const modal  = document.getElementById('modal-recepcion');
  const ocId   = modal?.dataset.ocId || null;

  if (estado) estado.textContent = '⏳ Procesando imagen...';

  // Convertir a base64
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result.split(',')[1]);
    r.onerror = () => reject(new Error('No se pudo leer el archivo'));
    r.readAsDataURL(file);
  });

  const mimeType = file.type || 'image/jpeg';

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;

    // 1. OCR con Claude Vision
    const res = await fetch(`/api/importar?vision=1&tipo=remito`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagen_base64: base64, mime_type: mimeType, orden_id: ocId })
    });

    if (!res.ok) {
      const err = await res.json();
      if (estado) estado.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' + window.sanitize(err.error || 'Error OCR');
      return;
    }

    const data = await res.json();
    const conc = data.conciliacion;

    // Guardar recepcion_id en el modal para usarlo al confirmar
    if (data.recepcion_id && modal) modal.dataset.recepcionId = data.recepcion_id;

    if (estado) estado.textContent = `⏳ OCR OK — subiendo foto...`;

    // 2. Subir foto al bucket 'remitos' (en paralelo, no bloquea)
    if (data.recepcion_id) {
      fetch('/api/compras?accion=upload-remito', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagen_base64: base64, mime_type: mimeType, recepcion_id: data.recepcion_id })
      })
      .then(r => r.json())
      .then(r => {
        if (r.foto_url && estado) {
          // Mostrar miniatura del remito
          _mostrarMiniatura(r.foto_url);
        }
      })
      .catch(e => console.warn('[upload-remito]', e.message));
    }

    if (estado) estado.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>${data.datos_ocr?.length || 0} producto(s) detectados`;

    // 3. Pre-rellenar la tabla con valores sugeridos por OCR
    if (conc?.items && conc.items.length) {
      _aplicarSugerenciasOcr(conc.items);
      _mostrarPanelDiff(conc.discrepancias || []);
    } else if (data.datos_ocr?.length) {
      _aplicarOcrSinConciliacion(data.datos_ocr);
      _mostrarPanelDiff([]);
    }

  } catch (err) {
    console.error('[compras] Error al procesar remito:', err);
    if (estado) estado.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>No pudimos leer el remito. Probá con otra foto.';
  } finally {
    // Resetear ambos inputs para que puedan volver a disparar onchange
    input.value = '';
    const otro = input.id === 'inp-remito-camara'
      ? document.getElementById('inp-remito-img')
      : document.getElementById('inp-remito-camara');
    if (otro) otro.value = '';
  }
}

function _mostrarMiniatura(fotoUrl) {
  // Insertar miniatura clickeable junto al estado OCR
  const zonaOcr = document.getElementById('zona-ocr-remito');
  if (!zonaOcr) return;
  let mini = document.getElementById('remito-miniatura');
  if (!mini) {
    mini = document.createElement('a');
    mini.id     = 'remito-miniatura';
    mini.target = '_blank';
    mini.rel    = 'noopener';
    mini.style.cssText = 'display:inline-block;margin-left:8px;vertical-align:middle';
    mini.innerHTML = `<img style="height:40px;border-radius:4px;border:1px solid var(--color-border);box-shadow:0 1px 4px rgba(0,0,0,.15)" alt="remito">`;
    zonaOcr.querySelector('div').appendChild(mini);
  }
  mini.href = fotoUrl;
  mini.querySelector('img').src = fotoUrl;
}

function _aplicarSugerenciasOcr(items) {
  // items viene de conciliacion.items: [{oc_item_id, cant_sugerida, precio_sugerido, ...}]
  const filas = document.querySelectorAll('#tbody-recepcion tr');
  filas.forEach(fila => {
    // cada fila tiene data-producto (producto_id); necesitamos oc_item_id
    // pero el tbody solo guarda producto_id — buscar por nombre si no hay oc_item_id
    const nombre = fila.querySelector('td:first-child')?.textContent?.toLowerCase().trim() || '';
    const match  = items.find(it =>
      (it.nombre || '').toLowerCase().includes(nombre) ||
      nombre.includes((it.nombre || '').toLowerCase())
    );
    if (!match) return;

    const inpCant  = fila.querySelector('[data-campo="recibida"]');
    const inpCosto = fila.querySelector('[data-campo="costo"]');
    if (inpCant  && match.cant_sugerida  != null) inpCant.value  = match.cant_sugerida;
    if (inpCosto && match.precio_sugerido != null) inpCosto.value = match.precio_sugerido;

    // Colorear fila si hay alerta
    fila.style.background = match.alerta ? 'rgba(184,122,0,0.08)' : '';
  });
}

function _aplicarOcrSinConciliacion(datosOcr) {
  // Solo OCR crudo sin conciliación — rellenar por similitud de nombre
  const filas = document.querySelectorAll('#tbody-recepcion tr');
  filas.forEach(fila => {
    const nombre = fila.querySelector('td:first-child')?.textContent?.toLowerCase().trim() || '';
    const match  = datosOcr.find(it =>
      (it.nombre || '').toLowerCase().includes(nombre) ||
      nombre.includes((it.nombre || '').toLowerCase())
    );
    if (!match) return;
    const inpCant  = fila.querySelector('[data-campo="recibida"]');
    const inpCosto = fila.querySelector('[data-campo="costo"]');
    if (inpCant  && match.cantidad       != null) inpCant.value  = match.cantidad;
    if (inpCosto && match.precio_unitario != null) inpCosto.value = match.precio_unitario;
  });
}

function _mostrarPanelDiff(discrepancias) {
  const panel = document.getElementById('panel-diff-ocr');
  const tbody = document.getElementById('tbody-diff-ocr');
  if (!panel || !tbody) return;

  if (!discrepancias.length) {
    panel.style.display = 'none';
    return;
  }

  tbody.innerHTML = discrepancias.map(d => {
    const colorCant  = Math.abs(d.diff_cant_pct   || 0) > 10 ? 'var(--color-danger-mid,#B3261E)' : 'var(--color-warning-mid,#B87A00)';
    const colorPrecio = Math.abs(d.diff_precio_pct || 0) > 10 ? 'var(--color-danger-mid,#B3261E)' : 'var(--color-warning-mid,#B87A00)';
    return `<tr>
      <td style="padding:4px 8px">${sanitize(d.nombre || '—')}</td>
      <td style="padding:4px 8px;text-align:left">${d.cant_pedida ?? '—'}</td>
      <td style="padding:4px 8px;text-align:left">${d.cant_ocr ?? '—'}</td>
      <td style="padding:4px 8px;text-align:left;color:${colorCant}">${d.diff_cant_pct != null ? d.diff_cant_pct + '%' : '—'}</td>
      <td style="padding:4px 8px;text-align:left;color:${colorPrecio}">${d.diff_precio_pct != null ? d.diff_precio_pct + '%' : '—'}</td>
    </tr>`;
  }).join('');

  panel.style.display = 'block';
}

// ── Historial de recepciones (Etapa 8.3) ─────────────────────────────
async function abrirHistorialRecepciones(ordenId = null) {
  const modal  = document.getElementById('modal-historial-recepciones');
  const body   = document.getElementById('historial-recepciones-body');
  if (!modal || !body) return;

  modal.style.display = 'flex';
  body.innerHTML = '<p style="font-size:13px;color:var(--color-text-muted);text-align:center;padding:20px 0">Cargando...</p>';

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const qs    = ordenId ? `&id=${ordenId}` : '';
    const res   = await fetch(`/api/compras?accion=historial-recepciones${qs}&limit=30`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) throw new Error('Error al cargar historial');
    const data = await res.json();
    body.innerHTML = _renderHistorial(data.recepciones || []);

  } catch (err) {
    console.error('[compras] Error al cargar historial de recepciones:', err);
    body.innerHTML = `<p style="color:var(--color-danger);padding:16px">No se pudo cargar el historial. Probá de nuevo en un momento.</p>`;
  }
}

function _renderHistorial(recepciones) {
  if (!recepciones.length) {
    return '<p style="font-size:13px;color:var(--color-text-muted);text-align:center;padding:30px 0">Sin recepciones registradas aún.</p>';
  }

  const filas = recepciones.map((r, idx) => {
    const fecha     = new Date(r.confirmada_at || r.created_at).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const estadoBadge = {
      confirmada:  '<span style="background:var(--color-success-bg,#DCEDE3);color:var(--color-success,#17402F);font-size:11px;padding:2px 8px;border-radius:99px">Confirmada</span>',
      borrador:    '<span style="background:var(--color-warning-bg,#FBEBC7);color:var(--color-warning,#7A4A00);font-size:11px;padding:2px 8px;border-radius:99px">Borrador</span>',
      descartada:  '<span style="background:var(--color-danger-bg,#F3DAD8);color:var(--color-danger,#7A1E19);font-size:11px;padding:2px 8px;border-radius:99px">Descartada</span>',
    }[r.estado] || r.estado;

    const discCount = Array.isArray(r.discrepancias) ? r.discrepancias.length : 0;
    const discCell  = discCount
      ? `<span style="color:var(--color-warning,#7A4A00);font-weight:600">⚠ ${discCount} difer.</span>`
      : '<span style="color:var(--color-text-muted)">—</span>';

    const miniatura = r.foto_url
      ? `<a href="${r.foto_url}" target="_blank" rel="noopener">
           <img src="${r.foto_url}" style="height:36px;border-radius:4px;border:1px solid var(--color-border);vertical-align:middle" alt="remito">
         </a>`
      : '<span style="color:var(--color-text-muted);font-size:12px">Sin foto</span>';

    const usuario = r.usuarios?.nombre || '—';
    const numeroOC = r.ordenes_compra?.numero ? `OC #${sanitize(r.ordenes_compra.numero)}` : '—';

    // Botón notificar — solo si tiene orden_id (hay proveedor) y está confirmada
    const btnNotif = (r.orden_id && r.estado === 'confirmada')
      ? `<button onclick="notificarProveedorRecepcion('${r.id}', this)"
           style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid var(--color-border);background:var(--color-surface-2,#EAE4D6);cursor:pointer;white-space:nowrap">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>Notificar
         </button>`
      : '<span style="color:var(--color-text-muted);font-size:12px">—</span>';

    // Detalle de productos/cantidades recepcionados en esta fila específica.
    const items = Array.isArray(r.items_conciliados) ? r.items_conciliados : [];
    const detalleId = `hist-detalle-${idx}`;
    const btnDetalle = items.length
      ? `<button onclick="document.getElementById('${detalleId}').style.display = document.getElementById('${detalleId}').style.display === 'none' ? 'table-row' : 'none'"
           style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--color-border);background:transparent;cursor:pointer">Ver detalle (${items.length})</button>`
      : '<span style="color:var(--color-text-muted);font-size:12px">Sin detalle</span>';

    const filaDetalle = items.length
      ? `<tr id="${detalleId}" style="display:none;background:var(--color-surface-2,#EAE4D6)">
           <td colspan="8" style="padding:6px 10px 10px 24px">
             <table style="width:100%;font-size:12px;border-collapse:collapse">
               <thead><tr style="color:var(--color-text-muted)">
                 <th style="text-align:left;font-weight:600;padding:2px 6px">Producto</th>
                 <th style="text-align:left;font-weight:600;padding:2px 6px">Cant. recibida</th>
                 <th style="text-align:left;font-weight:600;padding:2px 6px">Costo unit.</th>
               </tr></thead>
               <tbody>
                 ${items.map(it => `<tr>
                   <td style="padding:2px 6px">${sanitize(it.nombre || it.producto_id || '—')}</td>
                   <td style="padding:2px 6px;text-align:left">${it.cantidad_recibida ?? '—'}</td>
                   <td style="padding:2px 6px;text-align:left">${it.precio_costo != null ? '$' + Number(it.precio_costo).toLocaleString('es-AR',{minimumFractionDigits:2}) : '—'}</td>
                 </tr>`).join('')}
               </tbody>
             </table>
           </td>
         </tr>`
      : '';

    return `<tr style="border-bottom:1px solid var(--color-border)">
      <td style="padding:8px 10px;font-size:12px">${fecha}</td>
      <td style="padding:8px 10px;font-size:12px;font-weight:600">${numeroOC}</td>
      <td style="padding:8px 10px">${estadoBadge}</td>
      <td style="padding:8px 10px;font-size:12px;color:var(--color-text-muted)">${usuario}</td>
      <td style="padding:8px 10px">${discCell}</td>
      <td style="padding:8px 10px">${miniatura}</td>
      <td style="padding:8px 10px">${btnDetalle}</td>
      <td style="padding:8px 10px">${btnNotif}</td>
    </tr>${filaDetalle}`;
  }).join('');

  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:var(--color-surface-2,#EAE4D6);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--color-text-muted)">
          <th style="padding:8px 10px;text-align:left;font-weight:600">Fecha</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Orden</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Estado</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Usuario</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Difer.</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Remito</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Detalle</th>
          <th style="padding:8px 10px;text-align:left;font-weight:600">Acción</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>`;
}

async function notificarProveedorRecepcion(recepcionId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }

  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch('/api/compras?accion=notificar-proveedor', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recepcion_id: recepcionId })
    });

    const data = await res.json();

    if (!res.ok) {
      mostrarToast(data.error || 'No se pudo enviar el email', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>Notificar'; }
      return;
    }

    mostrarToast(`Email enviado a ${sanitize(data.email)}`, 'exito');
    if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Enviado'; btn.style.color = 'var(--color-success,#17402F)'; }

  } catch (err) {
    console.error('[compras] Error al notificar proveedor:', err);
    mostrarToast('No se pudo enviar el email. Probá de nuevo.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>Notificar'; }
  }
}

// ── Ir a cuentas corrientes: registrar factura de una OC recibida ─────────────
function irAFactura(ordenId, proveedorId) {
  const url = `/admin/cc-proveedores?proveedor=${proveedorId}&orden=${ordenId}`;
  window.location.href = url;
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)

// ── Arranque ──────────────────────────────────────────────────────────
window.authReady.then(() => {
  if (!window.authCtx?.perfil) { window.location.href = '/admin/login'; return; }
  init();
}).catch(err => {
  console.error('[compras.js] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});


// Exponer funciones al scope global (requerido por los onclick del HTML)
window.abrirHistorialRecepciones = abrirHistorialRecepciones;
window.abrirModalNuevo = abrirModalNuevo;
window.agregarItemOC = agregarItemOC;
window.cerrarModalOC = cerrarModalOC;
window.cerrarModalSiFondo = cerrarModalSiFondo;
window.confirmarRecepcion = confirmarRecepcion;
window.confirmarConExcedente = confirmarConExcedente;
window.cancelarExcedenteRecepcion = cancelarExcedenteRecepcion;
window.guardarOC = guardarOC;
