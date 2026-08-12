#!/usr/bin/env node
/**
 * check-asset-wiring.js — Recorre TODAS las páginas .html de frontend/ y
 * verifica que cada <script src="..."> / <link rel="stylesheet" href="...">
 * interno resuelva a un archivo real, aplicando las MISMAS reglas de rewrite
 * que usa Vercel en producción (leídas directamente de vercel.json, no una
 * copia a mano — así este check nunca queda desincronizado del deploy real).
 *
 * Por qué existe: el bug de offline-core.js en portal.html (404 silencioso
 * porque el rewrite /shared/*.js no estaba replicado en el static-server de
 * test) solo se detectó corriendo un browser real contra una página puntual.
 * Este script agarra esa clase de bug para las ~75 páginas del frontend en
 * milisegundos, sin browser, sin Supabase, sin levantar ningún server —
 * porque una vez que sabemos qué archivo final resuelve cada URL (aplicando
 * los rewrites), verificar que exista es solo un fs.existsSync.
 *
 * NO reemplaza a los tests e2e de Playwright (esos verifican comportamiento
 * en runtime — clicks, sync, IndexedDB). Esto solo verifica que el cableado
 * estático "esta página referencia este asset y el asset existe" es correcto
 * en TODAS las páginas, no solo en las que tienen spec e2e.
 *
 * Uso:
 *   node scripts/check-asset-wiring.js
 *   node scripts/check-asset-wiring.js --json
 *
 * Exit 0 si todo resuelve, exit 1 si hay al menos un asset roto.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JSON_MODE = process.argv.includes('--json');

function log(...a) { if (!JSON_MODE) console.log(...a); }

// ── Cargar y compilar los rewrites de vercel.json ───────────────────────────
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = (vercelConfig.rewrites || []).map(r => ({
  regex: new RegExp('^' + r.source + '$'),
  destination: r.destination,
}));

/**
 * Aplica las reglas de vercel.json en orden (primer match gana, igual que
 * Vercel) y devuelve el path de archivo final, o null si nada matchea.
 */
function resolveViaRewrites(urlPath) {
  for (const { regex, destination } of rewrites) {
    const m = urlPath.match(regex);
    if (!m) continue;
    let dest = destination;
    for (let i = 1; i < m.length; i++) {
      dest = dest.replace(`$${i}`, m[i] ?? '');
    }
    return dest;
  }
  return null;
}

/**
 * Resuelve una URL de asset referenciada en un HTML al path final en disco.
 * Devuelve { resolved, existsOnDisk, isApi } o null si es un asset externo
 * (http/https/protocol-relative) que no nos compete verificar.
 */
function resolveAsset(urlPath) {
  const withoutQuery = urlPath.split('?')[0].split('#')[0];

  const viaRewrite = resolveViaRewrites(withoutQuery);
  const finalPath = viaRewrite ?? withoutQuery;

  // Rutas /api/* no son archivos estáticos — no las chequeamos acá (eso lo
  // cubren los tests de integración de handlers).
  if (finalPath.startsWith('/api/')) {
    return { resolved: finalPath, isApi: true, existsOnDisk: null };
  }

  const diskPath = path.join(ROOT, finalPath);
  const existsOnDisk = fs.existsSync(diskPath) && fs.statSync(diskPath).isFile();
  return { resolved: finalPath, isApi: false, existsOnDisk, viaRewrite: Boolean(viaRewrite) };
}

// ── Extraer <script src="..."> y <link ... href="..."> de un HTML ──────────
const SCRIPT_SRC_RE = /<script\b[^>]*\ssrc=["']([^"']+)["']/gi;
const LINK_HREF_RE = /<link\b[^>]*\shref=["']([^"']+)["']/gi;

function extractInternalAssetRefs(html) {
  const refs = [];
  for (const re of [SCRIPT_SRC_RE, LINK_HREF_RE]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html))) {
      const url = m[1];
      // Solo assets propios (path-relative al sitio). Externos (CDN, etc.)
      // no son responsabilidad de este repo.
      if (url.startsWith('/') && !url.startsWith('//')) {
        refs.push(url);
      }
    }
  }
  return refs;
}

// ── Recorrer todas las páginas .html de frontend/ ───────────────────────────
function findHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findHtmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const htmlFiles = findHtmlFiles(path.join(ROOT, 'frontend')).sort();

log(`\nCheck de cableado de assets: ${htmlFiles.length} páginas HTML en frontend/\n`);

const results = [];
let brokenCount = 0;
let refCount = 0;

for (const htmlFile of htmlFiles) {
  const relHtml = '/' + path.relative(ROOT, htmlFile).replace(/\\/g, '/');
  const html = fs.readFileSync(htmlFile, 'utf8');
  const refs = extractInternalAssetRefs(html);

  const pageResult = { page: relHtml, broken: [] };

  for (const ref of refs) {
    refCount++;
    const info = resolveAsset(ref);
    if (info.isApi) continue; // no compete a este check
    if (!info.existsOnDisk) {
      brokenCount++;
      pageResult.broken.push({ ref, resolvedTo: info.resolved, viaRewrite: info.viaRewrite });
    }
  }

  results.push(pageResult);

  if (pageResult.broken.length > 0) {
    log(`  [FAIL] ${relHtml}`);
    for (const b of pageResult.broken) {
      log(`         ${b.ref}  →  ${b.resolvedTo}  (${b.viaRewrite ? 'vía rewrite' : 'sin rewrite, path literal'}) — NO EXISTE`);
    }
  } else {
    log(`  [OK]   ${relHtml}  (${refs.length} asset${refs.length === 1 ? '' : 's'})`);
  }
}

// ── Reporte ──────────────────────────────────────────────────────────────────
const line = '─'.repeat(70);
const brokenPages = results.filter(r => r.broken.length > 0);

if (JSON_MODE) {
  console.log(JSON.stringify({
    totalPages: htmlFiles.length,
    totalRefs: refCount,
    brokenRefs: brokenCount,
    brokenPages,
  }, null, 2));
} else {
  console.log(`\n${line}`);
  console.log('CHECK DE CABLEADO DE ASSETS — Resultado');
  console.log(line);
  console.log(`  Páginas revisadas : ${htmlFiles.length}`);
  console.log(`  Referencias revisadas : ${refCount}`);
  console.log(`  Referencias rotas : ${brokenCount}`);
  if (brokenPages.length > 0) {
    console.log(`  Páginas afectadas : ${brokenPages.length}`);
    console.log('\nCorregir agregando el rewrite correspondiente en vercel.json,');
    console.log('o corrigiendo el path en el <script>/<link> de la página.\n');
  } else {
    console.log('\n[OK] Todo el frontend está cableado: cada script/link interno resuelve a un archivo real.\n');
  }
}

process.exit(brokenCount > 0 ? 1 : 0);
