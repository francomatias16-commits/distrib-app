// lib/demo-mode.js
// Fase 3 del proceso demo/comercial: punto único desde donde CUALQUIER
// integración externa real (AFIP/ARCA, WhatsApp, email) debe preguntar
// si la empresa es una demo pública antes de disparar la llamada real.
//
// Diseño de la falla (importante):
//   Si la consulta a `empresas.es_demo` falla por cualquier motivo, esta
//   función devuelve `true` (asume demo) en vez de `false`. Es al revés
//   del fail-open que usa lib/plan-limits.js, y es intencional: bloquear
//   por error una factura real es recuperable (se reintenta), pero emitir
//   un comprobante fiscal real o mandar un WhatsApp real desde lo que
//   debería ser una demo no se puede deshacer. Ante la duda, no se dispara
//   la integración real.
//
// Uso:
//   import { esEmpresaDemo } from '../demo-mode.js';
//   if (await esEmpresaDemo(empresa_id)) { return respuestaSimulada(); }

import { crearClienteSupabaseLazy } from './supabase-lazy.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

const CACHE_TTL_MS = 60_000; // 1 minuto — suficiente para no pegarle a la BD en cada request, corto para que un cambio de es_demo se refleje rápido
const cache = new Map(); // empresa_id -> { esDemo: boolean, expira: number }

/**
 * @param {string} empresa_id
 * @returns {Promise<boolean>}
 */
export async function esEmpresaDemo(empresa_id) {
  if (!empresa_id) return false; // sin empresa_id no hay nada que proteger ni bloquear

  const cacheado = cache.get(empresa_id);
  if (cacheado && cacheado.expira > Date.now()) {
    return cacheado.esDemo;
  }

  const { data, error } = await supabase
    .from('empresas')
    .select('es_demo')
    .eq('id', empresa_id)
    .single();

  if (error) {
    console.error('[demo-mode] Error consultando es_demo, se asume demo por seguridad:', error.message, { empresa_id });
    return true; // fail-closed hacia NO disparar integraciones reales — ver comentario arriba
  }

  const esDemo = !!data?.es_demo;
  cache.set(empresa_id, { esDemo, expira: Date.now() + CACHE_TTL_MS });
  return esDemo;
}

/**
 * Genera un CAE simulado con la misma forma que devuelve ARCA, para que el
 * llamador (wsfev1.js) no tenga que distinguir el caso demo del real.
 * El prefijo "00000000" y el patrón del número lo hacen imposible de
 * confundir con un CAE real en una auditoría o captura de pantalla.
 */
export function caeSimulado() {
  const ahora = new Date();
  const vto = new Date(ahora);
  vto.setDate(vto.getDate() + 10);
  const yyyy = vto.getFullYear();
  const mm = String(vto.getMonth() + 1).padStart(2, '0');
  const dd = String(vto.getDate()).padStart(2, '0');
  return {
    cae: '00000000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0'),
    caeVto: `${yyyy}-${mm}-${dd}`,
  };
}

/**
 * Respuesta simulada para un envío de WhatsApp, misma forma que la API de
 * Meta devolvería en un envío real.
 */
export function whatsappSimulado() {
  return { message_id: 'demo.' + Date.now() + '.' + Math.floor(Math.random() * 1e6) };
}
