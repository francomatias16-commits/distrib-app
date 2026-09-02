#!/usr/bin/env node
/**
 * audit-security-grants.js — Etapa 0 (Higiene de base).
 *
 * Detecta, contra la base real, los dos patrones de fuga que ya salieron
 * dos veces (v124/v194 en vistas, v135/v136/v142 en funciones):
 *
 *   1. Funciones SECURITY DEFINER invocables por anon/authenticated
 *      (vía PostgREST, con la anon key pública) sin ninguna evidencia
 *      de que filtren por empresa_id — corren con privilegios de owner,
 *      así que si no filtran por tenant, cualquiera puede leer/escribir
 *      datos de OTRA empresa.
 *   2. Vistas sin `security_invoker = true` expuestas a anon/authenticated
 *      — bypassean RLS porque corren como el owner de la vista.
 *
 * Depende de las RPCs agregadas en la migración 249
 * (audit_security_definer_grants, audit_views_security_invoker),
 * que solo son ejecutables por service_role.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   node scripts/audit-security-grants.js [--json]
 *
 * Exit 0 si no hay riesgo_potencial=true en ninguna de las dos RPCs.
 * Exit 1 si hay al menos un hallazgo.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLAG_JSON     = process.argv.includes('--json');

const C = FLAG_JSON ? { r: '', g: '', y: '', x: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', x: '\x1b[0m',
};

function log(...args) { if (!FLAG_JSON) console.log(...args); }
function die(msg) { console.error(`${C.r}[FAIL] Error: ${msg}${C.x}`); process.exit(1); }

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    die('Faltan env vars: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas.\n' +
        'Uso: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhb... node scripts/audit-security-grants.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data: funciones, error: errFn } = await supabase.rpc('audit_security_definer_grants');
  if (errFn) die(`audit_security_definer_grants: ${errFn.message}`);

  const { data: vistas, error: errVw } = await supabase.rpc('audit_views_security_invoker');
  if (errVw) die(`audit_views_security_invoker: ${errVw.message}`);

  const funcionesRiesgo = (funciones || []).filter(f => f.riesgo_potencial);
  const vistasRiesgo    = (vistas || []).filter(v => v.riesgo_potencial);
  const funcionesSinSearchPath = (funciones || []).filter(f => !f.tiene_search_path_fijo);

  if (FLAG_JSON) {
    console.log(JSON.stringify({
      funciones_riesgo: funcionesRiesgo,
      vistas_riesgo: vistasRiesgo,
      funciones_sin_search_path: funcionesSinSearchPath,
      total_funciones_security_definer: (funciones || []).length,
      total_vistas: (vistas || []).length,
    }, null, 2));
    process.exit((funcionesRiesgo.length + vistasRiesgo.length) > 0 ? 1 : 0);
  }

  log('────────────────────────────────────────────────────────────');
  log('AUDITORÍA DE SEGURIDAD — SECURITY DEFINER + vistas sin security_invoker');
  log('────────────────────────────────────────────────────────────\n');

  log(`Funciones SECURITY DEFINER encontradas: ${(funciones || []).length}`);
  log(`Vistas encontradas: ${(vistas || []).length}\n`);

  if (funcionesRiesgo.length) {
    log(`${C.r}⚠  ${funcionesRiesgo.length} función(es) SECURITY DEFINER de riesgo:${C.x}`);
    for (const f of funcionesRiesgo) {
      const motivo = f.muta_datos && !f.parece_verificar_rol
        ? 'muta datos y NO verifica rol (patrón fn_crear_producto, 2026-08-28)'
        : 'sin evidencia de filtro por empresa_id ni verificación de rol';
      log(`   - ${f.funcion}(${f.argumentos}) — ${motivo}`);
      log(`     anon=${f.anon_puede_ejecutar} authenticated=${f.authenticated_puede_ejecutar} muta_datos=${f.muta_datos} filtra_tenant=${f.parece_filtrar_por_tenant} verifica_rol=${f.parece_verificar_rol} search_path_fijo=${f.tiene_search_path_fijo}`);
    }
    log('   → Si es una mutación sin verificación de rol, agregar el chequeo');
    log('     (mismo patrón que fn_guardar_combo / fn_combo_set_activo). Si no debería');
    log('     ser invocable desde el cliente: REVOKE EXECUTE ... FROM anon, authenticated;');
    log('   → Si es un falso positivo revisado (helper de RLS, panel superadmin, o');
    log('     mutación donde "cualquier empleado de la empresa" es la política de negocio');
    log('     intencional), agregarlo al array en_allowlist_revisado dentro de la RPC');
    log('     audit_security_definer_grants (migración audit_security_grants_v3).\n');
  } else {
    log(`${C.g}[OK] Ninguna función SECURITY DEFINER de riesgo evidente.${C.x}\n`);
  }

  if (vistasRiesgo.length) {
    log(`${C.r}⚠  ${vistasRiesgo.length} vista(s) sin security_invoker=true, expuesta(s) a anon/authenticated:${C.x}`);
    for (const v of vistasRiesgo) {
      log(`   - ${v.vista} (anon=${v.anon_puede_leer} authenticated=${v.authenticated_puede_leer})`);
    }
    log('   → Mismo patrón que causó la fuga cross-tenant de v124 y v194:');
    log('     ALTER VIEW public.<vista> SET (security_invoker = true);\n');
  } else {
    log(`${C.g}[OK] Ninguna vista de riesgo — todas tienen security_invoker=true o no están expuestas.${C.x}\n`);
  }

  if (funcionesSinSearchPath.length) {
    log(`${C.y}ℹ  ${funcionesSinSearchPath.length} función(es) SECURITY DEFINER sin search_path fijo (riesgo de search_path hijacking, ver 107/108):${C.x}`);
    for (const f of funcionesSinSearchPath) log(`   - ${f.funcion}`);
    log('');
  }

  const totalRiesgo = funcionesRiesgo.length + vistasRiesgo.length;
  if (totalRiesgo > 0) {
    log(`${C.r}[FAIL] ${totalRiesgo} hallazgo(s) de riesgo potencial. Revisar antes de deployar / dar acceso demo público.${C.x}`);
    process.exit(1);
  } else {
    log(`${C.g}[OK] Sin hallazgos de riesgo potencial.${C.x}`);
    process.exit(0);
  }
}

main().catch(err => die(err.message));
