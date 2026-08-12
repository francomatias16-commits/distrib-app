#!/usr/bin/env node
/**
 * check-schema.js — Validador de sincronización schema ↔ código
 *
 * Conecta a Supabase, descarga el schema real (information_schema) y
 * escanea todos los handlers JS buscando referencias a tablas y columnas.
 * Reporta discrepancias: tablas inexistentes, columnas inexistentes, etc.
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   node scripts/check-schema.js [--fix-hints] [--json]
 *
 * Flags:
 *   --fix-hints   Muestra sugerencias de corrección para cada error
 *   --json        Output en JSON (para CI/CD)
 *   --dir=path    Directorio raíz a escanear (default: .)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FLAG_HINTS    = process.argv.includes('--fix-hints');
const FLAG_JSON     = process.argv.includes('--json');
const FLAG_DIR      = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6)
                      || join(__dirname, '..');

// Directorios a escanear (relativos a la raíz)
const SCAN_DIRS = ['lib/handlers', 'api', 'frontend/admin/js', 'frontend/cliente/js', 'frontend/chofer'];

// Tablas internas de Supabase/Auth que no están en public
const IGNORE_TABLES = new Set(['auth.users', 'storage.objects']);

// Columnas que sabemos que son generadas/virtuales en PostgREST (relaciones)
const RELATION_PATTERN = /^[a-z_]+\s*\(/i; // e.g. "clientes(id, nombre)"

// ── Colores ───────────────────────────────────────────────────────────────────
const C = FLAG_JSON ? { r:'',g:'',y:'',b:'',m:'',c:'',w:'',x:'' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m',
  b: '\x1b[34m', m: '\x1b[35m', c: '\x1b[36m',
  w: '\x1b[37m', x: '\x1b[0m',
};

function log(...args) { if (!FLAG_JSON) console.log(...args); }
function die(msg)     { console.error(`${C.r}[FAIL] Error: ${msg}${C.x}`); process.exit(1); }


// ════════════════════════════════════════════════════════════════════════════
// 1. OBTENER SCHEMA REAL DE SUPABASE
// ════════════════════════════════════════════════════════════════════════════

async function fetchRealSchema(supabase) {
  log(`\n${C.c}Conectando a Supabase para obtener schema real...${C.x}`);

  const { data: cols, error } = await supabase.rpc('check_schema_columns');

  if (error) die(`No se pudo leer el schema via RPC check_schema_columns: ${error.message}`);

  // { tableName: Set<columnName> }
  const schema = {};
  for (const col of cols) {
    if (!schema[col.table_name]) schema[col.table_name] = new Set();
    schema[col.table_name].add(col.column_name);
  }

  log(`${C.g}[OK] Schema obtenido: ${Object.keys(schema).length} tablas${C.x}`);
  return schema;
}

// También obtener RPCs disponibles
async function fetchRealFunctions(supabase) {
  const { data, error } = await supabase.rpc('check_schema_functions');

  if (error) return new Set();
  return new Set((data || []).map(r => r.routine_name));
}


// ════════════════════════════════════════════════════════════════════════════
// 2. ESCANEAR ARCHIVOS JS
// ════════════════════════════════════════════════════════════════════════════

/** Recolectar todos los .js recursivamente */
function collectFiles(dir) {
  const files = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const e of entries) {
    if (['node_modules', '.git', 'dist', '.vercel'].includes(e)) continue;
    const full = join(dir, e);
    const st   = statSync(full);
    if (st.isDirectory()) files.push(...collectFiles(full));
    else if (extname(e) === '.js') files.push(full);
  }
  return files;
}

/**
 * Extraer referencias a tablas y columnas del código fuente JS.
 * Devuelve array de:
 *   { file, line, kind, table, columns, raw }
 *
 * kind: 'select' | 'insert' | 'update' | 'upsert' | 'eq' | 'rpc' | 'from'
 */
