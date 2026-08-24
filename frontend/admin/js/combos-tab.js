/* ============================================================
   combos-tab.js — Lógica de la pestaña "Combos" dentro de Productos
   (FIX 2026-08-23: portado desde el ex /admin/combos, que dejó de ser
   una sección aparte del menú y ahora vive como pestaña dentro de
   Productos — mismo criterio que Zonas dentro de Repartos y Listas de
   precio dentro de Clientes; ver nav-data.js y vercel.json).

   Reusa `sb` y `empresaData` que ya declaró productos.js más arriba
   en el documento (bindings `let` de script-scope, compartidos entre
   <script> clásicos en el mismo documento) — por eso NO se redeclaran
   acá, cosa que además tiraría SyntaxError por redeclaración.

   Sin auth propio: productos.js ya resuelve authReady y llama a
   cb_cargarCombos() la primera vez que se hace click en la pestaña
   "Combos" (ver cambiarVistaProductos() en productos.js).

   Estado local con prefijo cb_ para no colisionar con el de
   productos.js (que ya tiene su propio filtroEstado/busquedaTag).
   ============================================================ */

'use strict';

/* ============================================================
   combos.js — Lógica de la sección Combos (v1)
   Mismo criterio que productos.js: el CRUD (alta/edición/activar-
   desactivar) llama directo a las RPCs fn_guardar_combo /
   fn_combo_set_activo vía supabase-js, sin pasar por Node — igual que
   el resto de Productos. Ver lib/repos/combos.js para la parte que sí
   pasa por Node (checkout del portal cliente, que no toca este archivo).
   ============================================================ */

'use strict';

/* ── Cliente Supabase (se asigna en init() desde window.authCtx) ── */

/* ── Estado ── */
let combosAll     = [];   // [{id, nombre, descripcion, precio, foto_url, activo, combo_items:[{producto_id, cantidad, productos:{nombre}}]}]
let cb_filtroEstado  = '';   // '' | 'activo' | 'inactivo'
let cb_busqueda      = '';

/* ── Modal ── */
let modalComboId  = null; // null = alta, uuid = edición
let itemsModal    = [];   // [{producto_id, nombre, cantidad}]
let _picker       = null; // ProductoPicker — lazy-init al abrir el modal

/* ── Contador liviano para el badge de la pestaña (FIX 2026-08-23,
   resaltar Combos): corre en el init de productos.js, ANTES de que se
   haga click en la pestaña — por eso es una query aparte con
   count:'exact', head:true (no trae filas) en lugar de reusar
   cb_cargarCombos(), que sigue siendo lazy y solo se dispara al primer
   click (ver cambiarVistaProductos() en productos.js). Cuenta combos
   activos, que es el atributo que más le importa a quien mira la
   pestaña de reojo: cuántos combos están vendiéndose ahora mismo. ── */
async function cb_cargarContadorCombos() {
  const badge = document.getElementById('combos-badge');
  if (!badge || !sb) return;
  try {
    const { count, error } = await sb
      .from('combos')
      .select('id', { count: 'exact', head: true })
      .eq('activo', true);
    if (error) throw error;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    }
  } catch (e) {
    console.warn('[combos-tab] No se pudo cargar el contador de combos:', e?.message || e);
  }
}
window.cb_cargarContadorCombos = cb_cargarContadorCombos;

