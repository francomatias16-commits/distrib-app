#!/usr/bin/env node
/**
 * smoke-test-frontend.js — Verifica que todas las páginas del admin carguen
 * ui-utils.js antes de usarla, y detecta cualquier global de ui-utils.js
 * referenciada en un .js cuya .html no carga el script.
 *
 * NO necesita un browser ni Supabase — solo lee los archivos del proyecto.
 * Se corre en < 1 segundo antes de cada deploy.
 *
 * Uso (desde la raíz del proyecto):
 *   node scripts/smoke-test-frontend.js
 *   node scripts/smoke-test-frontend.js --dir ./frontend/admin
 *   node scripts/smoke-test-frontend.js --fix   ← agrega ui-utils.js donde falta
 *
 * Exit 0 si todo OK, exit 1 si hay problemas.
 */

import fs   from 'fs';
import path from 'path';

// ── Args ──────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const dirIdx   = args.findIndex(a => a === '--dir');
const dirEq    = args.find(a => a.startsWith('--dir='));
const ADMIN_DIR = dirEq
  ? dirEq.slice(6)
  : dirIdx >= 0
    ? args[dirIdx + 1]
    : './frontend/admin';
const FIX_MODE = args.includes('--fix');
const QUIET    = args.includes('--quiet');

// ── Globals exportados por ui-utils.js ───────────────────────────────────────
// Actualizar esta lista si se agregan más exports a ui-utils.js
const UI_UTILS_GLOBALS = [
  'window.toast',
  'window.formatARS',
  'window.formatFecha',
  'window.formatHora',
  'window.renderTbody',
  'window.renderFragment',
  'window.mostrarSkeletonTabla',
  'window.renderSkeletonTabla',
  'window.loadingStart',
  'window.loadingEnd',
  'window.confirmar',
  'window.btnAsyncClick',
  'window.syncTabAria',
  'window.mostrarEstadoVacio',
];

const GLOBALS_REGEX = new RegExp(
  UI_UTILS_GLOBALS.map(g => g.replace('.', '\\.')).join('|')
);

function log(...a) { if (!QUIET) console.log(...a); }

// ── Leer páginas ──────────────────────────────────────────────────────────────
if (!fs.existsSync(ADMIN_DIR)) {
  console.error(`[FAIL] Directorio no encontrado: ${ADMIN_DIR}`);
  console.error(`   Usá: node scripts/smoke-test-frontend.js --dir ./frontend/admin`);
  process.exit(1);
}

const htmlFiles = fs.readdirSync(ADMIN_DIR)
  .filter(f => f.endsWith('.html'))
  .sort()
  .map(f => ({
    name:     f.replace('.html', ''),
    htmlPath: path.join(ADMIN_DIR, f),
    jsPath:   path.join(ADMIN_DIR, 'js', f.replace('.html', '.js')),
    // 25/08/2026: si el JS de la página se partió en varios archivos (ver
    // pos.js → js/pos/*.js), el "JS propio" vive en un directorio con el
    // nombre de la página en vez de un único archivo — sin esto, el check
    // de globals se saltea en silencio para esas páginas (falso "sin JS
    // propio"), igual que pasó antes con el falso positivo de liquidacion.html.
    jsDirPath: path.join(ADMIN_DIR, 'js', f.replace('.html', '')),
  }));

log(`\nSmoke test: ${htmlFiles.length} páginas en ${ADMIN_DIR}\n`);

// ── Analizar ──────────────────────────────────────────────────────────────────
const issues = [];
const fixed  = [];
const ok     = [];

