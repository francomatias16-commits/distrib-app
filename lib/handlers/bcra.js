// lib/handlers/bcra.js — Integración con las APIs públicas del Banco Central (BCRA)
//
// APIs oficiales, públicas y gratuitas — no requieren API key ni registro
// (a diferencia de servicios de terceros como estadisticasbcra.com, que sí
// piden token). Documentación de referencia:
//   - Cheques Denunciados (robado/extraviado/adulterado):
//       https://cheques.bcra.apidocs.ar/
//   - Central de Deudores (situación crediticia + cheques rechazados):
//       https://deudores.bcra.apidocs.ar/
//
// ⚠ IMPORTANTE — sin probar contra la API real: este handler se armó en
// base a la documentación pública (esquemas de request/response), pero el
// entorno de desarrollo no tuvo salida a internet para probarlo en vivo.
// Verificar la primera consulta real en producción (loguear la respuesta
// cruda si algo no calza) antes de confiar en esto para decisiones de
// negocio. Si BCRA cambió algún nombre de campo, ajustar el parseo abajo.
//
// Notas de negocio importantes:
//   - "Denunciado" (robado/extraviado/adulterado) es un dato DISTINTO de
//     "Rechazado" (sin fondos u otra causal). No son sinónimos ni se
//     calculan igual — no unificar en la UI sin dejar en claro cuál es cuál.
//   - Un 404 de BCRA en Deudas/ChequesRechazados significa "sin registros"
//     (en general buena noticia), pero también puede deberse a un CUIT mal
//     tipeado — por eso el handler devuelve `sinRegistros: true` en vez de
//     tratarlo como si no hubiera nada que decir.
//   - `situacion` en Central de Deudores va de 1 (normal) a 6
//     (irrecuperable por disposición técnica); >=2 ya implica algún nivel
//     de riesgo, >=5 es severo.
//   - El monto en Deudas (situación) se reporta en MILES de pesos; el
//     monto en ChequesRechazados se reporta en pesos directos. Confirmar
//     con la primera respuesta real de cada endpoint.
//   - Esta es información PÚBLICA regulatoria (no un dato que la empresa
//     "posea"); tratarla como cualquier otro dato personal/financiero de
//     terceros — no loguear ni exponer más de lo necesario.

import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { db } from '../repos/_db.js';
import { puede } from '../permisos-service.js';

const BCRA_BASE = 'https://api.bcra.gob.ar';
const TIMEOUT_MS = 8000;

// Cache simple en memoria del listado de entidades (bancos) — cambia muy
// poco, no tiene sentido pedirlo a BCRA en cada consulta. En serverless
// esto solo ayuda dentro de una misma instancia "tibia", pero no rompe nada.
let _entidadesCache = null;
let _entidadesCacheAt = 0;
const ENTIDADES_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function limpiarCuit(valor) {
  return String(valor || '').replace(/\D/g, '');
}

async function fetchBcra(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BCRA_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (resp.status === 404) return { notFound: true };
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      throw new Error(`BCRA respondió ${resp.status}${texto ? `: ${texto.slice(0, 200)}` : ''}`);
    }
    const json = await resp.json();
    return { data: json };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('BCRA no respondió a tiempo (timeout)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function obtenerEntidades() {
  const ahora = Date.now();
  if (_entidadesCache && (ahora - _entidadesCacheAt) < ENTIDADES_TTL_MS) {
    return _entidadesCache;
  }
  const { data } = await fetchBcra('/cheques/v1.0/entidades');
  const lista = data?.results || [];
  _entidadesCache = lista;
  _entidadesCacheAt = ahora;
  return lista;
}

