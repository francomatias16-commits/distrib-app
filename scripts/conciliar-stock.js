#!/usr/bin/env node
/**
 * conciliar-stock.js — Etapa 4 del plan de auditoría de integridad
 * financiera (conciliación de saldos).
 *
 * Recalcula el stock TOTAL de cada producto (sumado entre depósitos)
 * desde movimientos_stock y lo compara contra la suma real de
 * stock.cantidad. A diferencia de cta_cte, stock.cantidad NO tiene un
 * trigger que lo recalcule solo: se actualiza con UPDATE directo en cada
 * función (registrar_venta_pos, ajustar_stock, transferir_stock, etc.) en
 * paralelo al INSERT en movimientos_stock. Sin ese trigger de por medio,
 * cualquier función que inserte un movimiento sin actualizar stock (o
 * viceversa) genera divergencia silenciosa.
 *
 * LIMITACIÓN CONOCIDA: esto concilia el TOTAL por producto (entre
 * depósitos), no por depósito individual. tipo='transferencia' no tiene
 * columna de dirección (ver migración 620) y se excluye del recálculo, lo
 * cual es correcto para el total (una transferencia interna nunca cambia
 * el total de la empresa) pero impide conciliar por depósito.
 *
 * Depende de la RPC conciliar_stock_por_producto(empresa_id) (migración
 * 620), solo ejecutable por service_role.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   EMPRESA_ID=uuid-de-la-empresa \
 *   node scripts/conciliar-stock.js [--json] [--tolerancia=0.01]
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
        'EMPRESA_ID=uuid node scripts/conciliar-stock.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const { data, error } = await supabase.rpc('conciliar_stock_por_producto', { p_empresa_id: EMPRESA_ID });
  if (error) die(`conciliar_stock_por_producto: ${error.message}`);

  const filas = data || [];
  const divergentes = filas.filter(f => Math.abs(f.diferencia) > TOLERANCIA);

  if (FLAG_JSON) {
    console.log(JSON.stringify({ empresa_id: EMPRESA_ID, tolerancia: TOLERANCIA, total_productos: filas.length, divergentes }, null, 2));
    process.exit(divergentes.length ? 1 : 0);
  }

  log(`Conciliación de stock (total por producto) — empresa ${EMPRESA_ID}`);
  log(`Productos evaluados: ${filas.length} — tolerancia: ${TOLERANCIA}`);
  log(`Nota: tipo='transferencia' se excluye del recálculo (ver comentario en el script).\n`);

  if (divergentes.length === 0) {
    log(`${C.g}[OK]${C.x} El stock total de todos los productos coincide con lo recalculado desde movimientos_stock.`);
    process.exit(0);
  }

  log(`${C.r}[FAIL]${C.x} ${divergentes.length} producto(s) con stock divergente:\n`);
  for (const f of divergentes) {
    log(`  ${C.y}${f.producto_nombre || f.producto_id}${C.x}`);
    log(`    mostrado: ${f.cantidad_mostrada}  recalculado: ${f.cantidad_recalculada}  diferencia: ${f.diferencia}`);
  }
  process.exit(1);
}

main().catch(e => die(e.stack || e.message));
