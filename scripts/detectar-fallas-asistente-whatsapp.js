#!/usr/bin/env node
/**
 * detectar-fallas-asistente-whatsapp.js — Capa 3 del asistente de WhatsApp
 * (ver PLAN_QA_ASISTENTE_WHATSAPP.md, sección 3).
 *
 * Mismo objetivo que scripts/detectar-fallas-asistente.js (asistente de
 * ayuda del dashboard): ninguna de las capas anteriores mira conversaciones
 * REALES que ya pasaron por producción. Adaptado a la diferencia de
 * esquema (ver migración 604): WhatsApp no tiene una tabla `asistente_uso`
 * separada — cada turno saliente del bot ya es una fila propia en
 * `whatsapp_mensajes` (direccion='out'), con `tools_usadas`/
 * `proveedor_usado` colgando directo de esa fila. La "pregunta" que
 * originó cada respuesta no está en la misma fila (a diferencia de
 * asistente_uso.pregunta) — hay que emparejarla con el mensaje 'in'
 * inmediato anterior de la misma conversación.
 *
 * Imprime tres señales, mismo criterio que la Capa 3 del dashboard:
 *
 *   1. SIN_TOOL   — un mensaje saliente del bot con tools_usadas=[] cuyo
 *      mensaje entrante inmediato anterior tiene palabras de dominio
 *      (mismo diccionario palabrasSignificativas() que usa el asistente
 *      del dashboard — no se reinventa uno nuevo acá) contra el catálogo
 *      de las 6 tools de WhatsApp (TOOLS de whatsapp-pedido-tools.js).
 *   2. REPREGUNTA — dos mensajes 'in' consecutivos del mismo cliente
 *      separados por menos de 60s dentro de la misma conversación (señal
 *      de que la respuesta anterior no le sirvió).
 *   3. FALLBACK   — proveedor_usado fue 'groq' u 'openrouter' (Gemini
 *      agotado) en un mensaje saliente — catálogo más filtrado por el
 *      proveedor, mayor riesgo de respuesta pobre.
 *
 * Cada hallazgo confirmado como falla real se suma como caso nuevo al
 * dataset de la Capa 2 (tests/handlers/evals-whatsapp/casos.json) o queda
 * anotado en PLAN_QA_ASISTENTE_WHATSAPP.md — ver el checklist reutilizable
 * de PLAN_QA_ASISTENTE.md, sección 7 (mismo criterio para los dos
 * asistentes).
 *
 * Requiere en el entorno: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Uso:
 *   node scripts/detectar-fallas-asistente-whatsapp.js
 *   node scripts/detectar-fallas-asistente-whatsapp.js --dias=14
 *   node scripts/detectar-fallas-asistente-whatsapp.js --json
 *
 * Nota: filas de whatsapp_mensajes anteriores a la migración 604 tienen
 * tools_usadas '[]' y proveedor_usado NULL por default de columna, no
 * porque no se haya llamado ninguna tool — quedan afuera de SIN_TOOL/
 * FALLBACK automáticamente porque --dias por default (7) ya las excluye
 * por fecha, pero si se corre con --dias grande, revisar la fecha de la
 * migración antes de confiar en el conteo para filas viejas.
 */

import { createClient } from '@supabase/supabase-js';
import { TOOLS } from '../lib/whatsapp-pedido-tools.js';
import { palabrasSignificativas } from '../lib/asistente-tools.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLAG_JSON = process.argv.includes('--json');
const DIAS = Number((process.argv.find((a) => a.startsWith('--dias=')) || '--dias=7').split('=')[1]) || 7;
const REPREGUNTA_MS = 60 * 1000;

