// frontend/admin/js/clientes/score-cliente.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { SCORE_CATEGORIAS, estadoModulo } from './_estado.js';
import { escHtml } from './_helpers.js';
import { cargarClientes } from './carga-listado.js';
import { cerrarModal } from './modal-cliente.js';
import { getFreshToken } from './nucleo.js';

// ═══════════════════════════════════════════════════════════════════════════
// REQ-5: Score Cliente — Semáforo Inteligente
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Renderiza el badge de score dentro de una celda / card de cliente.
 * @param {number} score     Valor 0-100
 * @param {string} categoria Categoría calculada
 * @returns {string} HTML del badge
 */
/**
 * Genera una frase corta explicando la principal causa del riesgo.
 * Solo se muestra cuando cat === 'riesgo' o 'bloqueado'.
 * @param {object} comp  { score_pagos, score_frecuencia, score_deuda, score_devolucion }
 * @param {string} cat   Categoría del score
 * @returns {string} Frase legible o ''
 */
export function motivoFrase(comp, cat) {
  if (!['riesgo', 'bloqueado'].includes(cat)) return '';
  if (!comp) return '';

  // Frases contextuales por componente según buckets del backend SQL
  function frasePagos(val) {
    if (val == null)  return 'Sin historial de pagos registrado';
    if (val <= 5)     return 'Paga con mucho atraso (más de 30 días después del vencimiento)';
    if (val <= 15)    return 'Paga con bastante atraso (15–30 días después del vencimiento)';
    if (val <= 25)    return 'Paga con algo de atraso (7–15 días después del vencimiento)';
    return null; // no es el problema dominante
  }
  function fraseFrecuencia(val) {
    if (val == null || val <= 3)  return 'Sin compras en los últimos 3 meses';
    if (val <= 9)                 return 'Muy pocas compras en los últimos 3 meses';
    if (val <= 15)                return 'Baja frecuencia de compras';
    return null;
  }
  function fraseDeuda(val) {
    if (val == null || val <= 5)  return 'Deuda supera ampliamente el límite de crédito';
    if (val <= 10)                return 'Deuda muy alta en relación al límite de crédito';
    if (val <= 14)                return 'Deuda alta en relación al límite de crédito';
    return null;
  }
  function fraseDevolucion(val) {
    if (val == null || val <= 3)  return 'Alta tasa de devoluciones (más del 20%)';
    if (val <= 7)                 return 'Tasa de devoluciones elevada (10–20%)';
    if (val <= 10)                return 'Tasa de devoluciones moderada (5–10%)';
    return null;
  }

  // Componentes con sus máximos para calcular el peor relativo
  const componentes = [
    { key: 'score_pagos',      max: 40, fn: frasePagos      },
    { key: 'score_deuda',      max: 20, fn: fraseDeuda      },
    { key: 'score_frecuencia', max: 25, fn: fraseFrecuencia },
    { key: 'score_devolucion', max: 15, fn: fraseDevolucion },
  ];

  // El componente con peor rendimiento relativo (% obtenido vs máximo)
  // Excluye score_pagos=20 (caso "sin datos", no es falla real)
  let peor = null, peorPct = Infinity;
  for (const c of componentes) {
    const val = comp[c.key] != null ? Number(comp[c.key]) : null;
    // score_pagos=20 es el default por "sin historial", no penalizar como malo
    if (c.key === 'score_pagos' && val === 20) continue;
    const efectivo = val ?? 0;
    const pct = efectivo / c.max;
    if (pct < peorPct) { peorPct = pct; peor = { ...c, val }; }
  }
  if (!peor) return '';

  const frase = peor.fn(peor.val);
  return frase || '';
}

export function renderScore(score, categoria) {
  const cat = SCORE_CATEGORIAS[categoria] || SCORE_CATEGORIAS.normal;
  return `<span class="score-badge ${cat.cls}" title="Nivel de confianza ${score}/100">${cat.icono} ${Math.round(score)}</span>`;
}

/**
 * Muestra el modal detallado de score de un cliente.
 * @param {string} clienteId UUID del cliente
 */
