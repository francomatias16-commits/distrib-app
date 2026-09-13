// scripts/audit-accesibilidad.js
//
// Pendiente #5 (accesibilidad) de la auditoría integral 2026 — no había
// script propio, ni siquiera una herramienta parcial armada. Corre
// axe-core (inyectado directo, sin @axe-core/playwright, para no arriesgar
// el conflicto de versión de playwright que casi rompe la suite de e2e la
// primera vez que se intentó esto) contra un set de páginas servidas por
// el mismo static-server que usa tests/e2e/helpers/static-server.js (así
// el resultado refleja el mismo HTML/CSS que corre en producción, sin
// tocar nada de ese server).
//
// [2.2, PLAN_UIUX_OPTIMIZACION_TOTAL.md] Alcance ampliado: además de las
// páginas públicas (landing, login de cada portal, registro, privacidad),
// ahora audita también las páginas admin autenticadas, reusando el mismo
// mecanismo de sesión mockeada que ya usan audit-mobile.js/
// audit-breakpoints.js (vendorizarDexie/vendorizarSupabase + mocks REST/API
// genéricos + loguearComoAdmin) — nunca pega contra Supabase real, así que
// no depende de la red del sandbox hacia Supabase (esa era la limitación
// original, no una limitación de axe-core/Playwright en sí). Mismo
// inventario de 44 páginas que audit-mobile.js (PAGINAS_ADMIN_CON_SESION),
// para no mantener dos listas que puedan divergir.
//
// Uso: node scripts/audit-accesibilidad.js [--json] [--solo-publicas] [--solo-admin]

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
import { vendorizarDexie, vendorizarSupabase } from '../tests/e2e/helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico } from '../tests/e2e/helpers/supabase-rest-mock.js';
import { loguearComoAdmin } from '../tests/e2e/helpers/auth-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AXE_CORE_PATH = join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');

const PAGINAS_PUBLICAS = [
  { nombre: 'Landing', path: '/' },
  { nombre: 'Registro', path: '/registro' },
  { nombre: 'Privacidad', path: '/privacidad' },
  { nombre: 'Login admin', path: '/admin/login' },
  { nombre: 'Login cliente', path: '/cliente/login' },
  { nombre: 'Login chofer', path: '/chofer/login' },
  { nombre: 'Portal proveedor', path: '/proveedor/portal' },
];

// Mismo inventario que audit-mobile.js (PAGINAS_ADMIN_CON_SESION) — fuente
// única sería mejor, pero se mantiene copia a propósito por el mismo
// motivo que ese script documenta: "auditoría mobile" y "auditoría a11y"
// son preguntas distintas que conviene poder ajustar por separado. Si se
// agrega/saca una página admin, revisar también audit-mobile.js.
const PAGINAS_ADMIN = [
  'anomalias', 'auditoria', 'automatizacion', 'avisos', 'cajas', 'cc-proveedores',
  'cheques', 'clientes', 'cobranzas', 'comparador-precios', 'compras',
  'conciliacion-bancaria', 'cta-cte', 'dashboard', 'devoluciones', 'empresa-config',
  'export-contable', 'facturacion-config', 'facturacion', 'fidelizacion',
  'liquidacion', 'lotes', 'mercadopago-config', 'notas', 'notif-log',
  'observabilidad', 'pedidos', 'pos', 'presupuestos', 'productos', 'proveedores',
  'puntos', 'reglas-precio', 'rentabilidad-producto-vendedor', 'rentabilidad-zona',
  'reportes-financieros', 'reportes-stock', 'reportes-ventas', 'riesgo-cheques',
  'rutas', 'saas-billing', 'stock', 'usuarios', 'vencimientos',
  'whatsapp-conversaciones', 'whatsapp-onboarding',
].map((nombre) => ({ nombre: `Admin: ${nombre}`, path: `/frontend/admin/${nombre}.html`, admin: true }));

async function correrAxe(page, axeSource) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    return await window.axe.run(document, { resultTypes: ['violations'] });
  });
}

async function auditarPaginaPublica(browser, baseURL, pagina, axeSource) {
  const page = await browser.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  try {
    await page.goto(baseURL + pagina.path, { waitUntil: 'load', timeout: 15000 });
    const resultado = await correrAxe(page, axeSource);
    return { ...pagina, ok: true, violaciones: resultado.violations, erroresConsola: errores };
  } catch (e) {
    return { ...pagina, ok: false, error: String(e), erroresConsola: errores };
  } finally {
    await page.close();
  }
}

// Mismo patrón de mocks que audit-mobile.js/audit-breakpoints.js: sesión
// admin sembrada + REST/API genéricos mockeados, nunca pega contra
// Supabase real. Corre en viewport desktop (esta auditoría es de
// accesibilidad, no de responsive — eso ya lo cubre audit-mobile.js/
// audit-breakpoints.js por separado).
async function auditarPaginaAdmin(browser, baseURL, pagina, axeSource) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  try {
    await vendorizarDexie(page);
    await vendorizarSupabase(page);
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await loguearComoAdmin(page);

    const response = await page.goto(baseURL + pagina.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500); // margen para renders async post-load, mismo criterio que audit-mobile.js

    if (!response || response.status() >= 400) {
      return { ...pagina, ok: false, error: `HTTP ${response?.status()}`, erroresConsola: errores };
    }

    const resultado = await correrAxe(page, axeSource);
    return { ...pagina, ok: true, violaciones: resultado.violations, erroresConsola: errores };
  } catch (e) {
    return { ...pagina, ok: false, error: String(e), erroresConsola: errores };
  } finally {
    await context.close();
  }
}

function parseArgs(argv) {
  const out = { json: false, soloPublicas: false, soloAdmin: false };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg === '--solo-publicas') out.soloPublicas = true;
    else if (arg === '--solo-admin') out.soloAdmin = true;
  }
  return out;
}

async function main() {
  const { json: soloJson, soloPublicas, soloAdmin } = parseArgs(process.argv.slice(2));
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
  if (!soloAdmin) {
    for (const pagina of PAGINAS_PUBLICAS) {
      resultados.push(await auditarPaginaPublica(browser, baseURL, pagina, axeSource));
    }
  }
  if (!soloPublicas) {
    for (const pagina of PAGINAS_ADMIN) {
      resultados.push(await auditarPaginaAdmin(browser, baseURL, pagina, axeSource));
    }
  }

  await browser.close();
  server.close();

  const reporte = {
    generado_en: new Date().toISOString(),
    alcance: 'páginas públicas + páginas admin autenticadas (sesión mockeada, mismo mecanismo que audit-mobile.js/audit-breakpoints.js — nunca pega contra Supabase real). Ver PLAN_UIUX_OPTIMIZACION_TOTAL.md 2.2.',
    paginas: resultados.map((r) => ({
      nombre: r.nombre,
      path: r.path,
      admin: !!r.admin,
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
