// frontend/admin/js/clientes/direcciones.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { getFreshToken } from './nucleo.js';

// ── Direcciones de entrega (vista global) ────────────────────────────────
export async function cargarDirecciones() {
  const tbody = document.getElementById('tabla-direcciones-body');
  tbody.innerHTML = '<tr><td colspan="7" class="tabla-loading">Cargando direcciones...</td></tr>';
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/direcciones?_svc=direcciones', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al cargar direcciones');
    estadoModulo.direccionesData = data || [];
    renderTablaDirecciones(estadoModulo.direccionesData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="tabla-loading">${sanitize(err.message)}</td></tr>`;
  }
}

export function renderTablaDirecciones(rows) {
  const tbody = document.getElementById('tabla-direcciones-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabla-loading">Sin direcciones cargadas</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const clienteNombre = r.clientes?.nombre_fantasia || r.clientes?.razon_social || '—';
    tr.innerHTML = `
      <td>${sanitize(clienteNombre)}</td>
      <td>${sanitize(r.etiqueta || '—')}</td>
      <td>${sanitize(r.domicilio)}</td>
      <td>${sanitize(r.localidad || '—')}</td>
      <td>${sanitize(r.provincia || '—')}</td>
      <td>${r.es_principal ? '<span class="sello sello--exito">Principal</span>' : ''}</td>
      <td class="col-sticky-end">
        <span class="fila-acciones">
        <button type="button" class="btn-tabla" onclick="abrirModalDireccion('${r.id}')">Editar</button>
        <button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => eliminarDireccion('${r.id}'))">Eliminar</button>
        </span>
      </td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

export function filtrarDirecciones() {
  const b = document.getElementById('input-busqueda-direcciones').value.trim().toLowerCase();
  if (!b) return renderTablaDirecciones(estadoModulo.direccionesData);
  const filtradas = estadoModulo.direccionesData.filter(r => {
    const cliente = (r.clientes?.nombre_fantasia || r.clientes?.razon_social || '').toLowerCase();
    return cliente.includes(b) ||
      (r.domicilio || '').toLowerCase().includes(b) ||
      (r.localidad || '').toLowerCase().includes(b);
  });
  renderTablaDirecciones(filtradas);
}

export function abrirModalDireccion(id) {
  const selCliente = document.getElementById('fd-cliente_id');
  selCliente.innerHTML = '<option value="">Seleccioná un cliente</option>' +
    estadoModulo.clientesData.map(c => `<option value="${c.id}">${sanitize(c.nombre_fantasia || c.razon_social)}</option>`).join('');

  const existente = id ? estadoModulo.direccionesData.find(r => r.id === id) : null;
  document.getElementById('modal-direccion-titulo').textContent = existente ? 'Editar dirección' : 'Nueva dirección';
  document.getElementById('fd-id').value = existente?.id || '';
  selCliente.value = existente?.cliente_id || '';
  selCliente.disabled = !!existente; // no se cambia el cliente de una dirección existente
  document.getElementById('fd-etiqueta').value = existente?.etiqueta || '';
  document.getElementById('fd-domicilio').value = existente?.domicilio || '';
  document.getElementById('fd-localidad').value = existente?.localidad || '';
  document.getElementById('fd-provincia').value = existente?.provincia || '';
  document.getElementById('fd-notas').value = existente?.notas || '';
  document.getElementById('fd-es_principal').checked = !!existente?.es_principal;

  document.getElementById('modal-direccion-backdrop').style.display = 'block';
  document.getElementById('modal-direccion').style.display = 'flex';
  document.getElementById('modal-direccion').classList.add('open');
}

export function cerrarModalDireccion() {
  document.getElementById('modal-direccion-backdrop').style.display = 'none';
  document.getElementById('modal-direccion').classList.remove('open');
  document.getElementById('fd-cliente_id').disabled = false;
}

export async function guardarDireccion() {
  const id = document.getElementById('fd-id').value;
  const cliente_id = document.getElementById('fd-cliente_id').value;
  const domicilio = document.getElementById('fd-domicilio').value.trim();

  if (!id && !cliente_id) { window.toast('Seleccioná un cliente'); return; }
  if (!domicilio) { window.toast('El domicilio es obligatorio'); return; }

  const ok = await window.confirmar(
    id ? `¿Guardar los cambios de esta dirección?` : `¿Confirmás agregar esta dirección de entrega?`,
    { labelOk: id ? 'Guardar' : 'Agregar', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  const payload = {
    cliente_id,
    etiqueta: document.getElementById('fd-etiqueta').value.trim() || null,
    domicilio,
    localidad: document.getElementById('fd-localidad').value.trim() || null,
    provincia: document.getElementById('fd-provincia').value.trim() || null,
    notas: document.getElementById('fd-notas').value.trim() || null,
    es_principal: document.getElementById('fd-es_principal').checked,
  };

  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/direcciones?_svc=direcciones', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(id ? { id, ...payload } : payload)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al guardar');
    window.toast('Dirección guardada');
    cerrarModalDireccion();
    estadoModulo.direccionesData = []; // fuerza recarga completa (por el reseteo de es_principal en otras filas)
    await cargarDirecciones();
  } catch (err) {
    console.error(err);
    window.toast('No se pudo guardar la dirección', 'error');
  }
}

export async function eliminarDireccion(id) {
  const ok = await window.confirmar(
    '¿Eliminar esta dirección de entrega? Esta acción no se puede deshacer.',
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/clientes/direcciones?_svc=direcciones&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al eliminar');
    window.toast('Dirección eliminada');
    estadoModulo.direccionesData = estadoModulo.direccionesData.filter(r => r.id !== id);
    renderTablaDirecciones(estadoModulo.direccionesData);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo eliminar la dirección', 'error');
  }
}
