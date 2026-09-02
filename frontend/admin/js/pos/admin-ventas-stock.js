// frontend/admin/js/pos/admin-ventas-stock.js
// Parte del split de frontend/admin/js/pos.js (25/08/2026) — Panel admin: pestaña Ventas (anular) y Stock (transferencias).
// Se carga como <script> clásico (no ES module) en pos.html, en el mismo
// orden que ocupaba en el archivo original, para preservar el scope global
// compartido entre secciones (variables de estado, funciones window.*).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

// ── Pestaña Ventas (anular) ──────────────────────────────────────────────
async function cargarVentas(q) {
  const cont = document.getElementById('pos-admin-ventas-lista');
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const desde  = document.getElementById('pos-admin-ventas-desde')?.value;
    const hasta  = document.getElementById('pos-admin-ventas-hasta')?.value;
    const estado = document.getElementById('pos-admin-ventas-estado')?.value;
    if (desde)  params.set('desde', desde);
    if (hasta)  params.set('hasta', hasta);
    if (estado) params.set('estado', estado);
    params.set('limit', '500');
    const ventas = await apiGet(`/api/pos/ventas${params.toString() ? '?' + params.toString() : ''}`);
    ventasAdminCache = ventas;
    ventasPaginaActual = 1; // nuevo filtro/búsqueda/día → siempre arranca en la página 1
    renderResumenVentas(ventas);
    renderVentas(ventas);
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar las ventas')}</p>`;
  }
}

let ventasAdminCache = [];

