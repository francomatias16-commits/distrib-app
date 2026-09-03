// scripts/audit-lighthouse.js
//
// Pendiente #5 (Lighthouse) de la auditoría integral 2026. Corre Lighthouse
// contra Chromium, apuntando al mismo static-server que usa la suite de
// e2e (tests/e2e/helpers/static-server.js), sobre el mismo set de páginas
// públicas que scripts/audit-accesibilidad.js — ver ese script para el
// porqué del alcance (sin red a Supabase en este entorno no se puede
// loguear de verdad, así que las páginas admin autenticadas quedan afuera).
//
// Uso: node scripts/audit-lighthouse.js [--json]

import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../tests/e2e/helpers/static-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PAGINAS = [
  { nombre: 'Landing', path: '/' },
  { nombre: 'Registro', path: '/registro' },
  { nombre: 'Privacidad', path: '/privacidad' },
  { nombre: 'Login admin', path: '/admin/login' },
];

async function main() {
  const soloJson = process.argv.includes('--json');
  const { server, baseURL } = await startStaticServer();

  const CACHED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const chrome = await chromeLauncher.launch({
    chromePath: CACHED_CHROMIUM,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });

  const resultados = [];
  try {
    for (const pagina of PAGINAS) {
      const runnerResult = await lighthouse(baseURL + pagina.path, {
        port: chrome.port,
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        output: 'json',
        logLevel: 'error',
      });
      const lhr = runnerResult.lhr;
      resultados.push({
        nombre: pagina.nombre,
        path: pagina.path,
        scores: Object.fromEntries(
          Object.entries(lhr.categories).map(([k, v]) => [k, Math.round(v.score * 100)])
        ),
        oportunidades: Object.values(lhr.audits)
          .filter((a) => a.score !== null && a.score < 0.9 && a.details?.type === 'opportunity')
          .map((a) => ({ id: a.id, titulo: a.title, ahorro_ms: a.numericValue })),
      });
    }
  } finally {
    await chrome.kill();
    server.close();
  }

  const reporte = {
    generado_en: new Date().toISOString(),
    alcance: 'páginas públicas servidas por tests/e2e/helpers/static-server.js — no cubre páginas admin autenticadas (sin red a Supabase en este entorno, ver pendiente #3)',
    paginas: resultados,
  };

  mkdirSync(join(ROOT, 'AUDITORIA_2026'), { recursive: true });
  const outPath = join(ROOT, 'AUDITORIA_2026', 'reporte-lighthouse.json');
  writeFileSync(outPath, JSON.stringify(reporte, null, 2));

  if (soloJson) {
    console.log(JSON.stringify(reporte, null, 2));
    return;
  }

  console.log('\n=== Auditoría Lighthouse ===\n');
  for (const p of reporte.paginas) {
    console.log(`${p.nombre} (${p.path})`);
    for (const [cat, score] of Object.entries(p.scores)) {
      console.log(`    ${cat}: ${score}/100`);
    }
    for (const op of p.oportunidades) {
      console.log(`    ⚠ ${op.titulo} (~${Math.round(op.ahorro_ms)}ms)`);
    }
    console.log('');
  }
  console.log(`Reporte completo: ${outPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
