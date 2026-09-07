#!/usr/bin/env node
/**
 * audit-asistente-tools.js — Auditoría estructural del catálogo de tools del asistente
 *
 * Motivo: la suite de tests (tests/asistente/*.test.js) prueba que cada tool
 * EJECUTA bien una vez que el modelo la elige — pero nada probaba (hasta
 * v1066/v1067) que el modelo/selector fuera a elegirla en primer lugar, ni
 * que la RPC que llama exista de verdad en Supabase. De ahí salieron 2 bugs
 * reales en la misma sesión: una tool nueva sin migración en el PR, y una
 * repregunta corta que se quedaba sin catálogo en el fallback Groq/OpenRouter.
 *
 * Este script NO reemplaza a esos tests — es la mitad "estática" del chequeo:
 * mira el catálogo completo (lib/asistente-tools/*.js) como datos y lo cruza
 * contra Supabase, sin necesitar levantar el asistente ni gastar cuota de
 * ningún modelo. La otra mitad, "¿el selector de keywords realmente elige
 * bien ante preguntas reales?", vive en
 * tests/asistente/cobertura-seleccion-tools.test.js (correr aparte con
 * npm test).
 *
 * Qué chequea:
 *   1. Nombres de tool duplicados entre archivos de dominio (overload fantasma
 *      a nivel JS, previo al de Postgres que ya audita audit-funciones-fantasma.js).
 *   2. Toda referencia db.rpc('nombre', ...) dentro de una tool apunta a una
 *      función que existe de verdad en public (vía check_schema_functions(),
 *      la misma RPC de solo-lectura que ya usa check-schema.js).
 *   3. Tools SIN campo `roles` inline (ni array literal ni constante
 *      reconocible) — no es necesariamente un error, pero si es una tool de
 *      escritura (requiereConfirmacion) sin roles explícitos vale la pena
 *      revisarla a mano.
 *   4. Tools de escritura (requiereConfirmacion: true) sin roles definidos.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   node scripts/audit-asistente-tools.js [--json]
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..');
const TOOLS_DIR  = join(ROOT, 'lib/asistente-tools');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLAG_JSON    = process.argv.includes('--json');

const C = FLAG_JSON ? { r:'',g:'',y:'',b:'',c:'',x:'' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', c: '\x1b[36m', x: '\x1b[0m',
};
function log(...args) { if (!FLAG_JSON) console.log(...args); }
function die(msg)     { console.error(`${C.r}[FAIL] ${msg}${C.x}`); process.exit(1); }

// ════════════════════════════════════════════════════════════════════════
// 1. EXTRAER EL CATÁLOGO COMO DATOS (sin ejecutar el código, sin conectar
//    a nada — parser por profundidad de llaves, no un AST completo, pero
//    alcanza para lo que necesitamos leer de cada tool).
// ════════════════════════════════════════════════════════════════════════

function extraerToolsDeArchivo(filepath, filename) {
  const src = readFileSync(filepath, 'utf8');
  const arrStart = src.indexOf('= [');
  if (arrStart === -1) return [];

  let i = src.indexOf('[', arrStart);
  let depth = 0;
  let objStart = null;
  const objs = [];

  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { if (depth === 1) objStart = i; depth++; }
    else if (c === '}') { depth--; if (depth === 1 && objStart !== null) { objs.push(src.slice(objStart, i + 1)); objStart = null; } }
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }

  return objs.map((obj) => {
    const nameM     = obj.match(/name:\s*'([a-zA-Z0-9_]+)'/);
    const rolesArrM = obj.match(/roles:\s*\[([^\]]*)\]/);
    const rolesIdM  = obj.match(/roles:\s*([A-Z_][A-Z0-9_]*)\s*,/);
    const escritura = /requiereConfirmacion\s*:\s*true/.test(obj);
    const rpcCalls  = [...obj.matchAll(/\.rpc\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]);
    return {
      archivo: filename,
      name: nameM ? nameM[1] : null,
      rolesInline: rolesArrM ? rolesArrM[1].replace(/[\s']/g, '').split(',').filter(Boolean) : null,
      rolesConstante: !rolesArrM && rolesIdM ? rolesIdM[1] : null,
      escritura,
      rpcCalls,
    };
  }).filter((t) => t.name);
}

function extraerCatalogoCompleto() {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js');
  const tools = [];
  for (const f of files) tools.push(...extraerToolsDeArchivo(join(TOOLS_DIR, f), f));
  return tools;
}

// ════════════════════════════════════════════════════════════════════════
// 2. FUNCIONES REALES EN SUPABASE (misma RPC que usa check-schema.js)
// ════════════════════════════════════════════════════════════════════════

async function fetchRealFunctions(supabase) {
  const PAGE_SIZE = 1000;
  const names = new Set();
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase.rpc('check_schema_functions').range(from, to);
    if (error) die(`No se pudo leer check_schema_functions(): ${error.message}`);
    if (!data || data.length === 0) break;
    data.forEach((r) => names.add(r.routine_name));
    if (data.length < PAGE_SIZE) break;
  }
  return names;
}

// ════════════════════════════════════════════════════════════════════════
// 3. MAIN
// ════════════════════════════════════════════════════════════════════════

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) die('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');

  log(`${C.c}Extrayendo catálogo de tools del asistente...${C.x}`);
  const tools = extraerCatalogoCompleto();
  log(`  ${tools.length} tools encontradas en ${new Set(tools.map((t) => t.archivo)).size} archivos.\n`);

  log(`${C.c}Conectando a Supabase para validar RPCs...${C.x}`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const funcionesReales = await fetchRealFunctions(supabase);
  log(`  ${funcionesReales.size} funciones encontradas en public.\n`);

  const problemas = { duplicados: [], rpcInexistente: [], escrituraSinRoles: [], rolesPorConstante: [] };

  // 1) Duplicados
  const porNombre = {};
  for (const t of tools) (porNombre[t.name] ||= []).push(t.archivo);
  for (const [name, archivos] of Object.entries(porNombre)) {
    if (archivos.length > 1) problemas.duplicados.push({ name, archivos });
  }

  // 2) RPCs inexistentes
  for (const t of tools) {
    for (const rpc of t.rpcCalls) {
      if (!funcionesReales.has(rpc)) problemas.rpcInexistente.push({ tool: t.name, archivo: t.archivo, rpc });
    }
  }

  // 3) Escritura sin roles inline ni por constante
  for (const t of tools) {
    if (t.escritura && !t.rolesInline && !t.rolesConstante) {
      problemas.escrituraSinRoles.push({ tool: t.name, archivo: t.archivo });
    }
  }

  // 4) Roles definidos por constante (no es error, pero no se puede auditar
  //    en este script sin resolver el import — se deja como recordatorio).
  for (const t of tools) {
    if (t.rolesConstante) problemas.rolesPorConstante.push({ tool: t.name, archivo: t.archivo, constante: t.rolesConstante });
  }

  if (FLAG_JSON) {
    console.log(JSON.stringify({ totalTools: tools.length, problemas }, null, 2));
  } else {
    if (problemas.duplicados.length) {
      log(`${C.r}✗ Nombres de tool duplicados entre archivos:${C.x}`);
      problemas.duplicados.forEach((d) => log(`   ${d.name} → ${d.archivos.join(', ')}`));
    } else {
      log(`${C.g}✓ Sin nombres de tool duplicados.${C.x}`);
    }

    if (problemas.rpcInexistente.length) {
      log(`\n${C.r}✗ Tools que llaman una RPC que NO existe en Supabase:${C.x}`);
      problemas.rpcInexistente.forEach((p) => log(`   ${p.tool} (${p.archivo}) → db.rpc('${p.rpc}')`));
    } else {
      log(`\n${C.g}✓ Todas las RPCs referenciadas existen en Supabase.${C.x}`);
    }

    if (problemas.escrituraSinRoles.length) {
      log(`\n${C.y}⚠ Tools de escritura (requiereConfirmacion) sin roles inline ni por constante — revisar a mano:${C.x}`);
      problemas.escrituraSinRoles.forEach((p) => log(`   ${p.tool} (${p.archivo})`));
    }

    if (problemas.rolesPorConstante.length) {
      log(`\n${C.b}ℹ Tools con roles definidos vía constante (no auditado automáticamente, revisar el import a mano):${C.x}`);
      problemas.rolesPorConstante.forEach((p) => log(`   ${p.tool} (${p.archivo}) → roles: ${p.constante}`));
    }
  }

  const huboErrores = problemas.duplicados.length > 0 || problemas.rpcInexistente.length > 0;
  process.exit(huboErrores ? 1 : 0);
}

main().catch((e) => die(e.message));
