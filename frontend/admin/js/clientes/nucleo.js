// frontend/admin/js/clientes/nucleo.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { cargarClientes, cargarListas, cargarVendedores, cargarZonas, cargarDepositos } from './carga-listado.js';
import { aplicarFiltros } from './filtros-render.js';
import { inyectarControlesPaginacion, refrescarContadorGeocodificacion } from './geocodificacion.js';
import { abrirModalEditar } from './modal-cliente.js';
import { cambiarVista } from './precios-especiales.js';

// frontend/admin/js/clientes.js — v39 (sin fugas de memoria)
// MIGRACIÓN v39: renderTbody (DocumentFragment), toast() de admin-utils

// Optimizado para Etapa 6: Paginación y Performance

// ── Config ─────────────────────────────────────────────────────────────────
// sb se obtiene en init() una vez que authCtx esté listo
// Helper: siempre obtiene un token fresco (evita tokens vencidos en sesiones largas)
export async function getFreshToken() {
  const { data: { session } } = await estadoModulo.sb.auth.getSession();
  return session?.access_token || '';
}

// ── Estado ─────────────────────────────────────────────────────────────────

// Paginación

// ── Ver catálogo tal como lo ve un cliente ──────────────────────────────────
// FIX v477 (el botón abría la página pero el catálogo quedaba vacío / no
// cargaba): el comentario de acá abajo daba por hecho que el catálogo público
// "no requiere sesión, alcanza con ?empresa_id=". Eso dejó de ser así desde
// SEC-008 (ver supabase/migrations/292_fix_sec008_gate_catalogo_publico.sql
// y CHANGELOG_v296): el modo sin-login ahora exige que la empresa tenga
// habilitado explícitamente config.catalogo_publico_habilitado — pensado
// para compartir el link con clientes potenciales, opt-in por empresa. La
// gran mayoría de las empresas NO tiene ese flag activado (es a propósito,
// hay que prenderlo aparte), así que el botón caía siempre en ese camino
// vacío.
//
// El propio SEC-008 dejó una puerta explícitamente abierta para esto: "Sesión
// autenticada (Bearer token) sigue funcionando igual que siempre, sin
// cambios". Como el dueño/admin YA es un usuario autenticado de su propia
// empresa, alcanza con que el catálogo reciba su token de acceso — el
// backend (resolverEmpresaCliente) lo resuelve por sesión real, sin pasar
// por el gate del modo público. Se manda en el fragmento (#) de la URL, no
// en el query string: el fragmento nunca viaja al servidor (no queda en
// logs de Vercel/Supabase ni en el header Referer), a diferencia de un
// query param. catalogo.html lo lee, lo usa como Authorization Bearer en sus
// fetch, y limpia la URL de la barra de inmediato.
export async function verCatalogoCliente() {
  if (!estadoModulo.empresaData?.id) return;
  let token = '';
  try {
    const { data: { session } } = await estadoModulo.sb.auth.getSession();
    token = session?.access_token || '';
  } catch (_e) { /* si falla, se abre igual en modo público (mejor que nada) */ }

  const url = `/cliente/catalogo?empresa_id=${estadoModulo.empresaData.id}`
    + (token ? `#preview_token=${encodeURIComponent(token)}` : '');
  window.open(url, '_blank');
}
// FIX v477: clientes.js se carga como <script type="module">, así que las
// funciones top-level NO quedan expuestas en window por defecto (a diferencia
// de un <script> normal). El onclick="verCatalogoCliente()" del botón vive en
// el scope global del HTML, por eso nunca encontraba la función y el botón no
// generaba ningún evento. El resto de las funciones usadas desde onclick en
// este archivo sí se exportan más abajo (ver bloque "window.xxx = xxx");
// esta se había quedado afuera.

// ── Inicialización ─────────────────────────────────────────────────────────
export async function init() {
  estadoModulo.sb          = window.authCtx.sb;
  estadoModulo.usuario     = window.authCtx.perfil;
  estadoModulo.empresaData = window.authCtx.perfil?.empresas || {
    id: window.authCtx.perfil?.empresa_id,
    nombre: '',
    config: {}
  };
  if (!estadoModulo.empresaData?.id) {
    console.error('[clientes] empresa_id no disponible — verificar que el usuario tenga empresa_id en la tabla usuarios');
    const tbody = document.getElementById('tabla-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-danger)">Error: no se pudo obtener la empresa del usuario. Contactar soporte.</td></tr>';
    return;
  }

  // Deep-link desde otras pantallas (ej. "Resolver" en las alertas de
  // confianza del dashboard): ?filter=riesgo activa el filtro correspondiente,
  // ?id=<uuid> abre directo la ficha de ese cliente.
  const urlParams  = new URLSearchParams(window.location.search);
  const filterParam = urlParams.get('filter');
  if (filterParam) {
    estadoModulo.filtroEstado = filterParam;
  }

  // Inyectar controles de paginación (envuelto en try por si falla el DOM)
  try { inyectarControlesPaginacion(); } catch(e) { console.warn('[clientes] paginacion init:', e.message); }

  // Buscador con debounce (250ms, mismo criterio que busqueda-global.js) en vez
  // de oninput inline: ahora que el fix filtra contra Supabase, disparar una
  // query por cada tecla sería innecesario y lento.
  const inputBusqueda = document.getElementById('input-busqueda');
  if (inputBusqueda) {
    let debounceBusquedaClientes = null;
    inputBusqueda.addEventListener('input', () => {
      clearTimeout(debounceBusquedaClientes);
      debounceBusquedaClientes = setTimeout(() => aplicarFiltros(), 250);
    });
  }

  try {
    await Promise.all([cargarZonas(), cargarDepositos(), cargarListas(), cargarVendedores(), cargarClientes()]);
  } catch(e) {
    console.error('[clientes] Error en carga inicial:', e);
    const tbody = document.getElementById('tabla-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--color-danger)">Error al cargar datos: ' + e.message + '</td></tr>';
    return;
  }

  if (filterParam) {
    const pill = document.querySelector(`.e-pill[data-f="${filterParam}"]`);
    if (pill) {
      document.querySelectorAll('.e-pill').forEach(b => b.classList.remove('activa'));
      pill.classList.add('activa');
    }
  }

  const idParam = urlParams.get('id');
  if (idParam) {
    abrirModalEditar(idParam);
  }

  // Deep-link desde el viejo /admin/listas-precio (ahora redirect, ver
  // vercel.json) y desde cualquier link guardado que apuntaba a esa
  // pantalla — mismo criterio que ?tab=zonas en rutas.js.
  if (urlParams.get('tab') === 'listas') {
    cambiarVista('listas');
  }

  // No bloquea la carga principal: es solo para mostrar/ocultar el botón
  // "Geocodificar pendientes" si hay clientes con domicilio sin coordenadas.
  refrescarContadorGeocodificacion();
}
