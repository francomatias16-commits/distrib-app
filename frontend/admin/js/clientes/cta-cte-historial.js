// frontend/admin/js/clientes/cta-cte-historial.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { ETIQUETA_TIPO_COMPROBANTE } from './_estado.js';
import { escHtml } from './_helpers.js';

export async function cargarCtaCteCliente(clienteId) {
  const contenedor = document.getElementById('panel-cta');
  if (!contenedor) return;
  contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Cargando cuenta corriente...</p>';
  try {
    // FIX: antes leía de movimientos_cta_cte, una tabla que ningún proceso
    // del backend escribe (RPCs reales: registrar_movimiento_cta_cte,
    // emitir_nota_cta_cte, aplicar_nota_credito_cta_cte, POS, etc. todos
    // escriben en cta_cte). Esto dejaba el modal siempre vacío en producción.
    // Fix (Fase 12): faltaba 'nota_debito' acá — una nota de débito
    // (emitida vía emitir_nota_cta_cte) quedaba sin clasificar y no se
    // mostraba como deuda en el extracto. Mismo ajuste hecho en el
    // trigger sync_saldo_deuda_cliente().
    const DEBE_TIPOS  = ['factura', 'debito', 'cargo', 'nota_debito'];
    const HABER_TIPOS = ['cobro', 'credito', 'nota_credito', 'pago'];
    const { data, error } = await window.conTimeoutRed(window.supabaseClient
      .from('cta_cte')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('fecha', { ascending: false })
      .limit(50), 10000);
    if (error) throw error;
    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Sin movimientos registrados.</p>';
      return;
    }
    const filas = data.map(m => {
      const esDebe = DEBE_TIPOS.includes(m.tipo);
      const esHaber = HABER_TIPOS.includes(m.tipo);
      const debe  = esDebe  ? m.monto : null;
      const haber = esHaber ? m.monto : null;
      return `
      <tr>
        <td>${m.fecha?.slice(0,10) ?? ''}</td>
        <td>${m.tipo ?? ''}</td>
        <td>${escHtml(m.descripcion ?? '')}</td>
        <td style="text-align:left">${debe != null ? '$' + Number(debe).toLocaleString('es-AR') : ''}</td>
        <td style="text-align:left">${haber != null ? '$' + Number(haber).toLocaleString('es-AR') : ''}</td>
        <td style="text-align:left;font-weight:600">${m.saldo != null ? '$' + Number(m.saldo).toLocaleString('es-AR') : ''}</td>
      </tr>`;
    }).join('');
    contenedor.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr>
          <th style="text-align:left;padding:.4rem .6rem">Fecha</th>
          <th style="text-align:left;padding:.4rem .6rem">Tipo</th>
          <th style="text-align:left;padding:.4rem .6rem">Descripción</th>
          <th style="text-align:left;padding:.4rem .6rem">Debe</th>
          <th style="text-align:left;padding:.4rem .6rem">Haber</th>
          <th style="text-align:left;padding:.4rem .6rem">Saldo</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  } catch(e) {
    console.error('[clientes] Error cargando cta-cte:', e);
    contenedor.innerHTML = `<p style="padding:1rem;color:var(--color-danger)">Error: ${sanitize(e.message)}</p>`;
  }
}

// Migración 177 (cierre gap crítico 1): comprobantes fiscales históricos,
// puramente de solo lectura — vienen de la migración asistida (wizard) y no
// se editan ni generan movimientos desde acá, solo se listan.

