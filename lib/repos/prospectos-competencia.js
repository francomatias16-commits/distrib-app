// lib/repos/prospectos-competencia.js
// Fase 3, Capa 1 (prospección geográfica) de PLAN_CAPTURA_COMPETENCIA.md.
// Tabla: prospectos_competencia (migración 557).
//
// El ranking por ruta (rankearProspectosCercaDeRuta) NO usa PostGIS —
// verificado antes de diseñar la migración que la extensión no está
// instalada — así que la distancia se calcula acá con Haversine en JS
// sobre los pares (prospecto, parada) del día. La cantidad de filas en
// juego (prospectos activos de una empresa × paradas de una ruta) es
// chica —decenas, no miles— así que el costo de hacerlo en la aplicación
// en vez de en la base es despreciable, y evita sumar una extensión nueva
// al proyecto por esta única funcionalidad.

import { db } from './_db.js';

const RADIO_TIERRA_METROS = 6_371_000;

/** Distancia entre dos puntos lat/lng, en metros (fórmula de Haversine). */
export function distanciaHaversineMetros(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RADIO_TIERRA_METROS * c;
}

// ── prospectos_competencia ────────────────────────────────────────────

export async function crearProspecto({ empresa_id, vendedor_id, nombre, rubro, direccion, lat, lng, notas }) {
  const { data, error } = await db
    .from('prospectos_competencia')
    .insert({
      empresa_id,
      vendedor_id,
      nombre,
      rubro: rubro || null,
      direccion: direccion || null,
      lat,
      lng,
      notas: notas || null,
      estado: 'pendiente',
    })
    .select()
    .single();
  return { data, error };
}

/**
 * Bandeja de prospectos. `vendedor_id_filtro` acota a "lo mío" cuando el
 * rol es vendedor; dueño/admin auditan la empresa completa — mismo
 * criterio que listarCapturasPendientes en captura-competencia.js.
 */
export async function listarProspectos(empresa_id, vendedor_id_filtro) {
  let q = db
    .from('prospectos_competencia')
    .select('id, nombre, rubro, estado, lat, lng, direccion, notas, captura_id, created_at, usuarios!vendedor_id(nombre)')
    .eq('empresa_id', empresa_id)
    .order('created_at', { ascending: false });

  if (vendedor_id_filtro) q = q.eq('vendedor_id', vendedor_id_filtro);

  const { data, error } = await q;
  return { data, error };
}

/**
 * Cambia el estado de un prospecto (planificar visita / marcar visitado /
 * descartar). Acotado por empresa_id siempre; además por vendedor_id
 * cuando `vendedor_id_filtro` viene informado (rol vendedor solo puede
 * tocar lo suyo — mismo criterio de scope que listarProspectos).
 * `captura_id` es opcional: se completa cuando la visita efectivamente
 * termina en una captura de competencia (Fase 1), vía pcIniciarCaptura
 * en el frontend seguido de un accion=marcar_estado con ese dato.
 */
export async function marcarEstadoProspecto(empresa_id, id, estado, { vendedor_id_filtro, captura_id } = {}) {
  let q = db
    .from('prospectos_competencia')
    .update({ estado, updated_at: new Date(), ...(captura_id ? { captura_id } : {}) })
    .eq('id', id)
    .eq('empresa_id', empresa_id);

  if (vendedor_id_filtro) q = q.eq('vendedor_id', vendedor_id_filtro);

  const { data, error } = await q.select('id, empresa_id').maybeSingle();
  return { data, error };
}

/**
 * Prospectos "activos" (no descartados ni ya convertidos) de la empresa,
 * con lat/lng, para el ranking por ruta. Mismo scope vendedor/dueño-admin
 * que el resto del recurso.
 */
export async function listarProspectosActivosParaRanking(empresa_id, vendedor_id_filtro) {
  let q = db
    .from('prospectos_competencia')
    .select('id, nombre, rubro, estado, lat, lng')
    .eq('empresa_id', empresa_id)
    .in('estado', ['pendiente', 'visita_planificada']);

  if (vendedor_id_filtro) q = q.eq('vendedor_id', vendedor_id_filtro);

  const { data, error } = await q;
  return { data, error };
}

/**
 * Métricas de éxito de la prospección (plan 3.5): trae SOLO `estado` y
 * `captura_id` de todos los prospectos de la empresa (sin filtrar por
 * activos, a diferencia de listarProspectosActivosParaRanking) — el
 * denominador de "% que reciben visita/captura" necesita el universo
 * completo de prospectos cargados, no solo los pendientes/planificados.
 * El cálculo de los porcentajes se hace en el handler (accionMetricas),
 * mismo criterio que obtenerMetricasCaptura en captura-competencia.js.
 */
export async function obtenerMetricasProspectos(empresa_id, vendedor_id_filtro) {
  let q = db
    .from('prospectos_competencia')
    .select('estado, captura_id')
    .eq('empresa_id', empresa_id);

  if (vendedor_id_filtro) q = q.eq('vendedor_id', vendedor_id_filtro);

  const { data, error } = await q;
  return { data, error };
}

/**
 * Paradas (lat/lng de los clientes) de una ruta puntual, para calcular
 * cercanía contra los prospectos. Recorre entregas → pedidos → clientes
 * porque `entregas` no tiene lat/lng propio (ver 001_schema.sql) — mismo
 * camino que ya usa obtenerRemitoDetalle en lib/repos/pedidos.js.
 * Acotada por empresa_id vía el pedido, no por la ruta sola, para que un
 * ruta_id de otra empresa no filtre datos (defensa en profundidad, la
 * capa de arriba ya valida empresa_id contra la sesión).
 */
export async function obtenerParadasConCoordsDeRuta(empresa_id, ruta_id) {
  const { data, error } = await db
    .from('entregas')
    .select('pedidos!inner(empresa_id, clientes(lat, lng))')
    .eq('ruta_id', ruta_id)
    .eq('pedidos.empresa_id', empresa_id);
  if (error) return { data: null, error };

  const paradas = (data || [])
    .map((e) => e.pedidos?.clientes)
    .filter((c) => c && c.lat != null && c.lng != null)
    .map((c) => ({ lat: Number(c.lat), lng: Number(c.lng) }));

  return { data: paradas, error: null };
}
