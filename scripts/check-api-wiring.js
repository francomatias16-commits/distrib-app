#!/usr/bin/env node
/**
 * check-api-wiring.js — Verifica el cableado de punta a punta entre:
 *
 *   frontend (fetch a /api/...)  →  vercel.json (rewrite)  →  api/index.js (HANDLERS[_mod])
 *
 * Dos chequeos:
 *
 *   A) Cada fetch('/api/...') encontrado en frontend/**\/*.js debe matchear
 *      al menos un rewrite de vercel.json. Si no matchea ninguno, esa
 *      llamada da 404 en producción sin importar que el handler exista.
 *
 *   B) Cada rewrite de vercel.json cuyo destination apunte a
 *      /api/index?_mod=X debe tener una entrada `X` en el objeto HANDLERS
 *      de api/index.js. Si falta, ese endpoint responde 404 "Módulo de API
 *      desconocido" sin importar que el rewrite y el fetch estén bien.
 *
 * Lo que NO cubre (fuera del alcance de un check estático):
 *   - El sub-ruteo DENTRO de cada handler (_svc, accion, recurso, etc.) —
 *     eso lo verían los tests de handlers en tests/handlers/.
 *   - Que el handler llame a la tabla/repo correcta — eso lo ven los tests
 *     de tests/repos/ y tests/handlers/.
 *   - Comportamiento en runtime — eso lo ven los e2e de Playwright.
 *
 * Uso:
 *   node scripts/check-api-wiring.js
 *   node scripts/check-api-wiring.js --json
 *
 * Exit 0 si todo cablea, exit 1 si hay algo roto.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JSON_MODE = process.argv.includes('--json');
function log(...a) { if (!JSON_MODE) console.log(...a); }

// ── Cargar vercel.json ──────────────────────────────────────────────────────
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = (vercelConfig.rewrites || []).filter(r => r.source.startsWith('/api/'));
const compiledRewrites = rewrites.map(r => ({
  ...r,
  regex: new RegExp('^' + r.source + '$'),
}));

// ── Cargar el objeto LOADERS de api/index.js (parseo del bloque, sin import
//    dinámico, para no necesitar env vars / Supabase real solo para listar
//    claves) ───────────────────────────────────────────────────────────────
// FIX v861: HANDLERS (imports estáticos + objeto de referencias) pasó a
// LOADERS (imports perezosos, `clave: () => import('.../archivo.js')`) para
// arreglar el cold start del lambda. Cada entrada ahora trae la clave Y el
// archivo en la misma línea — este check solo necesita la clave.
const dispatcherSrc = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
const handlersBlockMatch = dispatcherSrc.match(/const LOADERS = \{([\s\S]*?)\n\};/);
if (!handlersBlockMatch) {
  console.error('[FAIL] No se pudo encontrar el bloque `const LOADERS = { ... }` en api/index.js');
  process.exit(1);
}
const handlersBlock = handlersBlockMatch[1];
// Cada entrada es `nombre: () => import(...)` o `'nombre-con-guion': () => import(...)`.
const handlerKeys = new Set();
for (const line of handlersBlock.split('\n')) {
  const m = line.match(/^\s*(?:'([a-z0-9-]+)'|([a-zA-Z][a-zA-Z0-9]*))\s*:/);
  if (m) handlerKeys.add(m[1] || m[2]);
}

// ── A) frontend fetch → rewrite ─────────────────────────────────────────────
function findJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const jsFiles = findJsFiles(path.join(ROOT, 'frontend')).sort();

// Matchea fetch('/api/...'), fetch("/api/..."), fetch(`/api/...`)
const FETCH_RE = /fetch\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;

// Encontrado en producción (2026-08-28): un comentario en sw-admin.js que
// menciona literalmente `fetch('/api/...')` como ejemplo de texto se
// detectaba como llamada real y tiraba un falso [FAIL]. Se despoja el
// contenido de comentarios `//` y `/* */` antes de escanear — heurística
// simple (no distingue un `//` dentro de un string), suficiente para este
// check estático, cuyo alcance ya está documentado como no exhaustivo.
function despojarComentarios(codigo) {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(linea => linea.replace(/\/\/.*$/, ''))
    .join('\n');
}

