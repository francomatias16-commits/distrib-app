#!/usr/bin/env node
/**
 * scripts/eval-asistente.js — Eval de Capa 2 (ver PLAN_QA_ASISTENTE.md)
 *
 * Motivo: tests/asistente/*.test.js prueba ejecución de tools con DB
 * mockeada; cobertura-seleccion-tools.test.js prueba el selector de
 * keywords como función pura. Ninguno de los dos llama de verdad a un
 * modelo. Este script sí: corre tests/asistente/evals/casos.json contra
 * un proveedor real (Gemini/Groq/OpenRouter), reusando las mismas
 * funciones que usa producción (armarSystemPrompt, buscarArticulosRelevantes,
 * esquemaParaGemini/OpenAI, ejecutarTool, responderConFallback) — no
 * reimplementa nada del pipeline real, para que el eval mida lo mismo
 * que le va a pasar a un usuario de verdad.
 *
 * NO corre en CI: consume cuota real de los 3 proveedores y necesita una
 * empresa de prueba real en Supabase (mismo criterio que
 * scripts/seed-demo-loadtest.js — nunca una empresa productiva).
 *
 * Requiere en el entorno:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   GEMINI_API_KEY (o GEMINI_API_KEYS), GROQ_API_KEY, OPENROUTER_API_KEY
 *     (según qué proveedor(es) quieras evaluar)
 *   EMPRESA_ID   — empresa de prueba real (ver scripts/seed-demo-loadtest.js)
 *   USUARIO_ID   — un usuario real de esa empresa (para el rol y para las
 *                  tools de escritura, que insertan en
 *                  asistente_acciones_pendientes con FK a usuarios)
 *
 * Uso:
 *   node scripts/eval-asistente.js
 *   node scripts/eval-asistente.js --provider=gemini
 *   node scripts/eval-asistente.js --provider=groq --json
 *   node scripts/eval-asistente.js --solo=clientes-deuda-01,pedidos-diagnostico-01
 *
 * Qué hace por cada caso:
 *   1. Crea una fila real en asistente_conversaciones (se borra al final).
 *   2. Arma el prompt igual que lib/handlers/asistente.js (mismo
 *      armarSystemPrompt/buscarArticulosRelevantes/esquemas de tools).
 *   3. Llama al proveedor pedido (o a los 3, uno por uno, sin pasar por
 *      la cadena de fallback completa — así se puede comparar cada uno
 *      por separado).
 *   4. Compara la tool llamada contra `tool_esperada` (null = no debía
 *      llamar ninguna).
 *   5. Le pide a un juez LLM (mismo responderConFallback, sin tools) que
 *      diga si el texto final cumple `criterio_respuesta`.
 *   6. Imprime un resumen final por proveedor y guarda el detalle en
 *      tests/asistente/evals/ultimo-resultado.json.
 *
 * Los casos NO_PASA hay que revisarlos siempre a mano antes de asumir que
 * es un bug real — el juez es un primer filtro barato, no un reemplazo.
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { responderConFallback } from '../lib/asistente-providers.js';
import { esquemaParaGemini, esquemaParaOpenAI, ejecutarTool } from '../lib/asistente-tools.js';
import { armarSystemPrompt, buscarArticulosRelevantes } from '../lib/handlers/asistente.js';

const ROOT = process.cwd();
const CASOS_PATH = path.join(ROOT, 'tests', 'asistente', 'evals', 'casos.json');
const RESULTADO_PATH = path.join(ROOT, 'tests', 'asistente', 'evals', 'ultimo-resultado.json');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const EMPRESA_ID = requireEnv('EMPRESA_ID');
const USUARIO_ID = requireEnv('USUARIO_ID');

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const flagProvider = args.find((a) => a.startsWith('--provider='))?.split('=')[1];
const flagSolo = args.find((a) => a.startsWith('--solo='))?.split('=')[1]?.split(',');
const modoJson = args.includes('--json');
const PROVEEDORES = flagProvider ? [flagProvider] : ['gemini', 'groq', 'openrouter'];

// FIX: responderConFallback() encadena los 3 proveedores automáticamente.
// Para evaluar cada uno POR SEPARADO (y así poder comparar), se le pasa
// una lista de override con un solo proveedor — ver la firma real en
// lib/asistente-providers.js antes de tocar esto si cambia la API.
async function llamarProveedor(proveedor, { systemPromptConTools, systemPromptSinTools, historial, mensaje, tools }) {
  return responderConFallback({
    systemPromptConTools,
    systemPromptSinTools,
    historial,
    mensaje,
    tools,
    soloProveedor: proveedor, // si asistente-providers.js no soporta este override
    // todavía, agregarlo ahí primero (debería ser un cambio chico: usar
    // esta opción para saltear los proveedores que no matcheen en la
    // cadena de fallback existente, en vez de duplicar la lógica acá).
  });
}

async function crearConversacionDePrueba() {
  const { data, error } = await db
    .from('asistente_conversaciones')
    .insert({ empresa_id: EMPRESA_ID, usuario_id: USUARIO_ID, titulo: '[EVAL] descartar' })
    .select('id')
    .single();
  if (error) throw new Error(`No se pudo crear conversación de prueba: ${error.message}`);
  return data.id;
}

async function borrarConversacionDePrueba(id) {
  // ON DELETE CASCADE se lleva puesto asistente_mensajes y
  // asistente_acciones_pendientes de esta conversación — no dejar
  // basura de eval en la tabla real.
  await db.from('asistente_conversaciones').delete().eq('id', id);
}

async function obtenerRolUsuario() {
  const { data, error } = await db.from('usuarios').select('rol').eq('id', USUARIO_ID).single();
  if (error) throw new Error(`No se pudo leer el rol de USUARIO_ID: ${error.message}`);
  return data.rol;
}

async function juzgarRespuesta({ pregunta, texto, criterio }) {
  const promptJuez = `Pregunta del usuario: "${pregunta}"\nRespuesta del asistente: "${texto}"\nCriterio a cumplir: "${criterio}"\n\n¿La respuesta cumple el criterio? Contestá SOLO "PASA" o "NO_PASA" seguido de " - " y un motivo en una línea.`;
  const { texto: veredicto } = await responderConFallback({
    systemPromptConTools: promptJuez,
    systemPromptSinTools: promptJuez,
    historial: [],
    mensaje: promptJuez,
    tools: null,
  });
  return veredicto.trim();
}

async function correrCaso(caso, rol) {
  const conversacionId = await crearConversacionDePrueba();
  try {
    const articulos = await buscarArticulosRelevantes({ pregunta: caso.pregunta, rol });
    const { conTools: systemPromptConTools, sinTools: systemPromptSinTools } = armarSystemPrompt({
      articulos,
      rol,
      propuestaVigente: null,
    });

    const toolsLlamadas = [];
    const tools = {
      esquemaGemini: esquemaParaGemini(rol),
      esquemaOpenAI: esquemaParaOpenAI(rol, caso.pregunta),
      ejecutar: async (nombre, argsTool) => {
        toolsLlamadas.push(nombre);
        return ejecutarTool(nombre, {
          empresaId: EMPRESA_ID,
          rol,
          usuarioId: USUARIO_ID,
          conversacionId,
          args: argsTool,
        });
      },
    };

    const resultadosPorProveedor = {};
    for (const proveedor of PROVEEDORES) {
      try {
        const { texto, latenciaMs } = await llamarProveedor(proveedor, {
          systemPromptConTools,
          systemPromptSinTools,
          historial: caso.historial || [],
          mensaje: caso.pregunta,
          tools,
        });

        const toolCorrecta = caso.tool_esperada
          ? toolsLlamadas.includes(caso.tool_esperada)
          : toolsLlamadas.length === 0;

        const veredicto = await juzgarRespuesta({
          pregunta: caso.pregunta,
          texto,
          criterio: caso.criterio_respuesta,
        });

        resultadosPorProveedor[proveedor] = {
          toolsLlamadas: [...toolsLlamadas],
          toolCorrecta,
          texto,
          veredicto,
          pasaJuez: veredicto.toUpperCase().startsWith('PASA'),
          latenciaMs,
        };
      } catch (error) {
        resultadosPorProveedor[proveedor] = { error: error.message };
      }
      toolsLlamadas.length = 0;
    }

    return { id: caso.id, pregunta: caso.pregunta, resultadosPorProveedor };
  } finally {
    await borrarConversacionDePrueba(conversacionId);
  }
}

async function main() {
  const todosLosCasos = JSON.parse(fs.readFileSync(CASOS_PATH, 'utf8'));
  const casos = flagSolo ? todosLosCasos.filter((c) => flagSolo.includes(c.id)) : todosLosCasos;
  const rol = await obtenerRolUsuario();

  console.log(`Corriendo ${casos.length} caso(s) contra: ${PROVEEDORES.join(', ')} (rol=${rol})\n`);

  const resultados = [];
  for (const caso of casos) {
    process.stdout.write(`- ${caso.id}... `);
    const resultado = await correrCaso(caso, rol);
    resultados.push(resultado);
    const resumenLinea = PROVEEDORES.map((p) => {
      const r = resultado.resultadosPorProveedor[p];
      if (r.error) return `${p}=ERROR`;
      return `${p}=${r.toolCorrecta ? 'tool_ok' : 'tool_MAL'}/${r.pasaJuez ? 'pasa' : 'NO_PASA'}`;
    }).join('  ');
    console.log(resumenLinea);
  }

  fs.writeFileSync(RESULTADO_PATH, JSON.stringify(resultados, null, 2));

  if (modoJson) {
    console.log(JSON.stringify(resultados, null, 2));
    return;
  }

  console.log('\n--- Resumen ---');
  for (const proveedor of PROVEEDORES) {
    const deEsteProveedor = resultados.map((r) => r.resultadosPorProveedor[proveedor]).filter((r) => !r.error);
    const toolsOk = deEsteProveedor.filter((r) => r.toolCorrecta).length;
    const juezOk = deEsteProveedor.filter((r) => r.pasaJuez).length;
    const errores = resultados.length - deEsteProveedor.length;
    console.log(`${proveedor}: tool correcta ${toolsOk}/${resultados.length} · pasa el juez ${juezOk}/${resultados.length} · errores ${errores}`);
  }
  console.log(`\nDetalle completo en ${path.relative(ROOT, RESULTADO_PATH)}`);
}

main().catch((error) => {
  console.error('Eval falló:', error);
  process.exit(1);
});
