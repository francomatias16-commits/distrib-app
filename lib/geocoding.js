// lib/geocoding.js — Geocodificación de domicilios usando Nominatim (OpenStreetMap)
//
// Se eligió Nominatim porque es gratuito, no requiere API key, y es el mismo
// proveedor de datos que las tiles OSM que ya usa el mapa de Leaflet en
// rutas.js — mantiene todo el stack de mapas en una sola fuente.
//
// ⚠ Política de uso de Nominatim (https://operations.osmfoundation.org/policies/nominatim/):
//   - Máximo 1 request/segundo desde una misma IP/proceso.
//   - Es obligatorio un header User-Agent identificando la app (con contacto).
//   - No cachear resultados por más de lo razonable ni hacer scraping masivo.
// Por eso acá:
//   - `geocodificarDireccion` se usa siempre de a una dirección por vez.
//   - El llamador (handler) es responsable de espaciar llamadas sucesivas
//     (ver `withRetry`/delay en el frontend para geocodificación en lote).
//   - El resultado se persiste en clientes.lat/lng para no tener que volver
//     a pedirlo — geocodificar es un fallback de una sola vez, no algo que
//     se repite en cada carga de mapa.

import { withRetry } from './retry.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS    = 8000;
const USER_AGENT     = 'distrib-app/1.0 (soporte@mfwebsolutions.com.ar)';

/**
 * Arma la query de búsqueda a partir de los campos del cliente.
 * Siempre se ancla a Argentina para evitar falsos positivos en el exterior.
 */
function construirQuery({ domicilio, localidad, provincia }) {
  const partes = [domicilio, localidad, provincia, 'Argentina'].filter(Boolean);
  return partes.join(', ');
}

async function fetchNominatim(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'ar');

    const resp = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'es',
      },
    });

    if (!resp.ok) {
      const err = new Error(`Nominatim respondió ${resp.status}`);
      err.status = resp.status;
      throw err;
    }

    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocodifica una dirección y devuelve { lat, lng, direccion_usada, display_name } o null
 * si Nominatim no encontró ninguna coincidencia (dirección inexistente/mal escrita).
 *
 * @param {{ domicilio: string, localidad?: string, provincia?: string }} datos
 */
export async function geocodificarDireccion({ domicilio, localidad, provincia } = {}) {
  if (!domicilio || !domicilio.trim()) {
    throw new Error('domicilio requerido para geocodificar');
  }

  const query = construirQuery({ domicilio, localidad, provincia });

  const resultados = await withRetry(() => fetchNominatim(query), {
    intentos: 3,
    baseDelayMs: 500,
  });

  if (!Array.isArray(resultados) || resultados.length === 0) {
    return null;
  }

  const mejor = resultados[0];
  const lat = parseFloat(mejor.lat);
  const lng = parseFloat(mejor.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    direccion_usada: query,
    display_name: mejor.display_name,
  };
}