const frontendCalls = []; // { file, raw, normalized }

for (const jsFile of jsFiles) {
  const relJs = '/' + path.relative(ROOT, jsFile).replace(/\\/g, '/');
  const src = despojarComentarios(fs.readFileSync(jsFile, 'utf8'));
  let m;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src))) {
    const raw = m[1];
    // Los segmentos dinámicos `${...}` se reemplazan por un placeholder
    // literal para poder testearlos contra los rewrites con grupos (.*).
    const normalized = raw
      .replace(/\$\{[^}]*\}/g, '__DYNAMIC__')
      .split('?')[0]; // la query string no participa del matching de rewrites
    frontendCalls.push({ file: relJs, raw, normalized });
  }
}

const brokenFrontendCalls = [];
for (const call of frontendCalls) {
  const matched = compiledRewrites.some(r => r.regex.test(call.normalized));
  if (!matched) brokenFrontendCalls.push(call);
}

// ── B) rewrite → HANDLERS[_mod] ─────────────────────────────────────────────
const brokenRewrites = [];
for (const r of rewrites) {
  const modMatch = r.destination.match(/[?&]_mod=([a-z0-9-]+)/);
  if (!modMatch) continue; // rewrite de /api/* que no pasa por el dispatcher (no debería existir, pero no es de este check)
  const mod = modMatch[1];
  if (!handlerKeys.has(mod)) {
    brokenRewrites.push({ source: r.source, destination: r.destination, mod });
  }
}

// ── Reporte ──────────────────────────────────────────────────────────────────
log(`\nCheck de cableado API: ${jsFiles.length} archivos JS, ${frontendCalls.length} llamadas a /api/*, ${rewrites.length} rewrites de /api/*, ${handlerKeys.size} módulos en HANDLERS\n`);

log('── A) fetch() del frontend sin rewrite que lo resuelva ──');
if (brokenFrontendCalls.length === 0) {
  log('  [OK] Todas las llamadas fetch(\'/api/...\') matchean al menos un rewrite.');
} else {
  for (const c of brokenFrontendCalls) {
    log(`  [FAIL] ${c.file}`);
    log(`         fetch('${c.raw}')  →  normalizado: '${c.normalized}'  — NINGÚN rewrite lo matchea`);
  }
}

log('\n── B) rewrites de vercel.json cuyo _mod no existe en HANDLERS ──');
if (brokenRewrites.length === 0) {
  log('  [OK] Todo _mod referenciado en vercel.json existe en HANDLERS de api/index.js.');
} else {
  for (const r of brokenRewrites) {
    log(`  [FAIL] ${r.source}  →  ${r.destination}`);
    log(`         _mod="${r.mod}" no está en HANDLERS de api/index.js`);
  }
}

const totalBroken = brokenFrontendCalls.length + brokenRewrites.length;
const line = '─'.repeat(70);

if (JSON_MODE) {
  console.log(JSON.stringify({
    frontendCallsChecked: frontendCalls.length,
    brokenFrontendCalls,
    rewritesChecked: rewrites.length,
    brokenRewrites,
  }, null, 2));
} else {
  console.log(`\n${line}`);
  console.log('CHECK DE CABLEADO API — Resultado');
  console.log(line);
  console.log(`  fetch() rotos (sin rewrite)      : ${brokenFrontendCalls.length}`);
  console.log(`  rewrites rotos (sin handler)      : ${brokenRewrites.length}`);
  if (totalBroken === 0) {
    console.log('\n[OK] Cableado frontend → rewrite → handler verificado end-to-end.\n');
  } else {
    console.log('\nRevisar los detalles arriba.\n');
  }
}

process.exit(totalBroken > 0 ? 1 : 0);
