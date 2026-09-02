// lib/cache.js
// Etapa 3 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md — caché en
// memoria para lecturas calientes, generalizando el patrón que ya usaba
// lib/demo-mode.js (Map + TTL) para que cualquier handler lo reutilice sin
// reinventar el cacheo cada vez.
//
// Alcance real (importante, léase antes de asumir que esto es Redis):
// Cada instancia de Serverless Function ("lambda warm") tiene su propio Map
// en memoria — no hay estado compartido entre instancias ni sobrevive un
// cold start. NO es un caché distribuido. Se evaluó Upstash Redis (lo
// menciona el plan) y se decidió arrancar por acá para el piloto: cero
// dependencias nuevas, cero env vars nuevas, mismo criterio que ya está
// probado en producción en demo-mode.js. Si el piloto muestra que hace
// falta compartir el caché entre instancias, ese es el momento de sumar
// Redis — no antes.
// Aun así reduce carga real: Vercel reutiliza instancias "warm" entre
// requests seguidos, así que ráfagas de tráfico al mismo endpoint (varios
// usuarios viendo el dashboard a la vez, alguien con la pantalla en
// auto-refresh) sí pegan al caché en vez de a Postgres.
//
// Fail-open por diseño: si `calcular()` tira error, no se cachea nada (el
// error se propaga tal cual al caller) — un dato viejo en caché nunca debe
// esconder un error real de la próxima consulta.
//
// Uso:
//   import { cacheado } from '../cache.js';
//   const datos = await cacheado(`kpis:${empresa_id}:${periodo}`, 30_000,
//     () => calcularKpisReal(empresa_id, periodo));

const cache = new Map(); // clave -> { valor, expira }

/**
 * @param {string} clave - debe incluir todo lo que hace único el resultado
 *   (empresa_id, período, filtros) — una clave demasiado genérica filtra
 *   datos de una empresa/consulta a otra.
 * @param {number} ttlMs - cuánto tiempo se sirve el valor cacheado antes de
 *   recalcular. Cortos (30-60s) para datos que no necesitan ser 100% en
 *   tiempo real, como sugiere el plan.
 * @param {() => Promise<any>} calcular - solo se ejecuta en cache miss o TTL
 *   vencido. Si tira, no se cachea nada y el error sube tal cual al caller.
 * @returns {Promise<any>}
 */
export async function cacheado(clave, ttlMs, calcular) {
  const ahora = Date.now();
  const entrada = cache.get(clave);
  if (entrada && entrada.expira > ahora) {
    return entrada.valor;
  }

  const valor = await calcular();
  cache.set(clave, { valor, expira: ahora + ttlMs });
  return valor;
}

/**
 * Invalida una clave puntual — útil si en el futuro algún endpoint necesita
 * forzar un dato fresco después de una mutación relacionada. No hace falta
 * para el piloto (el TTL corto ya resuelve el caso general), se expone por
 * si hace falta más adelante.
 * @param {string} clave
 */
export function invalidar(clave) {
  cache.delete(clave);
}
