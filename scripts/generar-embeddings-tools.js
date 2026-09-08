#!/usr/bin/env node
/**
 * scripts/generar-embeddings-tools.js
 *
 * Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md (selección de tools por
 * similitud semántica). Análogo a generar-embeddings-asistente.js pero
 * para el catálogo de tools en vez de los artículos de ayuda: recorre
 * TOOLS (lib/asistente-tools.js, 98 tools a la fecha de este frente),
 * genera el embedding de `name + description` de cada una con
 * gemini-embedding-001 (768 dims) y los sube (upsert) a la tabla
 * asistente_tools_embeddings en Supabase (ver
 * supabase/migrations/602_asistente_tools_embeddings.sql).
 *
 * Al final borra de la tabla cualquier fila cuyo tool_nombre ya no exista
 * en TOOLS — evita que una tool eliminada/renombrada quede como
 * "fantasma" compitiendo en la búsqueda semántica indefinidamente.
 *
 * A diferencia del script de artículos, este NO se corre en cada deploy
 * ni con un cron: se corre a mano cada vez que se agrega, edita (el
 * texto de `description`, sobre todo) o elimina una tool del catálogo.
 * Si no se corre después de agregar una tool nueva, esa tool
 * simplemente no participa de la selección semántica todavía —
 * seleccionarToolsRelevantes() sigue funcionando igual por keyword como
 * red de seguridad (ver lib/asistente-tools/index.js).
 *
 * Requiere en tu entorno (exportadas en la shell o vía `vercel env pull`):
 *   GEMINI_API_KEY
 *   SUPABASE_URL              (la URL de tu proyecto, ej: https://xxxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY (service role key, NO la anon key — hace falta para poder escribir)
 *
 * Uso:
 *   npm run cargar-embeddings-tools
 *   node scripts/generar-embeddings-tools.js
 */

import { createClient } from '@supabase/supabase-js';
import { TOOLS } from '../lib/asistente-tools.js';

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMS = 768;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return value;
}

const GEMINI_API_KEY = requireEnv('GEMINI_API_KEY');
const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Llama a la API de Gemini para obtener el embedding de un texto,
 * truncado a 768 dimensiones vía outputDimensionality. Mismo taskType
 * (RETRIEVAL_DOCUMENT) que generar-embeddings-asistente.js: se está
 * indexando contenido para que después lo encuentre una query, no al
 * revés — la asimetría RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY es la que usa
 * Gemini para orientar mejor el embedding en cada caso.
 */
async function generarEmbedding(texto) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: texto }] },
      outputDimensionality: EMBEDDING_DIMS,
      taskType: 'RETRIEVAL_DOCUMENT',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini embedding falló (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const values = data?.embedding?.values;
  if (!values || values.length !== EMBEDDING_DIMS) {
    throw new Error(`Embedding inesperado: se esperaban ${EMBEDDING_DIMS} dims, llegaron ${values?.length}`);
  }
  return values;
}

async function borrarToolsFantasma(nombresVigentes) {
  // Traer los nombres existentes en la tabla para poder listar cuáles se
  // borran (además de borrarlos) — solo a fines de log, la query de
  // borrado en sí no necesita esta lectura previa.
  const { data: existentes, error: errorLectura } = await supabase
    .from('asistente_tools_embeddings')
    .select('tool_nombre');

  if (errorLectura) {
    console.error(`No se pudo verificar tools fantasma: ${errorLectura.message}`);
    return;
  }

  const fantasma = (existentes || [])
    .map((f) => f.tool_nombre)
    .filter((nombre) => !nombresVigentes.has(nombre));

  if (fantasma.length === 0) {
    console.log('Sin tools fantasma para borrar (la tabla ya está sincronizada con el catálogo).');
    return;
  }

  console.log(`Borrando ${fantasma.length} tool(s) fantasma: ${fantasma.join(', ')}`);
  const { error: errorBorrado } = await supabase
    .from('asistente_tools_embeddings')
    .delete()
    .in('tool_nombre', fantasma);

  if (errorBorrado) {
    console.error(`No se pudieron borrar las tools fantasma: ${errorBorrado.message}`);
  }
}

async function main() {
  console.log(`Encontradas ${TOOLS.length} tools en el catálogo (lib/asistente-tools.js)`);

  let ok = 0;
  let fallidas = 0;

  for (const tool of TOOLS) {
    try {
      process.stdout.write(`Procesando "${tool.name}"... `);

      // Se embebe name + description (mismo criterio que título+contenido
      // en generar-embeddings-asistente.js): el nombre suele traer la
      // acción principal ("listar", "consultar", "crear") y la
      // description trae el detalle + los sinónimos que el modelo
      // debería reconocer (ver cada entrada de TOOLS).
      const textoParaEmbedding = `${tool.name}\n\n${tool.description}`;
      const embedding = await generarEmbedding(textoParaEmbedding);

      const { error } = await supabase.from('asistente_tools_embeddings').upsert(
        {
          tool_nombre: tool.name,
          embedding,
          actualizado_en: new Date().toISOString(),
        },
        { onConflict: 'tool_nombre' }
      );

      if (error) throw error;

      console.log('OK');
      ok++;

      // Misma pausa que generar-embeddings-asistente.js, mismo motivo:
      // no pegarle demasiado rápido a la cuota de Gemini.
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.log('ERROR');
      console.error(`  -> ${tool.name}: ${err.message}`);
      fallidas++;
    }
  }

  await borrarToolsFantasma(new Set(TOOLS.map((t) => t.name)));

  console.log(`\nListo. ${ok} tools cargadas, ${fallidas} fallidas.`);
  if (fallidas > 0) process.exit(1);
}

main();