export async function cargarComprobantesHistoricosCliente(clienteId) {
  const contenedor = document.getElementById('panel-comprobantes');
  if (!contenedor) return;
  contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Cargando comprobantes...</p>';
  try {
    const { data, error } = await window.conTimeoutRed(window.supabaseClient
      .from('comprobantes_historicos')
      .select('*')
      .eq('cliente_id', clienteId)
      .order('fecha', { ascending: false })
      .limit(50), 10000);
    if (error) throw error;
    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Sin comprobantes históricos registrados.</p>';
      return;
    }
    const filas = data.map(c => `
      <tr>
        <td>${c.fecha?.slice(0,10) ?? ''}</td>
        <td>${ETIQUETA_TIPO_COMPROBANTE[c.tipo] || c.tipo || ''}</td>
        <td>${escHtml(c.numero_original ?? '')}</td>
        <td style="text-align:left">${c.monto != null ? '$' + Number(c.monto).toLocaleString('es-AR') + ' ' + (c.moneda || 'ARS') : ''}</td>
        <td>${escHtml(c.observaciones ?? '')}</td>
      </tr>`).join('');
    contenedor.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr>
          <th style="text-align:left;padding:.4rem .6rem">Fecha</th>
          <th style="text-align:left;padding:.4rem .6rem">Tipo</th>
          <th style="text-align:left;padding:.4rem .6rem">Número</th>
          <th style="text-align:left;padding:.4rem .6rem">Monto</th>
          <th style="text-align:left;padding:.4rem .6rem">Observaciones</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  } catch(e) {
    console.error('[clientes] Error cargando comprobantes históricos:', e);
    contenedor.innerHTML = `<p style="padding:1rem;color:var(--color-danger)">Error: ${sanitize(e.message)}</p>`;
  }
}

export async function cargarHistorialNotasCliente(clienteId) {
  const lista = document.getElementById('historial-lista');
  if (!lista || !window.NotasInternas) return;

  lista.innerHTML = '<div class="loading-row">Cargando notas...</div>';

  try {
    const notas = await window.NotasInternas.cargar('clientes', clienteId);
    window.NotasInternas.renderLista(notas, 'historial-lista', {
      onArchivar: () => cargarHistorialNotasCliente(clienteId),
    });
  } catch (e) {
    console.error('[clientes] Error cargando historial de notas:', e);
    lista.innerHTML = '<div class="loading-row">No se pudo cargar el historial.</div>';
  }

  window.NotasInternas.renderForm('historial-form', 'clientes', clienteId, {
    onGuardada: () => cargarHistorialNotasCliente(clienteId),
  });
}

export async function cargarBloqueos(clienteId) {
  const contenedor = document.getElementById('panel-bloqueos');
  if (!contenedor) return;
  contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Cargando historial de bloqueos...</p>';
  try {
    const { data, error } = await window.conTimeoutRed(window.supabaseClient
      .from('bloqueos_cliente')
      .select('*, usuarios(nombre)')
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: false })
      .limit(50), 10000);
    if (error) throw error;
    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p style="padding:1rem;color:var(--color-text-muted)">Sin bloqueos registrados para este cliente.</p>';
      return;
    }
    const filas = data.map(b => `
      <tr>
        <td>${b.created_at?.slice(0,10) ?? ''}</td>
        <td>
          <span class="badge-estado ${b.activo ? 'badge-critico' : 'badge-ok'}" style="font-size:.78rem">
            <span class="badge-dot"></span>${b.activo ? 'Activo' : 'Levantado'}
          </span>
        </td>
        <td>${escHtml(b.motivo ?? '—')}</td>
        <td>${escHtml(b.usuarios?.nombre ?? '—')}</td>
        <td>${b.updated_at?.slice(0,10) ?? ''}</td>
      </tr>`).join('');
    contenedor.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr>
          <th style="text-align:left;padding:.4rem .6rem">Fecha</th>
          <th style="text-align:left;padding:.4rem .6rem">Estado</th>
          <th style="text-align:left;padding:.4rem .6rem">Motivo</th>
          <th style="text-align:left;padding:.4rem .6rem">Registrado por</th>
          <th style="text-align:left;padding:.4rem .6rem">Actualizado</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  } catch(e) {
    console.error('[clientes] Error cargando bloqueos:', e);
    contenedor.innerHTML = `<p style="padding:1rem;color:var(--color-danger)">Error: ${sanitize(e.message)}</p>`;
  }
}
