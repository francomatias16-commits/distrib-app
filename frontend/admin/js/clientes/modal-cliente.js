// frontend/admin/js/clientes/modal-cliente.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { SCORE_CATEGORIAS, estadoModulo } from './_estado.js';
import { escHtml, formatPeso } from './_helpers.js';
import { obtenerClientePorId } from './carga-listado.js';
import { cargarBloqueos, cargarComprobantesHistoricosCliente, cargarCtaCteCliente, cargarHistorialNotasCliente } from './cta-cte-historial.js';
import { resetForm } from './guardar-cliente.js';
import { verScoreCliente } from './score-cliente.js';

// ── Modal ──────────────────────────────────────────────────────────────────
export function abrirModalNuevo() {
  estadoModulo.modalClienteId = null;
  document.getElementById('modal-titulo').textContent    = 'Nuevo cliente';
  document.getElementById('modal-subtitulo').textContent = 'Completá los datos del cliente';
  const _badgeCont = document.getElementById('badge-origen-migracion');
  if (_badgeCont) _badgeCont.innerHTML = '';
  document.getElementById('tab-historial').style.display = 'none';
  document.getElementById('tab-cta').style.display       = 'none';
  document.getElementById('tab-comprobantes').style.display = 'none';
  document.getElementById('tab-bloqueos').style.display     = 'none';
  document.getElementById('btn-baja').style.display      = 'none';
  document.getElementById('btn-desbloquear').style.display = 'none';
  document.getElementById('resumen-deuda').style.display = 'none';
  resetForm();
  selTab('datos', document.querySelector('.modal-tab[data-tab="datos"]'));
  abrirModal();
}

export async function abrirModalEditar(id) {
  estadoModulo.modalClienteId = id;
  let c = estadoModulo.clientesData.find(x => x.id === id);

  if (!c) {
    // El cliente puede no estar en la página actual (la lista pagina de a
    // 50). Lo traemos puntualmente con el mismo shape que usa la tabla.
    c = await obtenerClientePorId(id);
    if (!c) {
      window.mostrarToast?.('No se encontró el cliente', 'err');
      return;
    }
    estadoModulo.clientesData = [c, ...estadoModulo.clientesData];
  }

  document.getElementById('modal-titulo').textContent    = c.nombre_fantasia || c.razon_social;
  document.getElementById('modal-subtitulo').textContent = c.cuit ? `CUIT: ${sanitize(c.cuit)}` : 'Sin CUIT cargado';
  if (typeof renderBadgeOrigenMigracion === 'function') renderBadgeOrigenMigracion('clientes', c.id, 'badge-origen-migracion');
  document.getElementById('tab-historial').style.display = 'flex';
  document.getElementById('tab-cta').style.display       = 'flex';
  document.getElementById('tab-comprobantes').style.display = 'flex';
  document.getElementById('tab-bloqueos').style.display     = 'flex';
  document.getElementById('btn-baja').style.display      = c.activo ? 'inline-flex' : 'none';
  document.getElementById('btn-desbloquear').style.display = c.bloqueado ? 'inline-flex' : 'none';

  // Poblar form
  document.getElementById('f-razon_social').value    = c.razon_social || '';
  document.getElementById('f-nombre_fantasia').value = c.nombre_fantasia || '';
  document.getElementById('f-cuit').value            = c.cuit || '';
  document.getElementById('f-condicion_iva').value   = c.condicion_iva || 'consumidor_final';
  document.getElementById('f-telefono').value        = c.telefono || '';
  document.getElementById('f-email').value           = c.email || '';
  document.getElementById('f-domicilio').value       = c.domicilio || '';
  document.getElementById('f-localidad').value       = c.localidad || '';
  document.getElementById('f-zona_id').value         = c.zona_id || '';
  document.getElementById('f-deposito_id').value      = c.deposito_id || '';
  document.getElementById('f-notas').value           = c.notas || '';
  document.getElementById('f-lista_precio_id').value = c.lista_precio_id || '';
  document.getElementById('f-dias_credito').value    = c.dias_credito || 0;
  document.getElementById('f-limite_credito').value  = c.limite_credito || 0;
  document.getElementById('f-activo').value          = String(c.activo !== false);
  document.getElementById('f-lat').value             = c.lat ?? '';
  document.getElementById('f-lng').value             = c.lng ?? '';
  document.getElementById('f-vendedor_id_default').value = c.vendedor_id_default || '';

  // Score exacto + link en panel-datos
  const scoreExactoEl = document.getElementById('score-exacto-dato');
  if (scoreExactoEl) {
    if (c.score_actual != null) {
      const catDef = SCORE_CATEGORIAS[c.score_categoria] || SCORE_CATEGORIAS.normal;
      scoreExactoEl.innerHTML = `
        <span class="score-badge-inline ${catDef.cls}" style="font-size:.9rem">
          ${catDef.icono} <strong>${c.score_actual}</strong>/100 — ${catDef.label}
        </span>
        <button type="button" class="btn-link-score" onclick="verScoreCliente('${id}')" title="Ver historial completo de confianza">
          Ver historial ↗
        </button>`;
    } else {
      scoreExactoEl.innerHTML = '<span style="color:var(--color-text-muted);font-size:.85rem">Sin score calculado todavía.</span>';
    }
  }

  // Resumen crédito
  const deuda   = Number(c.saldo_deuda || 0);
  const limite  = Number(c.limite_credito || 0);
  const usado   = limite > 0 ? Math.min((deuda / limite) * 100, 100) : 0;
  const deudaCls = deuda > limite && limite > 0 ? 'val-rojo' : deuda > 0 ? 'val-amarillo' : 'val-verde';
  document.getElementById('resumen-deuda').style.display = 'block';
  document.getElementById('credito-grid').innerHTML = `
    <div class="credito-item">
      <span class="cred-label">Saldo deuda</span>
      <span class="cred-val ${deudaCls}">${deuda > 0 ? formatPeso(deuda) : (deuda < 0 ? `${formatPeso(Math.abs(deuda))} a favor` : 'Al día')}</span>
    </div>
    <div class="credito-item">
      <span class="cred-label">Límite de crédito</span>
      <span class="cred-val">${limite > 0 ? formatPeso(limite) : 'Sin límite'}</span>
    </div>
    <div class="credito-item">
      <span class="cred-label">Días de crédito</span>
      <span class="cred-val">${c.dias_credito || 0} días</span>
    </div>
    <div class="credito-item">
      <span class="cred-label">Lista de precios</span>
      <span class="cred-val">${escHtml(c.listas_precios?.nombre || 'Por defecto')}</span>
    </div>
    ${limite > 0 ? `
    <div class="credito-item credito-full">
      <span class="cred-label">Crédito usado: ${usado.toFixed(0)}%</span>
      <div class="barra-credito">
        <div class="barra-fill ${deuda > limite ? 'barra-rojo' : deuda > limite * 0.8 ? 'barra-amarillo' : 'barra-verde'}" style="width:${usado}%"></div>
      </div>
    </div>` : ''}
    <div class="credito-item credito-full" style="margin-top:8px">
      <button class="btn-secundario" id="btn-estado-cuenta"
        onclick="enviarEstadoCuenta('${id}')"
        ${!c.email ? 'disabled title="El cliente no tiene email registrado"' : ''}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></svg>Enviar estado de cuenta
      </button>
    </div>
  `;

  // REQ-07: cargar sección Piloto Automático (ciclos + pedido sugerido)
  cli_ciclos_cargar(id);

  selTab('datos', document.querySelector('.modal-tab[data-tab="datos"]'));
  abrirModal();
}