function extractReferences(src, filepath) {
  const refs = [];
  const lines = src.split('\n');

  // ── .from('table') ──────────────────────────────────────────────────────
  // Captura la tabla y asocia el select/insert/update que sigue (en la misma cadena)
  const FROM_RE = /\.from\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let m;

  while ((m = FROM_RE.exec(src)) !== null) {
    const lineNum = src.slice(0, m.index).split('\n').length;
    const table   = m[1];
    // Skip auth/storage pseudo-tables
    if (table.includes('.')) continue;

    // Buscar el .select() más cercano DESPUÉS del .from()
    const after = src.slice(m.index);

    // .select('col1, col2, rel(...)') — puede ser multi-línea entre backticks/quotes
    const selMatch = after.match(/\.select\(\s*(`[^`]*`|'[^']*'|"[^"]*")/);
    if (selMatch) {
      const raw    = selMatch[1].slice(1, -1);           // quitar quotes/backticks
      const cols   = parseSelectCols(raw);
      refs.push({ file: filepath, line: lineNum, kind: 'select', table, columns: cols, raw });
    }

    // .insert({ key: val, ... }) — objeto literal
    const insMatch = after.match(/\.insert\(\s*\{([^}]{0,800})\}/s);
    if (insMatch) {
      const cols = parseObjectKeys(insMatch[1]);
      if (cols.length > 0)
        refs.push({ file: filepath, line: lineNum, kind: 'insert', table, columns: cols, raw: insMatch[1] });
    }

    // .update({ key: val }) 
    const updMatch = after.match(/\.update\(\s*\{([^}]{0,800})\}/s);
    if (updMatch) {
      const cols = parseObjectKeys(updMatch[1]);
      if (cols.length > 0)
        refs.push({ file: filepath, line: lineNum, kind: 'update', table, columns: cols, raw: updMatch[1] });
    }

    // .upsert({ key: val })
    const upsMatch = after.match(/\.upsert\(\s*\{([^}]{0,800})\}/s);
    if (upsMatch) {
      const cols = parseObjectKeys(upsMatch[1]);
      if (cols.length > 0)
        refs.push({ file: filepath, line: lineNum, kind: 'upsert', table, columns: cols, raw: upsMatch[1] });
    }

    // .eq('col', val) — solo capturar la columna del .eq encadenado al mismo from
    const eqRe = /\.eq\(\s*['"`]([^'"`]+)['"`]/g;
    const eqSrc = after.slice(0, 600); // ventana corta
    let em;
    while ((em = eqRe.exec(eqSrc)) !== null) {
      const col = em[1];
      if (!col.includes('.')) // skip "tabla.col" nested
        refs.push({ file: filepath, line: lineNum, kind: 'eq', table, columns: [col], raw: em[0] });
    }
  }

  // ── .rpc('nombre', { params }) ──────────────────────────────────────────
  const RPC_RE = /\.rpc\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{([^}]{0,500})\}/gs;
  while ((m = RPC_RE.exec(src)) !== null) {
    const lineNum  = src.slice(0, m.index).split('\n').length;
    const rpcName  = m[1];
    const params   = parseObjectKeys(m[2]);
    refs.push({ file: filepath, line: lineNum, kind: 'rpc', table: rpcName, columns: params, raw: m[0] });
  }

  return refs;
}

/** Parsear columnas de un string select de PostgREST */
function parseSelectCols(raw) {
  const cols = [];
  // Dividir por coma, pero respetar paréntesis anidados
  let depth = 0, cur = '';
  for (const ch of raw) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) {
      const token = cur.trim();
      if (token) cols.push(token);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) cols.push(cur.trim());

  // Procesar cada token: sacar alias, anotar si es relación
  return cols.map(tok => {
    // Alias: "col:alias" → col
    const colonIdx = tok.indexOf(':');
    if (colonIdx > 0) tok = tok.slice(0, colonIdx).trim();
    // Filtros PostgREST: "col.operator.value" → col
    const dotIdx = tok.indexOf('.');
    if (dotIdx > 0) tok = tok.slice(0, dotIdx).trim();
    // Quitar modificadores: !, cast, etc.
    tok = tok.replace(/[!]/, '').trim();
    return tok;
  }).filter(Boolean);
}

/** Extraer keys de un objeto JS literal */
function parseObjectKeys(objBody) {
  const keys = [];
  // Matchear "key:" o "'key':" o `"key":`
  const KEY_RE = /(?:^|,|\{)\s*(?:['"`]([^'"`]+)['"`]|([a-zA-Z_][a-zA-Z0-9_]*))\s*:/gm;
  let m;
  while ((m = KEY_RE.exec(objBody)) !== null) {
    const key = (m[1] || m[2] || '').trim();
    if (key && !key.startsWith('//')) keys.push(key);
  }
  return [...new Set(keys)];
}


// ════════════════════════════════════════════════════════════════════════════
// 3. VALIDAR REFERENCIAS CONTRA SCHEMA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Columnas virtuales/técnicas que no son columnas reales:
 *   - Relaciones PostgREST: "clientes(id)" — el nombre antes del ( es la relación
 *   - count, * (wildcard), etc.
 */
function isVirtualRef(colToken) {
  return (
    colToken === '*' ||
    colToken === 'count' ||
    RELATION_PATTERN.test(colToken) ||          // "relacion(..."
    colToken.includes('(') ||                    // cualquier función
    colToken.startsWith('!') ||
    /^[A-Z]/.test(colToken)                      // constantes
  );
}

function validate(refs, schema, functions) {
  const errors   = [];
  const warnings = [];

  // Columnas que son relaciones PostgREST (nombre de tabla como FK shorthand)
  const allTables = new Set(Object.keys(schema));

  for (const ref of refs) {
    const { file, line, kind, table, columns } = ref;
    const relPath = relative(FLAG_DIR, file);

    // ── RPC: verificar que la función existe ────────────────────────────────
    if (kind === 'rpc') {
      if (!functions.has(table)) {
        errors.push({
          severity: 'ERROR',
          file: relPath, line, kind,
          message: `RPC '${table}' no existe en la DB`,
          hint: `Crear la función en una migration SQL: CREATE OR REPLACE FUNCTION public.${table}(...)`,
        });
      }
      continue;
    }

    // ── Tabla: verificar existencia ─────────────────────────────────────────
    if (IGNORE_TABLES.has(table)) continue;

    const tableCols = schema[table];
    if (!tableCols) {
      errors.push({
        severity: 'ERROR',
        file: relPath, line, kind,
        message: `Tabla '${table}' no existe en la DB (esquema public)`,
        hint: `¿Escribiste mal el nombre? Tablas disponibles con nombre similar: ${
          [...allTables].filter(t => levenshtein(t, table) <= 3).join(', ') || 'ninguna'
        }`,
      });
      continue;
    }

    // ── Columnas: verificar existencia ──────────────────────────────────────
    for (const col of columns) {
      // Ignorar tokens que son relaciones, wildcards o parámetros de RPC
      if (isVirtualRef(col)) continue;
      // Ignorar nombres de tablas usados como relación PostgREST
      if (allTables.has(col)) continue;

      if (!tableCols.has(col)) {
        // Buscar sugerencia por similitud
        const suggestion = [...tableCols].find(c => levenshtein(c, col) <= 2);
        errors.push({
          severity: 'ERROR',
          file: relPath, line, kind,
          message: `Columna '${col}' no existe en '${table}'`,
          hint: suggestion
            ? `¿Quisiste decir '${suggestion}'? Columnas de '${table}': ${[...tableCols].join(', ')}`
            : `Columnas de '${table}': ${[...tableCols].join(', ')}`,
        });
      }
    }
  }

  return { errors, warnings };
}

/** Distancia de Levenshtein simple (para sugerencias) */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i || j));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
               : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}


// ════════════════════════════════════════════════════════════════════════════
// 4. REPORTE
// ════════════════════════════════════════════════════════════════════════════

function report({ errors, warnings }, allRefs) {
  const tablesMentioned = [...new Set(allRefs.map(r => r.table))].sort();

  if (FLAG_JSON) {
    console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, tablesMentioned }, null, 2));
    return;
  }

  const separator = `${'─'.repeat(80)}`;

  console.log(`\n${separator}`);
  console.log(`${C.b}REPORTE DE SINCRONIZACIÓN SCHEMA ↔ CÓDIGO${C.x}`);
  console.log(separator);

  // Resumen por tabla
  const byTable = {};
  for (const e of errors) {
    const t = e.message.match(/'([^']+)'/)?.[1] || 'desconocida';
    if (!byTable[t]) byTable[t] = [];
    byTable[t].push(e);
  }

  if (errors.length === 0) {
    console.log(`\n${C.g}[OK]  Sin errores de sincronización. El código coincide con el schema real.${C.x}\n`);
  } else {
    console.log(`\n${C.r}[FAIL]  ${errors.length} error(es) encontrado(s):${C.x}\n`);

    // Agrupar por archivo
    const byFile = {};
    for (const e of errors) {
      if (!byFile[e.file]) byFile[e.file] = [];
      byFile[e.file].push(e);
    }

    for (const [file, errs] of Object.entries(byFile)) {
      console.log(`  ${C.y}${file}${C.x}`);
      for (const e of errs) {
        console.log(`     ${C.r}[${e.kind.toUpperCase()} L${e.line}]${C.x} ${e.message}`);
        if (FLAG_HINTS && e.hint) {
          console.log(`     ${C.c}  → ${e.hint}${C.x}`);
        }
      }
      console.log('');
    }
  }

  if (warnings.length > 0) {
    console.log(`${C.y}⚠  ${warnings.length} advertencia(s):${C.x}`);
    for (const w of warnings)
      console.log(`  ${C.y}[${w.kind} L${w.line}] ${w.file}: ${w.message}${C.x}`);
    console.log('');
  }

  // Tablas escaneadas
  console.log(`${separator}`);
  console.log(`${C.w}Tablas/RPCs referenciadas en el código (${tablesMentioned.length}):${C.x}`);
   console.log(`  ${tablesMentioned.join(', ')}`);
  console.log(`${separator}\n`);

  // Exit code para CI
  process.exit(errors.length > 0 ? 1 : 0);
}


// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    die('Faltan env vars: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas.\n' +
        'Uso: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhb... node scripts/check-schema.js');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Obtener schema real
  const [schema, functions] = await Promise.all([
    fetchRealSchema(supabase),
    fetchRealFunctions(supabase),
  ]);

  log(`   RPCs disponibles: ${functions.size}`);

  // 2. Recolectar archivos JS
  const root    = FLAG_DIR;
  const allFiles = [];
  for (const d of SCAN_DIRS) {
    allFiles.push(...collectFiles(join(root, d)));
  }

  log(`\n${C.c}Escaneando ${allFiles.length} archivos JS en:${C.x}`);
  for (const d of SCAN_DIRS) log(`   • ${d}`);

  // 3. Extraer referencias
  const allRefs = [];
  for (const file of allFiles) {
    const src  = readFileSync(file, 'utf8');
    const refs = extractReferences(src, file);
    allRefs.push(...refs);
  }
  log(`   ${allRefs.length} referencias encontradas`);

  // 4. Validar
  const result = validate(allRefs, schema, functions);

  // 5. Reportar
  report(result, allRefs);
}

main().catch(err => {
  console.error(`${C.r}Error fatal: ${err.message}${C.x}`);
  process.exit(1);
});
