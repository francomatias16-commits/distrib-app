#!/usr/bin/env node
/**
 * scripts/bump-sw-version.js
 *
 * Se ejecuta automáticamente en cada deploy (ver "build" en package.json).
 * Reescribe la constante SW_VERSION de cada Service Worker usando un id
 * único por deploy, para que el navegador SIEMPRE descarte la caché
 * anterior y vuelva a descargar CSS/JS actualizados.
 *
 * Por qué existe:
 *   Antes había que acordarse de subir "admin-v144" → "admin-v145" a mano
 *   en cada release. Si alguien se olvidaba, los usuarios quedaban con
 *   assets viejos cacheados indefinidamente (Cache-First), aunque el
 *   código correcto ya estuviera en producción. Este script elimina ese
 *   paso manual.
 *
 * De dónde sale el id de versión (en este orden de preferencia):
 *   1. VERCEL_GIT_COMMIT_SHA  → variable que Vercel inyecta automáticamente
 *      en cada build (Production y Preview). Es la opción ideal: un id
 *      distinto por cada commit deployado.
 *   2. `git rev-parse --short HEAD` → fallback para builds locales fuera
 *      de Vercel, si hay repo git disponible.
 *   3. Date.now() → último fallback si no hay git ni la env var (evita
 *      que el script rompa el build).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

// archivo → prefijo del SW_VERSION que le corresponde
const ARCHIVOS_SW = [
  { ruta: 'frontend/admin/sw-admin.js', prefijo: 'admin' },
  { ruta: 'frontend/chofer/sw-chofer.js', prefijo: 'chofer' },
];

let huboCambios = false;

for (const { ruta, prefijo } of ARCHIVOS_SW) {
  const rutaAbsoluta = path.join(ROOT, ruta);
  let contenido;
  try {
    contenido = readFileSync(rutaAbsoluta, 'utf8');
  } catch {
    console.warn(`[bump-sw-version] No se encontró ${ruta}, se omite.`);
    continue;
  }

  const regex = /const SW_VERSION\s*=\s*'[^']+';/;
  if (!regex.test(contenido)) {
    console.warn(`[bump-sw-version] No se encontró SW_VERSION en ${ruta}, se omite.`);
    continue;
  }

  const nuevoValor = `const SW_VERSION   = '${prefijo}-${ID_DEPLOY}';`;
  contenido = contenido.replace(regex, nuevoValor);
  writeFileSync(rutaAbsoluta, contenido, 'utf8');
  huboCambios = true;
  console.log(`[bump-sw-version] ${ruta} → ${prefijo}-${ID_DEPLOY}`);
}

if (!huboCambios) {
  console.warn('[bump-sw-version] No se actualizó ningún Service Worker.');
}
