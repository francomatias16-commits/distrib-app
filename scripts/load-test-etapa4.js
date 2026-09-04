#!/usr/bin/env node
// scripts/load-test-etapa4.js
//
// Etapa 4 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md — extiende la
// cobertura de scripts/load-test.js (que solo cubre 9 endpoints GET de
// /api/admin/*, nacidos del incidente RL-01) a las tres superficies con más
// tráfico real esperado: checkout del portal cliente, venta de POS, y el
// webhook entrante de WhatsApp.
//
// A diferencia de load-test.js, estos NO son GET-only — escriben datos
// reales (pedidos, ventas de POS). Decisión confirmada con vos (2026-08-28):
//   - Tenant: la EMPRESA DEMO pública (fn_reset_demo_v2 la resetea a su
//     snapshot base al final de este script, siempre, salvo que pidas lo
//     contrario con SKIP_DEMO_RESET=yes).
//   - Webhook de WhatsApp: SOLO se mide el costo de recepción (validación de
//     firma HMAC + parseo + intento de resolución de teléfono). El payload
//     usa un `phone_number_id` y un número `from` que NO matchean ninguna
//     empresa/cliente real (ver `firmaValidaDeMeta`/resolución de teléfono en
//     lib/handlers/notif.js) — así el flujo entra, se valida y se mide, pero
//     nunca resuelve a un cliente real y por lo tanto nunca dispara una
//     respuesta automática ni un envío saliente real, sin importar en qué
//     entorno corra esto.
//
// Uso:
//   BASE_URL=https://tu-preview.vercel.app \
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_ANON_KEY=eyJ... \
//   LOAD_TEST_EMAIL=admin-de-prueba@ejemplo.com \
//   LOAD_TEST_PASSWORD=************ \
//   LOAD_TEST_CLIENTE_EMAIL=cliente-de-prueba@ejemplo.com \
//   LOAD_TEST_CLIENTE_PASSWORD=************ \
//   LOAD_TEST_SUPERADMIN_EMAIL=superadmin@ejemplo.com \
//   LOAD_TEST_SUPERADMIN_PASSWORD=************ \
//   LOAD_TEST_DEMO_EMPRESA_ID=uuid-de-la-empresa-demo \
//   WA_APP_SECRET=el-mismo-valor-que-en-Vercel \
//   npm run loadtest:etapa4
//
// Variables de entorno:
//   BASE_URL                     — default: http://localhost:3000
//   SUPABASE_URL / SUPABASE_ANON_KEY — requeridos, para login (misma publishable key, no service role)
//   LOAD_TEST_EMAIL/PASSWORD          — usuario admin/dueño/vendedor de la empresa demo (mismo que load-test.js)
//   LOAD_TEST_CLIENTE_EMAIL/PASSWORD  — usuario del portal cliente de la empresa demo
//   LOAD_TEST_SUPERADMIN_EMAIL/PASSWORD — usuario superadmin (o dueño de la empresa raíz) — SOLO se usa
//                                         para el reset final; si falta, el script corre igual pero
//                                         avisa al final que el reset no se hizo.
//   LOAD_TEST_DEMO_EMPRESA_ID    — requerido para el reset (nunca se infiere ni se manda vacío: un
//                                  p_empresa_id NULL en fn_reset_demo_v2 no está documentado acá y no
//                                  vale la pena arriesgarse a que resetee de más).
//   WA_APP_SECRET                — requerido para el escenario whatsapp-webhook (mismo secreto que Vercel)
//   ESCENARIOS                   — default: "checkout,pos,whatsapp-webhook" (coma-separado, para correr un subconjunto)
//   CONNECTIONS_ESCRITURA         — default: 10 (más conservador que load-test.js: esto escribe datos reales)
//   DURATION_ESCRITURA            — default: 10 (segundos por escenario)
//   SKIP_DEMO_RESET=yes          — no resetear la empresa demo al final (para inspeccionar los datos generados)
//   CONFIRM_PROD=yes             — requerido si BASE_URL no es local, igual que load-test.js