window.exportarVentasExcel = function () {
  if (!ventasAdminCache.length) { window.toast('No hay ventas para exportar', 'error'); return; }
  const filas = ventasAdminCache.map(v => ({
    'Número':        v.numero || '',
    'Fecha':         v.created_at ? new Date(v.created_at).toLocaleString('es-AR') : '',
    'Cliente':       v.clientes?.razon_social || 'Consumidor final',
    'Caja':          v.cajas_pos?.nombre || '',
    'Total':         Number(v.total) || 0,
    'Descuento (%)': v.descuento_global_pct || 0,
    'Estado':        v.estado || '',
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ventas POS');
  XLSX.writeFile(wb, `ventas-pos-${new Date().toISOString().slice(0,10)}.xlsx`);
};

document.getElementById('pos-admin-buscar-venta')?.addEventListener('input', (e) => {
  clearTimeout(buscarVentaTimer);
  const q = e.target.value.trim();
  buscarVentaTimer = setTimeout(() => cargarVentas(q), 250);
});

// FIX: no había ninguna vista agregada de "cuánto vendí por día" — solo la
// lista plana de ventas (una por una) o el historial de arqueo por turno en
// Cajas. Este resumen agrupa por día lo que ya está cargado y filtrado en
// pantalla (respeta buscador, rango de fechas y estado), sin pegarle otra
// vez al backend. Clic en un día → filtra la lista a ese día.
function fechaLocalKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

window.filtrarPorDia = function (fechaKey) {
  document.getElementById('pos-admin-ventas-desde').value = fechaKey;
  document.getElementById('pos-admin-ventas-hasta').value = fechaKey;
  cargarVentas(document.getElementById('pos-admin-buscar-venta')?.value.trim());
};

function renderResumenVentas(ventas) {
  const cont = document.getElementById('pos-admin-ventas-resumen');
  if (!cont) return;
  if (!ventas.length) { cont.innerHTML = ''; return; }

  const porDia = new Map(); // fechaKey -> { fechaKey, cantidad, total, anuladas }
  for (const v of ventas) {
    const key = fechaLocalKey(v.created_at);
    if (!porDia.has(key)) porDia.set(key, { fechaKey: key, cantidad: 0, total: 0, anuladas: 0 });
    const d = porDia.get(key);
    if (v.estado === 'anulada') {
      d.anuladas++;
    } else {
      d.cantidad++;
      d.total += Number(v.total) || 0;
    }
  }

  const dias = [...porDia.values()].sort((a, b) => b.fechaKey.localeCompare(a.fechaKey));
  const totalGeneral = dias.reduce((acc, d) => acc + d.total, 0);
  const cantidadGeneral = dias.reduce((acc, d) => acc + d.cantidad, 0);

  cont.innerHTML = `
    <div class="pos-ventas-resumen-tabla">
      <div class="pos-ventas-resumen-fila pos-ventas-resumen-header">
        <span>Día</span><span>Ventas</span><span>Anuladas</span><span>Total</span>
      </div>
      ${dias.map(d => `
        <div class="pos-ventas-resumen-fila" onclick="filtrarPorDia('${d.fechaKey}')" title="Ver el detalle de este día">
          <span>${escapeHtml(new Date(d.fechaKey + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' }))}</span>
          <span>${d.cantidad}</span>
          <span>${d.anuladas ? d.anuladas : '—'}</span>
          <span>${fmt(d.total)}</span>
        </div>
      `).join('')}
      <div class="pos-ventas-resumen-fila pos-ventas-resumen-total">
        <span>Total del período</span><span>${cantidadGeneral}</span><span></span><span>${fmt(totalGeneral)}</span>
      </div>
    </div>`;
}

// FIX: la lista de ventas volcaba las hasta 500 filas que trae el backend
// en un solo bloque scrolleable, sin paginar — con la caja abierta un rato,
// eso son cientos de filas apiladas y sin ninguna referencia de "dónde estoy".
// Paginamos en el cliente (ya tenemos todo el período cargado en memoria
// para el resumen por día, así que no hace falta pegarle de nuevo al
// backend por cada página) y dejamos el resumen intacto viendo el período
// completo, como antes.
const VENTAS_POR_PAGINA = 20;
let ventasPaginaActual = 1;

function renderVentas(ventas) {
  const cont = document.getElementById('pos-admin-ventas-lista');
  const contPag = document.getElementById('pos-admin-ventas-paginacion');
  if (!ventas.length) {
    cont.innerHTML = '<p class="pos-resultados-vacio">Sin ventas para mostrar.</p>';
    if (contPag) contPag.innerHTML = '';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(ventas.length / VENTAS_POR_PAGINA));
  if (ventasPaginaActual > totalPaginas) ventasPaginaActual = totalPaginas;
  if (ventasPaginaActual < 1) ventasPaginaActual = 1;

  const desdeIdx = (ventasPaginaActual - 1) * VENTAS_POR_PAGINA;
  const pagina = ventas.slice(desdeIdx, desdeIdx + VENTAS_POR_PAGINA);

  cont.innerHTML = pagina.map(v => `
    <div class="pos-venta-fila ${v.estado === 'anulada' ? 'anulada' : ''}">
      <div class="pos-venta-fila-info">
        <span class="pos-venta-fila-num">N° ${escapeHtml(v.numero || '—')}${v.descuento_global_pct ? ` <span style="font-size:11px;font-weight:600;color:var(--color-warning,#8A5F13);">−${v.descuento_global_pct}%</span>` : ''}</span>
        <span class="pos-venta-fila-meta">${escapeHtml(v.clientes?.razon_social || 'Consumidor final')} · ${escapeHtml(v.cajas_pos?.nombre || '')} · ${window.formatHora ? window.formatHora(v.created_at) : ''}</span>
      </div>
      <span class="pos-venta-fila-total">${fmt(v.total)}</span>
      ${v.estado === 'anulada'
        ? '<span class="pos-venta-badge-anulada">Anulada</span>'
        : v.factura_id
          ? '<span class="pos-venta-badge-facturada" title="Ya tiene factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.">Facturada</span>'
          : `<button class="pos-venta-btn-anular" onclick="anularVenta('${v.id}', '${escapeHtml(v.numero || '')}')">Anular</button>`}
    </div>
  `).join('');

  if (contPag) {
    contPag.innerHTML = `
      <button type="button" class="pos-pag-btn" ${ventasPaginaActual <= 1 ? 'disabled' : ''} onclick="irAPaginaVentas(-1)">‹ Anterior</button>
      <span class="pos-pag-info">Página ${ventasPaginaActual} de ${totalPaginas} · ${ventas.length} ventas</span>
      <button type="button" class="pos-pag-btn" ${ventasPaginaActual >= totalPaginas ? 'disabled' : ''} onclick="irAPaginaVentas(1)">Siguiente ›</button>
    `;
  }
}

window.irAPaginaVentas = function (delta) {
  ventasPaginaActual += delta;
  renderVentas(ventasAdminCache);
  document.getElementById('pos-admin-ventas-lista')?.scrollTo({ top: 0, behavior: 'smooth' });
};

window.anularVenta = async function (venta_pos_id, numero) {
  const venta = ventasAdminCache.find(v => v.id === venta_pos_id);

  // Si ya tiene factura con CAE emitida, no dejamos ni abrir el diálogo:
  // anularla acá dejaría la factura viva ante AFIP sin la venta que la
  // respalda. Hay que emitir una Nota de Crédito primero (fuera de este
  // flujo por ahora).
  if (venta?.factura_id) {
    window.toast(`La venta N° ${numero} ya tiene una factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.`, 'error');
    return;
  }

  const cliente  = venta?.clientes?.razon_social || 'Consumidor final';
  const importe  = venta ? fmt(venta.total) : '';
  const mensaje  = `¿Anular la venta N° ${numero}${importe ? ` (${importe})` : ''}${cliente ? ` — ${escapeHtml(cliente)}` : ''}?<br>Se repone el stock vendido. Esta acción no se puede deshacer.`;

  const doAnular = async () => {
    const motivo = await window.confirmarConTexto(mensaje, {
      labelOk: 'Sí, anular', placeholder: 'Motivo de la anulación (obligatorio)...', requerido: true,
    });
    if (!motivo) return;
    try {
      await apiPost('/api/pos/anular', { venta_pos_id, motivo });
      window.toast('Venta anulada', 'exito');
      cargarVentas(document.getElementById('pos-admin-buscar-venta')?.value.trim());
    } catch (e) {
      console.error(e);
      window.toast(e.message || 'No se pudo anular la venta', 'error');
    }
  };

  if (window.tieneRol?.('dueno', 'admin')) {
    doAnular();
  } else {
    pedirPinSupervisor(`Anular la venta N° ${numero} requiere autorización de supervisor.`, doAnular);
  }
};

// ── Pestaña Stock ──────────────────────────────────────────────────────────
async function cargarDepositosAdmin() {
  if (depositosAdmin.length) return;
  try {
    depositosAdmin = await apiGet('/api/pos/depositos');
    const opciones = depositosAdmin.map(d => `<option value="${d.id}">${escapeHtml(d.nombre)}</option>`).join('');
    document.getElementById('pos-transf-origen').innerHTML  = opciones || '<option value="">Sin depósitos</option>';
    document.getElementById('pos-transf-destino').innerHTML = opciones || '<option value="">Sin depósitos</option>';
  } catch (e) {
    console.error(e);
    window.toast('Error al cargar depósitos', 'error');
  }
}

document.getElementById('pos-transf-producto')?.addEventListener('input', (e) => {
  clearTimeout(buscarProdTransfTimer);
  const q = e.target.value.trim();
  const cont = document.getElementById('pos-transf-producto-resultados');
  if (!q) { cont.innerHTML = ''; return; }
  buscarProdTransfTimer = setTimeout(async () => {
    try {
      const resultados = await apiGet(`/api/pos/productos?q=${encodeURIComponent(q)}`);
      cont.innerHTML = (resultados || []).slice(0, 10).map(p => `
        <div class="pos-cliente-resultado" data-id="${p.id}">${escapeHtml(p.nombre)} <span style="color:var(--color-text-light)">${escapeHtml(p.codigo || '')}</span></div>
      `).join('') || '<div class="pos-cliente-resultado" style="color:var(--color-text-light)">Sin resultados</div>';
      cont.querySelectorAll('.pos-cliente-resultado[data-id]').forEach(el => {
        el.addEventListener('click', () => {
          const p = resultados.find(r => r.id === el.dataset.id);
          if (p) seleccionarProductoTransf(p);
        });
      });
    } catch (e) { console.error(e);
    window.toast('Error al buscar productos', 'error'); }
  }, 220);
});

function seleccionarProductoTransf(producto) {
  productoTransfSel = producto;
  const cont = document.getElementById('pos-transf-producto-sel');
  cont.style.display = '';
  cont.innerHTML = `<span>${escapeHtml(producto.nombre)}</span><button onclick="quitarProductoTransf()">Quitar</button>`;
  document.getElementById('pos-transf-producto').value = '';
  document.getElementById('pos-transf-producto-resultados').innerHTML = '';
}
window.quitarProductoTransf = function () {
  productoTransfSel = null;
  document.getElementById('pos-transf-producto-sel').style.display = 'none';
};

window.confirmarTransferencia = async function () {
  const errEl = document.getElementById('pos-transf-error');
  errEl.style.display = 'none';
  if (!productoTransfSel) { errEl.textContent = 'Elegí un producto primero.'; errEl.style.display = ''; return; }
  const origen   = document.getElementById('pos-transf-origen').value;
  const destino  = document.getElementById('pos-transf-destino').value;
  const cantidad = parseFloat(document.getElementById('pos-transf-cantidad').value || '0');
  const notas    = document.getElementById('pos-transf-notas').value.trim();
  if (!origen || !destino) { errEl.textContent = 'Elegí depósito de origen y de destino.'; errEl.style.display = ''; return; }
  if (origen === destino)  { errEl.textContent = 'El depósito de origen y destino no pueden ser el mismo.'; errEl.style.display = ''; return; }
  if (!cantidad || cantidad <= 0) { errEl.textContent = 'Ingresá una cantidad válida.'; errEl.style.display = ''; return; }
  const btn = document.getElementById('btn-confirmar-transferencia');
  btn.disabled = true;
  try {
    await apiPost('/api/pos/transferir-stock', { producto_id: productoTransfSel.id, deposito_origen: origen, deposito_destino: destino, cantidad, notas: notas || null });
    window.toast('Stock transferido', 'exito');
    quitarProductoTransf();
    document.getElementById('pos-transf-cantidad').value = '';
    document.getElementById('pos-transf-notas').value = '';
    cargarTransferencias();
  } catch (e) {
    errEl.textContent = e.message || 'No se pudo transferir el stock'; errEl.style.display = '';
  } finally { btn.disabled = false; }
};

async function cargarTransferencias() {
  const cont = document.getElementById('pos-admin-transferencias-lista');
  try {
    const data = await apiGet('/api/pos/transferencias-stock');
    renderTransferencias(data);
  } catch (e) {
    cont.innerHTML = `<p class="pos-resultados-vacio">${escapeHtml(e.message || 'Error al cargar el historial')}</p>`;
  }
}

function renderTransferencias(items) {
  const cont = document.getElementById('pos-admin-transferencias-lista');
  if (!items.length) { cont.innerHTML = '<p class="pos-resultados-vacio">Todavía no hay transferencias registradas.</p>'; return; }
  cont.innerHTML = items.map(t => `
    <div class="pos-transf-fila">
      <div class="pos-transf-fila-info">
        <span class="pos-venta-fila-num">${escapeHtml(t.productos?.nombre || 'Producto')}</span>
        <span class="pos-transf-fila-meta">→ ${escapeHtml(t.depositos?.nombre || '')} · ${window.formatHora ? window.formatHora(t.created_at) : ''}</span>
      </div>
      <span class="pos-venta-fila-total">+${t.cantidad}</span>
    </div>
  `).join('');
}

// ── Util ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(str);
}

// ══════════════════════════════════════════════════════════════════════════
// FASE 3 (v142) — Alta rápida de cliente, alerta stock, preguntar factura
// ══════════════════════════════════════════════════════════════════════════

