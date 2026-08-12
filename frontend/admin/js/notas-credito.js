// frontend/admin/js/notas-credito.js
// Módulo de notas de crédito — REQ-03
// Se carga junto a facturacion.js en facturacion.html

let ncData = [];
let modalNcId = null;
let itemsNC = [];
let clientesNC = []; // caché de clientes
let facturasNC = []; // caché de facturas para asociar

let paginaActualNC = 1;
const ITEMS_POR_PAGINA_NC = 50;
let totalNCFiltradas = 0;

// ── Carga ─────────────────────────────────────────────────────────────
// Antes: dos fetch separados (manuales via /api/notas-credito ignorando
// paginación, + facturas tipo='NC_C' SIN ningún .limit()) mergeados y
// ordenados en el navegador, sin paginación de UI ni búsqueda de texto.
// Ahora: una sola RPC (fn_notas_credito_lista, migración 264) que unifica
// ambas fuentes en SQL, con búsqueda, filtro de estado y paginación real.
async function cargarNotasCredito(filtrosNC = {}) {
  try {
    const busq = document.getElementById('nc-busqueda')?.value.trim() || '';
    const estado = filtrosNC.estado ?? document.getElementById('nc-filtro-estado')?.value ?? '';
    const desde = (paginaActualNC - 1) * ITEMS_POR_PAGINA_NC;

    const { data, error } = await window.authCtx.sb.rpc('fn_notas_credito_lista', {
      p_busqueda: busq || null,
      p_estado: estado || null,
      p_limit: ITEMS_POR_PAGINA_NC,
      p_offset: desde,
    });

    if (error) throw error;

    ncData = (data || []).map(n => ({
      id: n.id,
      tipo: n.tipo,
      numero: n.numero,
      estado: n.estado,
      motivo: n.motivo,
      total: n.total,
      fecha_emision: n.fecha_emision,
      cae: n.cae,
      pdf_url: n.pdf_url,
      clientes: (n.cliente_razon_social || n.cliente_nombre_fantasia)
        ? { razon_social: n.cliente_razon_social, nombre_fantasia: n.cliente_nombre_fantasia }
        : null,
      facturas: n.factura_numero ? { numero: n.factura_numero } : null,
      _fuente: n.fuente,
    }));
    totalNCFiltradas = data?.[0]?.total_count || 0;

    renderTablaNC();
    actualizarControlesPaginacionNC();
  } catch (err) {
    console.error('[notas-credito] Error cargando:', err);
    mostrarToast('No se pudieron cargar las notas de crédito', 'error');
  }
}

// ── Paginación ──────────────────────────────────────────────────────────
function inyectarControlesPaginacionNC() {
  if (document.getElementById('paginacion-nc')) return; // ya existe
  const contenedor = document.getElementById('panel-nc');
  if (!contenedor) return;
  const div = document.createElement('div');
  div.id = 'paginacion-nc';
  div.className = 'paginacion-container';
  div.innerHTML = `
      <button id="btn-prev-nc" class="btn-pag" onclick="cambiarPaginaNC(-1)">Anterior</button>
      <span id="info-pag-nc">Página 1</span>
      <button id="btn-next-nc" class="btn-pag" onclick="cambiarPaginaNC(1)">Siguiente</button>
  `;
  contenedor.appendChild(div);
}

function actualizarControlesPaginacionNC() {
  const totalPaginas = Math.max(1, Math.ceil(totalNCFiltradas / ITEMS_POR_PAGINA_NC));
  const info = document.getElementById('info-pag-nc');
  if (info) info.textContent = `Página ${paginaActualNC} de ${totalPaginas} (${totalNCFiltradas} notas)`;
  const btnPrev = document.getElementById('btn-prev-nc');
  const btnNext = document.getElementById('btn-next-nc');
  if (btnPrev) btnPrev.disabled = paginaActualNC <= 1;
  if (btnNext) btnNext.disabled = paginaActualNC >= totalPaginas;
}

function cambiarPaginaNC(delta) {
  const totalPaginas = Math.max(1, Math.ceil(totalNCFiltradas / ITEMS_POR_PAGINA_NC));
  const nueva = paginaActualNC + delta;
  if (nueva < 1 || nueva > totalPaginas) return;
  paginaActualNC = nueva;
  cargarNotasCredito({});
}
window.cambiarPaginaNC = cambiarPaginaNC;

// Dispara desde el buscador (debounce) o el select de estado: siempre
// vuelve a página 1 antes de recargar.
function filtrarNC() {
  paginaActualNC = 1;
  cargarNotasCredito({});
}
window.filtrarNC = filtrarNC;

