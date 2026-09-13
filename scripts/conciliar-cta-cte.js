#!/usr/bin/env node
/**
 * conciliar-cta-cte.js — Etapa 4 del plan de auditoría de integridad
 * financiera (conciliación de saldos).
 *
 * Recalcula clientes.saldo_deuda desde los movimientos individuales de
 * cta_cte y lo compara contra lo que hoy se muestra. En teoría esto
 * SIEMPRE debería cerrar en 0, porque trg_sync_saldo_deuda recalcula
 * saldo_deuda completo desde cta_cte en cada INSERT/UPDATE/DELETE (ver
 * migración 620). Si aparece una divergencia acá, algo escribió
 * saldo_deuda por fuera de ese camino, o el trigger se rompió/deshabilitó.
 *
 * Depende de la RPC conciliar_cta_cte(empresa_id) (migración 620),
 * solo ejecutable por service_role.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   EMPRESA_ID=uuid-de-la-empresa \
 *   node scripts/conciliar-cta-cte.js [--json] [--tolerancia=0.01]
 *
 * Exit 0 si no hay divergencias por encima de la tolerancia.
 * Exit 1 si hay al menos una.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMPRESA_ID    = process.env.EMPRESA_ID;
const FLAG_JSON     = process.argv.includes('--json');
const TOLERANCIA    = Number(
  (process.argv.find(a => a.startsWith('--tolerancia=')) || '').split('=')[1] || 0.01
);

const C = FLAG_JSON ? { r: '', g: '', y: '', x: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', x: '\x1b[0m',
};

function log(...args) { if (!FLAG_JSON) console.log(...args); }
function die(msg) { console.error(`${C.r}[FAIL] Error: ${msg}${C.x}`); process.exit(1); }

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !EMPRESA_ID) {
    die('Faltan env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y EMPRESA_ID son requeridas.\n' +
        'Uso: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhb... ' +
        'EMPRESA_ID=uuid node scripts/conciliar-cta-cte.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data, error } = await supabase.rpc('conciliar_cta_cte', { p_empresa_id: EMPRESA_ID });
  if (error) die(`conciliar_cta_cte: ${error.message}`);

  const filas = data || [];
  const divergentes = filas.filter(f => Math.abs(f.diferencia) > TOLERANCIA);

  if (FLAG_JSON) {
    console.log(JSON.stringify({ empresa_id: EMPRESA_ID, tolerancia: TOLERANCIA, total_clientes: filas.length, divergentes }, null, 2));
    process.exit(divergentes.length ? 1 : 0);
  }

  log(`Conciliación cta_cte — empresa ${EMPRESA_ID}`);
  log(`Clientes evaluados: ${filas.length} — tolerancia: ${TOLERANCIA}\n`);

  if (divergentes.length === 0) {
    log(`${C.g}[OK]${C.x} Todos los saldos_deuda coinciden con lo recalculado desde cta_cte.`);
    process.exit(0);
  }

  log(`${C.r}[FAIL]${C.x} ${divergentes.length} cliente(s) con saldo_deuda divergente:\n`);
  for (const f of divergentes) {
    log(`  ${C.y}${f.cliente_nombre || f.cliente_id}${C.x}`);
    log(`    mostrado: ${f.saldo_mostrado}  recalculado: ${f.saldo_recalculado}  diferencia: ${f.diferencia}`);
  }
  process.exit(1);
}

main().catch(e => die(e.stack || e.message));
