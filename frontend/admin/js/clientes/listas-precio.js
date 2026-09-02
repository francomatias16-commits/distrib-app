// frontend/admin/js/clientes/listas-precio.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { cargarListas } from './carga-listado.js';
import { getFreshToken } from './nucleo.js';

// ── Listas de precio (vista global) ──────────────────────────────────────
// Ex /admin/listas-precio (página propia) — incorporada acá porque es un
// ABM chico y conceptualmente pertenece a Clientes: son las condiciones
// comerciales que se asignan desde la pestaña "Comercial" de la ficha de
// cada cliente (ver cargarListas() más arriba, que puebla ese combo).
// Mismo endpoint /api/maestros?recurso=listas-precios que usaba la página
// vieja — no se tocó nada del lado del servidor.

export async function cargarListasPreciosTab() {
  const tbody = document.getElementById('tabla-listas-body');
  tbody.innerHTML = '<tr><td colspan="4" class="tabla-loading">Cargando listas...</td></tr>';
  try {
    const token = await getFreshToken();
    const activa = document.getElementById('filtro-activa-listas')?.value ?? 'true';
    const params = new URLSearchParams({ recurso: 'listas-precios' });
    if (activa !== '') params.set('activa', activa);

    const resp = await fetch(`/api/maestros?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'No se pudo cargar la lista de precios.');
    estadoModulo.listasPreciosTabData = data.data || [];
    renderTablaListasPrecios();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="tabla-loading">${sanitize(err.message)}</td></tr>`;
  }
}

export function renderTablaListasPrecios() {
  const tbody = document.getElementById('tabla-listas-body');
  if (!tbody) return;

  if (!estadoModulo.listasPreciosTabData.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="tabla-loading">Todavía no cargaste ninguna lista. Creá la primera con «Nueva lista».</td></tr>';
    return;
  }

  tbody.innerHTML = estadoModulo.listasPreciosTabData.map(l => `
    <tr>
      <td>${sanitize(l.nombre)}</td>
      <td style="text-align:center">${l.es_default ? '<span class="badge-estado badge-ok"><span class="badge-dot"></span>Sí</span>' : '—'}</td>
      <td><span class="badge-estado ${l.activa ? 'badge-ok' : 'badge-critico'}"><span class="badge-dot"></span>${l.activa ? 'Activa' : 'Inactiva'}</span></td>
      <td class="col-sticky-end">
        <span class="fila-acciones">
          <button type="button" class="btn-tabla" onclick="abrirModalListaPrecio('${l.id}')">Editar</button>
          ${l.activa
            ? `<button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => desactivarListaPrecio('${l.id}'))">Dar de baja</button>`
            : `<button type="button" class="btn-tabla primario" onclick="btnAsyncClick(this, () => activarListaPrecio('${l.id}'))">Activar</button>`
          }
        </span>
      </td>
    </tr>
  `).join('');
}

export function abrirModalListaPrecio(id) {
  estadoModulo.modalListaPrecioId = id || null;
  const l = id ? estadoModulo.listasPreciosTabData.find(x => x.id === id) : null;
  if (id && !l) { window.toast('No se pudo cargar la lista', 'error'); return; }

  document.getElementById('fl-id').value = id || '';
  document.getElementById('fl-nombre').value = l?.nombre || '';
  document.getElementById('fl-es_default').checked = !!l?.es_default;
  document.getElementById('modal-lista-precio-titulo').textContent = id ? 'Editar lista' : 'Nueva lista';

  document.getElementById('modal-lista-precio-backdrop').style.display = 'block';
  document.getElementById('modal-lista-precio').style.display = 'flex';
  document.getElementById('modal-lista-precio').classList.add('open');
}

export function cerrarModalListaPrecio() {
  document.getElementById('modal-lista-precio-backdrop').style.display = 'none';
  document.getElementById('modal-lista-precio').style.display = 'none';
  document.getElementById('modal-lista-precio').classList.remove('open');
  estadoModulo.modalListaPrecioId = null;
}

export async function guardarListaPrecio() {
  const id = document.getElementById('fl-id').value;
  const body = {
    nombre:     document.getElementById('fl-nombre').value.trim(),
    es_default: document.getElementById('fl-es_default').checked,
  };

  if (!body.nombre) { window.toast('El nombre es requerido', 'error'); return; }

  const ok = await window.confirmar(
    id ? `¿Guardar los cambios de la lista "${body.nombre}"?` : `¿Confirmás crear la lista "${body.nombre}"?`,
    { labelOk: id ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  try {
    const token = await getFreshToken();
    if (id) body.id = id;
    const resp = await fetch('/api/maestros?recurso=listas-precios', {
      method: id ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'No se pudo guardar la lista');

    window.toast(id ? 'Lista actualizada' : 'Lista creada', 'exito');
    cerrarModalListaPrecio();
    await cargarListasPreciosTab();
    await cargarListas(); // refresca el combo de la ficha del cliente (pestaña Comercial)
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo guardar la lista', 'error');
  }
}

export async function desactivarListaPrecio(id) {
  const ok = await window.confirmar(
    '¿Dar de baja esta lista de precio? Los clientes que la tengan asignada pasarán a usar la lista predeterminada.',
    { labelOk: 'Dar de baja', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/maestros?recurso=listas-precios&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'No se pudo dar de baja la lista');
    window.toast('Lista dada de baja', 'exito');
    await cargarListasPreciosTab();
    await cargarListas();
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo dar de baja la lista', 'error');
  }
}

export async function activarListaPrecio(id) {
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/maestros?recurso=listas-precios', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, activa: true })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'No se pudo activar la lista');
    window.toast('Lista activada', 'exito');
    await cargarListasPreciosTab();
    await cargarListas();
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo activar la lista', 'error');
  }
}

// Globales para onclick

