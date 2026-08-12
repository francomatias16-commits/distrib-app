#!/usr/bin/env node
/**
 * check-handler-dispatch.js — Capa C del cableado de punta a punta:
 *
 *   frontend fetch(?accion=X)  →  vercel.json (rewrite, fija o pasa accion)
 *      →  api/index.js (_mod)  →  DENTRO del handler: ¿existe algo que
 *         reaccione al valor "X" de accion/_svc/recurso/tipo/_ruta?
 *
 * Es HEURÍSTICO, no una prueba formal: comprueba que el valor literal (ej.
 * "abrir-turno") aparezca como string en el código fuente del handler que
 * recibe ese _mod. Si el valor no aparece en ningún lado del handler, es
 * una señal fuerte de que esa acción no está manejada (cae a un default /
 * 404 en runtime) — pero por ser basado en texto, puede haber falsos
 * negativos (valor armado dinámicamente) o falsos positivos (el string
 * aparece en un comentario). Sirve para priorizar dónde mirar a mano, no
 * para reemplazar los tests de tests/handlers/.
 *
 * Claves de dispatch reconocidas (las mismas que documenta el comentario
 * de cabecera de api/index.js): _ruta, _svc, accion, recurso, tipo.
 *
 * Uso:
 *   node scripts/check-handler-dispatch.js
 *   node scripts/check-handler-dispatch.js --json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JSON_MODE = process.argv.includes('--json');
function log(...a) { if (!JSON_MODE) console.log(...a); }

const DISPATCH_KEYS = ['_ruta', '_svc', 'accion', 'recurso', 'tipo'];

// ── vercel.json rewrites (/api/*) ───────────────────────────────────────────
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = (vercelConfig.rewrites || []).filter(r => r.source.startsWith('/api/'));
const compiledRewrites = rewrites.map(r => ({ ...r, regex: new RegExp('^' + r.source + '$') }));

function parseQueryString(qs) {
  const params = {};
  if (!qs) return params;
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v !== undefined ? decodeURIComponent(v) : '';
  }
  return params;
}

// ── HANDLERS map (mod → nombre de archivo de handler) ──────────────────────
// Reconstruimos el mapeo mod→archivo leyendo los imports de api/index.js
// (mismo criterio que check-api-wiring.js, pero acá necesitamos el PATH del
// archivo, no solo si la clave existe).
const dispatcherSrc = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
const importRe = /import\s+(\w+)\s+from\s+['"]\.\.\/lib\/handlers\/([^'"]+)['"]/g;
const varToFile = {};
let im;
while ((im = importRe.exec(dispatcherSrc))) {
  varToFile[im[1]] = im[2]; // ej: automatizacion -> automatizacion.js
}
const handlersBlockMatch = dispatcherSrc.match(/const HANDLERS = \{([\s\S]*?)\n\};/);
const modToFile = {};
for (const line of handlersBlockMatch[1].split('\n')) {
  const quoted = line.match(/^\s*['"]([a-z0-9-]+)['"]\s*:\s*(\w+)/);
  const bare = line.match(/^\s*([a-zA-Z][a-zA-Z0-9]*)\s*,?\s*(\/\/.*)?$/);
  if (quoted && varToFile[quoted[2]]) modToFile[quoted[1]] = varToFile[quoted[2]];
  else if (bare && varToFile[bare[1]]) modToFile[bare[1]] = varToFile[bare[1]];
}

// ── Extraer fetch('/api/...') del frontend, CON su query string completa ──
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
const FETCH_RE = /fetch\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;

// mod -> Map(dispatchKey -> Set(valores) con origen)
const dispatchUsage = {};

function registerDispatch(mod, key, value, origin) {
  if (!mod || !key || value === undefined || value === '') return;
  if (!dispatchUsage[mod]) dispatchUsage[mod] = {};
  if (!dispatchUsage[mod][key]) dispatchUsage[mod][key] = new Map();
  if (!dispatchUsage[mod][key].has(value)) dispatchUsage[mod][key].set(value, []);
  dispatchUsage[mod][key].get(value).push(origin);
}

for (const jsFile of jsFiles) {
  const relJs = '/' + path.relative(ROOT, jsFile).replace(/\\/g, '/');
  const src = fs.readFileSync(jsFile, 'utf8');
  let m;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src))) {
    const raw = m[1];
    const [rawPath, rawQuery] = raw.split('?');
    const normalizedPath = rawPath.replace(/\$\{[^}]*\}/g, '__DYNAMIC__');
    const rewrite = compiledRewrites.find(r => r.regex.test(normalizedPath));
    if (!rewrite) continue; // ya lo reporta check-api-wiring.js

    const modMatch = rewrite.destination.match(/[?&]_mod=([a-z0-9-]+)/);
    if (!modMatch) continue;
    const mod = modMatch[1];

    // 1) Params fijos en el destination del rewrite (ganan siempre).
    const destParams = parseQueryString(rewrite.destination.split('?')[1]);
    for (const key of DISPATCH_KEYS) {
      if (destParams[key]) registerDispatch(mod, key, destParams[key], relJs);
    }

    // 2) Params propios de la URL que pidió el frontend — solo aplican si
    //    el rewrite NO los fija ya (si los fija, el valor real es el fijo).
    const ownParams = parseQueryString(rawQuery);
    for (const key of DISPATCH_KEYS) {
      if (destParams[key]) continue; // ya fijado por el rewrite, no por el frontend
      const val = ownParams[key];
      if (val && !val.includes('${') && !val.includes('__DYNAMIC__')) {
        registerDispatch(mod, key, val, relJs);
      }
    }
  }
}

// ── Verificar que cada valor aparezca como string en el handler ────────────
const problems = [];
let totalChecked = 0;

// lib/handlers/*.js frecuentemente delega sub-rutas a otro archivo del mismo
// directorio (ej: proveedores.js → portal_proveedor.js para _svc=portal*).
// Sin seguir esos imports, cualquier valor manejado en el archivo delegado
// se reportaría como falso positivo "sin manejar". Resolvemos, por cada
// handler, el set de archivos relevantes: el propio + todo lo que importe
// desde './algo.js' o '../handlers/algo.js' dentro de lib/handlers/.
const LOCAL_IMPORT_RE = /from\s+['"](\.\/[^'"]+\.js|\.\.\/handlers\/[^'"]+\.js)['"]/g;

function resolveRelevantSources(handlerFile) {
  const handlerDir = path.join(ROOT, 'lib/handlers');
  const visited = new Set();
  const queue = [handlerFile];
  let combined = '';
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const filePath = path.join(handlerDir, file);
    if (!fs.existsSync(filePath)) continue;
    const src = fs.readFileSync(filePath, 'utf8');
    combined += '\n' + src;
    let im;
    LOCAL_IMPORT_RE.lastIndex = 0;
    while ((im = LOCAL_IMPORT_RE.exec(src))) {
      const rel = im[1].replace(/^\.\.\/handlers\//, './').replace(/^\.\//, '');
      queue.push(rel);
    }
  }
  return combined;
}

for (const [mod, keys] of Object.entries(dispatchUsage)) {
  const handlerFile = modToFile[mod];
  if (!handlerFile) continue; // ya lo reporta check-api-wiring.js
  if (!fs.existsSync(path.join(ROOT, 'lib/handlers', handlerFile))) continue;
  const combinedSrc = resolveRelevantSources(handlerFile);

  for (const [key, values] of Object.entries(keys)) {
    for (const [value, origins] of values) {
      totalChecked++;
      const literalSingle = `'${value}'`;
      const literalDouble = `"${value}"`;
      const found = combinedSrc.includes(literalSingle) || combinedSrc.includes(literalDouble);
      if (!found) {
        problems.push({ mod, handlerFile, key, value, origins: [...new Set(origins)] });
      }
    }
  }
}

// ── Reporte ──────────────────────────────────────────────────────────────────
log(`\nCheck de dispatch interno (heurístico): ${totalChecked} combinaciones mod+${DISPATCH_KEYS.join('/')} usadas por el frontend\n`);

if (problems.length === 0) {
  log('  [OK] Todos los valores de dispatch usados por el frontend aparecen en el handler correspondiente.');
} else {
  for (const p of problems) {
    log(`  [WARN] _mod="${p.mod}" (lib/handlers/${p.handlerFile}) — "${p.key}=${p.value}" no aparece como literal en el handler`);
    for (const o of p.origins) log(`         usado desde ${o}`);
  }
}

const line = '─'.repeat(70);
if (JSON_MODE) {
  console.log(JSON.stringify({ totalChecked, problems }, null, 2));
} else {
  console.log(`\n${line}`);
  console.log('CHECK DE DISPATCH INTERNO (heurístico) — Resultado');
  console.log(line);
  console.log(`  Combinaciones revisadas : ${totalChecked}`);
  console.log(`  Posibles sin manejar    : ${problems.length}`);
  if (problems.length > 0) {
    console.log('\n  Esto es una SEÑAL, no una prueba — revisar a mano antes de asumir que está roto.\n');
  } else {
    console.log('\n[OK] Sin señales de dispatch interno faltante.\n');
  }
}

// Nota: este check es heurístico por diseño (falsos positivos posibles), así
// que no rompe el build — informa con exit 0 siempre. Si se vuelve confiable
// con el tiempo (ej: 0 falsos positivos sostenidos), se puede endurecer a
// exit 1 cuando problems.length > 0.
process.exit(0);
