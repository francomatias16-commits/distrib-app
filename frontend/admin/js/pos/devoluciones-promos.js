// frontend/admin/js/pos/devoluciones-promos.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Panel admin: devoluciones y promociones.
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

function iniciarPanelDevoluciones() {
  _devVentaSel = null;
  document.getElementById('dev-venta-buscar').value = '';
  document.getElementById('dev-venta-resultado').innerHTML = '';
  document.getElementById('dev-items-panel').style.display = 'none';
  document.getElementById('dev-historial-lista').innerHTML = '';
}

window.buscarVentaDevolucion = async function () {
  const q = document.getElementById('dev-venta-buscar').value.trim();
  const resEl = document.getElementById('dev-venta-resultado');
  if (!q) { resEl.innerHTML = ''; return; }
  resEl.innerHTML = '<p class="pos-resultados-vacio">Buscando...</p>';
  try {
    const ventas = await apiGet(`/api/pos/ventas?q=${encodeURIComponent(q)}`);
    if (!ventas.length) { resEl.innerHTML = '<p class="pos-resultados-vacio">No se encontró ninguna venta con ese número.</p>'; return; }
    resEl.innerHTML = ventas.slice(0, 5).map(v => `
      <div class="pos-cliente-resultado" onclick="seleccionarVentaDevolucion('${v.id}')">
        <strong>N° ${escapeHtml(v.numero || '—')}</strong> · ${escapeHtml(v.clientes?.razon_social || 'Consumidor final')} · ${fmt(v.total)}
        ${v.estado === 'anulada' ? ' <span style="color:var(--color-danger,#7A2820)">[Anulada]</span>' : ''}
      </div>
    `).join('');
  } catch (e) {
    resEl.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al buscar')}</p>`;
  }
};

window.seleccionarVentaDevolucion = async function (ventaId) {
  document.getElementById('dev-venta-resultado').innerHTML = '<p class="pos-resultados-vacio">Cargando detalle...</p>';
  try {
    const venta = await apiGet(`/api/pos/ticket?venta_id=${ventaId}`);
    _devVentaSel = {
      id:     venta.id,
      numero: venta.numero,
      items:  (venta.venta_pos_items || []).map(i => ({
        id:            i.id,
        nombre:        i.productos?.nombre || 'Producto',
        cantidad:      parseFloat(i.cantidad),
        precio_unit:   parseFloat(i.precio_unitario),
        descuento_pct: parseFloat(i.descuento_pct || 0),
        subtotal:      parseFloat(i.subtotal),
      })),
    };

    document.getElementById('dev-venta-resultado').innerHTML =
      `<div style="padding:6px 0;font-size:13px;color:var(--color-text)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Venta N° <strong>${escapeHtml(venta.numero)}</strong> seleccionada</div>`;

    // Renderizar items con input de cantidad a devolver
    document.getElementById('dev-items-lista').innerHTML = _devVentaSel.items.map((it, idx) => `
      <div class="pos-dev-item-fila">
        <span class="pos-dev-item-nombre">${escapeHtml(it.nombre)}</span>
        <span class="pos-dev-item-cant-orig">Vendido: ${it.cantidad}</span>
        <input type="number" class="input-base pos-dev-item-input" id="dev-cant-${idx}"
               min="0" max="${it.cantidad}" step="1" placeholder="0" value="0" />
      </div>
    `).join('');

    document.getElementById('dev-items-panel').style.display = '';
    document.getElementById('dev-motivo').value = '';
    document.getElementById('dev-error').style.display = 'none';

    // Cargar historial de devoluciones previas
    const devs = await apiGet(`/api/pos/devoluciones?venta_id=${ventaId}`);
    renderHistorialDevoluciones(devs);
  } catch (e) {
    document.getElementById('dev-venta-resultado').innerHTML =
      `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar la venta')}</p>`;
  }
};

