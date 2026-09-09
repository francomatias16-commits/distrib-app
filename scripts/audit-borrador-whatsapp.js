#!/usr/bin/env node
/**
 * audit-borrador-whatsapp.js — Auditoría de Capa 4 del asistente de
 * WhatsApp (ver PLAN_QA_ASISTENTE_WHATSAPP.md, sección 4).
 *
 * Motivo: audit-resumenes-asistente.js audita, para las tools de
 * escritura del dashboard, el único texto que el usuario lee ANTES de
 * confirmar una acción irreversible (resumen()). El asistente de WhatsApp
 * no tiene resumen() — el punto equivalente de riesgo es el borrador de
 * pedido (`pedido_borrador` jsonb en whatsapp_conversaciones): las 6 tools
 * de lib/whatsapp-pedido-tools.js lo leen/mutan directo, y un bug ahí
 * puede dejarle al cliente un pedido con ítems que no pidió, o hacerle
 * creer que sacó algo que en realidad seguía en el borrador — mismo tipo
 * de daño silencioso que el bug de resumen() del dashboard, aunque el
 * mecanismo sea distinto.
 *
 * Qué chequea, por cada tool del catálogo (TOOLS en whatsapp-pedido-tools.js):
 *   1. ERROR — la tool no tiene execute() (contrato roto, mismo criterio
 *      que audit-resumenes-asistente.js).
 *   2. ERROR — execute() lee el borrador con obtenerBorrador() pero nunca
 *      llama guardarBorrador() antes de terminar — el cambio se pierde en
 *      silencio (el modelo recibe la respuesta como si hubiera funcionado).
 *   3. WARN  — una tool que busca un producto_id en el borrador (find/
 *      filter) y no distingue "no estaba" de "se sacó/modificó" — silent
 *      no-op: si el modelo (o el cliente) manda un producto_id que ya no
 *      está, la tool devuelve el borrador sin cambios y sin avisar, y el
 *      modelo puede decirle al cliente "listo, lo saqué" sin que sea
 *      cierto. HALLAZGO REAL (2026-09-08): quitar_item hace exactamente
 *      esto — `filter` sin comprobar antes si el producto_id existía.
 *   4. WARN  — un total/subtotal armado a mano (con `+` o `+=` fuera de
 *      calcularTotalesPedido) en vez de vía calc/pedido-totales.js — mismo
 *      invariante que "nunca sumes vos mismo los precios" del system
 *      prompt (armarSystemPromptWhatsApp(), notif.js): si el propio código
 *      del servidor no lo respeta, tampoco hay forma de exigírselo al
 *      modelo de manera consistente.
 *
 * Es heurístico (regex sobre texto, no un AST real) — mismo criterio que
 * audit-resumenes-asistente.js para el catálogo del dashboard. Un WARN no
 * es necesariamente un bug: revisar a mano antes de "corregir" solo para
 * silenciar el script.
 *
 * Uso:
 *   node scripts/audit-borrador-whatsapp.js [--json]
 *
 * No necesita Supabase ni ningún proveedor de IA — solo lee
 * lib/whatsapp-pedido-tools.js como texto.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const TOOLS_FILE = join(ROOT, 'lib/whatsapp-pedido-tools.js');
const FLAG_JSON = process.argv.includes('--json');

const C = FLAG_JSON ? { r: '', g: '', y: '', c: '', x: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m',
};
function log(...a) { if (!FLAG_JSON) console.log(...a); }

// Mismo extractor balanceado en llaves que audit-resumenes-asistente.js —
// TOOLS acá es un array plano de objetos (no agrupado por archivo, es un
// solo archivo con 6 tools), así que alcanza con un solo pase.
function extraerToolsDeArchivo(src) {
  const arrStart = src.indexOf('const TOOLS = [');
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
    return { name: nameM ? nameM[1] : null, src: obj };
  }).filter((t) => t.name);
}

// Extrae el cuerpo balanceado en llaves de `async execute(...) {` — mismo
// helper que extraerCuerpoMetodo() de audit-resumenes-asistente.js,
// acotado al único shape que usa este archivo (`async execute(...) {`).
function extraerCuerpoExecute(objSrc) {
  const match = objSrc.match(/async\s+execute\s*\([^)]*\)\s*\{/);
  if (!match) return null;

  const inicioLlave = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = inicioLlave; i < objSrc.length; i++) {
    if (objSrc[i] === '{') depth++;
    else if (objSrc[i] === '}') {
      depth--;
      if (depth === 0) return objSrc.slice(inicioLlave, i + 1);
    }
  }
  return null;
}

// Suma/resta manual fuera de calcularTotalesPedido — busca `total`/
// `subtotal` seguido de un operador aritmético que no sea parte de un
// llamado a esa función. Heurística angosta a propósito, mismo criterio
// que audit-resumenes-asistente.js: prefiere dejar pasar un caso raro
// antes que llenar de falsos positivos variables que solo se leen.
function tieneSumaManualDeTotal(cuerpo) {
  if (/calcularTotalesPedido/.test(cuerpo)) return false; // ya delega, ok
  return /\b(total|subtotal)\w*\s*(\+=|=\s*[\w.]+\s*\+)/i.test(cuerpo);
}

function tieneMutacionSinGuardar(cuerpo) {
  const lee = /obtenerBorrador\s*\(/.test(cuerpo);
  const guarda = /guardarBorrador\s*\(/.test(cuerpo);
  // proponer_confirmacion es un caso legítimo de "lee pero no llama
  // guardarBorrador()": no toca los ítems, solo pasa el estado a
  // 'esperando_confirmacion' con un .update() directo sobre
  // whatsapp_conversaciones (ver su execute()) — no hay nada que
  // reescribir en pedido_borrador. Se lo distingue de un bug real
  // buscando ese .update(...) directo como persistencia alternativa
  // válida, en vez de excluir la tool por nombre (así sigue detectando
  // el caso real si OTRA tool nueva reproduce el mismo patrón sin razón).
  const persisteDirecto = /\.from\(\s*['"]whatsapp_conversaciones['"]\s*\)\s*\n?\s*\.update\s*\(/.test(cuerpo);
  return lee && !guarda && !persisteDirecto;
}

// Busca un producto_id contra el borrador con find/filter sin ninguna
// rama que distinga "no estaba" — mismo criterio que el hallazgo real de
// quitar_item en la cabecera. No aplica a modificar_cantidad porque esa sí
// tira error si `!existente` (ver su execute()).
function tieneBusquedaSinDistinguirNoEncontrado(cuerpo, toolName) {
  if (toolName === 'modificar_cantidad') return false; // ya valida `!existente`
  const filtraPorProductoId = /\.filter\s*\(\s*\([^)]*\)\s*=>\s*[^)]*producto_id\s*!==/.test(cuerpo);
  const validaExistencia = /if\s*\(\s*!\s*\w*existente/.test(cuerpo);
  return filtraPorProductoId && !validaExistencia;
}

function main() {
  const src = readFileSync(TOOLS_FILE, 'utf8');
  const tools = extraerToolsDeArchivo(src);

  log(`${C.c}Auditando ${tools.length} tool(s) del borrador de pedido de WhatsApp...${C.x}\n`);

  const errores = [];
  const warns = [];

  for (const t of tools) {
    const cuerpoExecute = extraerCuerpoExecute(t.src);

    if (!cuerpoExecute) {
      errores.push({ tool: t.name, motivo: 'no tiene execute() (o el parser no pudo extraerlo)' });
      continue;
    }

    if (tieneMutacionSinGuardar(cuerpoExecute)) {
      errores.push({ tool: t.name, motivo: 'lee el borrador con obtenerBorrador() pero nunca llama guardarBorrador() — el cambio se pierde en silencio' });
    }

    if (tieneBusquedaSinDistinguirNoEncontrado(cuerpoExecute, t.name)) {
      warns.push({ tool: t.name, motivo: 'filtra por producto_id sin comprobar antes si existía en el borrador — silent no-op si el producto_id no está (el modelo puede decir "listo, lo saqué" sin que sea cierto)' });
    }

    if (tieneSumaManualDeTotal(cuerpoExecute)) {
      warns.push({ tool: t.name, motivo: 'arma un total/subtotal con suma manual en vez de calcularTotalesPedido() — riesgo de desalinearse del total que se factura al confirmar' });
    }
  }

  if (FLAG_JSON) {
    console.log(JSON.stringify({ totalTools: tools.length, errores, warns }, null, 2));
  } else {
    if (errores.length) {
      log(`${C.r}✗ ${errores.length} problema(s) bloqueante(s):${C.x}`);
      errores.forEach((e) => log(`   ${e.tool}: ${e.motivo}`));
    } else {
      log(`${C.g}✓ Sin problemas bloqueantes en el manejo del borrador de pedido.${C.x}`);
    }
    if (warns.length) {
      log(`\n${C.y}⚠ ${warns.length} advertencia(s) para revisar a mano:${C.x}`);
      warns.forEach((w) => log(`   ${w.tool}: ${w.motivo}`));
    }
  }

  process.exit(errores.length ? 1 : 0);
}

main();
