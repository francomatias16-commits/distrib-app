#!/usr/bin/env node
/**
 * scripts/eval-asistente-whatsapp.js — Eval de Capa 2 del asistente de
 * pedidos por WhatsApp (ver PLAN_QA_ASISTENTE_WHATSAPP.md, secciones 1 y 2).
 *
 * Mismo patrón que scripts/eval-asistente.js (asistente de ayuda del
 * dashboard), adaptado al contrato distinto del asistente de WhatsApp: acá
 * no hay usuario logueado con rol, hay un cliente identificado por teléfono
 * y solo 6 tools (siempre declaradas todas, sin selector por keyword — ver
 * sección 1 del plan). Por eso esta capa absorbe también lo que hubiera
 * sido la Capa 1: el dataset (tests/handlers/evals-whatsapp/casos.json)
 * incluye variantes de typo/coloquial que en el asistente del dashboard
 * viven en cobertura-seleccion-tools.test.js como test unitario aparte —
 * acá no hay función pura de selección para testear así, así que se miden
 * junto con todo lo demás, contra el modelo real.
 *
 * Reusa las mismas funciones que usa producción (armarSystemPromptWhatsApp
 * de lib/handlers/notif.js, esquemaPedidoWhatsAppGemini/OpenAI y
 * ejecutarToolPedidoWhatsApp de lib/whatsapp-pedido-tools.js,
 * responderConFallback de lib/asistente-providers.js) — no reimplementa
 * nada del pipeline real.
 *
 * NO corre en CI: consume cuota real de los 3 proveedores y necesita una
 * empresa + cliente de prueba reales en Supabase (mismo criterio que
 * scripts/eval-asistente.js — nunca una empresa/cliente productivo).
 *
 * Requiere en el entorno:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   GEMINI_API_KEY (o GEMINI_API_KEYS), GROQ_API_KEY, OPENROUTER_API_KEY
 *     (según qué proveedor(es) quieras evaluar)
 *   EMPRESA_ID   — empresa de prueba real
 *   CLIENTE_ID   — un cliente real de esa empresa (para resolver precios y
 *                  para las tools que validan cliente/stock)
 *
 * Uso:
 *   node scripts/eval-asistente-whatsapp.js
 *   node scripts/eval-asistente-whatsapp.js --provider=gemini
 *   node scripts/eval-asistente-whatsapp.js --provider=groq --json
 *   node scripts/eval-asistente-whatsapp.js --solo=buscar-productos-directo-01,derivar-precio-especial-01
 *
 * Qué hace por cada caso:
 *   1. Crea una fila real en whatsapp_conversaciones con un teléfono
 *      descartable único por caso (se borra al final — el índice único
 *      idx_whatsapp_conv_telefono_abierta exige un teléfono distinto por
 *      conversación abierta a la vez).
 *   2. Arma el prompt igual que lib/handlers/notif.js
 *      (armarSystemPromptWhatsApp real, no una copia).
 *   3. Llama al proveedor pedido (o a los 3, uno por uno, sin pasar por la
 *      cadena de fallback completa — así se puede comparar cada uno).
 *   4. Compara la tool llamada contra `tool_esperada` (null = no debía
 *      llamar ninguna — casos de fallback/no-derivación).
 *   5. Le pide a un juez LLM (mismo responderConFallback, sin tools) que
 *      diga si el texto final cumple `criterio_respuesta`.
 *   6. Imprime un resumen final por proveedor y guarda el detalle en
 *      tests/handlers/evals-whatsapp/ultimo-resultado.json.
 *
 * Los casos NO_PASA hay que revisarlos siempre a mano antes de asumir que
 * es un bug real — el juez es un primer filtro barato, no un reemplazo.
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { responderConFallback } from '../lib/asistente-providers.js';
import { esquemaPedidoWhatsAppGemini, esquemaPedidoWhatsAppOpenAI, ejecutarToolPedidoWhatsApp } from '../lib/whatsapp-pedido-tools.js';
import { armarSystemPromptWhatsApp } from '../lib/handlers/notif.js';

const ROOT = process.cwd();
const CASOS_PATH = path.join(ROOT, 'tests', 'handlers', 'evals-whatsapp', 'casos.json');
const RESULTADO_PATH = path.join(ROOT, 'tests', 'handlers', 'evals-whatsapp', 'ultimo-resultado.json');

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
const CLIENTE_ID = requireEnv('CLIENTE_ID');

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const flagProvider = args.find((a) => a.startsWith('--provider='))?.split('=')[1];
const flagSolo = args.find((a) => a.startsWith('--solo='))?.split('=')[1]?.split(',');
const modoJson = args.includes('--json');
const PROVEEDORES = flagProvider ? [flagProvider] : ['gemini', 'groq', 'openrouter'];

// FIX: mismo motivo que en eval-asistente.js — responderConFallback()
// encadena los 3 proveedores automáticamente; para evaluar cada uno POR
// SEPARADO se le pasa un override con un solo proveedor.
async function llamarProveedor(proveedor, { systemPromptConTools, systemPromptSinTools, historial, mensaje, tools }) {
  return responderConFallback({
    systemPromptConTools,
    systemPromptSinTools,
    historial,
    mensaje,
    tools,
    soloProveedor: proveedor,
  });
}

// Teléfono descartable único por corrida de caso — idx_whatsapp_conv_
// telefono_abierta es un índice único parcial sobre conversaciones no
// cerradas, así que dos casos no pueden compartir teléfono mientras estén
// corriendo (aunque se corran en distintas invocaciones del script).
function telefonoDePrueba(casoId) {
  const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
  return `+549eval${casoId.slice(0, 8)}${sufijo}`.replace(/[^0-9+]/g, '').slice(0, 20);
}

async function crearConversacionDePrueba(casoId) {
  const { data, error } = await db
    .from('whatsapp_conversaciones')
    .insert({
      telefono: telefonoDePrueba(casoId),
      empresa_id: EMPRESA_ID,
      cliente_id: CLIENTE_ID,
      estado: 'activa',
      pedido_borrador: { items: [] },
      turno_desde: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(`No se pudo crear conversación de prueba: ${error.message}`);
  return data.id;
}

async function borrarConversacionDePrueba(id) {
  // ON DELETE CASCADE se lleva puesto whatsapp_mensajes de esta
  // conversación (migración 247) — no dejar basura de eval en la tabla real.
  await db.from('whatsapp_conversaciones').delete().eq('id', id);
}

async function juzgarRespuesta({ pregunta, texto, criterio }) {
  const promptJuez = `Mensaje del cliente: "${pregunta}"\nRespuesta del bot: "${texto}"\nCriterio a cumplir: "${criterio}"\n\n¿La respuesta cumple el criterio? Contestá SOLO "PASA" o "NO_PASA" seguido de " - " y un motivo en una línea.`;
  const { texto: veredicto } = await responderConFallback({
    systemPromptConTools: promptJuez,
    systemPromptSinTools: promptJuez,
    historial: [],
    mensaje: promptJuez,
    tools: null,
  });
  return veredicto.trim();
}

async function correrCaso(caso) {
  const conversacionId = await crearConversacionDePrueba(caso.id);
  try {
    const { systemPromptConTools, systemPromptSinTools } = armarSystemPromptWhatsApp();

    const toolsLlamadas = [];
    const tools = {
      esquemaGemini: esquemaPedidoWhatsAppGemini(),
      esquemaOpenAI: esquemaPedidoWhatsAppOpenAI(),
      ejecutar: async (nombre, argsTool) => {
        toolsLlamadas.push(nombre);
        return ejecutarToolPedidoWhatsApp(nombre, {
          empresaId: EMPRESA_ID,
          clienteId: CLIENTE_ID,
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

  console.log(`Corriendo ${casos.length} caso(s) contra: ${PROVEEDORES.join(', ')} (empresa=${EMPRESA_ID})\n`);

  const resultados = [];
  for (const caso of casos) {
    process.stdout.write(`- ${caso.id}... `);
    const resultado = await correrCaso(caso);
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