export async function verScoreCliente(clienteId) {
  const modal = document.getElementById('modal-score-cliente');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('score-cliente-body').innerHTML =
    '<div class="loading-row">Cargando nivel de confianza...</div>';

  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch(`/api/score?accion=cliente&cliente_id=${clienteId}`, {
      headers: { Authorization: `Bearer ${_freshTok}` }
    });
    if (!resp.ok) throw new Error('Error al cargar nivel de confianza');
    const { cliente, historial, ultima_oferta_plan_pago } = await resp.json();

    const score    = Number(cliente?.score_actual ?? 0);
    const cat      = cliente?.score_categoria || 'normal';
    const catDef   = SCORE_CATEGORIAS[cat] || SCORE_CATEGORIAS.normal;
    const scoreHtml = renderScore(score, cat);

    const componenteHtml = (label, val, max, desc) => {
      const pct = Math.round((val / max) * 100);
      return `
        <div class="score-comp">
          <div class="score-comp-header">
            <span class="score-comp-label">${label}</span>
            <span class="score-comp-val">${Number(val).toFixed(1)}/${max}</span>
          </div>
          <div class="score-bar-wrap">
            <div class="score-bar-fill score-bar-fill--${pct > 70 ? 'alta' : pct > 40 ? 'media' : 'baja'}"
                 style="width:${pct}%"></div>
          </div>
          <small class="score-comp-desc">${desc}</small>
        </div>`;
    };

    // Historial simplificado (últimos 6 puntos)
    const hist6 = (historial || []).slice(0, 6).reverse();
    const histHtml = hist6.length
      ? hist6.map(h => `
          <div class="score-hist-row">
            <time>${new Date(h.created_at).toLocaleDateString('es-AR')}</time>
            <span class="score-hist-val">${Math.round(h.score)}</span>
            <small>${h.motivo_cambio || ''}</small>
          </div>`).join('')
      : '<p class="empty-hint">Sin historial</p>';

    const frase = motivoFrase(historial?.[0], cat);

    document.getElementById('score-cliente-body').innerHTML = `
      <div class="score-desglose">
        <div class="score-header">
          ${scoreHtml}
          <span class="score-cat-badge ${catDef.cls}">${catDef.icono} ${catDef.label}</span>
        </div>
        ${frase ? `<p class="score-motivo-frase">${escHtml(frase)}</p>` : ''}
        <div class="score-grid">
          ${componenteHtml('Comportamiento de pago', (historial?.[0]?.score_pagos || 0), 40, 'Velocidad de pago vs. vencimiento')}
          ${componenteHtml('Frecuencia de compra',   (historial?.[0]?.score_frecuencia || 0), 25, 'Pedidos en últimos 90 días')}
          ${componenteHtml('Nivel de deuda',          (historial?.[0]?.score_deuda || 0), 20, 'Ratio deuda/límite crédito')}
          ${componenteHtml('Devoluciones',            (historial?.[0]?.score_devolucion || 0), 15, 'Tasa de devoluciones')}
        </div>
        <div class="score-condiciones">
          <strong>Condiciones actuales:</strong>
          Días de crédito: <b>${cliente?.dias_credito ?? 0}</b>
        </div>
        <div class="score-historial">
          <strong>Historial</strong>
          ${histHtml}
        </div>
        <div class="score-acciones">
          <button class="btn btn--sm btn--primario" onclick="recalcularScore('${clienteId}')">
            ↺ Recalcular
          </button>
          ${['riesgo', 'bloqueado'].includes(cat) ? `
            <button class="btn btn--sm" style="background:#25D366;color:#fff;border:none;" onclick="ofrecerPlanPago('${clienteId}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-3px;margin-right:4px"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>Ofrecer plan de pago
            </button>
            <small class="empty-hint" style="display:block;margin-top:4px;">
              ${ultima_oferta_plan_pago
                ? `Última oferta enviada: ${new Date(ultima_oferta_plan_pago).toLocaleDateString('es-AR')}`
                : 'Todavía no se le ofreció un plan de pago'}
            </small>
          ` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    document.getElementById('score-cliente-body').innerHTML =
      `<p class="empty-hint">Error: ${err.message}</p>`;
  }
}

window.cerrarModalScore = function() {
  const m = document.getElementById('modal-score-cliente');
  if (m) m.style.display = 'none';
};

window.recalcularScore = async function(clienteId) {
  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch('/api/score?accion=recalcular', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_freshTok}`
      },
      body: JSON.stringify({ cliente_id: clienteId })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error');
    window.toast(`Nivel de confianza recalculado: ${Math.round(data.score)}/100`);
    await verScoreCliente(clienteId);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo recalcular el nivel de confianza', 'error');
  }
};

