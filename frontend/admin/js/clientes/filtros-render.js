// frontend/admin/js/clientes/filtros-render.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { SCORE_CATEGORIAS, estadoModulo } from './_estado.js';
import { escHtml, escOnclickArg, formatPeso, iniciales } from './_helpers.js';
import { cargarClientes } from './carga-listado.js';
import { abrirModalEditar, abrirModalNuevo } from './modal-cliente.js';
import { gestionarAccesoPortal } from './portal-cliente.js';
import { motivoFrase, verScoreCliente } from './score-cliente.js';

// ── Filtros ────────────────────────────────────────────────────────────────
export async function aplicarFiltros() {
  estadoModulo.paginaActual = 1; // Resetear a la primera página al filtrar
  await cargarClientes();
}

export function selFiltroEstado(estado, btn) {
  estadoModulo.filtroEstado = estado;
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  aplicarFiltros();
}

export function limpiarFiltros() {
  document.getElementById('input-busqueda').value = '';
  document.getElementById('filtro-zona').value = '';
  estadoModulo.filtroEstado = '';
  document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
  document.querySelector('.e-pill[data-f=""]').classList.add('activa');
  aplicarFiltros();
}

// ── Render tabla ───────────────────────────────────────────────────────────
export function renderTabla() {
  const tbody = document.getElementById('tabla-body');
  if (!tbody) return;

  if (!estadoModulo.clientesData.length) {
    window.mostrarEstadoVacio('tabla-body', {
      icono: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      titulo: 'Sin clientes registrados',
      descripcion: 'No se encontraron clientes con los filtros aplicados.',
      ctaLabel: '+ Nuevo cliente',
      ctaOnClick: 'abrirModalNuevo()',
    });
    return;
  }
  window.renderTbody(tbody, estadoModulo.clientesData, (c) => {
    const nombre  = c.nombre_fantasia || c.razon_social;
    const deuda   = Number(c.saldo_deuda || 0);
    const limite  = Number(c.limite_credito || 0);
    const deudaCls = deuda > limite && limite > 0 ? 'num-rojo' : deuda > 0 ? 'num-amarillo' : 'num-verde';

    return `
      <tr class="fila-cliente fila-clickeable${c.activo ? '' : ' fila-inactiva'}" data-testid="clientes-fila" data-id="${c.id}" onclick="if (event.target.closest('[onclick],a,select,input,textarea,button') === this) abrirModalEditar('${c.id}')">
        <td class="td-cliente" data-label="Cliente">
          <div class="cli-avatar">${iniciales(nombre)}</div>
          <div>
            <div class="cli-nombre">${escHtml(nombre)}</div>
            ${c.nombre_fantasia ? `<div class="cli-razon">${escHtml(c.razon_social)}</div>` : ''}
            ${c.localidad ? `<div class="cli-loc">${escHtml(c.localidad)}</div>` : ''}
          </div>
        </td>
        <td class="td-text" data-label="CUIT">${c.cuit || '—'}</td>
        <td class="td-text" data-label="Zona">${escHtml(c.zonas?.nombre || '—')}</td>
        <td class="td-text" data-label="Teléfono">${c.telefono ? `<a href="tel:${sanitize(c.telefono)}" class="tel-link">${escHtml(c.telefono)}</a>` : '—'}</td>
        <td class="td-num td-muted" data-label="Límite crédito">${limite > 0 ? formatPeso(limite) : '—'}</td>
        <td class="td-num ${deudaCls}" data-label="Saldo deuda">${deuda > 0 ? formatPeso(deuda) : (deuda < 0 ? `<span style="color:var(--color-success)">${formatPeso(Math.abs(deuda))} a favor</span>` : '<span style="color:var(--color-success)">Al día</span>')}</td>
        <td data-label="Estado">
          <span class="badge-estado ${c.activo ? 'badge-ok' : 'badge-critico'}">
            <span class="badge-dot"></span>${c.activo ? 'Activo' : 'Inactivo'}
          </span>
        </td>
        <td data-label="Confianza" class="td-score" ${c.score_actual != null ? `onclick="verScoreCliente('${c.id}')"` : ''}>
          ${c.score_actual != null
            ? (() => {
                const _frase = motivoFrase(c, c.score_categoria);
                return `<button class="score-badge-btn ${(SCORE_CATEGORIAS[c.score_categoria] || SCORE_CATEGORIAS.normal).cls}"
                   title="${_frase || 'Ver detalle de confianza'}">
                   ${(SCORE_CATEGORIAS[c.score_categoria] || SCORE_CATEGORIAS.normal).icono} ${c.score_actual}
                 </button>
                 ${_frase ? `<div class="score-motivo-inline">${escHtml(_frase)}</div>` : ''}`;
              })()
            : '<span class="td-muted">—</span>'}
        </td>
        <td class="td-acciones col-sticky-end" data-label="Acciones">
          <span class="fila-acciones">
          <button class="btn-tabla" onclick="abrirModalEditar('${c.id}')">Ver / Editar</button>
          <button class="btn-portal ${c.usuario_id ? 'btn-portal--activo' : ''}"
                  onclick="btnAsyncClick(this, () => gestionarAccesoPortal('${c.id}', ${escOnclickArg(nombre)}, ${!!c.usuario_id}))"
                  title="${c.usuario_id ? 'Tiene acceso portal — click para revocar' : 'Dar acceso al portal'}">
            ${c.usuario_id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>Portal' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Sin portal'}
          </button>
          </span>
        </td>
      </tr>`;
  }, 8);
}
