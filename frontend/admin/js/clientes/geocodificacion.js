// frontend/admin/js/clientes/geocodificacion.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { cambiarPagina, cargarClientes } from './carga-listado.js';
import { getFreshToken } from './nucleo.js';

// ── Botones "Geocodificar pendientes" / "Exportar" del topbar ───────────────
// Antes vivían agrupados en un dropdown "Más acciones". Ahora son botones
// directos como el resto de la topbar: "Exportar" siempre visible, y
// "Geocodificar pendientes" se muestra/oculta solo según haya o no clientes
// con domicilio pero sin coordenadas (ver refrescarContadorGeocodificacion).

// ── Geocodificación automática desde domicilio ──────────────────────────────

export async function refrescarContadorGeocodificacion() {
  const btn = document.getElementById('btn-geocodificar-lote');
  if (!btn) return;
  try {
    const token = await getFreshToken();
    const resp = await fetch('/api/clientes/geocodificar?_svc=geocodificar', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al consultar pendientes');
    estadoModulo._pendientesGeocodificar = data || [];
    if (estadoModulo._pendientesGeocodificar.length > 0) {
      document.getElementById('btn-geocodificar-lote-texto').textContent =
        `Geocodificar pendientes (${estadoModulo._pendientesGeocodificar.length})`;
      btn.style.display = 'flex';
    } else {
      btn.style.display = 'none';
    }
  } catch (err) {
    // Silencioso: no es crítico para el uso normal de la pantalla.
    console.warn('[clientes] No se pudo consultar pendientes de geocodificación:', err.message);
  }
}

/**
 * Geocodifica el cliente que está abierto en el modal (nuevo o existente)
 * a partir de los campos domicilio/localidad ya tipeados en el formulario.
 */
export async function geocodificarClienteActual() {
  const domicilio = document.getElementById('f-domicilio')?.value?.trim();
  const localidad = document.getElementById('f-localidad')?.value?.trim();
  const status = document.getElementById('geocodificar-status');
  const btn = document.getElementById('btn-geocodificar');

  if (!domicilio) {
    window.toast('Cargá el domicilio antes de buscar las coordenadas');
    return;
  }

  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Buscando...';

  try {
    const token = await getFreshToken();
    const body = estadoModulo.modalClienteId
      ? { cliente_id: estadoModulo.modalClienteId }
      : { domicilio, localidad };

    const resp = await fetch('/api/clientes/geocodificar?_svc=geocodificar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error al geocodificar');

    document.getElementById('f-lat').value = data.lat;
    document.getElementById('f-lng').value = data.lng;
    window._actualizarMapLink?.();

    if (status) status.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><polyline points="20 6 9 17 4 12"/></svg>Ubicación encontrada';
    window.toast('Coordenadas encontradas a partir del domicilio');

    // Si era un cliente ya guardado, el backend ya persistió lat/lng —
    // refrescamos el contador de pendientes por si era el último.
    if (estadoModulo.modalClienteId) refrescarContadorGeocodificacion();
  } catch (err) {
    if (status) status.textContent = '';
    console.error(err);
    window.toast('No se pudo obtener la ubicación a partir del domicilio', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Geocodifica en lote todos los clientes con domicilio pero sin lat/lng.
 * Procesa de a uno con una pequeña pausa entre llamadas (política de uso
 * de Nominatim: máx. 1 request/segundo).
 */
export async function geocodificarPendientesLote() {
  if (estadoModulo._pendientesGeocodificar.length === 0) return;

  const btn = document.getElementById('btn-geocodificar-lote');
  const textoEl = document.getElementById('btn-geocodificar-lote-texto');
  const pendientes = [...estadoModulo._pendientesGeocodificar];

  if (!confirm(`Se va a buscar la ubicación de ${pendientes.length} cliente(s) a partir de su domicilio. ¿Continuar?`)) {
    return;
  }

  btn.disabled = true;
  const token = await getFreshToken();
  let ok = 0, fallidos = 0;

  for (let i = 0; i < pendientes.length; i++) {
    const cliente = pendientes[i];
    textoEl.textContent = `Geocodificando ${i + 1}/${pendientes.length}...`;
    try {
      const resp = await fetch('/api/clientes/geocodificar?_svc=geocodificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cliente_id: cliente.id }),
      });
      if (resp.ok) ok++; else fallidos++;
    } catch {
      fallidos++;
    }
    // Respeta el límite de 1 request/segundo de Nominatim
    if (i < pendientes.length - 1) await new Promise(r => setTimeout(r, 1100));
  }

  btn.disabled = false;
  window.toast(`Geocodificación terminada: ${ok} encontrados, ${fallidos} sin resultado`);
  await cargarClientes();
  await refrescarContadorGeocodificacion();
}

export function inyectarControlesPaginacion() {
    if (document.getElementById('paginacion-clientes')) return; // ya existe
    const contenedor = document.getElementById('contenido-principal')
                    || document.querySelector('main')
                    || document.querySelector('.content')
                    || document.body;
    if (!contenedor) return; // no hay dónde inyectar, salir silenciosamente
    const div = document.createElement('div');
    div.id = 'paginacion-clientes';
    div.className = 'paginacion-container';
    div.innerHTML = `
        <button id="btn-prev" class="btn-pag" onclick="cambiarPagina(-1)">Anterior</button>
        <span id="info-pag">Página 1</span>
        <button id="btn-next" class="btn-pag" onclick="cambiarPagina(1)">Siguiente</button>
    `;
    contenedor.appendChild(div);
}
