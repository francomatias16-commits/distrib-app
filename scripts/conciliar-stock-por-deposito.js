#!/usr/bin/env node
/**
 * conciliar-stock-por-deposito.js — Etapa 4 del plan de auditoría de
 * integridad financiera, complemento de conciliar-stock.js.
 *
 * Recalcula el stock de cada PAR (producto, depósito) desde
 * movimientos_stock y lo compara contra stock.cantidad. A diferencia de
 * conciliar-stock.js (que solo concilia el total por producto), este SÍ
 * detecta un desvío en un depósito puntual aunque el total de la empresa
 * cierre — porque tipo='transferencia' se incluye en el recálculo (ya
 * viene guardado con signo desde la migración 400: negativo en el
 * depósito de origen, positivo en el de destino — ver comentario en
 * supabase/migrations/621_conciliar_stock_por_deposito_etapa4.sql).
 *
 * Depende de la RPC conciliar_stock_por_deposito(empresa_id) (migración
 * 621), solo ejecutable por service_role.
 *
 * ADVERTENCIA (igual que conciliar-stock.js): correr esto contra la
 * empresa demo da un montón de falsos positivos, porque el stock demo se
 * siembra con cantidades directas en `stock` sin las filas de
 * movimientos_stock correspondientes — no es un bug de este script.
 * Usar el id de una empresa real con movimientos genuinos.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   EMPRESA_ID=uuid-de-la-empresa \
 *   node scripts/conciliar-stock-por-deposito.js [--json] [--tolerancia=0.01]
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
        'EMPRESA_ID=uuid node scripts/conciliar-stock-por-deposito.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data, error } = await supabase.rpc('conciliar_stock_por_deposito', { p_empresa_id: EMPRESA_ID });
  if (error) die(`conciliar_stock_por_deposito: ${error.message}`);

  const filas = data || [];
  const divergentes = filas.filter(f => Math.abs(f.diferencia) > TOLERANCIA);

  if (FLAG_JSON) {
    console.log(JSON.stringify({ empresa_id: EMPRESA_ID, tolerancia: TOLERANCIA, total_pares: filas.length, divergentes }, null, 2));
    process.exit(divergentes.length ? 1 : 0);
  }

  log(`Conciliación de stock por depósito — empresa ${EMPRESA_ID}`);
  log(`Pares (producto, depósito) evaluados: ${filas.length} — tolerancia: ${TOLERANCIA}`);
  log(`Nota: incluye tipo='transferencia' (con signo desde v400) en el recálculo.\n`);

  if (divergentes.length === 0) {
    log(`${C.g}[OK]${C.x} El stock de todos los pares (producto, depósito) coincide con lo recalculado desde movimientos_stock.`);
    process.exit(0);
  }

  log(`${C.r}[FAIL]${C.x} ${divergentes.length} par(es) producto/depósito con stock divergente:\n`);
  for (const f of divergentes) {
    log(`  ${C.y}${f.producto_nombre || f.producto_id} — ${f.deposito_nombre || f.deposito_id}${C.x}`);
    log(`    mostrado: ${f.cantidad_mostrada}  recalculado: ${f.cantidad_recalculada}  diferencia: ${f.diferencia}`);
  }
  process.exit(1);
}

main().catch(e => die(e.stack || e.message));
