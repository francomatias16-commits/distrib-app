// frontend/admin/js/productos/categorias-abm.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — ABM completo de categorías (modal aparte) y aporte al banco de códigos compartido.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Administrar categorías (ABM completo) ─────────────────────────────
   Usa el mismo endpoint genérico /api/maestros?recurso=categorias que ya
   soporta crear/editar/dar de baja/reactivar (mismo patrón que zonas). ── */
let catAbmData = [];
let catAbmEditId = null;

function abrirModalCategoriasAbm(event) {
  if (event) event.preventDefault();
  cancelarEdicionCatAbm();
  document.getElementById('modal-backdrop-cat-abm').style.display = 'block';
  document.getElementById('modal-categorias-abm').style.display = 'flex';
  cargarCategoriasAbm();
}

function cerrarModalCategoriasAbm() {
  document.getElementById('modal-backdrop-cat-abm').style.display = 'none';
  document.getElementById('modal-categorias-abm').style.display = 'none';
}

function cerrarModalCategoriasAbmSiFondo(event) {
  if (event.target.id === 'modal-backdrop-cat-abm') cerrarModalCategoriasAbm();
}

async function cargarCategoriasAbm() {
  const tbody = document.getElementById('tbody-cat-abm');
  tbody.innerHTML = '<tr><td colspan="4" class="vacio">Cargando...</td></tr>';
  try {
    const token = await getToken();
    const activa = document.getElementById('catabm-filtro').value;
    const params = new URLSearchParams({ recurso: 'categorias' });
    if (activa !== '') params.set('activa', activa);

    const res = await fetch(`/api/maestros?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('No se pudo cargar la lista de categorías.');
    const data = await res.json();
    catAbmData = data.data || [];
    renderTablaCatAbm();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="vacio">${err.message}</td></tr>`;
  }
}

function renderTablaCatAbm() {
  const tbody = document.getElementById('tbody-cat-abm');
  if (!catAbmData.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="vacio">No hay categorías para mostrar.</td></tr>';
    return;
  }
  tbody.innerHTML = catAbmData.map(c => `
    <tr>
      <td data-label="Nombre">${sanitize(c.nombre)}</td>
      <td data-label="Orden">${c.orden ?? 0}</td>
      <td data-label="Estado"><span class="badge ${c.activa ? 'badge-activo' : 'badge-inactivo'}">${c.activa ? 'Activa' : 'Inactiva'}</span></td>
      <td class="col-sticky-end" data-label="Acciones">
        <div class="acciones-td">
          <button type="button" class="btn-tabla" onclick="editarCatAbm('${c.id}')">Editar</button>
          ${c.activa
            ? `<button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => desactivarCatAbm('${c.id}'))">Dar de baja</button>`
            : `<button type="button" class="btn-tabla primario" onclick="btnAsyncClick(this, () => activarCatAbm('${c.id}'))">Activar</button>`
          }
        </div>
      </td>
    </tr>
  `).join('');
}

function editarCatAbm(id) {
  const c = catAbmData.find(x => x.id === id);
  if (!c) return;
  catAbmEditId = id;
  document.getElementById('catabm-nombre').value = c.nombre || '';
  document.getElementById('catabm-orden').value = c.orden ?? '';
  document.getElementById('catabm-descripcion').value = c.descripcion || '';
  document.getElementById('btn-guardar-cat-abm').textContent = 'Guardar cambios';
  document.getElementById('btn-cancelar-cat-abm-edit').style.display = '';
  document.getElementById('catabm-nombre').focus();
}

function cancelarEdicionCatAbm() {
  catAbmEditId = null;
  document.getElementById('catabm-nombre').value = '';
  document.getElementById('catabm-orden').value = '';
  document.getElementById('catabm-descripcion').value = '';
  document.getElementById('btn-guardar-cat-abm').textContent = 'Crear categoría';
  document.getElementById('btn-cancelar-cat-abm-edit').style.display = 'none';
}

async function guardarCatAbm() {
  const nombre = document.getElementById('catabm-nombre').value.trim();
  if (!nombre) { toast('El nombre es obligatorio', 'warning'); return; }

  const body = {
    nombre,
    orden: document.getElementById('catabm-orden').value.trim() || 0,
    descripcion: document.getElementById('catabm-descripcion').value.trim() || null,
  };

  const token = await getToken();
  const method = catAbmEditId ? 'PATCH' : 'POST';
  if (catAbmEditId) body.id = catAbmEditId;

  const res = await fetch('/api/maestros?recurso=categorias', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'No se pudo guardar la categoría', 'error');
    return;
  }

  toast(catAbmEditId ? 'Categoría actualizada' : 'Categoría creada', 'success');
  cancelarEdicionCatAbm();
  await cargarCategoriasAbm();
  await cargarCategorias();
  poblarSelectCategoriasModal();
}

async function desactivarCatAbm(id) {
  const c = catAbmData.find(x => x.id === id);
  const ok = await (window.confirmar
    ? window.confirmar(`¿Dar de baja la categoría "${c?.nombre || ''}"? Los productos que la usan la mantienen, pero dejará de aparecer para asignar a productos nuevos.`, { labelOk: 'Dar de baja', tipo: 'danger' })
    : Promise.resolve(confirm('¿Dar de baja esta categoría?')));
  if (!ok) return;

  const token = await getToken();
  const res = await fetch(`/api/maestros?recurso=categorias&id=${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'No se pudo dar de baja la categoría', 'error');
    return;
  }
  toast('Categoría dada de baja', 'success');
  await cargarCategoriasAbm();
  await cargarCategorias();
  poblarSelectCategoriasModal();
}

async function activarCatAbm(id) {
  const token = await getToken();
  const res = await fetch('/api/maestros?recurso=categorias', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, activa: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'No se pudo activar la categoría', 'error');
    return;
  }
  toast('Categoría activada', 'success');
  await cargarCategoriasAbm();
  await cargarCategorias();
  poblarSelectCategoriasModal();
}

window.abrirModalCategoriasAbm = abrirModalCategoriasAbm;
window.cerrarModalCategoriasAbm = cerrarModalCategoriasAbm;
window.cerrarModalCategoriasAbmSiFondo = cerrarModalCategoriasAbmSiFondo;
window.cargarCategoriasAbm = cargarCategoriasAbm;
window.editarCatAbm = editarCatAbm;
window.cancelarEdicionCatAbm = cancelarEdicionCatAbm;
window.guardarCatAbm = guardarCatAbm;
window.desactivarCatAbm = desactivarCatAbm;
window.activarCatAbm = activarCatAbm;

/* ── Aportar al banco de códigos compartido (440) ─────────────────────────
   Fire-and-forget: no bloquea el guardado del producto ni muestra error al
   usuario si falla (falta de conexión, permiso, etc.) — es un "extra" que
   beneficia a otras empresas del SaaS, nunca debe entorpecer el alta de
   este producto. Se llama tanto desde guardarProducto() (aporte "manual",
   con lo que el usuario tipeó) como desde productos-scanner-remoto.js
   cuando Open Food Facts/Open Products Facts/Mercado Libre devuelven un
   match (fuente correspondiente), para cachear ese hallazgo acá. */
async function aportarBancoCodigos(codigo, nombre, fotoUrl, fuente = 'manual') {
  if (!codigo || (!nombre && !fotoUrl)) return;
  try {
    const token = await getToken();
    await fetch('/api/banco-codigos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ codigo, nombre, foto_url: fotoUrl, fuente }),
    });
  } catch (err) {
    console.warn('[productos] no se pudo aportar al banco de códigos:', err?.message);
  }
}

window.aportarBancoCodigos = aportarBancoCodigos;