import autocannon from 'autocannon';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const BASE_URL           = process.env.BASE_URL || 'http://localhost:3000';
const CONNECTIONS         = Number(process.env.CONNECTIONS_ESCRITURA || 10);
const DURATION            = Number(process.env.DURATION_ESCRITURA || 10);
const UMBRAL_LATENCIA_P99_MS = 5000;
const ESCENARIOS = (process.env.ESCENARIOS || 'checkout,pos,whatsapp-webhook')
  .split(',').map(s => s.trim()).filter(Boolean);

function requerirEnv(nombre) {
  const valor = process.env[nombre];
  if (!valor) {
    console.error(`[loadtest-etapa4] Falta la variable de entorno ${nombre}. Ver el encabezado de este script.`);
    process.exit(1);
  }
  return valor;
}

function esLocal(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);
}

async function login(email, password) {
  const supabaseUrl = requerirEnv('SUPABASE_URL');
  const supabaseAnonKey = requerirEnv('SUPABASE_ANON_KEY');
  const sb = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data?.session?.access_token) {
    console.error(`[loadtest-etapa4] No se pudo iniciar sesión con ${email}:`, error?.message);
    process.exit(1);
  }
  return data.session.access_token;
}

async function apiFetch(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function resumirResultado(nombre, r) {
  const status5xx = Object.entries(r.statusCodeStats || {})
    .filter(([codigo]) => Number(codigo) >= 500)
    .reduce((acc, [, stats]) => acc + stats.count, 0);
  const timeouts = r.timeouts || 0;
  const p99 = r.latency?.p99 ?? 0;

  const problema = timeouts > 0 || status5xx > 0 || p99 > UMBRAL_LATENCIA_P99_MS;

  console.log(
    `${problema ? '✗' : '✓'} ${nombre}\n` +
    `    req/s: ${r.requests?.average?.toFixed(1) ?? '-'}` +
    `  |  latencia p50/p99: ${r.latency?.p50 ?? '-'}ms / ${p99}ms` +
    `  |  errores: ${r.errors || 0}  |  timeouts: ${timeouts}  |  5xx: ${status5xx}` +
    (r._non2xx ? `  |  no-2xx (excl. 5xx): ${r._non2xx}` : '')
  );
  if (problema) {
    console.log(`    → revisar: ${timeouts > 0 ? 'hubo timeouts. ' : ''}${status5xx > 0 ? `${status5xx} respuestas 5xx. ` : ''}${p99 > UMBRAL_LATENCIA_P99_MS ? `p99 (${p99}ms) supera el umbral de ${UMBRAL_LATENCIA_P99_MS}ms.` : ''}`);
  }
  return !problema;
}

// ══════════════════════════════════════════════════════════════════════════
// Escenario 1 — Checkout de cliente (carrito → confirmar pedido)
// ══════════════════════════════════════════════════════════════════════════
async function escenarioCheckout() {
  console.log('\n[loadtest-etapa4] === Checkout de cliente ===');
  const email = requerirEnv('LOAD_TEST_CLIENTE_EMAIL');
  const password = requerirEnv('LOAD_TEST_CLIENTE_PASSWORD');
  const token = await login(email, password);

  // Traer un producto real con stock disponible del catálogo de la propia
  // empresa del cliente (resuelta por el token, no hace falta empresa_id).
  const { status, data } = await apiFetch('/api/cliente/productos?limit=10', { token });
  if (status !== 200 || !data?.productos?.length) {
    console.error('[loadtest-etapa4] No se pudo obtener el catálogo del cliente de prueba (¿tiene productos activos con stock la empresa demo?). Se omite este escenario.');
    return true; // no cuenta como falla de performance, es un problema de datos de prueba
  }
  const producto = data.productos.find(p => (p.stock_disponible || 0) > 0) || data.productos[0];

  console.log(`[loadtest-etapa4] Usando producto "${producto.nombre}" (id ${producto.id}) para el checkout de prueba.`);
  console.log('[loadtest-etapa4] IMPORTANTE: cada request confirma un pedido REAL (cantidad=1) contra la empresa demo — se resetea al final salvo SKIP_DEMO_RESET=yes.');

  const resultado = await autocannon({
    url: BASE_URL + '/api/pedidos?accion=confirmar',
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [{
      method: 'POST',
      path: '/api/pedidos?accion=confirmar',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      setupRequest: (request) => {
        // idempotency_key distinto por request — si se repitiera la misma
        // clave en todas las conexiones, el endpoint dedupearía y el test
        // dejaría de medir el camino real de confirmación.
        request.body = JSON.stringify({
          items: [{ producto_id: producto.id, cantidad: 1 }],
          forma_pago: 'pago_inmediato', // no genera deuda de cta_cte real en el cliente demo
          idempotency_key: crypto.randomUUID(),
        });
        return request;
      },
    }],
  });

  return resumirResultado('POST /api/pedidos?accion=confirmar', resultado);
}

// ══════════════════════════════════════════════════════════════════════════
// Escenario 2 — Venta de POS
// ══════════════════════════════════════════════════════════════════════════
async function escenarioPos() {
  console.log('\n[loadtest-etapa4] === Venta de POS ===');
  const email = requerirEnv('LOAD_TEST_EMAIL');
  const password = requerirEnv('LOAD_TEST_PASSWORD');
  const token = await login(email, password);

  const cajas = await apiFetch('/api/pos?accion=cajas', { token });
  if (cajas.status !== 200 || !cajas.data?.length) {
    console.error('[loadtest-etapa4] No se pudo listar cajas activas de la empresa demo (¿el usuario tiene permiso "vender" en POS? ¿hay al menos una caja activa?). Se omite este escenario.');
    return true;
  }

  // /api/pos?accion=cajas no informa si una caja ya tiene turno abierto, así
  // que no alcanza con tomar cajas.data[0] a ciegas: en la empresa demo es
  // habitual que alguna caja quede con un turno abierto de una corrida
  // anterior (o directamente ya lo tenga así el propio snapshot de reset).
  // Se prueba abrir turno en cada caja activa, en orden, hasta encontrar una
  // libre (409 = ya tiene turno abierto → se prueba la siguiente).
  let caja_id = null;
  let turno_id = null;
  for (const caja of cajas.data) {
    const apertura = await apiFetch('/api/pos?accion=abrir-turno', { token, method: 'POST', body: { caja_id: caja.id, monto_inicial: 0 } });
    if (apertura.status === 409) {
      console.log(`[loadtest-etapa4] Caja "${caja.nombre}" (${caja.id}) ya tiene un turno abierto — probando la siguiente.`);
      continue;
    }
    if (apertura.status !== 201 || !apertura.data?.id) {
      console.error(`[loadtest-etapa4] No se pudo abrir turno en caja "${caja.nombre}" (${caja.id}):`, apertura.data?.error || apertura.status);
      continue;
    }
    caja_id = caja.id;
    turno_id = apertura.data.id;
    break;
  }
  if (!turno_id) {
    console.error('[loadtest-etapa4] Ninguna de las cajas activas de la empresa demo tiene un turno libre para abrir (¿quedaron todas con turnos abiertos de corridas anteriores? revisá/cerrálas manualmente desde el panel POS, o re-generá el snapshot de la demo con fn_snapshot_demo_v2 después de cerrarlas). Se omite este escenario.');
    return true;
  }

  const productos = await apiFetch(`/api/pos?accion=productos&q=a&caja_id=${caja_id}`, { token });
  if (productos.status !== 200 || !productos.data?.length) {
    console.error('[loadtest-etapa4] No se encontraron productos para vender por POS (probá con otra letra de búsqueda si la empresa demo tiene pocos productos). Se omite este escenario.');
    return true;
  }
  const producto_id = productos.data[0].id;

  console.log(`[loadtest-etapa4] Turno ${turno_id} abierto en caja ${caja_id}. Vendiendo producto ${producto_id} en bucle.`);
  console.log('[loadtest-etapa4] IMPORTANTE: cada request registra una venta REAL de POS contra la empresa demo — se resetea al final salvo SKIP_DEMO_RESET=yes.');

  const resultado = await autocannon({
    url: BASE_URL + '/api/pos',
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [{
      method: 'POST',
      path: '/api/pos',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      setupRequest: (request) => {
        request.body = JSON.stringify({
          caja_id,
          turno_id,
          items: [{ producto_id, cantidad: 1 }],
          // Monto de sobra en efectivo: no hace falta calcular el total
          // exacto server-side, solo que la suma de pagos alcance el total.
          pagos: [{ medio: 'efectivo', monto: 999999 }],
          offline_local_id: crypto.randomUUID(),
        });
        return request;
      },
    }],
  });

  const ok = resumirResultado('POST /api/pos (registrar venta)', resultado);

  const cierre = await apiFetch('/api/pos?accion=cerrar-turno', { token, method: 'POST', body: { turno_id, monto_final_declarado: 0 } });
  if (cierre.status !== 200) {
    console.error(`[loadtest-etapa4] No se pudo cerrar el turno ${turno_id} automáticamente — cerralo a mano desde el panel POS antes de operar esa caja de nuevo.`);
  }

  return ok;
}

// ══════════════════════════════════════════════════════════════════════════
// Escenario 3 — Webhook entrante de WhatsApp (solo recepción, sin disparar
// envíos salientes reales — ver nota al inicio del archivo)
// ══════════════════════════════════════════════════════════════════════════
async function escenarioWhatsappWebhook() {
  console.log('\n[loadtest-etapa4] === Webhook entrante de WhatsApp (solo recepción) ===');
  const secret = requerirEnv('WA_APP_SECRET');

  // phone_number_id y "from" sintéticos: no matchean ninguna fila real de
  // empresa_whatsapp ni ningún cliente por teléfono. El handler igual valida
  // firma + parsea + intenta resolver el teléfono (que es el costo real que
  // queremos medir), pero como no resuelve a un cliente real nunca dispara
  // una respuesta automática — ver lib/handlers/notif.js, resolución de
  // teléfono y el comentario "procesarMensajeTexto corta el flujo automático
  // si clienteId es null".
  const payloadBase = (id) => ({
    entry: [{
      id: 'loadtest-etapa4',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '000000000000000' },
          contacts: [{ profile: { name: 'Load Test' }, wa_id: '5490000000000' }],
          messages: [{
            from: '5490000000000',
            id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'mensaje de prueba — scripts/load-test-etapa4.js' },
            type: 'text',
          }],
        },
      }],
    }],
  });

  const resultado = await autocannon({
    url: BASE_URL + '/api/notif?_svc=whatsapp-webhook',
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [{
      method: 'POST',
      path: '/api/notif?_svc=whatsapp-webhook',
      setupRequest: (request) => {
        const id = 'wamid.loadtest.' + crypto.randomUUID();
        const bodyStr = JSON.stringify(payloadBase(id));
        const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
        request.body = bodyStr;
        request.headers = {
          ...request.headers,
          'content-type': 'application/json',
          'x-hub-signature-256': firma,
        };
        return request;
      },
    }],
  });

  // El webhook devuelve 200 tanto en éxito como en error interno controlado
  // (ver comentario en notif.js: "Meta espera 200 rápido"), así que acá un
  // 401 sí importaría (firma inválida — bug en este script) pero no lo
  // tratamos como falla de performance per se.
  return resumirResultado('POST /api/notif?_svc=whatsapp-webhook', resultado);
}

