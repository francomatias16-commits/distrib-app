// Regresión de la escala de breakpoints --bp-* (480/640/900/1200px) —
// mismos 3 detectores que scripts/audit-mobile.js, pero corridos en
// varios anchos en vez de solo el mobile fijo de 375px. Nace del bug
// real encontrado en #filtros-der (pedidos/presupuestos): un overflow
// horizontal que solo aparece entre ~901px y ~1250px — fuera del
// rango que cubre audit-mobile.js (375px) y fuera de cualquier prueba
// puntual a un solo ancho "de escritorio" — por eso conviene barrer
// varios anchos, no solo los 4 puntos de la escala de tokens.
//
// Uso: npm run audit:breakpoints [-- --anchos=480,640,900,1200,1400]
//                                     [--paginas=pedidos,presupuestos] [--json]

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from '../tests/e2e/helpers/static-server.js';
import { vendorizarDexie, vendorizarSupabase } from '../tests/e2e/helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico } from '../tests/e2e/helpers/supabase-rest-mock.js';
import { loguearComoAdmin } from '../tests/e2e/helpers/auth-helper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'auditorias');

const ANCHOS_DEFAULT = [480, 640, 900, 1200];

// Mismo inventario que audit-mobile.js — ver el comentario ahí sobre
// por qué se mantiene una copia separada de la de smoke-universal.spec.js.
const PAGINAS_ADMIN_CON_SESION = [
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
];

function parseArgs(argv) {
  const out = { json: false, paginas: null, anchos: ANCHOS_DEFAULT };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg.startsWith('--paginas=')) out.paginas = arg.slice('--paginas='.length).split(',').filter(Boolean);
    else if (arg.startsWith('--anchos=')) out.anchos = arg.slice('--anchos='.length).split(',').map(Number).filter((n) => !Number.isNaN(n));
  }
  return out;
}

// Mismos 3 detectores que audit-mobile.js (overflow-x / overlap /
// input-anomalo), parametrizados por ancho de viewport en vez de fijo
// a 375px. Ver scripts/audit-mobile.js para el detalle de cada uno.
async function detectarBugs(page, vpWidth) {
  return page.evaluate((vw) => {
    const bugs = [];
    const MARGEN_SUBPIXEL = 2;

    for (const el of document.querySelectorAll('body *')) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.scrollWidth > vw + MARGEN_SUBPIXEL) {
        const rect = el.getBoundingClientRect();
        if (rect.right <= 0 || rect.left >= vw) continue;
        if (rect.width > vw + MARGEN_SUBPIXEL) {
          bugs.push({
            tipo: 'overflow-x',
            selector: describirSelector(el),
            detalle: `scrollWidth=${Math.round(el.scrollWidth)}px vs viewport=${vw}px`,
          });
        }
      }
    }

    const flotantes = document.querySelectorAll('.modal, .dropdown, .dropdown-menu');
    for (const flot of flotantes) {
      const styleFlot = window.getComputedStyle(flot);
      if (styleFlot.display === 'none' || styleFlot.visibility === 'hidden' || parseFloat(styleFlot.opacity) === 0) continue;
      const rectFlot = flot.getBoundingClientRect();
      if (rectFlot.width === 0 || rectFlot.height === 0) continue;
      if (rectFlot.right <= 0 || rectFlot.left >= vw || rectFlot.bottom <= 0) continue;

      const overlapsConflictivos = [];
      const candidatos = document.querySelectorAll('main *, #contenido-principal *, .contenido *');
      for (const otro of candidatos) {
        if (flot.contains(otro) || otro.contains(flot)) continue;
        const styleOtro = window.getComputedStyle(otro);
        if (styleOtro.display === 'none' || styleOtro.visibility === 'hidden') continue;
        const rectOtro = otro.getBoundingClientRect();
        if (rectOtro.width < 20 || rectOtro.height < 20) continue;
        const cruzan = !(rectOtro.right <= rectFlot.left || rectOtro.left >= rectFlot.right ||
                          rectOtro.bottom <= rectFlot.top || rectOtro.top >= rectFlot.bottom);
        if (cruzan) overlapsConflictivos.push(describirSelector(otro));
      }
      if (overlapsConflictivos.length) {
        bugs.push({
          tipo: 'overlap',
          selector: describirSelector(flot),
          detalle: `se cruza con: ${[...new Set(overlapsConflictivos)].slice(0, 3).join(', ')}`,
        });
      }
    }

    const campos = document.querySelectorAll('input, select, textarea');
    for (const campo of campos) {
      const style = window.getComputedStyle(campo);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (campo.type === 'hidden' || campo.type === 'checkbox' || campo.type === 'radio') continue;
      if (campo.offsetHeight > 100) {
        bugs.push({
          tipo: 'input-anomalo',
          selector: describirSelector(campo),
          detalle: `offsetHeight=${campo.offsetHeight}px`,
        });
      }
    }

    function describirSelector(el) {
      if (el.id) return `#${el.id}`;
      const clases = (el.className && typeof el.className === 'string')
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
      return `${el.tagName.toLowerCase()}${clases}`;
    }

    return bugs;
  }, vpWidth);
}

