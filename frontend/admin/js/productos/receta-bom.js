// frontend/admin/js/productos/receta-bom.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Receta (BOM): insumos que se descuentan automáticamente al vender el producto.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Receta (BOM) — v343: insumos que se descuentan automáticamente al
   producir este producto vía "Producción propia" en Stock (tabla
   producto_insumos + RPC producir_con_insumos). ──────────────────────── */
let recetaProductoInsumos = [];

async function abrirModalReceta() {
  if (!modalProductoId) return; // solo tiene sentido para un producto ya guardado
  if (!sb) { toast('No hay conexión con la base de datos (modo demo).', 'warning'); return; }

  const p = productosPage.find(x => x.id === modalProductoId);
  document.getElementById('modal-receta-subtitulo').textContent = p ? p.nombre : '';

  await Promise.all([cargarInsumosDisponibles(), cargarRecetaProducto()]);

  document.getElementById('modal-backdrop-receta').style.display = 'block';
  document.getElementById('modal-receta').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function cerrarModalReceta() {
  document.getElementById('modal-backdrop-receta').style.display = 'none';
  document.getElementById('modal-receta').classList.remove('open');
  document.body.style.overflow = '';
}

async function cargarInsumosDisponibles() {
  const sel = document.getElementById('receta-select-insumo');
  if (!sel) return;
  const { data, error } = await window.conTimeoutRed(sb
    .from('productos')
    .select('id, nombre, unidad')
    .eq('empresa_id', empresaData?.id)
    .eq('activo', true)
    .neq('id', modalProductoId)
    .order('nombre'), 10000);
  if (error) { console.error('[productos] insumos disponibles:', error); return; }
  sel.innerHTML = (data || [])
    .map(pr => `<option value="${pr.id}">${escHtml(pr.nombre)}${pr.unidad ? ` (${escHtml(pr.unidad)})` : ''}</option>`)
    .join('') || '<option value="">No hay otros productos activos para usar como insumo</option>';
}

async function cargarRecetaProducto() {
  const { data, error } = await window.conTimeoutRed(sb
    .from('producto_insumos')
    .select('id, insumo_id, cantidad_por_unidad, productos:insumo_id(nombre, unidad)')
    .eq('producto_terminado_id', modalProductoId)
    .order('created_at'), 10000);
  if (error) { console.error('[productos] receta:', error); recetaProductoInsumos = []; }
  else recetaProductoInsumos = data || [];
  renderRecetaLista();
}

function renderRecetaLista() {
  const cont = document.getElementById('receta-lista');
  if (!cont) return;
  if (!recetaProductoInsumos.length) {
    cont.innerHTML = '<p style="font-size:12.5px;color:var(--color-text-muted);margin:0">Todavía no cargaste insumos para este producto.</p>';
    return;
  }
  cont.innerHTML = recetaProductoInsumos.map(ri => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--color-border, #C7BFA9);border-radius:8px">
      <span style="font-size:13px">
        <strong>${fmt(ri.cantidad_por_unidad)}</strong> ${escHtml(ri.productos?.unidad || 'u')} de ${escHtml(ri.productos?.nombre || 'insumo')}
      </span>
      <button type="button" class="prod-menu-btn" aria-label="Quitar insumo" onclick="btnAsyncClick(this, () => eliminarInsumoReceta('${ri.id}'))">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

async function agregarInsumoReceta() {
  const insumoId  = document.getElementById('receta-select-insumo').value;
  const cantidad  = parseInt(document.getElementById('receta-input-cantidad').value, 10);
  if (!insumoId) { toast('Elegí un insumo', 'warning'); return; }
  if (isNaN(cantidad) || cantidad <= 0) { toast('Ingresá una cantidad entera por unidad, mayor a cero', 'warning'); return; }

  const { error } = await window.conTimeoutRed(sb.from('producto_insumos').upsert({
    empresa_id: empresaData?.id,
    producto_terminado_id: modalProductoId,
    insumo_id: insumoId,
    cantidad_por_unidad: cantidad,
  }, { onConflict: 'producto_terminado_id,insumo_id' }), 10000);

  if (error) { toast('No se pudo agregar el insumo: ' + error.message, 'error'); return; }

  document.getElementById('receta-input-cantidad').value = '';
  await cargarRecetaProducto();
  toast('Insumo agregado a la receta', 'success');
}

async function eliminarInsumoReceta(id) {
  const { error } = await window.conTimeoutRed(sb.from('producto_insumos').delete().eq('id', id), 10000);
  if (error) { toast('No se pudo quitar el insumo: ' + error.message, 'error'); return; }
  await cargarRecetaProducto();
}

function fmt(n) {
  const num = Number(n) || 0;
  return num % 1 === 0 ? String(num) : num.toFixed(3).replace(/\.?0+$/, '');
}
