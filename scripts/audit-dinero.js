#!/usr/bin/env node
/**
 * audit-dinero.js — Etapa 7 del plan de auditoría de integridad financiera.
 *
 * Empaqueta en un único comando toda la batería que hoy hay que acordarse de
 * correr a mano antes de tocar código que mueve plata real (caja, POS, pagos,
 * cobranzas, facturación, stock). Mismo criterio que `predeploy`: se corre
 * antes de cada deploy que toque ese código.
 *
 * Cubre, en orden:
 *   Etapa 0  — batería estática/unitaria ya existente
 *   Etapa 2  — unit tests de cálculo (van dentro de `npm test`)
 *   Etapa 3  — tests de condición de carrera (van dentro de `npm test`)
 *   Etapa 4  — conciliación de saldos (cta_cte y stock) contra un tenant real
 *   Etapa 5  — E2E de monto punta a punta (va dentro de `npm run test:e2e`)
 *
 * Deliberadamente AFUERA de esta batería (no se corren en cada deploy):
 *   - `npm run loadtest:etapa4` (Etapa 6): hace escrituras reales de carga
 *     (ventas, cobros) para probar el locking bajo concurrencia. Es una
 *     corrida de verificación puntual, no un chequeo de humo — se deja como
 *     tarea manual/periódica, no automática en cada deploy.
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... EMPRESA_ID=<tenant real> \
 *   node scripts/audit-dinero.js [--json] [--skip-e2e] [--skip-integration]
 *
 * La conciliación (Etapa 4) se salta con una advertencia si no hay EMPRESA_ID
 * seteado — correrla contra la empresa demo da falsos positivos/negativos
 * porque el stock demo se siembra sin historial de movimientos (ver plan,
 * Etapa 4). Hace falta el id de una empresa real con movimientos genuinos.
 *
 * Exit 0 si todos los pasos ejecutados están en verde. Exit 1 si alguno falló.
 */

import { spawnSync } from 'child_process';

const FLAG_JSON        = process.argv.includes('--json');
const SKIP_E2E         = process.argv.includes('--skip-e2e');
const SKIP_INTEGRATION = process.argv.includes('--skip-integration');
const EMPRESA_ID       = process.env.EMPRESA_ID;

const C = FLAG_JSON ? { ok: '', fail: '', skip: '', h: '', dim: '', x: '' } : {
  ok: '\x1b[32m', fail: '\x1b[31m', skip: '\x1b[33m',
  h: '\x1b[36m', dim: '\x1b[90m', x: '\x1b[0m',
};

function run(label, cmd, args) {
  if (!FLAG_JSON) console.log(`\n${C.h}▶ ${label}${C.x}`);
  const res = spawnSync(cmd, args, { stdio: FLAG_JSON ? 'pipe' : 'inherit', encoding: 'utf8' });
  const ok = res.status === 0;
  if (!FLAG_JSON) {
    console.log(ok ? `${C.ok}✔ ${label}${C.x}` : `${C.fail}✘ ${label}${C.x}`);
  }
  return { label, ok, skipped: false, output: FLAG_JSON ? `${res.stdout || ''}${res.stderr || ''}` : null };
}

function skip(label, reason) {
  if (!FLAG_JSON) console.log(`\n${C.skip}⏭ ${label} — SALTEADO: ${reason}${C.x}`);
  return { label, ok: true, skipped: true, reason };
}

const steps = [];

// Etapa 0 — batería estática ya existente
steps.push(run('npm test (unitarios, incluye Etapa 2 cálculo y Etapa 3 condiciones de carrera)', 'npm', ['test']));
steps.push(run('check-schema (código vs. DB real)', 'npm', ['run', 'check-schema']));
steps.push(run('check:migrations (duplicadas/no registradas)', 'npm', ['run', 'check:migrations']));
steps.push(run('audit:security (SECURITY DEFINER / security_invoker)', 'npm', ['run', 'audit:security']));
steps.push(run('audit:funciones-fantasma', 'npm', ['run', 'audit:funciones-fantasma']));
steps.push(run('check-wiring:all (incluye check-handler-dispatch)', 'npm', ['run', 'check-wiring:all']));

// Etapa 0 — requieren credenciales/entorno reales, opcionalmente salteables
if (SKIP_INTEGRATION) {
  steps.push(skip('test:integration', 'pedido explícito (--skip-integration)'));
} else if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  steps.push(skip('test:integration', 'faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY (correlo aparte apuntando a un proyecto de test, nunca a producción)'));
} else {
  steps.push(run('test:integration (CRUD/RPCs reales)', 'npm', ['run', 'test:integration']));
}

if (SKIP_E2E) {
  steps.push(skip('test:e2e', 'pedido explícito (--skip-e2e)'));
} else {
  steps.push(run('test:e2e (incluye Etapa 5, flujo-completo-pedido-monto)', 'npm', ['run', 'test:e2e']));
}

// Etapa 4 — conciliación de saldos, solo contra un tenant real
if (!EMPRESA_ID) {
  steps.push(skip('conciliar:cta-cte', 'falta EMPRESA_ID de un tenant real (correr contra la demo da falsos positivos)'));
  steps.push(skip('conciliar:stock', 'falta EMPRESA_ID de un tenant real (correr contra la demo da falsos positivos)'));
} else {
  steps.push(run('conciliar:cta-cte', 'npm', ['run', 'conciliar:cta-cte']));
  steps.push(run('conciliar:stock', 'npm', ['run', 'conciliar:stock']));
}

// ── Resumen ──────────────────────────────────────────────────────────────────
const failed = steps.filter(s => !s.skipped && !s.ok);
const skipped = steps.filter(s => s.skipped);
const passed = steps.filter(s => !s.skipped && s.ok);

if (FLAG_JSON) {
  console.log(JSON.stringify({
    ok: failed.length === 0,
    pasos: steps.map(({ label, ok, skipped, reason }) => ({ label, ok, skipped, reason: reason || null })),
  }, null, 2));
} else {
  console.log(`\n${C.h}── Resumen audit:dinero ──${C.x}`);
  console.log(`${C.ok}${passed.length} OK${C.x}, ${C.fail}${failed.length} fallidos${C.x}, ${C.skip}${skipped.length} salteados${C.x}`);
  if (skipped.length) {
    console.log(`${C.dim}Salteados: ${skipped.map(s => s.label).join(', ')}${C.x}`);
  }
  if (failed.length) {
    console.log(`${C.fail}Fallidos: ${failed.map(s => s.label).join(', ')}${C.x}`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);
