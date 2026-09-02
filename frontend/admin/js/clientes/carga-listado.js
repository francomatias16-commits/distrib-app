// frontend/admin/js/clientes/carga-listado.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo, itemsPorPagina } from './_estado.js';
import { renderTabla } from './filtros-render.js';
import { inyectarControlesPaginacion } from './geocodificacion.js';

// ── Carga de datos auxiliares ──────────────────────────────────────────────
export async function cargarZonas() {
  const { data } = await window.conTimeoutRed(estadoModulo.sb.from('zonas')
    .select('id, nombre')
    .eq('empresa_id', estadoModulo.empresaData.id)
    .order('nombre'), 10000);
  estadoModulo.zonas = data || [];
  const sel = document.getElementById('filtro-zona');
  const selF = document.getElementById('f-zona_id');
  
  // Limpiar antes de agregar para evitar duplicados en re-cargas
  sel.innerHTML = '<option value="">Todas las zonas</option>';
  selF.innerHTML = '<option value="">Seleccionar zona...</option>';
  
  estadoModulo.zonas.forEach(z => {
    [sel, selF].forEach(s => {
      const o = document.createElement('option');
      o.value = z.id; o.textContent = z.nombre;
      s.appendChild(o);
    });
  });
}

// Depósito/sucursal fija del cliente (multi-depósito, 550): un solo
// select (en el modal, no hay filtro de listado por depósito todavía),
// mismo criterio de recarga que cargarZonas.
export async function cargarDepositos() {
  const { data } = await window.conTimeoutRed(estadoModulo.sb.from('depositos')
    .select('id, nombre, es_principal')
    .eq('empresa_id', estadoModulo.empresaData.id)
    .order('nombre'), 10000);
  estadoModulo.depositos = data || [];
  const selF = document.getElementById('f-deposito_id');

  selF.innerHTML = '<option value="">Depósito principal (sin sucursal fija)</option>';
  estadoModulo.depositos.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.nombre + (d.es_principal ? ' (principal)' : '');
    selF.appendChild(o);
  });
}

// Permite crear una zona sin salir del formulario de cliente — evita el
// viaje ida y vuelta a "Zonas de reparto" cuando el select está vacío
// porque la empresa todavía no cargó ninguna.
window.crearZonaRapida = async function () {
  const nombre = (window.prompt('Nombre de la nueva zona (ej: Centro, Zona Norte):') || '').trim();
  if (!nombre) return;

  const btn = document.getElementById('btn-nueva-zona-rapida');
  if (btn) btn.disabled = true;
  try {
    const token = (await estadoModulo.sb.auth.getSession()).data.session?.access_token;
    const res = await fetch('/api/maestros?recurso=zonas', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.toast(data.error || 'No se pudo crear la zona', 'error');
      return;
    }
    await cargarZonas();
    // Preseleccionar la zona recién creada en el form abierto
    const selF = document.getElementById('f-zona_id');
    if (selF && data.id) selF.value = data.id;
    window.toast(`Zona "${nombre}" creada`, 'exito');
  } catch (e) {
    window.toast('Error de conexión al crear la zona', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

export async function cargarListas() {
  const { data } = await window.conTimeoutRed(estadoModulo.sb.from('listas_precios')
    .select('id, nombre, es_default')
    .eq('empresa_id', estadoModulo.empresaData.id)
    .eq('activa', true)
    .order('nombre'), 10000);
  estadoModulo.listas = data || [];
  const sel = document.getElementById('f-lista_precio_id');
  sel.innerHTML = '<option value="">Por defecto de la empresa</option>';
  estadoModulo.listas.forEach(l => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.nombre + (l.es_default ? ' (por defecto)' : '');
    sel.appendChild(o);
  });
}

// ── Carga principal con Paginación ─────────────────────────────────────────
export async function cargarVendedores() {
  const { data } = await window.conTimeoutRed(estadoModulo.sb.from('usuarios')
    .select('id, nombre, rol')
    .eq('empresa_id', estadoModulo.empresaData.id)
    .in('rol', ['vendedor', 'admin', 'dueno'])
    .eq('activo', true)
    .order('nombre'), 10000);
  estadoModulo.vendedores = data || [];
  const sel = document.getElementById('f-vendedor_id_default');
  if (!sel) return;
  sel.innerHTML = '<option value="">Sin vendedor asignado</option>';
  estadoModulo.vendedores.forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.nombre + (v.rol !== 'vendedor' ? ` (${v.rol})` : '');
    sel.appendChild(o);
  });
}