function renderHistorialDevoluciones(devs) {
  const cont = document.getElementById('dev-historial-lista');
  if (!devs.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = `<p class="pos-sec-label" style="margin-top:10px">Devoluciones registradas</p>` +
    devs.map(d => `
      <div class="pos-dev-historial-fila">
        <div class="pos-dev-historial-header">
          <span>${window.formatHora ? window.formatHora(d.created_at) : d.created_at} · ${escapeHtml(d.usuarios?.nombre || 'Usuario')}</span>
          <span class="pos-dev-monto">${fmt(d.monto_total)}</span>
        </div>
        ${d.motivo ? `<div style="font-size:11px;margin-bottom:3px;color:var(--color-text-light)">${escapeHtml(d.motivo)}</div>` : ''}
        <div class="pos-dev-historial-items">
          ${(d.devoluciones_pos_items || []).map(i =>
            `${i.cantidad_devuelta} × ${escapeHtml(i.productos?.nombre || 'Producto')} — ${fmt(i.monto)}`
          ).join('<br>')}
        </div>
      </div>
    `).join('');
}

window.confirmarDevolucion = async function () {
  const errEl = document.getElementById('dev-error');
  errEl.style.display = 'none';

  if (!_devVentaSel) { errEl.textContent = 'No hay venta seleccionada.'; errEl.style.display = ''; return; }

  const items = [];
  _devVentaSel.items.forEach((it, idx) => {
    const cant = parseInt(document.getElementById(`dev-cant-${idx}`)?.value || '0', 10);
    if (cant > 0) {
      items.push({ venta_pos_item_id: it.id, cantidad_devuelta: cant });
    }
  });

  if (!items.length) {
    errEl.textContent = 'Indicá al menos una cantidad a devolver mayor a cero.';
    errEl.style.display = '';
    return;
  }

  const motivo = document.getElementById('dev-motivo').value.trim();
  const btn = document.getElementById('btn-confirmar-devolucion');
  btn.disabled = true;

  try {
    await apiPost('/api/pos/devolucion', {
      venta_pos_id: _devVentaSel.id,
      items,
      motivo: motivo || null,
    });
    window.toast('Devolución registrada', 'exito');
    // Recargar historial
    const devs = await apiGet(`/api/pos/devoluciones?venta_id=${_devVentaSel.id}`);
    renderHistorialDevoluciones(devs);
    // Limpiar cantidades
    _devVentaSel.items.forEach((_, idx) => {
      const inp = document.getElementById(`dev-cant-${idx}`);
      if (inp) inp.value = '0';
    });
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo registrar la devolución';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

// ══════════════════════════════════════════════════════════════════════════
// FASE 4 — GESTIÓN DE PROMOCIONES
// ══════════════════════════════════════════════════════════════════════════

let _promoProdSel = null; // producto seleccionado para promo

async function iniciarPanelPromociones() {
  _promoProdSel = null;
  await Promise.all([cargarPromocionesAdmin(), cargarCategoriasParaPromo()]);
  renderPromoFormExtra();
}

async function cargarPromocionesAdmin() {
  const cont = document.getElementById('pos-promos-lista');
  try {
    const promos = await apiGet('/api/pos/promociones');
    if (!promos.length) {
      cont.innerHTML = '<p class="pos-resultados-vacio">No hay promociones configuradas.</p>';
      return;
    }
    cont.innerHTML = promos.map(p => {
      const desc = p.tipo === 'nxm'
        ? `${p.n_cantidad}x${p.m_paga}`
        : `${p.descuento_pct}% de descuento`;
      const objetivo = p.productos?.nombre || p.categorias?.nombre || '(todos)';
      return `
        <div class="pos-promo-fila">
          <div class="pos-promo-info">
            <div class="pos-promo-nombre">${escapeHtml(p.nombre)}</div>
            <div class="pos-promo-meta">${desc} · ${escapeHtml(objetivo)}</div>
          </div>
          <span class="pos-promo-badge ${p.activa ? 'activa' : 'inactiva'}">${p.activa ? 'Activa' : 'Inactiva'}</span>
          <button class="btn btn--sm" onclick="togglePromo('${p.id}')">${p.activa ? 'Pausar' : 'Activar'}</button>
          <button class="pos-venta-btn-anular" onclick="eliminarPromo('${p.id}')">Eliminar</button>
        </div>
      `;
    }).join('');
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar')}</p>`;
  }
}

async function cargarCategoriasParaPromo() {
  try {
    const cats = await apiGet('/api/categorias');
    const sel = document.getElementById('promo-cat-select');
    if (!sel) return;
    sel.innerHTML = (cats || []).map(c => `<option value="${sanitize(c.id)}">${escapeHtml(c.nombre)}</option>`).join('')
      || '<option value="">Sin categorías</option>';
  } catch (_e) {}
}

window.renderPromoFormExtra = function () {
  const tipo = document.getElementById('promo-tipo')?.value;
  document.getElementById('promo-extra-nxm').style.display         = tipo === 'nxm' ? '' : 'none';
  document.getElementById('promo-extra-descuento').style.display   = tipo !== 'nxm' ? '' : 'none';
  document.getElementById('promo-extra-producto').style.display    = tipo === 'descuento_producto' ? '' : 'none';
  document.getElementById('promo-extra-categoria').style.display   = tipo === 'descuento_categoria' ? '' : 'none';
};

// Búsqueda de producto para promo
let _promoBuscarTimer = null;
document.getElementById('promo-prod-buscar')?.addEventListener('input', (e) => {
  clearTimeout(_promoBuscarTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('promo-prod-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  _promoBuscarTimer = setTimeout(async () => {
    try {
      const res = await apiGet(`/api/pos/productos?q=${encodeURIComponent(q)}`);
      cont.innerHTML = (res || []).slice(0, 8).map(p => `
        <div class="pos-cliente-resultado" data-id="${p.id}" data-nombre="${escapeHtml(p.nombre)}">
          ${escapeHtml(p.nombre)} <span style="color:var(--color-text-light)">${escapeHtml(p.codigo || '')}</span>
        </div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          _promoProdSel = el.dataset.id;
          document.getElementById('promo-prod-sel').style.display = '';
          document.getElementById('promo-prod-sel').textContent = el.dataset.nombre;
          document.getElementById('promo-prod-buscar').value = '';
          cont.innerHTML = '';
        });
      });
    } catch (_e) {}
  }, 220);
});

window.crearPromocion = async function () {
  const errEl = document.getElementById('promo-error');
  errEl.style.display = 'none';

  const nombre = document.getElementById('promo-nombre').value.trim();
  const tipo   = document.getElementById('promo-tipo').value;
  const desde  = document.getElementById('promo-desde').value || null;
  const hasta  = document.getElementById('promo-hasta').value || null;

  const body = { accion: 'crear', nombre, tipo, fecha_desde: desde, fecha_hasta: hasta };

  if (tipo === 'nxm') {
    body.n_cantidad = parseInt(document.getElementById('promo-n').value);
    body.m_paga     = parseInt(document.getElementById('promo-m').value);
  } else {
    body.descuento_pct = parseFloat(document.getElementById('promo-pct').value);
    if (tipo === 'descuento_producto') body.producto_id   = _promoProdSel;
    if (tipo === 'descuento_categoria') body.categoria_id = document.getElementById('promo-cat-select').value;
  }

  const btn = document.getElementById('btn-crear-promo');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/promociones', body);
    window.toast('Promoción creada', 'exito');
    document.getElementById('promo-nombre').value = '';
    document.getElementById('promo-pct').value = '';
    document.getElementById('promo-n').value = '2';
    document.getElementById('promo-m').value = '1';
    document.getElementById('promo-desde').value = '';
    document.getElementById('promo-hasta').value = '';
    _promoProdSel = null;
    document.getElementById('promo-prod-sel').style.display = 'none';
    await cargarPromocionesAdmin();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo crear la promoción';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
};

window.togglePromo = async function (id) {
  try {
    const res = await apiPost('/api/pos/promociones', { accion: 'toggle', id });
    window.toast(res.activa ? 'Promoción activada' : 'Promoción pausada', 'default');
    await cargarPromocionesAdmin();
  } catch (e) {
    console.error(e);
    window.toast('Error al cambiar estado', 'error');
  }
};

window.eliminarPromo = async function (id) {
  const ok = await window.confirmar('¿Eliminar esta promoción? Esta acción no se puede deshacer.', { tipo: 'danger', labelOk: 'Eliminar' });
  if (!ok) return;
  try {
    await apiPost('/api/pos/promociones', { accion: 'eliminar', id });
    window.toast('Promoción eliminada', 'default');
    await cargarPromocionesAdmin();
  } catch (e) {
    console.error(e);
    window.toast('Error al eliminar', 'error');
  }
};

// ══════════════════════════════════════════════════════════════════════════
// OFFLINE MODE — Feature #3 Grupo B
// ══════════════════════════════════════════════════════════════════════════

// Ticket para ventas que quedaron encoladas offline
