#!/usr/bin/env node
// scripts/load-test.js
//
// Plan de acción 3.3: "el incidente RL-01 (504 en 9 endpoints) se hubiera
// detectado con un test de carga de 5 minutos antes de deployar."
//
// Pega contra los 9 endpoints de /api/admin/* que se colgaron en el
// incidente de 2026-07-12 (ver CHANGELOG_v300 y CHANGELOG_v303),
// simulando 20-50 usuarios concurrentes, y reporta si alguno tarda
// sospechosamente cerca del límite de 60s de Vercel o directamente
// devuelve 504/timeout.
//
// NO es parte del CI de cada push (así lo pide el plan) — se corre a
// mano antes de un cambio grande en rate limiting o en estos handlers:
//
//   BASE_URL=https://tu-preview.vercel.app \
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_ANON_KEY=eyJ... \
//   LOAD_TEST_EMAIL=admin-de-prueba@ejemplo.com \
//   LOAD_TEST_PASSWORD=************ \
//   npm run loadtest
//
// Todos los endpoints listados abajo son GET-only (el dispatcher de
// admin.js ya rechaza cualquier otro método con 405), así que este
// script no escribe nada en la base — es seguro correrlo contra un
// preview o incluso contra producción sin riesgo de efectos secundarios,
// más allá de la carga en sí.
//
// Variables de entorno:
//   BASE_URL            — default: http://localhost:3000
//   SUPABASE_URL         — requerido, para hacer login y sacar el access_token
//   SUPABASE_ANON_KEY    — requerido (la publishable key, no la service role)
//   LOAD_TEST_EMAIL      — requerido, usuario con rol admin/dueno/vendedor
//   LOAD_TEST_PASSWORD   — requerido
//   CONNECTIONS          — default: 30 (usuarios concurrentes, rango sugerido 20-50)
//   DURATION             — default: 20 (segundos por endpoint)
//   CONFIRM_PROD=yes     — requerido si BASE_URL no es localhost/127.0.0.1,
//                          para no pegarle a producción por accidente.

import autocannon from 'autocannon';
import { createClient } from '@supabase/supabase-js';

const BASE_URL    = process.env.BASE_URL || 'http://localhost:3000';
const CONNECTIONS = Number(process.env.CONNECTIONS || 30);
const DURATION    = Number(process.env.DURATION || 20);

// Umbral de alerta: si algo se acerca demasiado al límite de 60s de
// Vercel, es la misma señal de alarma que hubiera detectado RL-01 antes
// de llegar a producción.
const UMBRAL_LATENCIA_P99_MS = 5000;

// Los 9 endpoints que se colgaron en el incidente (CHANGELOG_v300).
const ENDPOINTS = [
  '/api/admin/kpis',
  '/api/admin/pedidos',
  '/api/admin/stock/bajo',
  '/api/admin/reportes/ventas-diarias',
  '/api/admin/alertas',
  '/api/admin/onboarding',
  '/api/admin/dashboard-ejecutivo',
  '/api/admin/comparativa-mensual',
  '/api/admin/resumen-arranque',
];

function requerirEnv(nombre) {
  const valor = process.env[nombre];
  if (!valor) {
    console.error(`[loadtest] Falta la variable de entorno ${nombre}. Ver el encabezado de scripts/load-test.js.`);
    process.exit(1);
  }
  return valor;
}

async function obtenerAccessToken() {
  const supabaseUrl = requerirEnv('SUPABASE_URL');
  const supabaseAnonKey = requerirEnv('SUPABASE_ANON_KEY');
  const email = requerirEnv('LOAD_TEST_EMAIL');
  const password = requerirEnv('LOAD_TEST_PASSWORD');

  const sb = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data?.session?.access_token) {
    console.error('[loadtest] No se pudo iniciar sesión con LOAD_TEST_EMAIL/LOAD_TEST_PASSWORD:', error?.message);
    process.exit(1);
  }
  return data.session.access_token;
}

function esLocal(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);
}

async function correrEndpoint(path, token) {
  const resultado = await autocannon({
    url: BASE_URL + path,
    connections: CONNECTIONS,
    duration: DURATION,
    headers: { Authorization: `Bearer ${token}` },
  });
  return resultado;
}

function resumirResultado(path, r) {
  const status5xx = Object.entries(r.statusCodeStats || {})
    .filter(([codigo]) => Number(codigo) >= 500)
    .reduce((acc, [, stats]) => acc + stats.count, 0);
  const timeouts = r.timeouts || 0;
  const errores = r.errors || 0;
  const p99 = r.latency?.p99 ?? 0;

  // errores > 0 cubre fallas de conexión (ECONNREFUSED, ECONNRESET, socket
  // hang up, etc.) que autocannon cuenta aparte de los 5xx y de los
  // timeouts — sin este chequeo, un servidor caído (0 requests completados,
  // miles de conexiones rechazadas) pasaba como "OK" porque no había ni
  // 5xx ni timeouts ni latencia que evaluar.
  const problema = timeouts > 0 || status5xx > 0 || errores > 0 || p99 > UMBRAL_LATENCIA_P99_MS;

  console.log(
    `${problema ? '✗' : '✓'} ${path}\n` +
    `    req/s: ${r.requests?.average?.toFixed(1) ?? '-'}` +
    `  |  latencia p50/p99: ${r.latency?.p50 ?? '-'}ms / ${p99}ms` +
    `  |  errores: ${errores}  |  timeouts: ${timeouts}  |  5xx: ${status5xx}`
  );
  if (problema) {
    console.log(`    → revisar: ${errores > 0 ? `${errores} errores de conexión (¿servidor caído en BASE_URL?). ` : ''}${timeouts > 0 ? 'hubo timeouts. ' : ''}${status5xx > 0 ? `${status5xx} respuestas 5xx. ` : ''}${p99 > UMBRAL_LATENCIA_P99_MS ? `p99 (${p99}ms) supera el umbral de ${UMBRAL_LATENCIA_P99_MS}ms.` : ''}`);
  }

  return !problema;
}

async function main() {
  if (!esLocal(BASE_URL) && process.env.CONFIRM_PROD !== 'yes') {
    console.error(
      `[loadtest] BASE_URL (${BASE_URL}) no parece local. Si es intencional (preview o producción),\n` +
      `           corré de nuevo con CONFIRM_PROD=yes para confirmar que es a propósito.`
    );
    process.exit(1);
  }

  console.log(`[loadtest] BASE_URL=${BASE_URL}  connections=${CONNECTIONS}  duration=${DURATION}s/endpoint`);
  console.log('[loadtest] Iniciando sesión de prueba...');
  const token = await obtenerAccessToken();

  console.log(`[loadtest] Corriendo ${ENDPOINTS.length} endpoints, uno por vez (~${ENDPOINTS.length * DURATION}s en total)...\n`);

  let todoOk = true;
  for (const path of ENDPOINTS) {
    const resultado = await correrEndpoint(path, token);
    const ok = resumirResultado(path, resultado);
    todoOk = todoOk && ok;
  }

  console.log(`\n[loadtest] ${todoOk ? 'OK — sin timeouts, 5xx ni latencias fuera de umbral.' : 'HAY PROBLEMAS — ver el detalle arriba.'}`);
  process.exit(todoOk ? 0 : 1);
}

main().catch(err => {
  console.error('[loadtest] Error inesperado:', err);
  process.exit(1);
});