const rateLimitApi = rateLimit({ max: 30, windowMs: 60_000 });

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });
  if (!puede(perfil, 'consultar', 'bcra')) {
    return res.status(403).json({ error: 'Sin permiso' });
  }

  const accion = req.query.accion;

  try {
    // ── GET: listado de entidades (bancos) para el selector ──────────────
    if (req.method === 'GET' && accion === 'entidades') {
      const entidades = await obtenerEntidades();
      return res.json({ entidades });
    }

    // ── GET: cheque puntual denunciado (robado/extraviado/adulterado) ────
    if (req.method === 'GET' && accion === 'denunciado') {
      const codigoEntidad = parseInt(req.query.codigoEntidad, 10);
      const numeroCheque  = parseInt(req.query.numeroCheque, 10);
      if (!codigoEntidad || !numeroCheque) {
        return res.status(400).json({ error: 'codigoEntidad y numeroCheque son requeridos' });
      }

      const { data, notFound } = await fetchBcra(`/cheques/v1.0/denunciados/${codigoEntidad}/${numeroCheque}`);
      if (notFound) return res.json({ encontrado: false });

      // OJO: BCRA devuelve 200 tanto para "sí denunciado" como para "no
      // denunciado" (el 404 solo indica entidad/cheque inexistente en su
      // base). `encontrado: true` acá SOLO significa "la consulta resolvió
      // con datos" — el estado real está en `resultado.denunciado`
      // (boolean) y el detalle de cada denuncia en `resultado.detalles`
      // (array de {sucursal, numeroCuenta, causal}). No asumir denunciado
      // a partir de `encontrado` en el frontend.
      return res.json({ encontrado: true, resultado: data?.results || null });
    }

    // ── GET: situación crediticia oficial (Central de Deudores) ──────────
    if (req.method === 'GET' && accion === 'situacion') {
      const cuit = limpiarCuit(req.query.cuit);
      if (cuit.length !== 11) {
        return res.status(400).json({ error: 'CUIT/CUIL inválido (deben ser 11 dígitos)' });
      }

      const { data, notFound } = await fetchBcra(`/centraldedeudores/v1.0/Deudas/${cuit}`);
      if (notFound) return res.json({ sinRegistros: true });

      return res.json({ sinRegistros: false, resultado: data?.results || null });
    }

    // ── GET: cheques rechazados oficiales (Central de Deudores) ──────────
    if (req.method === 'GET' && accion === 'cheques-rechazados') {
      const cuit = limpiarCuit(req.query.cuit);
      if (cuit.length !== 11) {
        return res.status(400).json({ error: 'CUIT/CUIL inválido (deben ser 11 dígitos)' });
      }

      const { data, notFound } = await fetchBcra(`/centraldedeudores/v1.0/Deudas/ChequesRechazados/${cuit}`);
      if (notFound) return res.json({ sinRegistros: true });

      return res.json({ sinRegistros: false, resultado: data?.results || null });
    }

    // ── GET: verificación combinada de un cliente (usada por riesgo-cheques) ─
    // Trae situación + rechazados en paralelo para un mismo cliente, evitando
    // que el frontend tenga que orquestar dos llamadas.
    if (req.method === 'GET' && accion === 'verificar-cliente') {
      const cuit = limpiarCuit(req.query.cuit);
      if (cuit.length !== 11) {
        return res.status(400).json({ error: 'CUIT/CUIL inválido (deben ser 11 dígitos)' });
      }

      const [situacionRes, rechazadosRes] = await Promise.allSettled([
        fetchBcra(`/centraldedeudores/v1.0/Deudas/${cuit}`),
        fetchBcra(`/centraldedeudores/v1.0/Deudas/ChequesRechazados/${cuit}`),
      ]);

      const situacion = situacionRes.status === 'fulfilled' && !situacionRes.value.notFound
        ? situacionRes.value.data?.results
        : null;
      const rechazados = rechazadosRes.status === 'fulfilled' && !rechazadosRes.value.notFound
        ? rechazadosRes.value.data?.results
        : null;

      if (situacionRes.status === 'rejected') {
        console.error('[BCRA] Error consultando situación:', situacionRes.reason?.message);
      }
      if (rechazadosRes.status === 'rejected') {
        console.error('[BCRA] Error consultando cheques rechazados:', rechazadosRes.reason?.message);
      }

      return res.json({
        situacion,
        rechazados,
        errores: {
          situacion:  situacionRes.status  === 'rejected' ? 'No se pudo consultar la situación crediticia.' : null,
          rechazados: rechazadosRes.status === 'rejected' ? 'No se pudo consultar los cheques rechazados.' : null,
        },
      });
    }

    return res.status(404).json({ error: 'Acción no encontrada' });
  } catch (err) {
    return errorSeguro(res, err, 502, 'No se pudo consultar al Banco Central. Probá de nuevo en un momento.');
  }
}
