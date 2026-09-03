// scripts/audit-accesibilidad.js
//
// Pendiente #5 (accesibilidad) de la auditoría integral 2026 — no había
// script propio, ni siquiera una herramienta parcial armada. Corre
// axe-core (inyectado directo, sin @axe-core/playwright, para no arriesgar
// el conflicto de versión de playwright que casi rompe la suite de e2e la
// primera vez que se intentó esto) contra un set de páginas públicas
// servidas por el mismo static-server que usa tests/e2e/helpers/static-server.js
// (así el resultado refleja el mismo HTML/CSS que corre en producción, sin
// tocar nada de ese server).
//
// Alcance: páginas públicas (landing, login de cada portal, registro,
// privacidad) — las páginas admin autenticadas redirigen a login sin
// sesión real contra Supabase, y este sandbox no tiene red hacia Supabase,
// así que no se puede loguear de verdad acá (mismo límite que el pase
// manual, pendiente #3). Ver notas al final del reporte.
//
// Uso: node scripts/audit-accesibilidad.js [--json]

// IMPORTANTE: usar `playwright-core` (ya presente como dependencia del
// proyecto) y NO el paquete `playwright` completo — este último trae su
// propio test-runner embebido que choca con @playwright/test y rompe
// `test.beforeAll()` en la suite de e2e ("did Playwright Test not expect
// test.beforeAll() to be called here" / "two different versions of
// @playwright/test"). Es el mismo riesgo que la sesión anterior detectó
// al intentar instalar @axe-core/playwright.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer } from '../tests/e2e/helpers/static-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AXE_CORE_PATH = join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');

const PAGINAS = [
  { nombre: 'Landing', path: '/' },
  { nombre: 'Registro', path: '/registro' },
  { nombre: 'Privacidad', path: '/privacidad' },
  { nombre: 'Login admin', path: '/admin/login' },
  { nombre: 'Login cliente', path: '/cliente/login' },
  { nombre: 'Login chofer', path: '/chofer/login' },
  { nombre: 'Portal proveedor', path: '/proveedor/portal' },
];

async function auditarPagina(browser, baseURL, pagina, axeSource) {
  const page = await browser.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  try {
    await page.goto(baseURL + pagina.path, { waitUntil: 'load', timeout: 15000 });
    await page.addScriptTag({ content: axeSource });
    const resultado = await page.evaluate(async () => {
      return await window.axe.run(document, {
        resultTypes: ['violations'],
      });
    });
    return { ...pagina, ok: true, violaciones: resultado.violations, erroresConsola: errores };
  } catch (e) {
    return { ...pagina, ok: false, error: String(e), erroresConsola: errores };
  } finally {
    await page.close();
  }
}

async function main() {
  const soloJson = process.argv.includes('--json');
  if (!existsSync(AXE_CORE_PATH)) {
    console.error('Falta axe-core. Corré: npm install --no-save axe-core');
    process.exit(1);
  }
  const axeSource = readFileSync(AXE_CORE_PATH, 'utf8');

  const { server, baseURL } = await startStaticServer();
  // El paquete `playwright` recién instalado espera un build de Chromium
  // más nuevo (1234) del que ya está cacheado en este sandbox (1194, el
  // que usa playwright-core/@playwright-test del proyecto). Apuntamos
  // directo al binario ya presente en vez de descargar uno nuevo (sin
  // red hacia el CDN de Playwright en este entorno).
  const CACHED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(
    existsSync(CACHED_CHROMIUM) ? { executablePath: CACHED_CHROMIUM } : {}
  );

  const resultados = [];
  for (const pagina of PAGINAS) {
    resultados.push(await auditarPagina(browser, baseURL, pagina, axeSource));
  }

  await browser.close();
  server.close();

  const reporte = {
    generado_en: new Date().toISOString(),
    alcance: 'páginas públicas servidas por tests/e2e/helpers/static-server.js — no cubre páginas admin autenticadas (sin red a Supabase en este entorno, ver pendiente #3)',
    paginas: resultados.map((r) => ({
      nombre: r.nombre,
      path: r.path,
      ok: r.ok,
      error: r.error,
      total_violaciones: r.violaciones ? r.violaciones.length : null,
      violaciones: (r.violaciones || []).map((v) => ({
        id: v.id,
        impacto: v.impact,
        descripcion: v.description,
        ayuda_url: v.helpUrl,
        nodos_afectados: v.nodes.length,
        selectores: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      })),
      errores_consola: r.erroresConsola,
    })),
  };

  const outPath = join(ROOT, 'AUDITORIA_2026', 'reporte-accesibilidad.json');
  writeFileSync(outPath, JSON.stringify(reporte, null, 2));

  if (soloJson) {
    console.log(JSON.stringify(reporte, null, 2));
    return;
  }

  console.log('\n=== Auditoría de accesibilidad (axe-core) ===\n');
  let totalViolaciones = 0;
  for (const p of reporte.paginas) {
    if (!p.ok) {
      console.log(`✗ ${p.nombre} (${p.path}) — ERROR: ${p.error}`);
      continue;
    }
    totalViolaciones += p.total_violaciones;
    const marca = p.total_violaciones === 0 ? '✓' : '⚠';
    console.log(`${marca} ${p.nombre} (${p.path}) — ${p.total_violaciones} violación(es)`);
    for (const v of p.violaciones) {
      console.log(`    [${v.impacto}] ${v.id}: ${v.descripcion} (${v.nodos_afectados} nodo(s))`);
      for (const sel of v.selectores) console.log(`        ${sel}`);
    }
  }
  console.log(`\nTotal violaciones: ${totalViolaciones}`);
  console.log(`Reporte completo: ${outPath}\n`);

  if (totalViolaciones > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
