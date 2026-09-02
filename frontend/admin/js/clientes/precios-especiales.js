// frontend/admin/js/clientes/precios-especiales.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { cargarDirecciones } from './direcciones.js';
import { cargarListasPreciosTab } from './listas-precio.js';
import { getFreshToken } from './nucleo.js';

// ── Precios especiales (vista global) ────────────────────────────────────

export async function cambiarVista(vista) {
  estadoModulo.vistaActual = vista;
  document.getElementById('vtab-clientes').classList.toggle('activa', vista === 'clientes');
  document.getElementById('vtab-precios').classList.toggle('activa', vista === 'precios');
  document.getElementById('vtab-direcciones').classList.toggle('activa', vista === 'direcciones');
  document.getElementById('vtab-listas').classList.toggle('activa', vista === 'listas');
  document.getElementById('vista-clientes').style.display = vista === 'clientes' ? '' : 'none';
  document.getElementById('vista-precios').style.display = vista === 'precios' ? '' : 'none';
  document.getElementById('vista-direcciones').style.display = vista === 'direcciones' ? '' : 'none';
  document.getElementById('vista-listas').style.display = vista === 'listas' ? '' : 'none';
  if (vista === 'precios' && estadoModulo.preciosData.length === 0) {
    await cargarPreciosClientes();
  }
  if (vista === 'direcciones' && estadoModulo.direccionesData.length === 0) {
    await cargarDirecciones();
  }
  if (vista === 'listas') {
    await cargarListasPreciosTab();
  }
}

export async function cargarPreciosClientes() {
  const tbody = document.getElementById('tabla-precios-body');
  tbody.innerHTML = '<tr><td colspan="6" class="tabla-loading">Cargando precios...</td></tr>';
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/precios?_svc=precios', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al cargar precios');
    estadoModulo.preciosData = data || [];
    renderTablaPrecios(estadoModulo.preciosData);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="tabla-loading">${sanitize(err.message)}</td></tr>`;
  }
}

export function renderTablaPrecios(rows) {
  const tbody = document.getElementById('tabla-precios-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tabla-loading">Sin precios especiales cargados</td></tr>';
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const clienteNombre = r.clientes?.nombre_fantasia || r.clientes?.razon_social || '—';
    const productoNombre = r.productos?.nombre ? `${r.productos.nombre}${r.productos.codigo ? ' (' + r.productos.codigo + ')' : ''}` : '—';
    const actualizado = r.updated_at ? new Date(r.updated_at).toLocaleDateString('es-AR') : '—';
    tr.innerHTML = `
      <td>${sanitize(clienteNombre)}</td>
      <td>${sanitize(productoNombre)}</td>
      <td class="th-num">$${Number(r.precio).toLocaleString('es-AR', {minimumFractionDigits:2})}</td>
      <td>${sanitize(r.notas || '—')}</td>
      <td>${actualizado}</td>
      <td class="col-sticky-end"><span class="fila-acciones"><button type="button" class="btn-tabla peligro" onclick="btnAsyncClick(this, () => eliminarPrecioCliente('${r.id}'))">Eliminar</button></span></td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

export function filtrarPrecios() {
  const b = document.getElementById('input-busqueda-precios').value.trim().toLowerCase();
  if (!b) return renderTablaPrecios(estadoModulo.preciosData);
  const filtradas = estadoModulo.preciosData.filter(r => {
    const cliente = (r.clientes?.nombre_fantasia || r.clientes?.razon_social || '').toLowerCase();
    const producto = (r.productos?.nombre || r.productos?.codigo || '').toLowerCase();
    return cliente.includes(b) || producto.includes(b);
  });
  renderTablaPrecios(filtradas);
}

export async function abrirModalPrecio() {
  // Poblar select de clientes (reutiliza clientesData ya cargado)
  const selCliente = document.getElementById('fp-cliente_id');
  selCliente.innerHTML = '<option value="">Seleccioná un cliente</option>' +
    estadoModulo.clientesData.map(c => `<option value="${c.id}">${sanitize(c.nombre_fantasia || c.razon_social)}</option>`).join('');

  // Poblar select de productos (consulta directa, igual que en compras.js)
  if (estadoModulo.productosParaPrecios.length === 0) {
    const { data } = await window.conTimeoutRed(estadoModulo.sb.from('productos').select('id, nombre, codigo').eq('activo', true).order('nombre'), 10000);
    estadoModulo.productosParaPrecios = data || [];
  }
  const selProducto = document.getElementById('fp-producto_id');
  selProducto.innerHTML = '<option value="">Seleccioná un producto</option>' +
    estadoModulo.productosParaPrecios.map(p => `<option value="${p.id}">${sanitize(p.nombre)}${p.codigo ? ' (' + sanitize(p.codigo) + ')' : ''}</option>`).join('');

  document.getElementById('fp-precio').value = '';
  document.getElementById('fp-notas').value = '';
  document.getElementById('modal-precio-backdrop').style.display = 'block';
  document.getElementById('modal-precio').style.display = 'flex';
  document.getElementById('modal-precio').classList.add('open');
}

export function cerrarModalPrecio() {
  document.getElementById('modal-precio-backdrop').style.display = 'none';
  document.getElementById('modal-precio').classList.remove('open');
}

export async function guardarPrecioCliente() {
  const cliente_id = document.getElementById('fp-cliente_id').value;
  const producto_id = document.getElementById('fp-producto_id').value;
  const precio = document.getElementById('fp-precio').value;
  const notas = document.getElementById('fp-notas').value.trim();

  if (!cliente_id) { window.toast('Seleccioná un cliente'); return; }
  if (!producto_id) { window.toast('Seleccioná un producto'); return; }
  if (precio === '' || Number(precio) < 0) { window.toast('Ingresá un precio válido'); return; }

  const ok = await window.confirmar(`¿Confirmás guardar este precio especial de $${precio}?`, { labelOk: 'Guardar', labelCancel: 'Revisar' });
  if (!ok) return;

  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/precios?_svc=precios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cliente_id, producto_id, precio: Number(precio), notas: notas || null })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al guardar');
    window.toast('Precio especial guardado');
    cerrarModalPrecio();
    await cargarPreciosClientes();
  } catch (err) {
    console.error(err);
    window.toast('No se pudo guardar el precio especial', 'error');
  }
}

export async function eliminarPrecioCliente(id) {
  const ok = await window.confirmar(
    '¿Eliminar este precio especial? Esta acción no se puede deshacer.',
    { labelOk: 'Eliminar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!ok) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch(`/api/clientes/precios?_svc=precios&id=${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al eliminar');
    window.toast('Precio especial eliminado');
    estadoModulo.preciosData = estadoModulo.preciosData.filter(r => r.id !== id);
    renderTablaPrecios(estadoModulo.preciosData);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo eliminar el precio especial', 'error');
  }
}
