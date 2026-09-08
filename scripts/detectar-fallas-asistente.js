#!/usr/bin/env node
/**
 * detectar-fallas-asistente.js — Capa 3 (ver PLAN_QA_ASISTENTE.md)
 *
 * Motivo: `tests/asistente/*.test.js` prueba ejecución con DB mockeada,
 * `cobertura-seleccion-tools.test.js` prueba el selector como función
 * pura, y `scripts/eval-asistente.js` (Capa 2) corre casos sintéticos
 * contra un modelo real — pero ninguno de los tres mira las conversaciones
 * REALES que ya pasaron por producción. El hallazgo que originó
 * PLAN_COBERTURA_TOOLS_ASISTENTE.md salió de un reclamo puntual de un
 * cliente, no de un proceso que lo hubiera encontrado antes.
 *
 * Este script no reemplaza revisión humana: imprime candidatos a revisar
 * a mano, con tres señales (ver sección 3 del plan):
 *
 *   1. SIN_TOOL   — asistente_uso.tools_usadas vino vacío ([]) pero la
 *      pregunta tiene palabras de dominio conocidas (mismo diccionario de
 *      palabrasSignificativas() que usa el selector real — no se
 *      reinventa uno nuevo acá, ver lib/asistente-tools/index.js).
 *   2. REPREGUNTA — dentro de una misma conversación, dos mensajes 'user'
 *      consecutivos separados por menos de 60s (señal de que la primera
 *      respuesta no le sirvió al usuario).
 *   3. FALLBACK   — asistente_uso.proveedor_usado fue 'groq' u
 *      'openrouter' (Gemini agotado) — catálogo de tools más filtrado,
 *      mayor riesgo de respuesta pobre.
 *
 * Cada hallazgo confirmado como falla real se convierte en un caso nuevo
 * de Capa 1 (selección), Capa 2 (calidad de respuesta) o un hueco de
 * PLAN_COBERTURA_TOOLS_ASISTENTE.md — ver el checklist reutilizable al
 * final de PLAN_QA_ASISTENTE.md.
 *
 * Requiere en el entorno: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Uso:
 *   node scripts/detectar-fallas-asistente.js
 *   node scripts/detectar-fallas-asistente.js --dias=14
 *   node scripts/detectar-fallas-asistente.js --json
 *
 * Nota: filas de asistente_uso anteriores a la migración 600 tienen
 * conversacion_id NULL y tools_usadas '[]' por default de columna, no
 * porque no se haya llamado ninguna tool — quedan afuera de la señal
 * SIN_TOOL automáticamente porque --dias por default (7) ya las excluye
 * por fecha, pero si se corre con --dias grande, revisar la fecha de la
 * migración antes de confiar en el conteo de SIN_TOOL para filas viejas.
 */

import { createClient } from '@supabase/supabase-js';
import { TOOLS, palabrasSignificativas } from '../lib/asistente-tools.js';

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

// Mismo criterio de vocabulario que seleccionarToolsRelevantes() en
// lib/asistente-tools/index.js, pero acá solo interesa SI hay algún
// match contra el catálogo completo (cualquier rol), no elegir cuál tool
// mandarle al modelo — por eso no se reusa seleccionarToolsRelevantes()
// tal cual (siempre devuelve algo, incluso sin match, por el fallback a
// TOOLS_NUCLEO_FALLBACK, así que no sirve para esta pregunta binaria).
function tieneVocabularioDeDominio(pregunta) {
  const palabrasPregunta = palabrasSignificativas(pregunta);
  if (!palabrasPregunta.length) return false;
  const setPregunta = new Set(palabrasPregunta);
  return TOOLS.some((t) => {
    const palabrasNombre = t.name.split('_');
    const palabrasDesc = palabrasSignificativas(t.description);
    return palabrasNombre.some((p) => setPregunta.has(p)) || palabrasDesc.some((p) => setPregunta.has(p));
  });
}