const C = FLAG_JSON ? { r: '', g: '', y: '', b: '', x: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', x: '\x1b[0m',
};

function log(...args) { if (!FLAG_JSON) console.log(...args); }
function die(msg) { console.error(`${C.r}[FAIL] Error: ${msg}${C.x}`); process.exit(1); }

// Mismo criterio de vocabulario que tieneVocabularioDeDominio() en
// detectar-fallas-asistente.js, pero contra las 6 tools de WhatsApp en vez
// de las 66 del dashboard — acá no hay selección por keyword que reusar
// (ver sección 1 del plan), así que se compara directo contra TOOLS.
function tieneVocabularioDeDominio(texto) {
  const palabrasTexto = palabrasSignificativas(texto);
  if (!palabrasTexto.length) return false;
  const setTexto = new Set(palabrasTexto);
  return TOOLS.some((t) => {
    const palabrasNombre = t.name.split('_');
    const palabrasDesc = palabrasSignificativas(t.description);
    return palabrasNombre.some((p) => setTexto.has(p)) || palabrasDesc.some((p) => setTexto.has(p));
  });
}

// Trae todos los mensajes (in/out) del período, ordenados por conversación
// y fecha — base común para las tres señales, para no repetir el mismo
// SELECT tres veces.
async function obtenerMensajesDelPeriodo(supabase, desdeIso) {
  const { data, error } = await supabase
    .from('whatsapp_mensajes')
    .select('conversacion_id, direccion, texto, tools_usadas, proveedor_usado, created_at')
    .gte('created_at', desdeIso)
    .order('conversacion_id', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) die(`consultando whatsapp_mensajes: ${error.message}`);
  return data || [];
}

// Emparejamiento in→out por conversación, recorriendo la lista ya ordenada
// una sola vez (mismo mensaje 'in' puede quedar asociado a más de un 'out'
// si el bot mandó varios mensajes seguidos — se toma el 'in' más reciente
// de esa conversación como "la pregunta").
function detectarSinTool(mensajes) {
  const hallazgos = [];
  const ultimoInPorConversacion = new Map();
  for (const m of mensajes) {
    if (m.direccion === 'in') {
      ultimoInPorConversacion.set(m.conversacion_id, m);
      continue;
    }
    if (m.direccion !== 'out') continue;
    if (!Array.isArray(m.tools_usadas) || m.tools_usadas.length !== 0) continue;

    const preguntaPrevia = ultimoInPorConversacion.get(m.conversacion_id);
    if (!preguntaPrevia || !tieneVocabularioDeDominio(preguntaPrevia.texto)) continue;

    hallazgos.push({
      conversacion_id: m.conversacion_id,
      pregunta: preguntaPrevia.texto,
      respuesta_bot: m.texto,
      creado_en: m.created_at,
    });
  }
  return hallazgos;
}

function detectarFallback(mensajes) {
  return mensajes
    .filter((m) => m.direccion === 'out' && ['groq', 'openrouter'].includes(m.proveedor_usado))
    .map((m) => ({
      conversacion_id: m.conversacion_id,
      proveedor_usado: m.proveedor_usado,
      respuesta_bot: m.texto,
      creado_en: m.created_at,
    }));
}

function detectarRepreguntas(mensajes) {
  const hallazgos = [];
  let anterior = null;
  for (const m of mensajes) {
    if (m.direccion !== 'in') continue;
    if (anterior && anterior.conversacion_id === m.conversacion_id) {
      const gapMs = new Date(m.created_at) - new Date(anterior.created_at);
      if (gapMs >= 0 && gapMs < REPREGUNTA_MS) {
        hallazgos.push({
          conversacion_id: m.conversacion_id,
          mensaje_original: anterior.texto,
          repregunta: m.texto,
          gap_ms: gapMs,
          creado_en: m.created_at,
        });
      }
    }
    anterior = m;
  }
  return hallazgos;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    die('Faltan env vars: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas.\n' +
        'Uso: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhb... node scripts/detectar-fallas-asistente-whatsapp.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const desdeIso = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

  const mensajes = await obtenerMensajesDelPeriodo(supabase, desdeIso);
  const sinTool = detectarSinTool(mensajes);
  const fallback = detectarFallback(mensajes);
  const repreguntas = detectarRepreguntas(mensajes);

  if (FLAG_JSON) {
    console.log(JSON.stringify({ dias: DIAS, sin_tool: sinTool, fallback, repreguntas }, null, 2));
    return;
  }

  log(`${C.b}Detección de fallas del asistente de WhatsApp — últimos ${DIAS} día(s)${C.x}\n`);

  log(`${C.y}1. SIN_TOOL${C.x} — sin tool llamada pero el mensaje del cliente tiene palabras de dominio (${sinTool.length}):`);
  for (const f of sinTool) {
    log(`   [${f.creado_en}] conv=${f.conversacion_id} — "${f.pregunta}" -> "${f.respuesta_bot}"`);
  }
  if (!sinTool.length) log('   (nada)');

  log(`\n${C.y}2. REPREGUNTA${C.x} — mensaje del cliente repetido dentro del minuto siguiente (${repreguntas.length}):`);
  for (const f of repreguntas) {
    log(`   [${f.creado_en}] conv=${f.conversacion_id} (+${Math.round(f.gap_ms / 1000)}s) — "${f.mensaje_original}" -> "${f.repregunta}"`);
  }
  if (!repreguntas.length) log('   (nada)');

  log(`\n${C.y}3. FALLBACK${C.x} — cayó a Groq/OpenRouter (${fallback.length}):`);
  for (const f of fallback) {
    log(`   [${f.creado_en}] conv=${f.conversacion_id} proveedor=${f.proveedor_usado} — "${f.respuesta_bot}"`);
  }
  if (!fallback.length) log('   (nada)');

  const total = sinTool.length + repreguntas.length + fallback.length;
  log(`\n${total ? C.y : C.g}Total de candidatos a revisar a mano: ${total}${C.x}`);
  log('Cada uno confirmado como falla real: sumar caso a tests/handlers/evals-whatsapp/casos.json (Capa 2), o anotar en PLAN_QA_ASISTENTE_WHATSAPP.md — ver checklist en PLAN_QA_ASISTENTE.md, sección 7.');
}

main().catch((err) => die(err?.message || String(err)));
