// lib/handlers/prospectos-competencia.js
// Fase 3, Capa 1 (prospección geográfica) del PLAN_CAPTURA_COMPETENCIA.md.
//
// Flujo:
//   1. POST accion=crear         — alta manual de un comercio no-cliente
//                                   (nombre, rubro, dirección descriptiva,
//                                   lat/lng por GPS o a mano).
//   2. GET  accion=listar        — bandeja de prospectos (vendedor ve lo
//                                   suyo, dueño/admin auditan la empresa).
//   3. POST accion=marcar_estado — planificar visita / marcar visitado /
//                                   descartar (y, cuando corresponde,
//                                   vincular la captura_id resultante).
//   4. GET  accion=ranking_ruta  — prospectos activos ordenados por
//                                   cercanía a las paradas de una ruta del
//                                   día, para priorizar la visita.
//   5. GET  accion=metricas      — % de prospectos que efectivamente
//                                   reciben visita y terminan en captura
//                                   (plan 3.5).
//
// Mismo gate de feature flag que captura-competencia.js
// (empresas.config->>'captura_competencia_habilitada') — es la misma
// iniciativa y la misma pantalla de destino (pcIniciarCaptura), así que
// no tiene sentido un flag independiente: una empresa sin captura de
// competencia habilitada tampoco necesita prospección para alimentarla.

import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { db } from '../repos/_db.js';
import {
  crearProspecto,
  listarProspectos,
  marcarEstadoProspecto,
  obtenerMetricasProspectos,
  listarProspectosActivosParaRanking,
  obtenerParadasConCoordsDeRuta,
  distanciaHaversineMetros,
} from '../repos/prospectos-competencia.js';

const ESTADOS_VALIDOS = new Set(['pendiente', 'visita_planificada', 'visitado', 'convertido', 'descartado']);

// Radio de cercanía para el ranking por ruta — un prospecto más lejos que
// esto de TODAS las paradas del día no es "sobre la ruta", es un desvío
// aparte que el vendedor debería planificar como visita propia, no como
// oportunidad aprovechando el recorrido de hoy.
//
// Configurables por empresa (pendiente del changelog v1018) vía
// empresas.config->>'captura_competencia_radio_ranking_metros' /
// '...max_ranking_resultados', mismo criterio que
// captura_competencia_margen_minimo_pct en captura-competencia.js: si la
// empresa no cargó nada (o cargó un valor fuera de rango razonable), se
// usa el default. El clamp existe porque, a diferencia del margen (donde
// un valor mal cargado como mucho hace perder una venta), acá un radio
// absurdo (ej. 50km) o un tope absurdo (ej. 5000) puede convertir un
// cálculo pensado para decenas de filas en un recorrido caro sobre miles.
const RADIO_RANKING_METROS_DEFAULT = 500;
const RADIO_RANKING_METROS_MIN = 50;
const RADIO_RANKING_METROS_MAX = 5000;
const MAX_RANKING_RESULTADOS_DEFAULT = 20;
const MAX_RANKING_RESULTADOS_MIN = 1;
const MAX_RANKING_RESULTADOS_MAX = 100;

/** Lee un número de la config de la empresa, con default y clamp — mismo
 * criterio que el piso de margen de captura-competencia.js, pero además
 * acotado a un rango razonable (ver comentario arriba). */
function numeroConfigAcotado(valorConfig, { min, max, porDefecto }) {
  const n = Number(valorConfig);
  if (!Number.isFinite(n) || n <= 0) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

const rateLimitApi = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  const accion = req.query.accion;

  try {
    // Ex-gate de flag (empresas.config->>'captura_competencia_habilitada'):
    // sacado a pedido directo — la función queda disponible siempre, para
    // todas las empresas, sin depender de esa clave (mismo pedido que ya
    // sacó el flag del ítem de menú en nav-data.js). Se sigue consultando
    // 'empresas' porque accionRankingRuta necesita su config igual (radio/
    // tope configurables por empresa) — solo se dejó de usar para bloquear.
    const { data: empresaConfigRow } = await db.from('empresas').select('config').eq('id', perfil.empresa_id).single();
    const empresaConfig = empresaConfigRow?.config || {};

    if (req.method === 'POST' && accion === 'crear') return await accionCrear(req, res, perfil);
    if (req.method === 'GET' && accion === 'listar') return await accionListar(req, res, perfil);
    if (req.method === 'POST' && accion === 'marcar_estado') return await accionMarcarEstado(req, res, perfil);
    if (req.method === 'GET' && accion === 'ranking_ruta') return await accionRankingRuta(req, res, perfil, empresaConfig);
    if (req.method === 'GET' && accion === 'metricas') return await accionMetricas(req, res, perfil);

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo procesar la prospección de competencia.');
  }
}

// ── 1. Alta manual de un prospecto ────────────────────────────────────────

async function accionCrear(req, res, perfil) {
  if (!puede(perfil, 'crear', 'prospectos_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }

  const nombre = (req.body?.nombre || '').trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);

  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del comercio' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Faltan coordenadas (lat/lng) válidas' });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Coordenadas fuera de rango' });
  }

  const { data, error } = await crearProspecto({
    empresa_id: perfil.empresa_id,
    vendedor_id: perfil.id,
    nombre,
    rubro: req.body?.rubro,
    direccion: req.body?.direccion,
    lat,
    lng,
    notas: req.body?.notas,
  });
  if (error) throw new Error(`No se pudo guardar el prospecto: ${error.message}`);

  return res.status(201).json({ prospecto: data });
}

