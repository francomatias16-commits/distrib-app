#!/usr/bin/env node
/**
 * audit-bridges-window.js — Etapa 0.2 del Plan de Auditoría Funcional
 * Pre-Lanzamiento 2026.
 *
 * Clase de bug que ya mordió en producción (v798): un JS se carga con
 * `type="module"`, por lo que sus funciones top-level NO quedan expuestas
 * en `window`. Cualquier `onclick=""` / `onchange=""` / etc. inline en el
 * HTML (o generado dinámicamente desde un template string dentro del JS,
 * ej. filas de tabla) corre en scope global del navegador y necesita un
 * bridge explícito (`window.fn = fn;`) para encontrar la función. Si el
 * bridge falta, el botón "no hace nada" — sin error visible salvo que se
 * abra la consola.
 *
 * Qué hace:
 *   1. Recorre cada página HTML de los 4 portales (admin/cliente/chofer/
 *      proveedor) y arma, por página, el conjunto de "nombres disponibles
 *      en window" a partir de TODOS los <script> que la página carga:
 *        - Si el script es classic (sin type="module"): sus declaraciones
 *          top-level (function/const/let/var) son global automáticamente.
 *        - Si el script es type="module": SOLO cuentan sus
 *          `window.algo = ...` explícitos.
 *   2. Extrae cada llamada a función usada en atributos on* — tanto las
 *      que están escritas directo en el HTML como las que un JS arma
 *      dentro de un template string (filas de tabla, cards dinámicas).
 *   3. Marca como "posible bridge roto" toda llamada cuyo nombre no
 *      resuelve a ningún nombre disponible en el scope de esa página (y
 *      no es un builtin del navegador/JS).
 *
 * Limitaciones conocidas (es un piso, no un techo — igual que
 * audit-funciones-fantasma.js):
 *   - Heurística por texto/regex, no un parser de JS real. Un handler
 *     armado con interpolación total o parcial del nombre de función
 *     (`onclick="${accion}(...)"`, `onclick="exportarExcel_${tipo}(...)"`)
 *     no se puede resolver estáticamente y se ignora silenciosamente (no
 *     genera falso positivo, pero tampoco cobertura — revisar ese patrón a
 *     mano si se toca un archivo que lo usa).
 *   - Las llamadas dentro de `${...}` en un template literal (evaluadas en
 *     scope JS normal al construir el string, ej.
 *     `onclick="algo(${escOnclickArg(nombre)})"`) se excluyen a propósito:
 *     no corren en scope global del navegador y no necesitan `window.X=`.
 *   - Se ignoran comentarios (`//...` y `/* ... *\/`) al buscar llamadas
 *     embebidas en un JS, para no matchear ejemplos citados en comentarios
 *     explicativos. Un `window.X =` DENTRO de un comentario (código
 *     deshabilitado) igual cuenta como bridge presente — no se filtra ahí
 *     a propósito, ya que distinguir "comentado a propósito" de "código
 *     real" de forma confiable requeriría un parser completo.
 *   - "Top-level" para scripts classic se aproxima por indentación cero;
 *     una función definida con indentación dentro de un IIFE puede dar
 *     falso positivo — revisar a mano antes de tocar código.
 *   - No distingue si una página carga el MISMO script dos veces con tipos
 *     distintos (no debería pasar, pero si pasa se prioriza module).
 *
 * Uso:
 *   node scripts/audit-bridges-window.js
 *   node scripts/audit-bridges-window.js --json
 *   node scripts/audit-bridges-window.js --portal=admin
 *
 * Exit 0 si no hay bridges rotos, exit 1 si hay al menos uno.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JSON_MODE = process.argv.includes('--json');
const PORTAL_FILTER = (process.argv.find(a => a.startsWith('--portal=')) || '').slice(9) || null;

function log(...a) { if (!JSON_MODE) console.log(...a); }

const C = JSON_MODE ? { r: '', g: '', y: '', x: '', b: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', x: '\x1b[0m',
};

// ── vercel.json rewrites, para resolver <script src="/frontend/..."> igual
//    que check-asset-wiring.js (misma fuente de verdad, no una copia). ──────
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = (vercelConfig.rewrites || []).map(r => ({
  regex: new RegExp('^' + r.source + '$'),
  destination: r.destination,
}));

function resolveViaRewrites(urlPath) {
  for (const { regex, destination } of rewrites) {
    const m = urlPath.match(regex);
    if (!m) continue;
    let dest = destination;
    for (let i = 1; i < m.length; i++) dest = dest.replace(`$${i}`, m[i] ?? '');
    return dest;
  }
  return null;
}

function resolveScriptSrc(src) {
  const withoutQuery = src.split('?')[0].split('#')[0];
  if (!withoutQuery.startsWith('/') || withoutQuery.startsWith('//')) return null; // externo (CDN)
  const finalPath = resolveViaRewrites(withoutQuery) ?? withoutQuery;
  if (finalPath.startsWith('/api/')) return null;
  const diskPath = path.join(ROOT, finalPath);
  return fs.existsSync(diskPath) && fs.statSync(diskPath).isFile() ? diskPath : null;
}

// ── Portales a auditar ──────────────────────────────────────────────────────
const PORTALES = {
  admin:     path.join(ROOT, 'frontend', 'admin'),
  cliente:   path.join(ROOT, 'frontend', 'cliente'),
  chofer:    path.join(ROOT, 'frontend', 'chofer'),
  proveedor: path.join(ROOT, 'frontend', 'proveedor'),
};

function findHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.html'))
    .map(e => path.join(dir, e.name))
    .sort();
}

// ── Builtins / globales de plataforma que nunca van a tener un window.X=
//    propio en el repo — evita ruido. ───────────────────────────────────────
const BUILTINS = new Set([
  'alert', 'confirm', 'prompt', 'console', 'fetch', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone',
  'Date', 'Array', 'Object', 'JSON', 'Math', 'Number', 'String', 'Boolean',
  'RegExp', 'Promise', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol',
  'Proxy', 'Reflect', 'Intl', 'FormData', 'URLSearchParams', 'URL', 'Blob',
  'File', 'FileReader', 'Image', 'Audio', 'Notification', 'Worker',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'return', 'typeof', 'void', 'delete', 'new', 'await', 'yield', 'if', 'else',
  'this', 'event', 'window', 'document', 'navigator', 'location', 'history',
  'async', 'function', 'class', 'catch', 'while', 'for', 'switch', 'do',
  'try', 'finally', 'in', 'of', 'instanceof',
]);

// ── Regex de handlers inline: on<evento>="..." / on<evento>='...' — también
//    matchea la variante con comillas escapadas (\") típica de template
//    strings JS que arman HTML como texto. ───────────────────────────────────
const HANDLER_ATTRS = new Set([
  'click', 'change', 'input', 'submit', 'keyup', 'keydown', 'keypress',
  'focus', 'blur', 'dblclick', 'mouseover', 'mouseout', 'mouseenter',
  'mouseleave', 'drop', 'dragover', 'dragstart', 'dragend', 'contextmenu',
  'touchstart', 'touchend', 'reset', 'toggle',
]);
const HANDLER_RE = /\bon([a-zA-Z]+)\s*=\s*\\?(["'])([\s\S]*?)\\?\2/g;

// Dentro de un template literal, `${...}` se evalúa en el scope JS normal
// donde se CONSTRUYE el string (ej. dentro del propio módulo), no en el
// scope global del navegador donde corre el onclick ya resuelto. Una llamada
// como `onclick="algo(${escOnclickArg(nombre)})"` no necesita bridge para
// `escOnclickArg` — su resultado ya viene resuelto a texto plano antes de
// llegar al DOM. Se eliminan esos tramos (balanceando llaves) antes de
// buscar llamadas "reales" de handler.
function stripTemplateInterpolations(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '$' && str[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < str.length && depth > 0) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') depth--;
        i++;
      }
      i--; // compensar el for loop
      // Separador no-identificador: si el tramo interpolado era un SUFIJO
      // de un nombre de función (ej. `exportarExcel_${tipo}(...)`), evita
      // que el prefijo quede pegado al `(` siguiente y se lea como una
      // llamada real a `exportarExcel_`. Con esto la llamada de nombre
      // parcialmente dinámico queda no-resoluble y se ignora (mismo criterio
      // documentado para nombres 100% interpolados), en vez de generar un
      // falso positivo con un nombre inventado.
      out += '\u0001';
      continue;
    }
    out += str[i];
  }
  return out;
}

function extractHandlerCalls(text) {
  const calls = []; // { fn, attr }
  let m;
  HANDLER_RE.lastIndex = 0;
  while ((m = HANDLER_RE.exec(text))) {
    const attr = m[1].toLowerCase();
    if (!HANDLER_ATTRS.has(attr)) continue;
    const body = stripTemplateInterpolations(m[3]);
    // Llamadas "sueltas" (no precedidas por '.', que sería método de objeto).
    const callRe = /(?:^|[;,\s(!&|={}:?\[])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(body))) {
      const fn = cm[1];
      if (BUILTINS.has(fn)) continue;
      calls.push({ fn, attr });
    }
  }
  return calls;
}

// Quita líneas que son comentario puro (`//...`) y bloques `/* ... */` antes
// de buscar handlers embebidos en un archivo JS — evita falsos positivos de
// comentarios que citan un patrón `onclick="funcion(...)"` a modo de
// explicación (ver clientes.js, comparador-precios.js, riesgo-cheques.js).
function stripJsComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .map(line => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
}

// ── Parseo heurístico de un archivo JS: nombres top-level (classic-global) +
//    asignaciones window.X= (siempre global, sea module o classic). ─────────
const jsCache = new Map(); // diskPath -> { topLevel:Set, windowAssigned:Set, embeddedCalls:[{fn,attr}] }

function parseJsFile(diskPath) {
  if (jsCache.has(diskPath)) return jsCache.get(diskPath);
  const src = fs.readFileSync(diskPath, 'utf8');

  const topLevel = new Set();
  // function nombre(...)  al inicio de línea (indentación cero, con o sin
  // "export"/"async" delante).
  const reFnDecl = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
  let m;
  while ((m = reFnDecl.exec(src))) topLevel.add(m[1]);
  // const/let/var nombre = ... (arrow o function expr), indentación cero.
  const reVarDecl = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/gm;
  while ((m = reVarDecl.exec(src))) topLevel.add(m[1]);

  const windowAssigned = new Set();
  const reWindowAssign = /\bwindow\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  while ((m = reWindowAssign.exec(src))) windowAssigned.add(m[1]);

  const embeddedCalls = extractHandlerCalls(stripJsComments(src));

  const result = { topLevel, windowAssigned, embeddedCalls };
  jsCache.set(diskPath, result);
  return result;
}

// ── <script> tags de una página: src (resuelto) + si es module, y bloques
//    inline. ──────────────────────────────────────────────────────────────
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;

function extractScripts(html) {
  const scripts = []; // { src?: diskPath, inline?: string, isModule }
  let m;
  SCRIPT_TAG_RE.lastIndex = 0;
  while ((m = SCRIPT_TAG_RE.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    const srcMatch = attrs.match(SRC_ATTR_RE);
    if (srcMatch) {
      const diskPath = resolveScriptSrc(srcMatch[1]);
      if (diskPath) scripts.push({ src: diskPath, isModule });
      // Si no resuelve a disco, ya lo marca check-asset-wiring.js — no es
      // responsabilidad de este script duplicar ese chequeo.
    } else if (body.trim()) {
      scripts.push({ inline: body, isModule });
    }
  }
  return scripts;
}

// ── Auditoría por página ────────────────────────────────────────────────────
function auditPage(htmlFile, portal) {
  const relPage = '/' + path.relative(ROOT, htmlFile).replace(/\\/g, '/');
  const html = fs.readFileSync(htmlFile, 'utf8');

  const available = new Set();       // nombres resolubles en window para esta página
  const allCalls = [];               // { fn, attr, origen }
  const filesInvolved = [relPage];

  // 1) Handlers escritos directo en el HTML.
  for (const c of extractHandlerCalls(html)) allCalls.push({ ...c, origen: relPage });

  // 2) Scripts de la página.
  const scripts = extractScripts(html);
  for (const s of scripts) {
    if (s.src) {
      const relJs = '/' + path.relative(ROOT, s.src).replace(/\\/g, '/');
      filesInvolved.push(relJs);
      const parsed = parseJsFile(s.src);
      for (const w of parsed.windowAssigned) available.add(w);
      if (!s.isModule) for (const t of parsed.topLevel) available.add(t);
      for (const c of parsed.embeddedCalls) allCalls.push({ ...c, origen: relJs });
    } else if (s.inline) {
      // Bloque inline: mismas reglas de module/classic, buscadas sobre el
      // propio texto del bloque.
      const topLevel = new Set();
      const reFnDecl = /^\s*(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
      let mm;
      while ((mm = reFnDecl.exec(s.inline))) topLevel.add(mm[1]);
      const reWindowAssign = /\bwindow\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
      while ((mm = reWindowAssign.exec(s.inline))) available.add(mm[1]);
      if (!s.isModule) for (const t of topLevel) available.add(t);
    }
  }

  const broken = [];
  const seen = new Set();
  for (const call of allCalls) {
    if (available.has(call.fn)) continue;
    const key = `${call.fn}@${call.origen}`;
    if (seen.has(key)) continue;
    seen.add(key);
    broken.push(call);
  }

  return { page: relPage, portal, broken, totalCalls: allCalls.length, filesInvolved };
}

// ── Main ─────────────────────────────────────────────────────────────────
const results = [];
for (const [portal, dir] of Object.entries(PORTALES)) {
  if (PORTAL_FILTER && portal !== PORTAL_FILTER) continue;
  for (const htmlFile of findHtmlFiles(dir)) {
    results.push(auditPage(htmlFile, portal));
  }
}

const brokenPages = results.filter(r => r.broken.length > 0);
const totalBroken = brokenPages.reduce((acc, r) => acc + r.broken.length, 0);
const totalCalls = results.reduce((acc, r) => acc + r.totalCalls, 0);

if (JSON_MODE) {
  console.log(JSON.stringify({
    totalPages: results.length,
    totalCalls,
    totalBroken,
    brokenPages: brokenPages.map(r => ({
      page: r.page, portal: r.portal,
      broken: r.broken.map(b => ({ fn: b.fn, attr: b.attr, origen: b.origen })),
    })),
  }, null, 2));
  process.exit(totalBroken > 0 ? 1 : 0);
}

const line = '─'.repeat(78);
log(line);
log('AUDITORÍA DE BRIDGES window.* — Etapa 0.2 (Plan Funcional Pre-Lanzamiento 2026)');
log(line);
log(`Páginas revisadas: ${results.length}${PORTAL_FILTER ? ` (filtro: --portal=${PORTAL_FILTER})` : ''}`);
log(`Llamadas on* detectadas (HTML + templates JS): ${totalCalls}\n`);

for (const r of results) {
  if (r.broken.length === 0) {
    log(`  ${C.g}[OK]${C.x}   ${r.page}`);
  } else {
    log(`  ${C.r}[FAIL]${C.x} ${r.page}`);
    for (const b of r.broken) {
      log(`         on${b.attr}="${b.fn}(...)"  — sin window.${b.fn} resoluble  (definido/usado en ${b.origen})`);
    }
  }
}

log(`\n${line}`);
if (totalBroken > 0) {
  log(`${C.r}⚠  ${totalBroken} posible(s) bridge(s) roto(s) en ${brokenPages.length} página(s).${C.x}`);
  log('   Revisar a mano cada caso (puede ser falso positivo si la función viene');
  log('   de una lib externa (CDN) no rastreada como asset propio, o si el nombre');
  log('   se arma por interpolación total). Si es real, agregar `window.fn = fn;`');
  log('   junto al resto de los bridges del archivo — mismo patrón que v798.');
} else {
  log(`${C.g}[OK] Ningún bridge roto detectado en los ${results.length} páginas auditadas.${C.x}`);
}
log(line + '\n');

process.exit(totalBroken > 0 ? 1 : 0);