// Trae un cliente puntual por id (usado para deep-links: alertas del
// dashboard, notificaciones, etc. que pueden apuntar a un cliente que no
// está en la página actualmente cargada).
export async function obtenerClientePorId(id) {
  const { data, error } = await window.conTimeoutRed(estadoModulo.sb.from('clientes')
    .select(`*, zonas(nombre), listas_precios(nombre),
      scores_cliente(score_pagos, score_frecuencia, score_deuda, score_devolucion, created_at)`)
    .eq('id', id)
    .eq('empresa_id', estadoModulo.empresaData.id)
    .maybeSingle(), 10000);

  if (error || !data) {
    console.error('[clientes] obtenerClientePorId:', error?.message);
    return null;
  }

  const scores = data.scores_cliente;
  const ultimo = Array.isArray(scores) && scores.length
    ? scores.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    : null;
  return {
    ...data,
    score_pagos:      ultimo?.score_pagos      ?? null,
    score_frecuencia: ultimo?.score_frecuencia ?? null,
    score_deuda:      ultimo?.score_deuda      ?? null,
    score_devolucion: ultimo?.score_devolucion ?? null,
  };
}

export async function cargarClientes() {
  const desde = (estadoModulo.paginaActual - 1) * itemsPorPagina;
  const hasta = desde + itemsPorPagina - 1;

  window.mostrarSkeletonTabla('tabla-body', 8); // Mostrar skeleton antes de cargar

  let query = estadoModulo.sb.from('clientes')
    .select(`*, zonas(nombre), listas_precios(nombre),
      scores_cliente(score_pagos, score_frecuencia, score_deuda, score_devolucion, created_at)`,
      { count: 'exact' })
    .eq('empresa_id', estadoModulo.empresaData.id)
    .order('razon_social')
    .range(desde, hasta);

  // Aplicar filtros de base de datos si es posible para eficiencia
  const busq = document.getElementById('input-busqueda').value.trim();
  const zonaFiltro = document.getElementById('filtro-zona').value;

  if (busq) query = query.or(`razon_social.ilike.%${busq}%,nombre_fantasia.ilike.%${busq}%,cuit.ilike.%${busq}%`);
  if (zonaFiltro) query = query.eq('zona_id', zonaFiltro);
  if (estadoModulo.filtroEstado === 'activo') query = query.eq('activo', true);
  if (estadoModulo.filtroEstado === 'inactivo') query = query.eq('activo', false);
  if (estadoModulo.filtroEstado === 'deuda') query = query.gt('saldo_deuda', 0);
  // 'riesgo' se mantiene como riesgo+bloqueado combinado (compatibilidad con
  // el deep-link ?filter=riesgo que ya usan las alertas de confianza del
  // dashboard). 'bloqueado' es un pill nuevo, más específico, que aísla solo
  // esa categoría — igual criterio que el select de riesgo-cheques.js.
  if (estadoModulo.filtroEstado === 'riesgo') query = query.in('score_categoria', ['riesgo', 'bloqueado']);
  if (estadoModulo.filtroEstado === 'premium') query = query.eq('score_categoria', 'premium');
  if (estadoModulo.filtroEstado === 'bueno') query = query.eq('score_categoria', 'bueno');
  if (estadoModulo.filtroEstado === 'bloqueado') query = query.eq('score_categoria', 'bloqueado');

  const { data, count, error } = await window.conTimeoutRed(query, 10000);

  if (error) {
    console.error('[clientes] Error en query:', error);
    const tbody = document.getElementById('tabla-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--color-danger)">Error al cargar clientes: ${sanitize(error.message)}</td></tr>`;
    return;
  }
  
  // Aplanar el último registro de scores_cliente en cada cliente
  estadoModulo.clientesData = (data || []).map(c => {
    const scores = c.scores_cliente;
    const ultimo = Array.isArray(scores) && scores.length
      ? scores.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      : null;
    return {
      ...c,
      score_pagos:      ultimo?.score_pagos      ?? null,
      score_frecuencia: ultimo?.score_frecuencia ?? null,
      score_deuda:      ultimo?.score_deuda      ?? null,
      score_devolucion: ultimo?.score_devolucion ?? null,
    };
  });
  estadoModulo.totalResultados = count || 0;
  
  actualizarInfoPaginacion();
  renderTabla();
}

export function actualizarInfoPaginacion() {
    const totalPaginas = Math.ceil(estadoModulo.totalResultados / itemsPorPagina);
    // Guards defensivos: los IDs existen en el HTML estático y también los crea
    // inyectarControlesPaginacion() como fallback. Si por timing no están listos, no lanzar null.
    const elInfo = document.getElementById('info-pag');
    const elPrev = document.getElementById('btn-prev');
    const elNext = document.getElementById('btn-next');
    if (elInfo) elInfo.textContent = `Página ${estadoModulo.paginaActual} de ${totalPaginas || 1} (${estadoModulo.totalResultados} clientes)`;
    if (elPrev) elPrev.disabled = estadoModulo.paginaActual <= 1;
    if (elNext) elNext.disabled = estadoModulo.paginaActual >= totalPaginas;
}

export async function cambiarPagina(delta) {
    estadoModulo.paginaActual += delta;
    await cargarClientes();
}
