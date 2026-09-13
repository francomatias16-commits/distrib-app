// PLAN_UIUX_OPTIMIZACION_TOTAL.md, Etapa 2.1 — barrera de regresión para el
// mismo tipo de bug que el B8 original: una fuente se declara vía
// `@font-face` (con su URL, weight, etc.) pero ningún `font-family:` del
// proyecto termina apuntándola — el archivo .woff2 nunca se carga en
// producción y nadie lo nota porque el fallback de la pila (`sans-serif`,
// `Inter`, etc.) se ve "razonablemente parecido". Ningún audit actual
// (mobile/a11y/lighthouse) detecta esto: todos corren contra el DOM
// renderizado, y el navegador no distingue "fuente cargada" de "fuente
// fallback que por casualidad luce similar".
//
// No usa navegador ni parser de CSS real: es un grep/regex liviano sobre
// los .css del proyecto (a proposito, mismo criterio que
// check-shared-selectors.js — <1s, apto para pre-commit/CI). Cubre los dos
// patrones reales que existen hoy en el repo:
//   1. Uso directo: `font-family: NombreFuente, ...` en cualquier CSS.
//   2. Uso indirecto vía variable CSS: `--alguna-var: "NombreFuente", ...;`
//      y en otro lado (u otro archivo) `font-family: var(--alguna-var)`.
//      (Patrón real: `--gamma-heading-font`/`--gamma-body-font` en
//      frontend/landing/bundle.css.)
//
// Uso: npm run check:fonts-wiring
// Exit code 1 si encuentra una fuente declarada y nunca referenciada.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();

// Directorios donde puede haber CSS relevante. Se recorre todo
// frontend/ (admin, cliente, chofer, landing, shared) porque las fuentes
// pueden vivir en cualquier hoja de estilo, no solo en frontend/admin/css/
// como los selectores compartidos de check-shared-selectors.js.
const SCAN_DIRS = ['frontend'];

function listarArchivosCss(dir) {
  const resultado = [];
  let entradas;
  try {
    entradas = readdirSync(dir);
  } catch {
    return resultado;
  }
  for (const nombre of entradas) {
    if (nombre === 'node_modules' || nombre.startsWith('.')) continue;
    const ruta = join(dir, nombre);
    const info = statSync(ruta);
    if (info.isDirectory()) {
      resultado.push(...listarArchivosCss(ruta));
    } else if (extname(nombre) === '.css') {
      resultado.push(ruta);
    }
  }
  return resultado;
}

