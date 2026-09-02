#!/usr/bin/env node
/**
 * scripts/bump-asset-versions.js
 *
 * Se ejecuta automáticamente en cada deploy (ver "build" en package.json).
 * Reescribe el query string "?v=" de TODOS los <link rel="stylesheet" href="...">
 * y <script src="..."> internos (frontend/**) en TODAS las páginas .html,
 * usando un único id de versión por deploy.
 *
 * Por qué existe:
 *   El "?v=" de cache-busting se venía editando a mano, archivo por archivo,
 *   cada vez que se tocaba un CSS/JS compartido. Si te olvidabas de bumpear
 *   el query string en alguna de las páginas que referencian ese asset,
 *   esa página quedaba sirviendo la versión vieja cacheada por el navegador
 *   (aunque el archivo en el server ya estuviera actualizado) — el clásico
 *   "desfasaje visual que aparece después de cada release, siempre en algún
 *   rincón distinto". Prueba de esto en el repo: docenas de valores de "?v="
 *   distintos conviviendo (v=1, v=227, v=228, timestamps, fechas...), y al
 *   menos una página (saas-billing.html) todavía apuntando a un v= viejo de
 *   un asset que en el resto del sitio ya estaba en una versión más nueva.
 *
 *   Mismo problema, mismo motivo, que llevó a crear bump-sw-version.js para
 *   el Service Worker — esto extiende esa misma solución a los assets
 *   referenciados directamente desde el HTML.
 *
 * De dónde sale el id de versión: se reutiliza el mismo criterio que
 * bump-sw-version.js (VERCEL_GIT_COMMIT_SHA → git rev-parse --short HEAD →
 * Date.now()), así los dos scripts quedan en sync en el mismo deploy.
 *
 * Qué NO toca:
 *   - URLs externas (http/https, CDNs).
 *   - Atributos que no sean href/src de <link rel="stylesheet"> o <script>.
 *   - Si el asset no tenía "?v=" previamente, se le agrega (así también
 *     cubre archivos nuevos a los que nunca se les puso cache-busting).
 *
 * Uso:
 *   node scripts/bump-asset-versions.js
 *   node scripts/bump-asset-versions.js --dry-run   (solo reporta, no escribe)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

function obtenerIdDeploy() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 8);
  }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT })
      .toString()
      .trim();
  } catch {
    return Date.now().toString(36);
  }
}

const ID_DEPLOY = obtenerIdDeploy();

function listarHtml(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) listarHtml(abs, acc);
    else if (entry.endsWith('.html')) acc.push(abs);
  }
  return acc;
}

// Matchea href="....css[?v=...]" o src="....js[?v=...]" para assets locales
// (empiezan con "/" o son relativos, nunca http(s)://).
//
// FIX (bug detectado en vivo — ver captura de facturación mobile, menú "⋮"
// mostrando comportamiento de antes del fix de posicionarMenuFlotante pese
// a que el archivo en el server ya lo tenía): el grupo de versión exigía el
// separador "=" (?v=...). ui-utils.js, env-config.js, auth-ready.js y
// busqueda-global.js quedaron en algún momento hardcodeados a mano como
// "?v1782328742714" (sin el "="), un formato que este regex nunca matcheaba
// — el script los reescribía en CERO de los 46 HTML que los referencian, en
// TODOS los deploys, desde que se introdujo ese typo. Cualquier fix futuro a
// esos 4 archivos quedaba invisible para cualquier navegador que ya los
// hubiera cacheado una vez. El "?v=" del grupo de versión ahora es opcional
// también en el signo "=", así que la próxima corrida normaliza los 46
// archivos a la vez.
const REGEX_ASSET = /(href|src)="((?:\/|\.\.?\/)[^"]+?\.(?:css|js))(\?v=?[^"]*)?"/g;

let archivosModificados = 0;
let referenciasActualizadas = 0;

for (const archivo of listarHtml(path.join(ROOT, 'frontend'))) {
  const original = readFileSync(archivo, 'utf8');
  let cambiosEnArchivo = 0;

  const actualizado = original.replace(REGEX_ASSET, (match, attr, url, _viejoV) => {
    cambiosEnArchivo++;
    return `${attr}="${url}?v=${ID_DEPLOY}"`;
  });

  if (actualizado !== original) {
    archivosModificados++;
    referenciasActualizadas += cambiosEnArchivo;
    if (!DRY_RUN) writeFileSync(archivo, actualizado, 'utf8');
    console.log(`[bump-asset-versions] ${path.relative(ROOT, archivo)} → ${cambiosEnArchivo} referencia(s)`);
  }
}

console.log(
  `[bump-asset-versions] ${DRY_RUN ? '(dry-run) ' : ''}${archivosModificados} archivo(s), ` +
  `${referenciasActualizadas} referencia(s) → v=${ID_DEPLOY}`
);