/* ── Carga ──────────────────────────────────────────────────────────── */
async function cb_cargarCombos() {
  const tbody = document.getElementById('cb-tbody');
  if (!sb) { combosAll = []; cb_render(); return; }

  try {
    const { data, error } = await sb
      .from('combos')
      .select('id, nombre, descripcion, precio, foto_url, activo, combo_items(producto_id, cantidad, productos(nombre))')
      .order('nombre');

    if (error) throw error;
    combosAll = data || [];
    cb_render();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="prod-empty">No se pudieron cargar los combos: ${cb_esc(e.message)}</td></tr>`;
  }
}

/* ── Filtro + render de tabla ──────────────────────────────────────── */
function cb_onFiltroEstado(v) { cb_filtroEstado = v; cb_render(); }
function cb_onBusqueda(v)     { cb_busqueda = (v || '').trim().toLowerCase(); cb_render(); }

function cb_render() {
  const tbody = document.getElementById('cb-tbody');
  let lista = combosAll.slice();

  if (cb_filtroEstado === 'activo')   lista = lista.filter(c => c.activo === true);
  if (cb_filtroEstado === 'inactivo') lista = lista.filter(c => c.activo === false);
  if (cb_busqueda) lista = lista.filter(c => (c.nombre || '').toLowerCase().includes(cb_busqueda));

  if (!lista.length) {
    tbody.innerHTML = `
      <tr><td colspan="5" class="prod-empty">
        ${combosAll.length ? 'Ningún combo coincide con ese filtro.' : 'Todavía no creaste ningún combo. Usá "Nuevo combo" para armar el primero.'}
      </td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(c => {
    const composicion = (c.combo_items || [])
      .map(it => `${it.cantidad}x ${cb_esc(it.productos?.nombre || '—')}`)
      .join(' + ') || 'Sin productos';

    return `
      <tr>
        <td>
          <div class="cb-combo-cell">
            <div class="cb-combo-thumb">
              ${c.foto_url
                ? `<img src="${cb_esc(c.foto_url)}" alt="${cb_esc(c.nombre)}">`
                : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`}
            </div>
            <span class="cb-combo-nombre">${cb_esc(c.nombre)}</span>
          </div>
        </td>
        <td><span class="cb-combo-composicion" title="${cb_esc(composicion)}">${composicion}</span></td>
        <td class="prod-num">${cb_formatPeso(c.precio)}</td>
        <td>
          <span class="cb-estado-badge ${c.activo ? 'cb-estado-badge--activo' : 'cb-estado-badge--inactivo'}">
            ${c.activo ? 'Activo' : 'Inactivo'}
          </span>
        </td>
        <td class="col-sticky-end">
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button type="button" class="cb-btn-toggle" onclick="btnAsyncClick(this, () => cb_toggleActivo('${c.id}', ${!c.activo}))">
              ${c.activo ? 'Desactivar' : 'Activar'}
            </button>
            <button type="button" class="prod-icon-btn" aria-label="Editar" title="Editar" onclick="cb_abrirFormulario('${c.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

/* ── Activar / desactivar ─────────────────────────────────────────── */
async function cb_toggleActivo(comboId, nuevoValor) {
  if (!sb) { toast('No hay conexión con la base de datos.', 'warning'); return; }
  try {
    const { data, error } = await sb.rpc('fn_combo_set_activo', { p_combo_id: comboId, p_activo: nuevoValor });
    if (error) throw error;
    if (!data?.ok) { toast(data?.error || 'No se pudo actualizar el combo.', 'error'); return; }

    const c = combosAll.find(x => x.id === comboId);
    if (c) c.activo = nuevoValor;
    cb_render();
    toast(nuevoValor ? 'Combo activado.' : 'Combo desactivado.', 'success');
  } catch (e) {
    toast('Error al actualizar el combo: ' + e.message, 'error');
  }
}

/* ── Panel inline Nuevo/Editar (FIX 2026-08-23, cuarta vuelta: sin modal,
   ver comentario largo en productos.html sobre #cb-panel-form) ─────── */
async function cb_abrirFormulario(comboId) {
  modalComboId = comboId || null;
  const combo = comboId ? combosAll.find(c => c.id === comboId) : null;

  document.getElementById('cb-form-titulo').textContent = combo ? 'Editar combo' : 'Nuevo combo';
  document.getElementById('cb-f-nombre').value      = combo?.nombre || '';
  document.getElementById('cb-f-descripcion').value = combo?.descripcion || '';
  document.getElementById('cb-f-foto').value        = combo?.foto_url || '';
  document.getElementById('cb-f-precio').value      = combo?.precio ?? '';
  document.getElementById('cb-f-activo').value      = combo ? String(!!combo.activo) : 'true';

  itemsModal = (combo?.combo_items || []).map(it => ({
    producto_id: it.producto_id,
    nombre:      it.productos?.nombre || '(producto)',
    cantidad:    +it.cantidad || 1,
  }));
  cb_renderItemsModal();

  // Inicializar el ProductoPicker la primera vez; resetearlo en re-aperturas
  const pickerEl = document.getElementById('cb-picker-container');
  if (pickerEl && window.ProductoPicker) {
    if (!_picker) {
      _picker = new window.ProductoPicker(pickerEl, {
        onAgregar(item) {
          const existente = itemsModal.find(it => it.producto_id === item.producto_id);
          if (existente) {
            existente.cantidad = (Number(existente.cantidad) || 0) + (Number(item.cantidad) || 1);
          } else {
            itemsModal.push({
              producto_id: item.producto_id,
              nombre:      item.descripcion,
              cantidad:    Number(item.cantidad) || 1,
            });
          }
          cb_renderItemsModal();
        },
      });
      await _picker.init(sb, empresaData?.id);
    } else {
      _picker.reset();
    }
  }

  document.getElementById('cb-panel-form').style.display = 'block';
  document.getElementById('cb-btn-nuevo').style.display = 'none';
  document.getElementById('cb-panel-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  _picker?.focus?.();
}

function cb_cerrarFormulario() {
  document.getElementById('cb-panel-form').style.display = 'none';
  document.getElementById('cb-btn-nuevo').style.display = '';
}

function cb_renderItemsModal() {
  const cont = document.getElementById('cb-items-container');
  if (!itemsModal.length) {
    cont.innerHTML = `<div class="empty-items" style="font-size:12px;color:var(--color-text-muted);padding:8px 0">
      Sin productos. Usá el buscador de arriba para agregar.
    </div>`;
    return;
  }
  cont.innerHTML = itemsModal.map((it, i) => `
    <div class="cb-item-row">
      <span class="cb-item-nombre">${cb_esc(it.nombre)}</span>
      <input type="number" class="cb-item-cant" min="1" step="1" value="${it.cantidad}"
             aria-label="Cantidad de ${cb_esc(it.nombre)}"
             oninput="cb_actualizarCantidadItem(${i}, this.value)">
      <button type="button" class="cb-item-quitar" title="Quitar" aria-label="Quitar ${cb_esc(it.nombre)}" onclick="cb_quitarItem(${i})">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join('');
}

function cb_actualizarCantidadItem(idx, valor) {
  const n = Math.max(1, Math.floor(Number(valor) || 1));
  if (itemsModal[idx]) itemsModal[idx].cantidad = n;
}

function cb_quitarItem(idx) {
  itemsModal.splice(idx, 1);
  cb_renderItemsModal();
}

/* ── Guardar (alta o edición) ─────────────────────────────────────── */
async function cb_guardar() {
  const nombre      = document.getElementById('cb-f-nombre').value.trim();
  const descripcion = document.getElementById('cb-f-descripcion').value.trim() || null;
  const fotoUrl      = document.getElementById('cb-f-foto').value.trim() || null;
  const precio       = Number(document.getElementById('cb-f-precio').value);
  const activo       = document.getElementById('cb-f-activo').value === 'true';

  if (!nombre) { toast('El combo necesita un nombre.', 'warning'); return; }
  if (!Number.isFinite(precio) || precio < 0) { toast('Precio inválido.', 'warning'); return; }
  if (!itemsModal.length) { toast('Agregá al menos un producto al combo.', 'warning'); return; }

  if (!sb) { toast('No hay conexión con la base de datos.', 'warning'); return; }

  try {
    const { data, error } = await sb.rpc('fn_guardar_combo', {
      p_combo_id:    modalComboId,
      p_nombre:      nombre,
      p_descripcion: descripcion,
      p_precio:      precio,
      p_foto_url:    fotoUrl,
      p_activo:      activo,
      p_items:       itemsModal.map(it => ({ producto_id: it.producto_id, cantidad: it.cantidad })),
    });

    if (error) throw error;
    if (!data?.ok) { toast(data?.error || 'No se pudo guardar el combo.', 'error'); return; }

    toast(modalComboId ? 'Combo actualizado.' : 'Combo creado.', 'success');
    cb_cerrarFormulario();
    await cb_cargarCombos();
  } catch (e) {
    toast('Error al guardar el combo: ' + e.message, 'error');
  }
}

/* ── Helpers ───────────────────────────────────────────────────────── */
function cb_esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function cb_formatPeso(n) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(n) || 0);
}

/* Exponer al scope global — el HTML usa onclick inline, mismo criterio que productos.js */
window.cb_onFiltroEstado         = cb_onFiltroEstado;
window.cb_onBusqueda             = cb_onBusqueda;
window.cb_abrirFormulario        = cb_abrirFormulario;
window.cb_cerrarFormulario       = cb_cerrarFormulario;
window.cb_actualizarCantidadItem = cb_actualizarCantidadItem;
window.cb_quitarItem             = cb_quitarItem;
window.cb_guardar                = cb_guardar;
window.cb_toggleActivo           = cb_toggleActivo;