async function auditarPagina(browser, staticServer, nombre, ancho) {
  const context = await browser.newContext({ viewport: { width: ancho, height: 900 } });
  const page = await context.newPage();
  try {
    await vendorizarDexie(page);
    await vendorizarSupabase(page);
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await loguearComoAdmin(page);

    const url = `${staticServer.baseURL}/frontend/admin/${nombre}.html`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(400);

    if (!response || response.status() >= 400) {
      return { nombre, ancho, error: `HTTP ${response?.status()}`, bugs: [] };
    }

    const bugs = await detectarBugs(page, ancho);
    return { nombre, ancho, bugs };
  } catch (e) {
    return { nombre, ancho, error: e.message, bugs: [] };
  } finally {
    await context.close();
  }
}

function severidad(bug) {
  if (bug.tipo === 'overlap') return 'P0';
  return 'P1';
}

async function main() {
  const { json, paginas, anchos } = parseArgs(process.argv.slice(2));
  const listaPaginas = paginas || PAGINAS_ADMIN_CON_SESION;

  mkdirSync(OUT_DIR, { recursive: true });

  const staticServer = await startStaticServer();
  const browser = await chromium.launch();
  const resultados = {};

  for (const ancho of anchos) {
    resultados[ancho] = [];
    for (const nombre of listaPaginas) {
      process.stderr.write(`Auditando ${nombre} @ ${ancho}px...\n`);
      resultados[ancho].push(await auditarPagina(browser, staticServer, nombre, ancho));
    }
  }

  await browser.close();
  staticServer.server.close();

  const fecha = new Date().toISOString().slice(0, 10);
  const reportPath = join(OUT_DIR, `${fecha}_auditoria_breakpoints.md`);

  let md = `# Auditoría de breakpoints (--bp-*) — ${fecha}\n\n`;
  md += `Anchos: ${anchos.join('px, ')}px. ${listaPaginas.length} páginas por ancho.\n\n`;

  let totalBugs = 0;
  for (const ancho of anchos) {
    const resultadosAncho = resultados[ancho];
    const conBugs = resultadosAncho.filter((r) => r.bugs.length > 0 || r.error);
    const bugsAncho = resultadosAncho.reduce((acc, r) => acc + r.bugs.length, 0);
    totalBugs += bugsAncho;
    md += `## ${ancho}px — ${bugsAncho} hallazgos en ${conBugs.length} páginas\n\n`;
    if (conBugs.length === 0) {
      md += `Sin hallazgos.\n\n`;
      continue;
    }
    md += `| Página | Bug | Selector | Severidad | Detalle |\n|---|---|---|---|---|\n`;
    for (const r of resultadosAncho) {
      if (r.error) {
        md += `| ${r.nombre} | ERROR DE CARGA | — | P0 | ${r.error} |\n`;
        continue;
      }
      for (const bug of r.bugs) {
        md += `| ${r.nombre} | ${bug.tipo} | \`${bug.selector}\` | ${severidad(bug)} | ${bug.detalle} |\n`;
      }
    }
    md += `\n`;
  }

  writeFileSync(reportPath, md);
  process.stderr.write(`\nReporte: ${reportPath}\n`);

  if (json) {
    console.log(JSON.stringify(resultados, null, 2));
  } else {
    console.log(md);
  }

  const hayP0 = Object.values(resultados).some((lista) =>
    lista.some((r) => r.error || r.bugs.some((b) => severidad(b) === 'P0')));
  process.exitCode = hayP0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
