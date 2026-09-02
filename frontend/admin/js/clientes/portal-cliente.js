// frontend/admin/js/clientes/portal-cliente.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { escHtml, escOnclickArg } from './_helpers.js';
import { cargarClientes } from './carga-listado.js';
import { enviarEstadoCuenta } from './modal-cliente.js';

// ── Acceso Portal Cliente ─────────────────────────────────────────────────────

export async function gestionarAccesoPortal(clienteId, nombreCliente, tieneAcceso) {
  if (tieneAcceso) {
    // Revocar
    const ok = await confirmar(
      `¿Revocar el acceso portal de ${nombreCliente}? El cliente no podrá ingresar más.`,
      { labelOk: 'Revocar acceso', tipo: 'danger' }
    );
    if (!ok) return;

    try {
      const { data: { session: _sesRev } } = await estadoModulo.sb.auth.getSession();
      const resp = await fetch('/api/clientes/acceso?_svc=acceso', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_sesRev?.access_token || ''}`
        },
        body: JSON.stringify({ cliente_id: clienteId, accion: 'revocar' })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      window.toast('Acceso revocado correctamente', 'warn');
      await cargarClientes();
    } catch (err) {
      console.error(err);
      window.toast('No se pudo revocar el acceso', 'error');
    }
    return;
  }

  // Crear acceso
  const overlay = document.getElementById('modal-portal-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.getElementById('modal-portal-nombre').textContent = nombreCliente;
  document.getElementById('modal-portal-resultado').style.display = 'none';
  document.getElementById('modal-portal-loading').style.display = 'flex';
  document.getElementById('btn-crear-acceso').dataset.clienteId = clienteId;
  document.getElementById('btn-crear-acceso').style.display = 'inline-flex';
  document.getElementById('modal-portal-loading').style.display = 'none';
}

export async function confirmarCrearAcceso() {
  const btn = document.getElementById('btn-crear-acceso');
  const clienteId = btn.dataset.clienteId;
  btn.style.display = 'none';
  document.getElementById('modal-portal-loading').style.display = 'flex';

  try {
    const { data: { session: _sess } } = await estadoModulo.sb.auth.getSession();
    const resp = await fetch('/api/clientes/acceso?_svc=acceso', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_sess?.access_token || ''}`
      },
      body: JSON.stringify({ cliente_id: clienteId, accion: 'crear' })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    document.getElementById('modal-portal-loading').style.display = 'none';
    document.getElementById('modal-portal-resultado').style.display = 'block';
    document.getElementById('portal-wa-texto').value = data.mensajeWA;
    // Setear link directo a WhatsApp
    document.getElementById('btn-abrir-wa').href = data.waLink;
    await cargarClientes();
  } catch (err) {
    console.error(err);
    document.getElementById('modal-portal-loading').style.display = 'none';
    document.getElementById('btn-crear-acceso').style.display = 'inline-flex';
    window.toast('No se pudo crear el acceso al portal', 'error');
  }
}

export function copiarMensajeWA() {
  const txt = document.getElementById('portal-wa-texto').value;
  navigator.clipboard.writeText(txt).then(() => {
    window.toast('Mensaje copiado — pegalo en WhatsApp');
    document.getElementById('btn-copiar-wa').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Copiado';
    setTimeout(() => { document.getElementById('btn-copiar-wa').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>Copiar mensaje'; }, 2000);
  });
}

export function cerrarModalPortal() {
  document.getElementById('modal-portal-overlay').style.display = 'none';
}

// ── Modal Gestión de Accesos al Portal (listado completo, todos los clientes) ──

export async function abrirModalAccesosPortal() {
  const overlay = document.getElementById('modal-accesos-portal-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const input = document.getElementById('input-busqueda-accesos-portal');
  if (input) input.value = '';
  await cargarAccesosPortal();
}

export async function cargarAccesosPortal() {
  const cont = document.getElementById('lista-accesos-portal');
  if (cont) {
    cont.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--color-text-muted);font-size:.85rem;">Cargando clientes...</div>';
  }
  const { data, error } = await window.conTimeoutRed(estadoModulo.sb
    .from('clientes')
    .select('id, nombre_fantasia, razon_social, email, usuario_id, activo')
    .eq('empresa_id', estadoModulo.empresaData.id)
    .order('razon_social'), 10000);

  if (error) {
    console.error('[accesos-portal] Error al cargar clientes:', error);
    if (cont) cont.innerHTML = `<div style="text-align:center;padding:1.5rem;color:var(--color-danger);font-size:.85rem;">Error al cargar clientes: ${escHtml(error.message)}</div>`;
    return;
  }

  estadoModulo.accesosPortalData = data || [];
  renderListaAccesosPortal();
}

export function renderListaAccesosPortal() {
  const cont = document.getElementById('lista-accesos-portal');
  if (!cont) return;

  const filtro = (document.getElementById('input-busqueda-accesos-portal')?.value || '').trim().toLowerCase();
  const lista = estadoModulo.accesosPortalData.filter((c) => {
    if (!filtro) return true;
    const nombre = (c.nombre_fantasia || c.razon_social || '').toLowerCase();
    const razon  = (c.razon_social || '').toLowerCase();
    const email  = (c.email || '').toLowerCase();
    return nombre.includes(filtro) || razon.includes(filtro) || email.includes(filtro);
  });

  if (!lista.length) {
    cont.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--color-text-muted);font-size:.85rem;">No se encontraron clientes.</div>';
    return;
  }

  cont.innerHTML = lista.map((c) => {
    const nombre = c.nombre_fantasia || c.razon_social;
    const tieneAcceso = !!c.usuario_id;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.55rem .65rem;border:1px solid var(--color-border);border-radius: var(--radius-md);${c.activo ? '' : 'opacity:.6;'}">
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:.87rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(nombre)}</div>
          <div style="font-size:.75rem;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.email ? escHtml(c.email) : 'Sin email'}${c.activo ? '' : ' · Inactivo'}</div>
        </div>
        <button class="btn-portal ${tieneAcceso ? 'btn-portal--activo' : ''}" style="flex-shrink:0;"
                onclick="btnAsyncClick(this, () => gestionarAccesoPortalDesdeModal('${c.id}', ${escOnclickArg(nombre)}, ${tieneAcceso}))"
                title="${tieneAcceso ? 'Tiene acceso portal — click para revocar' : 'Dar acceso al portal'}">
          ${tieneAcceso
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-2px;margin-right:4px"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>Portal'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-2px;margin-right:4px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Sin portal'}
        </button>
      </div>`;
  }).join('');
}

export async function gestionarAccesoPortalDesdeModal(clienteId, nombreCliente, tieneAcceso) {
  await gestionarAccesoPortal(clienteId, nombreCliente, tieneAcceso);
  // Refresca la lista local (sin cerrar este modal) para reflejar el cambio.
  // Si se abrió el sub-modal de "crear acceso", éste se refresca solo al confirmar.
  await cargarAccesosPortal();
}

export function cerrarModalAccesosPortal() {
  const overlay = document.getElementById('modal-accesos-portal-overlay');
  if (overlay) overlay.style.display = 'none';
}

// FIX: enviarEstadoCuenta se llama desde onclick="enviarEstadoCuenta('${id}')" generado
// dinámicamente, pero al ser este archivo un módulo ES6 no queda accesible en window.