let _debounceBusquedaNC = null;
function onBusquedaNCInput() {
  clearTimeout(_debounceBusquedaNC);
  _debounceBusquedaNC = setTimeout(() => filtrarNC(), 250);
}
window.onBusquedaNCInput = onBusquedaNCInput;

// Inyecta los controles de paginación la primera vez que se muestra la
// pestaña (facturacion.html ya llama a cargarNotasCredito({}) en switchTab).
try { inyectarControlesPaginacionNC(); } catch(e) { console.warn('[notas-credito] paginacion init:', e.message); }

async function cargarClientesNC() {
  try {
    const { data, error } = await window.authCtx.sb.from('clientes')
      .select('id, razon_social, nombre_fantasia, condicion_iva')
      .eq('activo', true).order('razon_social');
    if (error) throw error;
    clientesNC = data || [];

    const sel = document.getElementById('nc-cliente');
    if (sel) {
      sel.innerHTML = '<option value="">Seleccionar cliente...</option>' +
        clientesNC.map(c => `<option value="${c.id}">${window.sanitize(c.razon_social || c.nombre_fantasia)}</option>`).join('');
    }
  } catch (err) {
    mostrarToast(err.message || 'No se pudieron cargar los clientes.', 'error');
  }
}

// ── Render ────────────────────────────────────────────────────────────
function renderTablaNC() {
  const tbody = document.getElementById('tbody-nc');
  if (!tbody) return;

  if (!ncData.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="vacio">No hay notas de crédito ni débito emitidas. Se generan desde el detalle de una factura o una devolución.</td></tr>';
    return;
  }

  tbody.innerHTML = ncData.map(nc => {
    const fecha  = new Date(nc.fecha_emision).toLocaleDateString('es-AR');
    const nombre = nc.clientes?.razon_social || nc.clientes?.nombre_fantasia || '—';    return `
      <tr>
        <td style="font-weight:600">${nc.numero || `NC-${nc.tipo} (pendiente)`}</td>
        <td>${sanitize(nombre)}</td>
        <td style="font-size:12px;color:var(--color-text-muted)">${fecha}</td>
        <td style="font-size:12px;color:var(--color-text-muted)">${nc.facturas?.numero || '—'}</td>
        <td style="text-align:left;font-weight:600">$${Number(nc.total).toLocaleString('es-AR',{minimumFractionDigits:2})}</td>
        <td><span class="badge badge-${nc.estado}">${labelEstadoNC(nc.estado)}</span></td>
        <td class="col-sticky-end">
          <div class="acciones-td" style="white-space:nowrap">
            ${nc.estado === 'pendiente'
              ? `<button class="btn-tabla primario" onclick="emitirNC('${nc.id}')">Emitir AFIP</button>
                 <button class="btn-tabla" onclick="verDetalleNC('${nc.id}')">Ver</button>`
              : `<button class="btn-tabla" onclick="verDetalleNC('${nc.id}')">Ver</button>`
            }
            ${nc.pdf_url ? `<a class="btn-tabla" href="${nc.pdf_url}" target="_blank">PDF</a>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function labelEstadoNC(e) {
  const map = {
    pendiente: 'Pendiente', emitida: 'Emitida', aplicada: 'Aplicada',
    anulada: 'Anulada', error_afip: 'Error AFIP'
  };
  return map[e] || (typeof sanitize === 'function' ? sanitize(e) : e);
}

// ── Modal nueva NC ────────────────────────────────────────────────────
function abrirModalNuevoNC() {
  modalNcId = null;
  itemsNC = [];
  document.getElementById('nc-cliente').value  = '';
  document.getElementById('nc-factura').value  = '';
  document.getElementById('nc-tipo').value     = 'B';
  document.getElementById('nc-motivo').value   = '';
  renderItemsNC();
  actualizarTotalesNC();
  document.getElementById('modal-nc').style.display = 'flex';
  cargarClientesNC();
}

function cerrarModalNC() {
  document.getElementById('modal-nc').style.display = 'none';
  modalNcId = null;
}

// Al seleccionar cliente, autocompleta tipo NC y carga sus facturas
async function onClienteNC(clienteId) {
  if (!clienteId) return;
  const cliente = clientesNC.find(c => c.id === clienteId);

  // Sugerir tipo según condición IVA
  if (cliente?.condicion_iva === 'responsable_inscripto') {
    document.getElementById('nc-tipo').value = 'A';
  } else {
    document.getElementById('nc-tipo').value = 'B';
  }

  // Cargar facturas del cliente para asociar
  try {
    const { data: facturas, error } = await window.authCtx.sb.from('facturas')
      .select('id, numero')
      .eq('cliente_id', clienteId)
      .in('estado', ['emitida', 'pagada'])
      .order('fecha_emision', { ascending: false })
      .limit(30);
    if (error) throw error;

    const sel = document.getElementById('nc-factura');
    if (sel) {
      sel.innerHTML = '<option value="">Sin factura asociada</option>' +
        (facturas || []).map(f => `<option value="${f.id}">${f.numero}</option>`).join('');
    }
  } catch (err) {
    mostrarToast(err.message || 'No se pudieron cargar las facturas del cliente.', 'error');
  }
}

// Items de la NC
function agregarItemNC() {
  itemsNC.push({ producto_id: null, descripcion: '', cantidad: 1, precio_unitario: 0 });
  renderItemsNC();
}

function quitarItemNC(idx) {
  itemsNC.splice(idx, 1);
  renderItemsNC();
  actualizarTotalesNC();
}

function renderItemsNC() {
  const tbody = document.getElementById('tbody-items-nc');
  if (!tbody) return;

  if (!itemsNC.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:12px;color:var(--color-text-light);font-size:12px">Agregue ítems a la nota de crédito</td></tr>`;
    return;
  }

  tbody.innerHTML = itemsNC.map((it, i) => `
    <tr>
      <td colspan="1">
        <input type="text" value="${sanitize(it.descripcion)}" placeholder="Descripción del item..."
          onchange="updateItemNC(${i},'descripcion',this.value)"
          style="width:100%;border:none;background:transparent;font-size:12px;color:var(--color-text)" />
      </td>
      <td><input type="number" min="0.001" step="any" value="${it.cantidad}"
            onchange="updateItemNC(${i},'cantidad',this.value)" /></td>
      <td><input type="number" min="0" step="1" data-money value="${Math.round(it.precio_unitario)}"
            onchange="updateItemNC(${i},'precio_unitario',this.value)" /></td>
      <td style="text-align:left;font-size:12px;font-weight:600">
        $${Number(it.cantidad * it.precio_unitario).toLocaleString('es-AR',{minimumFractionDigits:2})}
      </td>
      <td><button class="btn-tabla peligro" onclick="quitarItemNC(${i})" style="padding:3px 8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></td>
    </tr>
  `).join('');
}

function updateItemNC(idx, campo, valor) {
  if (campo === 'descripcion') itemsNC[idx][campo] = valor;
  else itemsNC[idx][campo] = parseFloat(valor) || 0;
  actualizarTotalesNC();
}

function actualizarTotalesNC() {
  const tipo = document.getElementById('nc-tipo')?.value || 'B';
  let neto = 0;
  itemsNC.forEach(it => { neto += it.cantidad * it.precio_unitario; });
  const iva   = neto * 0.21;
  const total = neto + iva;

  const f = (n) => `$${n.toLocaleString('es-AR',{minimumFractionDigits:2})}`;
  const el = id => document.getElementById(id);
  if (el('nc-neto'))  el('nc-neto').textContent  = f(neto);
  if (el('nc-iva'))   el('nc-iva').textContent   = tipo === 'C' ? '$0,00' : f(iva);
  if (el('nc-total')) el('nc-total').textContent = tipo === 'C' ? f(neto) : f(total);
}

async function guardarNC() {
  const btn = document.getElementById('btn-guardar-nc');
  if (!btn) return;

  const clienteId = document.getElementById('nc-cliente')?.value;
  const motivo    = document.getElementById('nc-motivo')?.value?.trim();
  const tipo      = document.getElementById('nc-tipo')?.value || 'B';
  const facturaId = document.getElementById('nc-factura')?.value || null;

  if (!clienteId) { mostrarToast('Seleccioná un cliente', 'error'); return; }
  if (!motivo)    { mostrarToast('El motivo es requerido', 'error'); return; }
  if (!itemsNC.length || !itemsNC.some(it => it.descripcion)) {
    mostrarToast('Agregá al menos un ítem', 'error'); return;
  }

  const okNC = await window.confirmar(
    '¿Confirmás crear esta nota de crédito? Una vez emitida ante AFIP no se puede deshacer.',
    { labelOk: 'Crear NC', labelCancel: 'Revisar' }
  );
  if (!okNC) return;

  btn.disabled = true; btn.textContent = 'Guardando...';

  try {
    const token = (await window.authCtx.sb.auth.getSession()).data.session?.access_token;
    const body  = {
      cliente_id: clienteId,
      factura_id: facturaId,
      tipo, motivo,
      items: itemsNC.filter(it => it.descripcion && it.precio_unitario > 0)
    };

    const res = await fetch('/api/notas-credito', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    btn.disabled = false; btn.textContent = 'Crear NC';

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      mostrarToast(err.error || 'Error al crear la NC', 'error');
      return;
    }

    mostrarToast('Nota de crédito creada. Pendiente de emisión AFIP.', 'exito');
    cerrarModalNC();
    await cargarNotasCredito();
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Crear NC';
    mostrarToast(err.message || 'Error al crear la NC', 'error');
  }
}

// ── Emitir contra AFIP ────────────────────────────────────────────────
async function emitirNC(id) {
  if (!(await confirmar('¿Emitir esta nota de crédito contra AFIP vía FacturAPI?', { labelOk: 'Emitir a AFIP', tipo: 'danger' }))) return;

  try {
    const token = (await window.authCtx.sb.auth.getSession()).data.session?.access_token;
    mostrarToast('Enviando a AFIP...', '');

    const res = await fetch('/api/notas-credito?accion=emitir', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      mostrarToast(`Error AFIP: ${err.error || 'Sin detalle'}`, 'error');
      return;
    }

    const data = await res.json();
    mostrarToast(`NC emitida. CAE: ${data.nc?.cae || '—'}`, 'exito');
    await cargarNotasCredito();
    // FIX F3-05: si la NC estaba vinculada a una factura, emitirla contra
    // ARCA marca esa factura original como 'anulada' en la BD (ver
    // lib/facturas.js: anularFactura()/emitirNotaCreditoARCA()). El tab
    // "Facturas" de esta misma página no se recarga solo al volver a él
    // (switchTab() únicamente recarga 'nc' y 'ch'), así que sin este
    // refresh la grilla y el modal de detalle seguían mostrando el estado
    // viejo ('emitida') — incluyendo el botón "Anular" — hasta que el
    // usuario recargaba la página a mano.
    if (typeof window.cargarFacturas === 'function') await window.cargarFacturas();
    if (typeof window.cargarContadoresFacturas === 'function') await window.cargarContadoresFacturas();
  } catch (err) {
    mostrarToast(`Error AFIP: ${err.message || 'Sin detalle'}`, 'error');
  }
}

// ── Detalle ───────────────────────────────────────────────────────────
async function verDetalleNC(id) {
  try {
    const token = (await window.authCtx.sb.auth.getSession()).data.session?.access_token;
    const res   = await fetch(`/api/notas-credito?id=${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar el detalle de la nota de crédito.');
    const nc = await res.json();
    if (!nc?.id) return;

    const el = i => document.getElementById(i);
    const nombre = nc.clientes?.razon_social || nc.clientes?.nombre_fantasia || '—';
    if (el('nc-detalle-numero'))  el('nc-detalle-numero').textContent  = nc.numero || 'Sin número AFIP';
    if (el('nc-detalle-cliente')) el('nc-detalle-cliente').textContent = nombre;
    if (el('nc-detalle-estado'))  el('nc-detalle-estado').innerHTML    = `<span class="badge badge-${sanitize(nc.estado)}">${labelEstadoNC(nc.estado)}</span>`;
    if (el('nc-detalle-total'))   el('nc-detalle-total').textContent   = `$${Number(nc.total).toLocaleString('es-AR',{minimumFractionDigits:2})}`;
    if (el('nc-detalle-cae'))     el('nc-detalle-cae').textContent     = nc.cae || '—';
    if (el('nc-detalle-motivo'))  el('nc-detalle-motivo').textContent  = nc.motivo;

    const tbody = el('nc-detalle-items');
    if (tbody) {
      tbody.innerHTML = (nc.notas_credito_items || []).map(it => `
        <tr>
          <td>${sanitize(it.descripcion)}</td>
          <td style="text-align:left">${Number(it.cantidad).toLocaleString('es-AR',{maximumFractionDigits:2})}</td>
          <td style="text-align:left">$${Number(it.precio_unitario).toLocaleString('es-AR',{minimumFractionDigits:2})}</td>
          <td style="text-align:left;font-weight:600">$${Number(it.subtotal).toLocaleString('es-AR',{minimumFractionDigits:2})}</td>
        </tr>
      `).join('');
    }

    if (el('modal-nc-detalle')) el('modal-nc-detalle').style.display = 'flex';
  } catch (err) {
    mostrarToast(err.message || 'No se pudo cargar el detalle de la nota de crédito.', 'error');
  }
}

// [Etapa 3] mostrarToast local eliminado — usa window.mostrarToast global (ui-utils.js)