function limpiarNombreFuente(crudo) {
  return crudo.trim().replace(/^['"]|['"]$/g, '');
}

function main() {
  const archivos = SCAN_DIRS.flatMap((d) => listarArchivosCss(join(ROOT, d)));
  const contenidoPorArchivo = new Map();
  for (const archivo of archivos) {
    contenidoPorArchivo.set(archivo, readFileSync(archivo, 'utf8'));
  }

  // 1) Extraer todas las declaraciones @font-face y su font-family.
  const fuentesDeclaradas = new Map(); // nombre -> [{archivo, familiaCruda}]
  const reFontFace = /@font-face\s*{([^}]*)}/g;
  const reFamiliaDentro = /font-family\s*:\s*([^;]+);/;

  for (const [archivo, contenido] of contenidoPorArchivo) {
    let m;
    while ((m = reFontFace.exec(contenido))) {
      const bloque = m[1];
      const fm = reFamiliaDentro.exec(bloque);
      if (!fm) continue;
      const nombre = limpiarNombreFuente(fm[1]);
      if (!fuentesDeclaradas.has(nombre)) fuentesDeclaradas.set(nombre, []);
      fuentesDeclaradas.get(nombre).push(archivo);
    }
  }

  if (fuentesDeclaradas.size === 0) {
    console.log('OK — no se encontraron declaraciones @font-face en el proyecto.');
    process.exitCode = 0;
    return;
  }

  // 2) Recolectar variables CSS que apuntan a una fuente (custom properties
  //    usadas como indirección, patrón --gamma-heading-font/--gamma-body-font).
  //    variable -> Set(nombres de fuente que contiene su valor)
  const variablesQueApuntanAFuente = new Map();
  const reVarDecl = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;

  for (const contenido of contenidoPorArchivo.values()) {
    let m;
    while ((m = reVarDecl.exec(contenido))) {
      const [, variable, valor] = m;
      for (const nombreFuente of fuentesDeclaradas.keys()) {
        const re = new RegExp(`(^|[,\\s'"])${escaparRegex(nombreFuente)}([,\\s'"]|$)`);
        if (re.test(valor)) {
          if (!variablesQueApuntanAFuente.has(variable)) {
            variablesQueApuntanAFuente.set(variable, new Set());
          }
          variablesQueApuntanAFuente.get(variable).add(nombreFuente);
        }
      }
    }
  }

  // 3) Para cada fuente declarada, buscar un uso real en `font-family:`
  //    en CUALQUIER archivo — directo, o indirecto vía var(--x).
  function escaparRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const usadas = new Set();
  const reFontFamilyUso = /font-family\s*:\s*([^;]+);/g;

  for (const contenido of contenidoPorArchivo.values()) {
    // La declaración `font-family: X;` DENTRO de un bloque @font-face no es
    // un uso — es la propia declaración de la fuente. Si no se saca, toda
    // fuente se "auto-detecta" como usada por su propia declaración y el
    // check nunca podría fallar.
    const sinFontFace = contenido.replace(/@font-face\s*{[^}]*}/g, '');
    let m;
    while ((m = reFontFamilyUso.exec(sinFontFace))) {
      const valor = m[1];
      for (const nombreFuente of fuentesDeclaradas.keys()) {
        if (usadas.has(nombreFuente)) continue;
        const reDirecta = new RegExp(`(^|[,\\s'"])${escaparRegex(nombreFuente)}([,\\s'"]|$)`);
        if (reDirecta.test(valor)) {
          usadas.add(nombreFuente);
          continue;
        }
        // Indirecto: font-family usa var(--x) y --x contiene esta fuente.
        const reVars = /var\(\s*(--[a-zA-Z0-9-]+)/g;
        let vm;
        while ((vm = reVars.exec(valor))) {
          const variable = vm[1];
          const fuentesDeEstaVar = variablesQueApuntanAFuente.get(variable);
          if (fuentesDeEstaVar && fuentesDeEstaVar.has(nombreFuente)) {
            usadas.add(nombreFuente);
          }
        }
      }
    }
  }

  const sinUsar = [...fuentesDeclaradas.keys()].filter((f) => !usadas.has(f));

  if (sinUsar.length === 0) {
    console.log(
      `OK — las ${fuentesDeclaradas.size} fuente(s) declarada(s) vía @font-face ` +
      `(${[...fuentesDeclaradas.keys()].join(', ')}) tienen al menos un uso real en font-family.`
    );
    process.exitCode = 0;
    return;
  }

  console.error(`Encontrada(s) ${sinUsar.length} fuente(s) declarada(s) y nunca usada(s):\n`);
  for (const nombre of sinUsar) {
    const archivosDeclaracion = fuentesDeclaradas.get(nombre);
    console.error(`  "${nombre}" — @font-face en: ${archivosDeclaracion.join(', ')}`);
    console.error('    Ningún font-family (directo o vía variable CSS) la referencia en todo el proyecto.');
  }
  console.error(
    `\nEsto es exactamente el patrón del bug B8 original: la fuente nunca se carga en` +
    `\nproducción porque nada la pide. Si es intencional (fuente reservada para uso` +
    `\nfuturo), agregá el font-family que la use; si ya no hace falta, borrá el` +
    `\n@font-face y el archivo .woff2 asociado.`
  );
  process.exitCode = 1;
}

main();