window.ofrecerPlanPago = async function(clienteId) {
  if (!confirm('¿Enviar oferta de plan de pago por WhatsApp a este cliente ahora?')) return;
  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch('/api/score?accion=ofrecer-plan-pago', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_freshTok}`
      },
      body: JSON.stringify({ cliente_id: clienteId })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error');
    window.toast('Oferta de plan de pago enviada por WhatsApp');
    await verScoreCliente(clienteId);
  } catch (err) {
    console.error(err);
    window.toast('No se pudo enviar la oferta por WhatsApp', 'error');
  }
};

// REQ-07: el envío de pedido habitual por WhatsApp ahora vive en
// clientes-ciclos.js (sección "Piloto Automático" de la ficha), que reemplaza
// a la función enviarPedidoHabitual() que pegaba directo a /api/piloto.

export async function cargarAlertasScore() {
  try {
    const _freshTok = await getFreshToken();
    const resp = await fetch('/api/score?accion=alertas', {
      headers: { Authorization: `Bearer ${_freshTok}` }
    });
    if (!resp.ok) return;
    const { alertas } = await resp.json();
    renderAlertasScorePanel(alertas || []);
  } catch (err) {
    console.error('[Score] alertas:', err);
  }
}

export function renderAlertasScorePanel(alertas) {
  const panel = document.getElementById('panel-alertas-score');
  if (!panel) return;
  if (!alertas.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  panel.innerHTML = `
    <div class="panel-alerta-title">⚠ ${alertas.length} alerta(s) de nivel de confianza</div>
    ${alertas.slice(0, 3).map(a => `
      <div class="alerta-score-row">
        <strong>${sanitize(a.clientes?.razon_social)}</strong>
        <span>${sanitize(a.mensaje)}</span>
        <button class="btn btn--xs btn--ghost" onclick="btnAsyncClick(this, () => resolverAlertaScore('${a.id}'))">Resolver</button>
      </div>`).join('')}
  `;
}

export async function resolverAlertaScore(alertaId) {
  const _freshTok = await getFreshToken();
  await fetch('/api/score?accion=resolver-alerta', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_freshTok}`
    },
    body: JSON.stringify({ alerta_id: alertaId })
  });
  window.toast('Alerta resuelta');
  await cargarAlertasScore();
}

// Exponer en window

// ── confirmarBaja: dar de baja al cliente activo en modal ─────────────────
export async function confirmarBaja() {
  if (!estadoModulo.modalClienteId) return;
  if (!(await confirmar('¿Dar de baja a este cliente? Quedará inactivo.', { labelOk: 'Dar de baja', tipo: 'danger' }))) return;
  try {
    const { error } = await window.conTimeoutRed(estadoModulo.sb.from('clientes').update({ activo: false }).eq('id', estadoModulo.modalClienteId), 10000);
    if (error) throw error;
    window.toast('Cliente dado de baja', 'warn');
    cerrarModal();
    await cargarClientes();
  } catch (err) {
    console.error(err);
    window.toast('No se pudo dar de baja al cliente', 'error');
  }
}

// ── confirmarDesbloqueo: desbloqueo manual (override de admin) ────────────
// Hallazgo AUDITORIA_CRUD_TABLAS_2026: existía bloqueo automático por mora
// (motor de cierre) pero ningún botón para desbloquear a mano — un cliente
// que arregla la deuda por fuera del flujo automático (acuerdo de pago,
// error de carga) quedaba bloqueado para siempre salvo que se saldara
// completamente vía registrar_cobro_completo.
export async function confirmarDesbloqueo() {
  if (!estadoModulo.modalClienteId) return;
  if (!(await confirmar('¿Desbloquear a este cliente? Va a poder volver a hacer pedidos.', { labelOk: 'Desbloquear' }))) return;
  try {
    const token = await getFreshToken();
    const res = await fetch('/api/clientes?_svc=desbloquear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cliente_id: estadoModulo.modalClienteId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'No se pudo desbloquear al cliente');
    }
    window.toast('Cliente desbloqueado', 'success');
    cerrarModal();
    await cargarClientes();
  } catch (err) {
    console.error(err);
    window.toast(err.message || 'No se pudo desbloquear al cliente', 'error');
  }
}