// ── 2. Bandeja ─────────────────────────────────────────────────────────────

async function accionListar(req, res, perfil) {
  if (!puede(perfil, 'leer', 'prospectos_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const vendedorIdFiltro = perfil.rol === 'vendedor' ? perfil.id : null;
  const { data, error } = await listarProspectos(perfil.empresa_id, vendedorIdFiltro);
  if (error) throw new Error(error.message);
  return res.json({ prospectos: data });
}

// ── 3. Cambiar estado ────────────────────────────────────────────────────

async function accionMarcarEstado(req, res, perfil) {
  if (!puede(perfil, 'confirmar', 'prospectos_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { id, estado, captura_id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });
  if (!ESTADOS_VALIDOS.has(estado)) return res.status(400).json({ error: 'Estado no válido' });

  // El vendedor solo puede tocar sus propios prospectos; dueño/admin
  // auditan/gestionan cualquiera de la empresa — mismo scope que la
  // bandeja (accionListar).
  const vendedorIdFiltro = perfil.rol === 'vendedor' ? perfil.id : null;

  const { data, error } = await marcarEstadoProspecto(perfil.empresa_id, id, estado, {
    vendedor_id_filtro: vendedorIdFiltro,
    captura_id,
  });
  if (error) throw new Error(error.message);
  if (!data) return res.status(404).json({ error: 'Prospecto no encontrado' });

  return res.json({ ok: true });
}

// ── 4. Ranking por cercanía a una ruta del día ────────────────────────────

async function accionRankingRuta(req, res, perfil, empresaConfig) {
  if (!puede(perfil, 'leer', 'prospectos_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const ruta_id = req.query.ruta_id;
  if (!ruta_id) return res.status(400).json({ error: 'Falta ruta_id' });

  const radioRankingMetros = numeroConfigAcotado(empresaConfig?.captura_competencia_radio_ranking_metros, {
    min: RADIO_RANKING_METROS_MIN,
    max: RADIO_RANKING_METROS_MAX,
    porDefecto: RADIO_RANKING_METROS_DEFAULT,
  });
  const maxRankingResultados = numeroConfigAcotado(empresaConfig?.captura_competencia_max_ranking_resultados, {
    min: MAX_RANKING_RESULTADOS_MIN,
    max: MAX_RANKING_RESULTADOS_MAX,
    porDefecto: MAX_RANKING_RESULTADOS_DEFAULT,
  });

  const { data: paradas, error: errorParadas } = await obtenerParadasConCoordsDeRuta(perfil.empresa_id, ruta_id);
  if (errorParadas) throw new Error(errorParadas.message);
  if (!paradas.length) return res.json({ prospectos: [] });

  const vendedorIdFiltro = perfil.rol === 'vendedor' ? perfil.id : null;
  const { data: prospectos, error: errorProspectos } = await listarProspectosActivosParaRanking(perfil.empresa_id, vendedorIdFiltro);
  if (errorProspectos) throw new Error(errorProspectos.message);

  // Para cada prospecto, la distancia que importa es la MÍNIMA contra
  // cualquiera de las paradas del día (el punto de la ruta donde más
  // conviene aprovechar el desvío), no el promedio ni la suma.
  const conDistancia = (prospectos || [])
    .map((p) => {
      const distanciaMinima = paradas.reduce((min, parada) => {
        const d = distanciaHaversineMetros(Number(p.lat), Number(p.lng), parada.lat, parada.lng);
        return d < min ? d : min;
      }, Infinity);
      return { ...p, distancia_metros: Math.round(distanciaMinima) };
    })
    .filter((p) => p.distancia_metros <= radioRankingMetros)
    .sort((a, b) => a.distancia_metros - b.distancia_metros)
    .slice(0, maxRankingResultados);

  return res.json({ prospectos: conDistancia });
}

// ── 5. Métricas de éxito de la prospección (plan 3.5) ─────────────────────
// Como accion=ranking_ruta se calcula on-demand y no queda un log
// histórico de qué prospecto apareció en qué ranking, el universo de
// "sugeridos" se toma como el total de prospectos cargados (candidatos
// disponibles en cualquier momento). Mismo scoping por rol que el resto
// del recurso: vendedor ve lo suyo, dueño/admin ven la empresa completa.

async function accionMetricas(req, res, perfil) {
  if (!puede(perfil, 'leer', 'prospectos_competencia')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const vendedorIdFiltro = perfil.rol === 'vendedor' ? perfil.id : null;
  const { data, error } = await obtenerMetricasProspectos(perfil.empresa_id, vendedorIdFiltro);
  if (error) throw new Error(error.message);

  const filas = data || [];
  const total = filas.length;
  // "Visitado" cuenta también convertido: una visita que terminó en
  // cliente real sigue siendo una visita que ocurrió.
  const visitados = filas.filter((f) => f.estado === 'visitado' || f.estado === 'convertido');
  const conCaptura = filas.filter((f) => f.captura_id != null);

  const tasaVisitaPct = total > 0 ? (visitados.length / total) * 100 : 0;
  const tasaCapturaPct = total > 0 ? (conCaptura.length / total) * 100 : 0;

  return res.json({
    total_prospectos: total,
    total_visitados: visitados.length,
    total_con_captura: conCaptura.length,
    tasa_visita_pct: Number(tasaVisitaPct.toFixed(1)),
    tasa_captura_pct: Number(tasaCapturaPct.toFixed(1)),
  });
}