for (const page of htmlFiles) {
  const html = fs.readFileSync(page.htmlPath, 'utf8');

  // Redirect: saltar. Cubre tanto `window.location.replace(...)` como el
  // `location.replace(...)` sin prefijo (mismo objeto global — equivalente
  // en cualquier browser, pero el checker original solo reconocía la forma
  // con `window.`, lo que producía un falso positivo en liquidacion.html:
  // el checker terminaba comparando la página contra js/liquidacion.js, un
  // archivo que esa página ni siquiera carga — el que lo carga de verdad es
  // vencimientos.html, que sí tiene ui-utils.js).
  if (/(?:window\.)?location\.replace\(/.test(html) ||
      html.includes('meta http-equiv="refresh"')) {
    log(`  ⏭  ${page.name} (redirect)`);
    continue;
  }

  const loadsUiUtils = html.includes('ui-utils.js');

  // JS propio partido en varios archivos (directorio js/<page>/*.js):
  // concatenar todos para el check de globals, igual que si fuera un
  // único archivo.
  let js = null;
  if (fs.existsSync(page.jsPath)) {
    js = fs.readFileSync(page.jsPath, 'utf8');
  } else if (fs.existsSync(page.jsDirPath) && fs.statSync(page.jsDirPath).isDirectory()) {
    js = fs.readdirSync(page.jsDirPath)
      .filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(page.jsDirPath, f), 'utf8'))
      .join('\n');
  }

  // Sin JS propio: saltar check de globals
  if (js === null) {
    log(`  ⏭  ${page.name} (sin JS propio)`);
    continue;
  }

  const usesGlobals = GLOBALS_REGEX.test(js);

  if (!usesGlobals) {
    log(`  [OK] ${page.name} (no usa globals de ui-utils)`);
    ok.push(page.name);
    continue;
  }

  if (loadsUiUtils) {
    log(`  [OK] ${page.name}`);
    ok.push(page.name);
    continue;
  }

  // ❌ Usa globals pero no carga ui-utils.js
  const calls = (js.match(GLOBALS_REGEX) || []).length;

  if (FIX_MODE) {
    const navMatch = html.match(/<script[^>]*nav\.js[^>]*><\/script>/);
    if (navMatch) {
      const vMatch = navMatch[0].match(/\?v(\d+)/);
      const ver    = vMatch ? `?v${vMatch[1]}` : '';
      const uiTag  = `<script src="/frontend/admin/js/ui-utils.js${ver}"></script>`;
      const patched = html.replace(navMatch[0], `${navMatch[0]}\n  ${uiTag}`);
      fs.writeFileSync(page.htmlPath, patched, 'utf8');
      fixed.push(page.name);
      log(`  FIXED ${page.name} (${calls} llamadas → ui-utils.js agregado)`);
      ok.push(page.name);
    } else {
      issues.push({ page: page.name, calls, detail: 'nav.js no encontrado — fix manual' });
      log(`  [FAIL] ${page.name} — fix manual requerido (no se encontró nav.js)`);
    }
  } else {
    issues.push({ page: page.name, calls });
    log(`  [FAIL] ${page.name} — ${calls} uso(s) de globals, falta <script src="ui-utils.js">`);
  }
}

// ── Reporte ───────────────────────────────────────────────────────────────────
const line = '─'.repeat(60);
console.log(`\n${line}`);
console.log('SMOKE TEST FRONTEND — Resultado');
console.log(line);
console.log(`  [OK] OK         : ${ok.length}`);
if (fixed.length)   console.log(`  Reparadas  : ${fixed.length} (${fixed.join(', ')})`);
if (issues.length)  console.log(`  [FAIL] Problemas  : ${issues.length}`);

if (issues.length > 0) {
  console.log('\nPáginas con problema:');
  for (const i of issues) {
    console.log(`  • ${i.page} — ${i.calls} llamadas a globals sin ui-utils.js`);
    if (i.detail) console.log(`    ↳ ${i.detail}`);
  }
  console.log('\nCorregir: agregar <script src="ui-utils.js"> después de nav.js');
  console.log('O correr con --fix para aplicarlo automáticamente.\n');
  process.exit(1);
} else {
  console.log('\n[OK] Todo OK — ninguna página usa globals sin cargar ui-utils.js.\n');
  process.exit(0);
}
