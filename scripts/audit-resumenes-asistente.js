#!/usr/bin/env node
/**
 * audit-resumenes-asistente.js — Auditoría de Capa 4 (ver PLAN_QA_ASISTENTE.md)
 *
 * Motivo: tests/asistente/*.test.js prueba que cada tool EJECUTA bien, y
 * cobertura-seleccion-tools.test.js prueba que el modelo la ENCUENTRE — pero
 * nada auditaba, para las 66 tools con requiereConfirmacion:true, la única
 * defensa real entre el modelo y una acción irreversible: el texto que
 * arma resumen() y el contrato de retorno de execute()/resumen() frente a
 * ejecutarTool() (lib/asistente-tools/index.js).
 *
 * Bug real encontrado corriendo esta idea a mano sobre el catálogo (ya
 * arreglado en este mismo commit, ver facturacion.js): resumen() de
 * anular_factura/emitir_factura hacía `if (x.ambiguo) return x` — un
 * OBJETO, no un string. ejecutarTool() inserta lo que devuelva resumen()
 * tal cual en la columna `resumen TEXT NOT NULL` de
 * asistente_acciones_pendientes (migración 419): eso rompe el insert en
 * vez de pedirle al usuario que desambigüe. El mismo bug ya se había
 * corregido antes del lado de execute() (ver el comentario ahí) pero
 * nunca se generalizó como chequeo — de ahí que sobreviviera del lado de
 * resumen(). Este script es esa generalización, para que una tool NUEVA
 * no reintroduzca ninguno de los dos lados del mismo bug.
 *
 * Qué chequea, por cada tool con requiereConfirmacion:true:
 *   1. ERROR — resumen() o execute() propagan un `.ambiguo` crudo con
 *      `return` en vez de `throw` (el bug de arriba, generalizado).
 *   2. WARN  — resumen() no interpola ningún dato de la tool (sin `${` en
 *      el cuerpo): probablemente un texto genérico, no específico de lo
 *      que se va a hacer.
 *   3. WARN  — resumen() contiene una frase que puede leerse como que la
 *      acción YA se hizo (ver LISTA_FRASES_COMPLETADO abajo) — el usuario
 *      todavía no confirmó nada en ese punto.
 *   4. ERROR — la tool no tiene resumen() o no tiene execute() (contrato
 *      roto: ver el comentario de cabecera de lib/asistente-tools/index.js).
 *
 * Es heurístico (regex sobre texto, no un AST real) — mismo criterio que
 * ya usa audit-asistente-tools.js para este mismo catálogo. Un WARN no es
 * necesariamente un bug: revisar a mano antes de "corregir" solo para
 * silenciar el script.
 *
 * Uso:
 *   node scripts/audit-resumenes-asistente.js [--json]
 *
 * No necesita Supabase ni ningún proveedor de IA — solo lee
 * lib/asistente-tools/*.js como texto.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const TOOLS_DIR = join(ROOT, 'lib/asistente-tools');
const FLAG_JSON = process.argv.includes('--json');

const C = FLAG_JSON ? { r: '', g: '', y: '', c: '', x: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m',
};
function log(...a) { if (!FLAG_JSON) console.log(...a); }

// Frases que, dentro de un resumen() (texto que el usuario lee ANTES de
// confirmar), sugieren que la acción ya ocurrió. Heurística deliberadamente
// angosta — prefiere dejar pasar un caso raro antes que llenar de falsos
// positivos frases legítimas como "ya está activo" (describe un ESTADO
// existente, no la acción que esta tool propone hacer).
const FRASES_COMPLETADO = [
  /\bya se (anul|elimin|cre|confirm|registr|dio de baja)/i,
  /\bse (anuló|eliminó|creó|confirmó|registró)\b/i,
  /\blisto[,:]?\s*(hecho|se hizo)/i,
  /\baccion (realizada|ejecutada|completada)/i,
];

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
    const nameM = obj.match(/name:\s*'([a-zA-Z0-9_]+)'/);
    const escritura = /requiereConfirmacion\s*:\s*true/.test(obj);
    return { archivo: filename, name: nameM ? nameM[1] : null, escritura, src: obj };
  }).filter((t) => t.name);
}

// Extrae el cuerpo balanceado en llaves de un método `campo(...) {` o
// `campo: async (...) => {` dentro del texto de un objeto tool. Devuelve
// null si no lo encuentra (contrato roto — lo reporta el caller).
function extraerCuerpoMetodo(objSrc, campo) {
  const patrones = [
    new RegExp(`\\basync\\s+${campo}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`\\b${campo}\\s*:\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`),
  ];
  let match = null;
  for (const re of patrones) {
    match = objSrc.match(re);
    if (match) break;
  }
  if (!match) return null;

  const inicioLlave = match.index + match[0].length - 1; // el '{' final del match
  let depth = 0;
  for (let i = inicioLlave; i < objSrc.length; i++) {
    if (objSrc[i] === '{') depth++;
    else if (objSrc[i] === '}') {
      depth--;
      if (depth === 0) return objSrc.slice(inicioLlave, i + 1);
    }
  }
  return null; // no debería pasar si el archivo es JS válido
}

// Bug de la sección de cabecera: `if (algo.ambiguo) return algo;` (o
// variantes de nombre de variable) — return de un valor marcado ambiguo
// en vez de throw. No exige que sea literalmente "ambiguo": basta con que
// el return devuelva algo cuya condición previa lo marcó como tal.
function tieneReturnDeAmbiguoCrudo(cuerpo) {
  return /if\s*\(\s*[\w.]+\.ambiguo\s*\)\s*(\{[^}]*)?return\s+[\w.]+\s*;/.test(cuerpo);
}

function main() {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js');
  const tools = [];
  for (const f of files) tools.push(...extraerToolsDeArchivo(join(TOOLS_DIR, f), f));

  const toolsEscritura = tools.filter((t) => t.escritura);
  log(`${C.c}Auditando ${toolsEscritura.length} tools de escritura (requiereConfirmacion:true) de ${tools.length} totales...${C.x}\n`);

  const errores = [];
  const warns = [];

  for (const t of toolsEscritura) {
    const cuerpoResumen = extraerCuerpoMetodo(t.src, 'resumen');
    const cuerpoExecute = extraerCuerpoMetodo(t.src, 'execute');

    if (!cuerpoResumen) errores.push({ tool: t.name, archivo: t.archivo, motivo: 'no tiene resumen() (o el parser no pudo extraerlo)' });
    if (!cuerpoExecute) errores.push({ tool: t.name, archivo: t.archivo, motivo: 'no tiene execute() (o el parser no pudo extraerlo)' });

    if (cuerpoResumen && tieneReturnDeAmbiguoCrudo(cuerpoResumen)) {
      errores.push({ tool: t.name, archivo: t.archivo, motivo: 'resumen() hace return de un objeto marcado .ambiguo en vez de throw — rompe la columna TEXT de asistente_acciones_pendientes' });
    }
    if (cuerpoExecute && tieneReturnDeAmbiguoCrudo(cuerpoExecute)) {
      errores.push({ tool: t.name, archivo: t.archivo, motivo: 'execute() hace return de un objeto marcado .ambiguo en vez de throw — resolverAccionPendiente() lo toma como éxito ("Listo, hecho")' });
    }

    if (cuerpoResumen) {
      if (!cuerpoResumen.includes('${')) {
        warns.push({ tool: t.name, archivo: t.archivo, motivo: 'resumen() no interpola ningún dato — revisar si el texto es específico o genérico' });
      }
      for (const re of FRASES_COMPLETADO) {
        if (re.test(cuerpoResumen)) {
          warns.push({ tool: t.name, archivo: t.archivo, motivo: `resumen() contiene una frase que puede leerse como "ya se hizo" (match: ${cuerpoResumen.match(re)[0]})` });
          break;
        }
      }
    }
  }

  if (FLAG_JSON) {
    console.log(JSON.stringify({ totalToolsEscritura: toolsEscritura.length, errores, warns }, null, 2));
  } else {
    if (errores.length) {
      log(`${C.r}✗ ${errores.length} problema(s) bloqueante(s):${C.x}`);
      errores.forEach((e) => log(`   ${e.tool} (${e.archivo}): ${e.motivo}`));
    } else {
      log(`${C.g}✓ Sin problemas bloqueantes en resumen()/execute() de las tools de escritura.${C.x}`);
    }
    if (warns.length) {
      log(`\n${C.y}⚠ ${warns.length} advertencia(s) para revisar a mano:${C.x}`);
      warns.forEach((w) => log(`   ${w.tool} (${w.archivo}): ${w.motivo}`));
    }
  }

  process.exit(errores.length ? 1 : 0);
}

main();
