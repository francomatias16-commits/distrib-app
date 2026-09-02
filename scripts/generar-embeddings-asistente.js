#!/usr/bin/env node
/**
 * scripts/generar-embeddings-asistente.js
 *
 * Lee todos los .md de docs/producto/ayuda/, genera el embedding de cada uno
 * con el modelo gemini-embedding-001 (768 dims) y los sube (upsert)
 * a la tabla asistente_articulos en Supabase (ver
 * supabase/migrations/195_asistente_ayuda.sql).
 *
 * Requiere en tu entorno (exportadas en la shell o vía `vercel env pull`):
 *   GEMINI_API_KEY
 *   SUPABASE_URL              (la URL de tu proyecto, ej: https://xxxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY (service role key, NO la anon key — hace falta para poder escribir)
 *
 * Uso:
 *   npm run cargar-embeddings-asistente
 *   node scripts/generar-embeddings-asistente.js
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { createClient } from '@supabase/supabase-js';

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, 'docs', 'producto', 'ayuda');
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
 * truncado a 768 dimensiones vía outputDimensionality.
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

function leerArticulos() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`No existe ${DOCS_DIR}. ¿Corriste el script desde la raíz del proyecto?`);
    process.exit(1);
  }

  const archivos = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));

  return archivos.map((archivo) => {
    const raw = fs.readFileSync(path.join(DOCS_DIR, archivo), 'utf-8');
    const { data: frontmatter, content } = matter(raw);

    // El título se toma del primer # del markdown si no viene en el frontmatter
    const tituloMatch = content.match(/^#\s+(.+)$/m);
    const titulo = frontmatter.titulo || tituloMatch?.[1] || archivo.replace('.md', '');

    if (!frontmatter.slug) {
      throw new Error(`El archivo ${archivo} no tiene "slug" en el frontmatter`);
    }

    return {
      archivo,
      slug: frontmatter.slug,
      titulo,
      contenido: content.trim(),
      categoria: frontmatter.categoria || null,
      roles: frontmatter.roles || null,
    };
  });
}

async function main() {
  const articulos = leerArticulos();
  console.log(`Encontrados ${articulos.length} artículos en docs/producto/ayuda/`);

  let ok = 0;
  let fallidos = 0;

  for (const art of articulos) {
    try {
      process.stdout.write(`Procesando "${art.slug}"... `);

      // Se embebe título + contenido para que la búsqueda semántica
      // capture bien de qué trata el artículo, no solo el cuerpo.
      const textoParaEmbedding = `${art.titulo}\n\n${art.contenido}`;
      const embedding = await generarEmbedding(textoParaEmbedding);

      const { error } = await supabase.from('asistente_articulos').upsert(
        {
          slug: art.slug,
          titulo: art.titulo,
          contenido: art.contenido,
          categoria: art.categoria,
          roles: art.roles,
          embedding,
          actualizado_en: new Date().toISOString(),
        },
        { onConflict: 'slug' }
      );

      if (error) throw error;

      console.log('OK');
      ok++;

      // Pequeña pausa para no pegarle demasiado rápido a la cuota
      // gratuita de Gemini (rate limit por minuto).
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.log('ERROR');
      console.error(`  -> ${art.slug}: ${err.message}`);
      fallidos++;
    }
  }

  console.log(`\nListo. ${ok} artículos cargados, ${fallidos} fallidos.`);
  if (fallidos > 0) process.exit(1);
}

main();
