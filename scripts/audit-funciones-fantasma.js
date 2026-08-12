#!/usr/bin/env node
/**
 * audit-funciones-fantasma.js — Etapa 0 (Higiene de base).
 *
 * Compara las funciones que viven HOY en el schema public de la base real
 * contra los CREATE (OR REPLACE) FUNCTION que aparecen en
 * supabase/migrations/*.sql. Lo que vive en la base pero no está en ningún
 * archivo del repo es una "función fantasma": alguien la creó a mano
 * (Supabase Studio, SQL editor) y nunca quedó trackeada — significa que un
 * `supabase db reset` / recrear el proyecto desde cero NO la traería de
 * vuelta. Mismo caso que forzar_cierre_turno_caja, encontrada suelta y
 * trackeada recién en la migración 241.
 *
 * Depende de la RPC audit_funciones_vivas() agregada en la migración 249
 * (solo ejecutable por service_role).
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhb... \
 *   node scripts/audit-funciones-fantasma.js [--json] [--dir=path]
 *
 * Exit 0 si toda función viva tiene al menos un CREATE FUNCTION en el repo.
 * Exit 1 si hay funciones fantasma.
 *
 * Nota: esto es un piso, no un techo. Si una función fantasma se creó con
 * el MISMO cuerpo que una versión vieja trackeada y después se editó a mano
 * en producción sin nueva migración, el nombre va a matchear igual — este
 * script no detecta *drift* de contenido, solo ausencia total. Para eso
 * server el hash_cuerpo que devuelve la RPC, pendiente de un chequeo futuro
 * más fino si hace falta.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLAG_JSON     = process.argv.includes('--json');
const FLAG_DIR      = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6)
                      || path.join(__dirname, '..');

const DIR_MIGRATIONS = path.join(FLAG_DIR, 'supabase', 'migrations');

const C = FLAG_JSON ? { r: '', g: '', y: '', x: '' } : {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', x: '\x1b[0m',
};

function log(...args) { if (!FLAG_JSON) console.log(...args); }
function die(msg) { console.error(`${C.r}[FAIL] Error: ${msg}${C.x}`); process.exit(1); }

// Funciones internas de Postgres/Supabase que nunca van a tener un CREATE
// FUNCTION propio en el repo (triggers de extensiones, helpers de sistema
// que vinieron con el proyecto base, etc.) — no tiene sentido flaggearlas.
const IGNORAR = new Set([
  'armor', 'dearmor', 'gen_random_bytes', 'gen_random_uuid', 'gen_salt',
  'crypt', 'hmac', 'digest', 'pgp_sym_encrypt', 'pgp_sym_decrypt',
  'uuid_generate_v1', 'uuid_generate_v1mc', 'uuid_generate_v3',
  'uuid_generate_v4', 'uuid_generate_v5',
]);

function extraerNombresDeMigraciones() {
  if (!fs.existsSync(DIR_MIGRATIONS)) die(`No existe ${DIR_MIGRATIONS}`);
  const archivos = fs.readdirSync(DIR_MIGRATIONS).filter(f => f.endsWith('.sql'));
  const nombres = new Set();
  // CREATE FUNCTION nombre(  |  CREATE OR REPLACE FUNCTION public.nombre(
  const re = /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?\s*\(/gi;
  for (const archivo of archivos) {
    const contenido = fs.readFileSync(path.join(DIR_MIGRATIONS, archivo), 'utf8');
    let m;
    while ((m = re.exec(contenido)) !== null) {
      nombres.add(m[2].toLowerCase());
    }
  }
  return nombres;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    die('Faltan env vars: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas.\n' +
        'Uso: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhb... node scripts/audit-funciones-fantasma.js');
  }

  const trackeadas = extraerNombresDeMigraciones();

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: vivas, error } = await supabase.rpc('audit_funciones_vivas');
  if (error) die(`audit_funciones_vivas: ${error.message}`);

  const fantasmas = (vivas || []).filter(f =>
    !IGNORAR.has(f.funcion.toLowerCase()) &&
    !trackeadas.has(f.funcion.toLowerCase())
  );

  if (FLAG_JSON) {
    console.log(JSON.stringify({
      total_vivas: (vivas || []).length,
      total_trackeadas: trackeadas.size,
      fantasmas,
    }, null, 2));
    process.exit(fantasmas.length > 0 ? 1 : 0);
  }

  log('────────────────────────────────────────────────────────────');
  log('BARRIDO FUNCIONES FANTASMA — pg_proc vivo vs. supabase/migrations/');
  log('────────────────────────────────────────────────────────────\n');
  log(`Funciones vivas en public: ${(vivas || []).length}`);
  log(`Nombres distintos con CREATE FUNCTION en el repo: ${trackeadas.size}\n`);

  if (fantasmas.length) {
    log(`${C.r}⚠  ${fantasmas.length} función(es) fantasma — viven en la base pero no tienen ningún CREATE FUNCTION en supabase/migrations/:${C.x}`);
    for (const f of fantasmas) {
      log(`   - ${f.funcion}(${f.argumentos})  ${f.es_security_definer ? '[SECURITY DEFINER]' : ''}`);
    }
    log('\n   → Volcarlas al repo con: CREATE OR REPLACE FUNCTION ... (traer la definición real');
    log('     con pg_get_functiondef desde el SQL editor de Supabase) en una migración nueva,');
    log('     igual que se hizo con caja en la 241.');
  } else {
    log(`${C.g}[OK] Ninguna función fantasma — todo lo que vive en la base tiene un CREATE FUNCTION rastreable en el repo.${C.x}`);
  }

  process.exit(fantasmas.length > 0 ? 1 : 0);
}

main().catch(err => die(err.message));