// ══════════════════════════════════════════════════════════════════════════
async function resetearDemo() {
  if (process.env.SKIP_DEMO_RESET === 'yes') {
    console.log('\n[loadtest-etapa4] SKIP_DEMO_RESET=yes — no se resetea la empresa demo. Los pedidos/ventas de esta corrida quedan en la base.');
    return;
  }

  const empresaId = process.env.LOAD_TEST_DEMO_EMPRESA_ID;
  if (!empresaId) {
    console.error('\n[loadtest-etapa4] Falta LOAD_TEST_DEMO_EMPRESA_ID — NO se reseteó la empresa demo. Los pedidos/ventas de esta corrida quedaron en la base, revisalos a mano.');
    return;
  }
  if (!process.env.LOAD_TEST_SUPERADMIN_EMAIL || !process.env.LOAD_TEST_SUPERADMIN_PASSWORD) {
    console.error('\n[loadtest-etapa4] Faltan LOAD_TEST_SUPERADMIN_EMAIL/PASSWORD — NO se reseteó la empresa demo (el endpoint de reset requiere rol superadmin/dueño de la empresa raíz). Los datos de esta corrida quedaron en la base.');
    return;
  }

  console.log('\n[loadtest-etapa4] Reseteando empresa demo a su snapshot base...');
  const token = await login(process.env.LOAD_TEST_SUPERADMIN_EMAIL, process.env.LOAD_TEST_SUPERADMIN_PASSWORD);
  const { status, data } = await apiFetch('/api/saas?_svc=demo-reset', { token, method: 'POST', body: { empresa_id: empresaId } });
  if (status !== 200 || !data?.ok) {
    console.error('[loadtest-etapa4] El reset de la empresa demo falló:', data?.error || status, '— revisá los datos generados a mano.');
    return;
  }
  console.log('[loadtest-etapa4] Empresa demo reseteada OK.');
}

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  if (!esLocal(BASE_URL) && process.env.CONFIRM_PROD !== 'yes') {
    console.error(
      `[loadtest-etapa4] BASE_URL (${BASE_URL}) no parece local. Este script ESCRIBE datos reales\n` +
      `           (pedidos, ventas de POS) contra la empresa demo. Si es intencional, corré de\n` +
      `           nuevo con CONFIRM_PROD=yes para confirmar que es a propósito.`
    );
    process.exit(1);
  }

  console.log(`[loadtest-etapa4] BASE_URL=${BASE_URL}  connections=${CONNECTIONS}  duration=${DURATION}s/escenario  escenarios=${ESCENARIOS.join(',')}`);

  const funciones = {
    'checkout': escenarioCheckout,
    'pos': escenarioPos,
    'whatsapp-webhook': escenarioWhatsappWebhook,
  };

  let todoOk = true;
  try {
    for (const nombre of ESCENARIOS) {
      const fn = funciones[nombre];
      if (!fn) {
        console.error(`[loadtest-etapa4] Escenario desconocido: "${nombre}" (válidos: ${Object.keys(funciones).join(', ')})`);
        todoOk = false;
        continue;
      }
      const ok = await fn();
      todoOk = todoOk && ok;
    }
  } finally {
    // Se resetea SIEMPRE que se corrió al menos checkout o pos, haya o no
    // habido errores de performance — el reset es sobre datos, no sobre el
    // resultado de la medición.
    if (ESCENARIOS.includes('checkout') || ESCENARIOS.includes('pos')) {
      await resetearDemo();
    }
  }

  console.log(`\n[loadtest-etapa4] ${todoOk ? 'OK — sin timeouts, 5xx ni latencias fuera de umbral.' : 'HAY PROBLEMAS — ver el detalle arriba.'}`);
  process.exit(todoOk ? 0 : 1);
}

main().catch(err => {
  console.error('[loadtest-etapa4] Error inesperado:', err);
  process.exit(1);
});
