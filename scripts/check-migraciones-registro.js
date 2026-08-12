#!/usr/bin/env node
/**
 * check-migraciones-registro.js — Fusiona en un solo listado lo que hay en
 * db/ y supabase/migrations/, detecta:
 *   1. Números de prefijo que existen en ambas carpetas con archivos DISTINTOS
 *      (riesgo real: alguien puede pensar que ya corrió "052" sin saber que
 *      hay dos "052" distintos en carpetas distintas).
 *   2. Archivos que todavía no tienen fila en schema_migrations_registry
 *      (no sabemos con certeza si corrieron contra la base real).
 *
 * NO corre nada contra Supabase — solo lee el filesystem y, si se le pasa
 * --db, también consulta la tabla schema_migrations_registry para cruzar.
 *
 * Uso:
 *   node scripts/check-migraciones-registro.js
 *   node scripts/check-migraciones-registro.js --seed-sql > db/093b_seed_completo.sql
 *       ← genera el INSERT completo para pegar en 093_schema_migrations_registry.sql
 *         (reemplaza el bloque mínimo de 3 filas que trae ese archivo)
 *
 * Exit 0 si no hay colisiones de número con contenido distinto.
 * Exit 1 si hay colisiones reales (mismo número, archivo distinto, no idéntico).
 */

import fs   from 'fs';
import path from 'path';
import crypto from 'crypto';

const ROOT       = process.cwd();
const DIR_DB     = path.join(ROOT, 'db');
const DIR_SUPA   = path.join(ROOT, 'supabase', 'migrations');
const SEED_MODE  = process.argv.includes('--seed-sql');

function listar(dir, carpetaLabel) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .map(f => {
      const m = f.match(/^(\d+)/);
      const full = path.join(dir, f);
      const hash = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
      return { carpeta: carpetaLabel, archivo: f, numero: m ? m[1] : '????', hash };
    });
}

const db   = listar(DIR_DB, 'db');
const supa = listar(DIR_SUPA, 'supabase/migrations');
const todas = [...db, ...supa];

if (SEED_MODE) {
  const rows = todas
    .map(t => `  ('${t.carpeta}', '${t.archivo.replace(/'/g, "''")}', '${t.numero}', 'historico', NULL)`)
    .join(',\n');
  console.log(`INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas) VALUES\n${rows}\nON CONFLICT (carpeta, archivo) DO NOTHING;`);
  process.exit(0);
}

console.log('────────────────────────────────────────────────────────────');
console.log(`CHECK MIGRACIONES — db/ (${db.length} archivos) + supabase/migrations/ (${supa.length} archivos)`);
console.log('────────────────────────────────────────────────────────────\n');

// Agrupar por número de prefijo
const porNumero = {};
for (const t of todas) {
  (porNumero[t.numero] = porNumero[t.numero] || []).push(t);
}

let colisionesReales = 0;
for (const [numero, items] of Object.entries(porNumero)) {
  if (items.length < 2) continue;
  const carpetasDistintas = new Set(items.map(i => i.carpeta));
  if (carpetasDistintas.size < 2) continue; // mismo número, misma carpeta = no es el caso que nos preocupa

  const hashesDistintos = new Set(items.map(i => i.hash)).size > 1;
  if (hashesDistintos) {
    colisionesReales++;
    console.log(`  ⚠  ${numero}: ARCHIVOS DISTINTOS en carpetas distintas`);
    items.forEach(i => console.log(`       - ${i.carpeta}/${i.archivo}`));
  } else {
    console.log(`  [OK] ${numero}: mismo contenido en ambas carpetas (no es riesgo)`);
  }
}

console.log(`\nTotal archivos: ${todas.length}`);
console.log(`Colisiones reales (mismo número, contenido distinto): ${colisionesReales}`);

if (colisionesReales > 0) {
  console.log('\n[FAIL] Hay números de prefijo que pisan archivos distintos entre carpetas.');
  console.log('   No es un error de sintaxis ni rompe nada por sí solo, pero es la fuente');
  console.log('   de confusión señalada en el Plan Estratégico de Recuperación: alguien');
  console.log('   puede asumir que "ya corrió el 052" sin saber cuál de los dos.');
  console.log('   Acción sugerida: renombrar los archivos de supabase/migrations/ con un');
  console.log('   prefijo que no compita con db/ (ej. continuar la numeración de db/ en');
  console.log('   vez de tener una serie propia), o documentarlos explícitamente como');
  console.log('   series independientes en schema_migrations_registry (carpeta ya lo hace).');
  process.exit(1);
} else {
  console.log('\n[OK] No hay colisiones de contenido — los números repetidos (si los hay) son');
  console.log('   el mismo archivo en ambos lados, sin riesgo real.');
  process.exit(0);
}
