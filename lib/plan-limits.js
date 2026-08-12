// lib/plan-limits.js
// Plan de comercialización, ítem 3.3 — Enforcement de límites por plan.
//
// El límite real vive en la tabla `planes_limites` (editable desde Supabase
// sin redeploy) y se calcula vía la RPC `chequear_limite_plan`. Este módulo
// es solo el punto único desde donde los handlers lo consultan, para no
// repetir la lógica de "armar el error 403" en cada lugar.
//
// Uso:
//   import { exigirLimitePlan } from '../plan-limits.js';
//   await exigirLimitePlan(db, empresa_id, 'clientes'); // lanza si está al límite

import { esEmpresaDemo } from './demo-mode.js';

export class LimitePlanError extends Error {
  constructor(info) {
    super(`Límite de plan alcanzado: ${info.recurso} (${info.actual}/${info.limite}, plan ${info.tier})`);
    this.name = 'LimitePlanError';
    this.code = 'LIMITE_PLAN_ALCANZADO';
    this.info = info;
  }
}

/**
 * Verifica el límite de un recurso para una empresa y lanza LimitePlanError
 * si ya lo alcanzó. No hace nada (no bloquea) si el plan no tiene límite
 * para ese recurso (max_* = NULL en planes_limites) o si hay un error de
 * lectura — en ese caso se loguea pero no se corta la operación, para que
 * un problema en el enforcement nunca tumbe una venta real.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db - cliente con service_role
 * @param {string} empresa_id
 * @param {'usuarios'|'clientes'|'pedidos_mes'} recurso
 */
export async function exigirLimitePlan(db, empresa_id, recurso) {
  // La demo pública nunca debe toparse con un muro de "límite de plan
  // alcanzado" — es la peor primera impresión posible para algo pensado
  // para vender. Se la exceptúa sin importar qué plan tenga asignado.
  if (await esEmpresaDemo(empresa_id)) return;

  const { data, error } = await db.rpc('chequear_limite_plan', {
    p_empresa_id: empresa_id,
    p_recurso: recurso,
  });

  if (error) {
    console.error('[plan-limits] Error consultando chequear_limite_plan:', error.message);
    return; // fail-open: un error de enforcement no debe bloquear la operación real
  }

  if (!data?.ok) {
    console.warn('[plan-limits] Respuesta inesperada de chequear_limite_plan:', data);
    return;
  }

  if (data.alcanzado) {
    throw new LimitePlanError(data);
  }
}