async function detectarSinTool(supabase, desdeIso) {
  // Se filtra "tools_usadas vacío" en JS y no con `.eq('tools_usadas', ...)`
  // a propósito: la representación exacta que PostgREST espera para
  // igualdad contra una columna jsonb es frágil (depende de cómo
  // supabase-js serialice el valor), así que es más seguro traer las
  // filas del período y filtrar acá con Array.isArray + length === 0.
  const { data, error } = await supabase
    .from('asistente_uso')
    .select('id, conversacion_id, usuario_id, empresa_id, pregunta, creado_en, tools_usadas')
    .gte('creado_en', desdeIso)
    .order('creado_en', { ascending: false });

  if (error) die(`consultando asistente_uso (sin_tool): ${error.message}`);

  return (data || [])
    .filter((fila) => Array.isArray(fila.tools_usadas) && fila.tools_usadas.length === 0)
    .filter((fila) => tieneVocabularioDeDominio(fila.pregunta));
}

async function detectarFallback(supabase, desdeIso) {
  const { data, error } = await supabase
    .from('asistente_uso')
    .select('id, conversacion_id, usuario_id, empresa_id, pregunta, proveedor_usado, creado_en')
    .in('proveedor_usado', ['groq', 'openrouter'])
    .gte('creado_en', desdeIso)
    .order('creado_en', { ascending: false });

  if (error) die(`consultando asistente_uso (fallback): ${error.message}`);
  return data || [];
}

async function detectarRepreguntas(supabase, desdeIso) {
  const { data, error } = await supabase
    .from('asistente_mensajes')
    .select('conversacion_id, contenido, creado_en')
    .eq('rol', 'user')
    .gte('creado_en', desdeIso)
    .order('conversacion_id', { ascending: true })
    .order('creado_en', { ascending: true });

  if (error) die(`consultando asistente_mensajes (repregunta): ${error.message}`);

  const hallazgos = [];
  let anterior = null;
  for (const fila of data || []) {
    if (anterior && anterior.conversacion_id === fila.conversacion_id) {
      const gapMs = new Date(fila.creado_en) - new Date(anterior.creado_en);
      if (gapMs >= 0 && gapMs < REPREGUNTA_MS) {
        hallazgos.push({
          conversacion_id: fila.conversacion_id,
          pregunta_original: anterior.contenido,
          repregunta: fila.contenido,
          gap_ms: gapMs,
          creado_en: fila.creado_en,
        });
      }
    }
    anterior = fila;
  }
  return hallazgos;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    die('Faltan env vars: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas.\n' +
        'Uso: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhb... node scripts/detectar-fallas-asistente.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const desdeIso = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

  const [sinTool, fallback, repreguntas] = await Promise.all([
    detectarSinTool(supabase, desdeIso),
    detectarFallback(supabase, desdeIso),
    detectarRepreguntas(supabase, desdeIso),
  ]);

  if (FLAG_JSON) {
    console.log(JSON.stringify({ dias: DIAS, sin_tool: sinTool, fallback, repreguntas }, null, 2));
    return;
  }

  log(`${C.b}Detección de fallas del asistente — últimos ${DIAS} día(s)${C.x}\n`);

  log(`${C.y}1. SIN_TOOL${C.x} — sin tool llamada pero con palabras de dominio (${sinTool.length}):`);
  for (const f of sinTool) {
    log(`   [${f.creado_en}] conv=${f.conversacion_id ?? '(sin conversación)'} — "${f.pregunta}"`);
  }
  if (!sinTool.length) log('   (nada)');

  log(`\n${C.y}2. REPREGUNTA${C.x} — repregunta dentro del minuto siguiente (${repreguntas.length}):`);
  for (const f of repreguntas) {
    log(`   [${f.creado_en}] conv=${f.conversacion_id} (+${Math.round(f.gap_ms / 1000)}s) — "${f.pregunta_original}" -> "${f.repregunta}"`);
  }
  if (!repreguntas.length) log('   (nada)');

  log(`\n${C.y}3. FALLBACK${C.x} — cayó a Groq/OpenRouter (${fallback.length}):`);
  for (const f of fallback) {
    log(`   [${f.creado_en}] conv=${f.conversacion_id ?? '(sin conversación)'} proveedor=${f.proveedor_usado} — "${f.pregunta}"`);
  }
  if (!fallback.length) log('   (nada)');

  const total = sinTool.length + repreguntas.length + fallback.length;
  log(`\n${total ? C.y : C.g}Total de candidatos a revisar a mano: ${total}${C.x}`);
  log('Cada uno confirmado como falla real: sumar caso a Capa 1/Capa 2, o hueco a PLAN_COBERTURA_TOOLS_ASISTENTE.md (ver checklist en PLAN_QA_ASISTENTE.md, sección 7).');
}

main().catch((err) => die(err?.message || String(err)));
