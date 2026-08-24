// frontend/admin/js/zonas.js
// ABM de zonas de reparto — antes solo se podían cargar a mano por SQL,
// aunque las usan clientes, reglas de precio, pedidos y reportes de
// rentabilidad por zona.

let sb = null;
let zonaData = [];
let modalZonaId = null;

async function init() {
  sb = window.authCtx.sb;
  await cargarZonas();
}

async function cargarZonas() {
  try {
    const token  = (await sb.auth.getSession()).data.session?.access_token;
    const activa = document.getElementById('filtro-activa')?.value ?? 'true';
    const params = new URLSearchParams({ recurso: 'zonas' });
    if (activa !== '') params.set('activa', activa);

    const res  = await fetch(`/api/maestros?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('No se pudo cargar la lista de zonas.');
    const data = await res.json();
    zonaData = data.data || [];

    renderTabla();
  } catch (err) {
    window.toast?.(err.message || 'No se pudo cargar la lista de zonas.', 'error');
  }
}

const NOMBRE_DIA = { lunes: 'Lun', martes: 'Mar', miercoles: 'Mié', jueves: 'Jue', viernes: 'Vie', sabado: 'Sáb', domingo: 'Dom' };

function renderTabla() {
  const tbody = document.getElementById('tbody-zonas');
  if (!tbody) return;

  if (!zonaData.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="vacio">Todavía no cargaste ninguna zona. Creá la primera con «Nueva zona».</td></tr>';
    return;
  }

  tbody.innerHTML = zonaData.map(z => `
    <tr class="fila-clickeable" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${z.id}')">
      <td data-label="Zona"><div style="font-weight:600;color:var(--color-text)">${sanitize(z.nombre)}</div></td>
      <td data-label="Días de reparto" style="font-size:12px;color:var(--color-text-muted)">
        ${(z.dias_reparto || []).length ? z.dias_reparto.map(d => NOMBRE_DIA[d] || d).join(', ') : '—'}
      </td>
      <td data-label="Estado">${ComponentesAdmin.renderBadgeEstado(z.activa ? 'Activa' : 'Inactiva', z.activa ? 'ok' : 'inactivo')}</td>
      <td class="col-sticky-end" data-label="Acciones">
        ${ComponentesAdmin.renderFilaAcciones([
          { label: 'Editar', attrs: `onclick="abrirModalEditar('${z.id}')"` },
          z.activa
            ? { label: 'Dar de baja', cls: 'peligro', attrs: `onclick="desactivar('${z.id}')"` }
            : { label: 'Activar', cls: 'primario', attrs: `onclick="activar('${z.id}')"` }
        ])}
      </td>
    </tr>
  `).join('');
}

function abrirModalNuevo() {
  modalZonaId = null;
  limpiarForm();
  document.getElementById('modal-titulo').textContent = 'Nueva zona';
  document.getElementById('btn-guardar').textContent  = 'Guardar zona';
  document.getElementById('modal-zona').style.display = 'flex';
}

function abrirModalEditar(id) {
  const z = zonaData.find(x => x.id === id);
  if (!z) { window.toast('No se pudo cargar la zona', 'error'); return; }

  modalZonaId = id;
  document.getElementById('f-nombre').value = z.nombre || '';
  document.querySelectorAll('#f-dias input[type=checkbox]').forEach(cb => {
    cb.checked = (z.dias_reparto || []).includes(cb.value);
  });

  document.getElementById('modal-titulo').textContent = 'Editar zona';
  document.getElementById('btn-guardar').textContent  = 'Guardar cambios';
  document.getElementById('modal-zona').style.display = 'flex';
}

function limpiarForm() {
  document.getElementById('f-nombre').value = '';
  document.querySelectorAll('#f-dias input[type=checkbox]').forEach(cb => cb.checked = false);
}

function cerrarModal() {
  document.getElementById('modal-zona').style.display = 'none';
  modalZonaId = null;
}

function cerrarModalSiFondo(event) {
  if (event.target.id === 'modal-zona') cerrarModal();
}

async function guardarZona() {
  const btn = document.getElementById('btn-guardar');

  const body = {
    nombre: document.getElementById('f-nombre').value.trim(),
    dias_reparto: Array.from(document.querySelectorAll('#f-dias input[type=checkbox]:checked')).map(cb => cb.value),
  };

  if (!body.nombre) {
    window.toast('El nombre es requerido', 'error');
    return;
  }

  const ok = await confirmar(
    modalZonaId ? `¿Guardar los cambios de la zona "${body.nombre}"?` : `¿Confirmás crear la zona "${body.nombre}"?`,
    { labelOk: modalZonaId ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  try {
    const token  = (await sb.auth.getSession()).data.session?.access_token;
    const method = modalZonaId ? 'PATCH' : 'POST';
    if (modalZonaId) body.id = modalZonaId;

    const res = await fetch('/api/maestros?recurso=zonas', {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo guardar la zona', 'error');
      return;
    }

    window.toast(modalZonaId ? 'Zona actualizada' : 'Zona creada', 'exito');
    cerrarModal();
    await cargarZonas();
  } catch (err) {
    window.toast(err.message || 'No se pudo guardar la zona', 'error');
  }
}

async function desactivar(id) {
  if (!(await confirmar('¿Dar de baja esta zona? Los clientes ya asignados la mantienen, pero dejará de aparecer para asignar clientes nuevos.', { labelOk: 'Dar de baja', tipo: 'danger' }))) return;
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch(`/api/maestros?recurso=zonas&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo dar de baja la zona', 'error');
      return;
    }
    window.toast('Zona dada de baja', 'exito');
    await cargarZonas();
  } catch (err) {
    window.toast(err.message || 'No se pudo dar de baja la zona', 'error');
  }
}

async function activar(id) {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/maestros?recurso=zonas', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, activa: true })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      window.toast(err.error || 'No se pudo activar la zona', 'error');
      return;
    }
    window.toast('Zona activada', 'exito');
    await cargarZonas();
  } catch (err) {
    window.toast(err.message || 'No se pudo activar la zona', 'error');
  }
}

window.abrirModalNuevo   = abrirModalNuevo;
window.abrirModalEditar  = abrirModalEditar;
window.cerrarModal       = cerrarModal;
window.cerrarModalSiFondo = cerrarModalSiFondo;
window.guardarZona       = guardarZona;
window.desactivar        = desactivar;
window.activar           = activar;
window.cargarZonas       = cargarZonas;

// ── Arranque ──────────────────────────────────────────────────────────
window.authReady.then(() => {
  if (!window.authCtx?.perfil) { window.location.href = '/admin/login'; return; }
  init();
}).catch(err => {
  console.error('[zonas.js] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});