// ── REQ-10: Enviar estado de cuenta por email ──────────────────────────────
export async function enviarEstadoCuenta(clienteId) {
  const btn = document.getElementById('btn-estado-cuenta');
  if (!btn) return;
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    const { data: { session } } = await estadoModulo.sb.auth.getSession();
    const resp = await fetch('/api/notif?_svc=estado-cuenta', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ cliente_id: clienteId }),
    });
    const data = await resp.json();
    if (resp.ok) {
      window.toast(`Estado de cuenta enviado a ${data.destinatario}`);
    } else {
      window.toast(data.error || 'Error al enviar', 'error');
    }
  } catch (e) {
    window.toast('Error de conexión', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

export function abrirModal() {
  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-cliente').classList.add('open');
  document.body.style.overflow = 'hidden';
}

export function cerrarModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  document.getElementById('modal-cliente').classList.remove('open');
  document.body.style.overflow = '';
}

export function selTab(tab, btn) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('activo'));
  btn.classList.add('activo');
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.getElementById('panel-' + tab).style.display = 'flex';
  document.getElementById('form-acciones').style.display =
    (tab === 'historial' || tab === 'cta' || tab === 'comprobantes') ? 'none' : 'flex';

  if (tab === 'historial' && estadoModulo.modalClienteId) {
    window.NotasInternas?.resetPaginacion('historial-lista');
    cargarHistorialNotasCliente(estadoModulo.modalClienteId);
  }
  if (tab === 'cta' && estadoModulo.modalClienteId) cargarCtaCteCliente(estadoModulo.modalClienteId);
  if (tab === 'comprobantes' && estadoModulo.modalClienteId) cargarComprobantesHistoricosCliente(estadoModulo.modalClienteId);
  if (tab === 'bloqueos' && estadoModulo.modalClienteId) cargarBloqueos(estadoModulo.modalClienteId);
}
