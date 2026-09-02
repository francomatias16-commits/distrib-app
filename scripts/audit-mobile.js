// Fase 0 / Fase 3 del PLAN_RESPONSIVE_MOBILE_COMPLETO.md — auditoría
// automatizada de mobile, reusable como `npm run audit:mobile`.
//
// Reusa toda la infraestructura ya construida para los E2E (auth-helper,
// supabase-rest-mock, mock-network, static-server) en vez de duplicar
// mocks: visita las páginas admin CON sesión en viewport 375x812 (el más
// común en las capturas reales que motivaron el plan), y detecta 3
// patrones de bug conocidos vía DOM/CSSOM:
//
//   1. Scroll horizontal no deseado: algún elemento excede el ancho del
//      viewport (`el.scrollWidth > viewport.width`, con margen chico para
//      redondeo de subpíxel).
//   2. Elementos superpuestos: bounding boxes de `.modal`/`.dropdown`
//      visibles que se cruzan con contenido de página también visible
//      (candidato exacto al bug de "los modales se superponen").
//   3. Inputs/selects con `offsetHeight` anómalo (>100px) — el bug
//      concreto de la captura original (`.filtros-bar`).
//
// Salida: docs/auditorias/YYYY-MM_auditoria_mobile.md + screenshots en
// docs/auditorias/screenshots_mobile/. No requiere red externa: todo el
// tráfico de Supabase/API se mockea igual que en smoke-universal.spec.js.
//
// Uso: npm run audit:mobile [-- --paginas=clientes,stock] [--json]

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from '../tests/e2e/helpers/static-server.js';
import { vendorizarDexie, vendorizarSupabase, filtrarRuidoRed } from '../tests/e2e/helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico } from '../tests/e2e/helpers/supabase-rest-mock.js';
import { loguearComoAdmin } from '../tests/e2e/helpers/auth-helper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'auditorias');
const SHOTS_DIR = join(OUT_DIR, 'screenshots_mobile');

const VIEWPORT = { width: 375, height: 812 };

// Mismo inventario que smoke-universal.spec.js (52 páginas admin con
// sesión) — fuente única sería mejor, pero se mantiene una copia acá a
// propósito: el smoke test verifica "carga sin error" (Fase 0.5 del plan
// E2E), esta auditoría verifica "se ve bien en mobile" (Fase 0 del plan
// responsive) — son dos preguntas distintas que conviene poder ajustar
// por separado sin que un cambio en una implique tocar la otra.
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
// Excluidas a propósito (mismo criterio que smoke-universal): wizards/
// pantallas de sistema sin el layout admin normal, no aportan a una
// auditoría de "cómo se ve el panel en el celular".
// migracion, setup, setup-wizard, superadmin, suspendida

function parseArgs(argv) {
  const out = { json: false, paginas: null };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg.startsWith('--paginas=')) out.paginas = arg.slice('--paginas='.length).split(',').filter(Boolean);
  }
  return out;
}

// Los 3 detectores corren DENTRO de la página (page.evaluate) para poder
// leer scrollWidth/getBoundingClientRect real post-render.
async function detectarBugs(page) {
  return page.evaluate((vpWidth) => {
    const bugs = [];
    const MARGEN_SUBPIXEL = 2;

    // 1. Overflow horizontal: cualquier elemento visible cuyo scrollWidth
    // exceda el ancho del viewport. Se excluyen los que están fuera de
    // pantalla a propósito (paneles .modal cerrados con `right` negativo
    // o `transform: translateX(100%)`, tooltips, etc.) — un elemento
    // ancho que nunca se pinta dentro del viewport no genera scroll
    // horizontal real, aunque su scrollWidth individual sea grande.
    // Un elemento que overflowea dentro de un ancestro con overflow-x
    // auto/scroll (y cuyo propio ancho SÍ entra en el viewport) es scroll
    // horizontal contenido a propósito (ej. tabla ancha en una card con
    // overflow-x:auto) — no es el bug que este detector busca, que es
    // contenido que se escapa de la página y rompe el layout general.
    function tieneAncestroScrollContenido(el) {
      let nodo = el.parentElement;
      while (nodo && nodo !== document.body) {
        const styleNodo = window.getComputedStyle(nodo);
        if (styleNodo.overflowX === 'auto' || styleNodo.overflowX === 'scroll') {
          const rectNodo = nodo.getBoundingClientRect();
          if (rectNodo.width <= vpWidth + MARGEN_SUBPIXEL) return true;
        }
        nodo = nodo.parentElement;
      }
      return false;
    }

    const candidatosOverflow = document.querySelectorAll('body *');
    for (const el of candidatosOverflow) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (el.scrollWidth > vpWidth + MARGEN_SUBPIXEL) {
        const rect = el.getBoundingClientRect();
        if (rect.right <= 0 || rect.left >= vpWidth) continue; // fuera de pantalla
        // Solo interesa si el propio elemento (no un hijo invisible)
        // realmente se pinta más ancho que el viewport.
        if (rect.width > vpWidth + MARGEN_SUBPIXEL) {
          if (tieneAncestroScrollContenido(el)) continue; // scroll horizontal contenido a propósito
          bugs.push({
            tipo: 'overflow-x',
            selector: describirSelector(el),
            detalle: `scrollWidth=${Math.round(el.scrollWidth)}px vs viewport=${vpWidth}px`,
          });
        }
      }
    }

    // 2. Elementos superpuestos: .modal/.dropdown visibles cuyo bounding
    // box se cruza con otro elemento de contenido también visible (que
    // no sea su propio backdrop/ancestro/descendiente).
    const flotantes = document.querySelectorAll('.modal, .dropdown, .dropdown-menu');
    for (const flot of flotantes) {
      const styleFlot = window.getComputedStyle(flot);
      if (styleFlot.display === 'none' || styleFlot.visibility === 'hidden' || parseFloat(styleFlot.opacity) === 0) continue;
      const rectFlot = flot.getBoundingClientRect();
      if (rectFlot.width === 0 || rectFlot.height === 0) continue;
      // Fuera de pantalla (paneles laterales cerrados con right negativo,
      // transform translateX, etc.) no cuenta como superposición.
      if (rectFlot.right <= 0 || rectFlot.left >= vpWidth || rectFlot.bottom <= 0) continue;

      const overlapsConflictivos = [];
      const candidatos = document.querySelectorAll('main *, #contenido-principal *, .contenido *');
      for (const otro of candidatos) {
        if (flot.contains(otro) || otro.contains(flot)) continue;
        const styleOtro = window.getComputedStyle(otro);
        if (styleOtro.display === 'none' || styleOtro.visibility === 'hidden') continue;
        const rectOtro = otro.getBoundingClientRect();
        if (rectOtro.width < 20 || rectOtro.height < 20) continue; // ruido de wrappers chicos
        const cruzan = !(rectOtro.right <= rectFlot.left || rectOtro.left >= rectFlot.right ||
                          rectOtro.bottom <= rectFlot.top || rectOtro.top >= rectFlot.bottom);
        if (cruzan) { overlapsConflictivos.push(describirSelector(otro)); }
      }
      if (overlapsConflictivos.length) {
        bugs.push({
          tipo: 'overlap',
          selector: describirSelector(flot),
          detalle: `se cruza con: ${[...new Set(overlapsConflictivos)].slice(0, 3).join(', ')}`,
        });
      }
    }

    // 3. Inputs/selects con altura anómala (>100px) — el bug de la
    // captura original.
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
  }, VIEWPORT.width);
}

async function auditarPagina(browser, staticServer, nombre) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const erroresConsola = [];
  page.on('console', (msg) => { if (msg.type() === 'error') erroresConsola.push(msg.text()); });

  try {
    await vendorizarDexie(page);
    await vendorizarSupabase(page);
    mockearRestGenerico(page);
    mockearApiGenerico(page);
    await loguearComoAdmin(page);

    const url = `${staticServer.baseURL}/frontend/admin/${nombre}.html`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500); // margen para renders async post-load

    if (!response || response.status() >= 400) {
      return { nombre, error: `HTTP ${response?.status()}`, bugs: [] };
    }

    const bugs = await detectarBugs(page);
    const shotPath = join(SHOTS_DIR, `${nombre}.png`);
    await page.screenshot({ path: shotPath, fullPage: true });

    const ruidoReal = filtrarRuidoRed(erroresConsola);

    return { nombre, bugs, erroresConsola: ruidoReal, screenshot: shotPath };
  } catch (e) {
    return { nombre, error: e.message, bugs: [] };
  } finally {
    await context.close();
  }
}

function severidad(bug) {
  if (bug.tipo === 'overlap') return 'P0';
  if (bug.tipo === 'input-anomalo') return 'P1';
  return 'P1'; // overflow-x
}

async function main() {
  const { json, paginas } = parseArgs(process.argv.slice(2));
  const lista = paginas || PAGINAS_ADMIN_CON_SESION;

  mkdirSync(SHOTS_DIR, { recursive: true });

  const staticServer = await startStaticServer();
  const browser = await chromium.launch();
  const resultados = [];

  for (const nombre of lista) {
    process.stderr.write(`Auditando ${nombre}...\n`);
    resultados.push(await auditarPagina(browser, staticServer, nombre));
  }

  await browser.close();
  staticServer.server.close();

  const fecha = new Date().toISOString().slice(0, 7); // YYYY-MM
  const reportPath = join(OUT_DIR, `${fecha}_auditoria_mobile.md`);

  const totalBugs = resultados.reduce((acc, r) => acc + r.bugs.length, 0);
  const conBugs = resultados.filter((r) => r.bugs.length > 0);
  const conError = resultados.filter((r) => r.error);

  let md = `# Auditoría mobile automatizada — ${fecha}\n\n`;
  md += `Viewport: ${VIEWPORT.width}x${VIEWPORT.height}. ${resultados.length} páginas visitadas, `;
  md += `${totalBugs} hallazgos en ${conBugs.length} páginas`;
  md += conError.length ? `, ${conError.length} páginas con error de carga.\n\n` : '.\n\n';

  md += `| Página | Bug | Selector | Severidad | Detalle |\n|---|---|---|---|---|\n`;
  for (const r of resultados) {
    if (r.error) {
      md += `| ${r.nombre} | ERROR DE CARGA | — | P0 | ${r.error} |\n`;
      continue;
    }
    for (const bug of r.bugs) {
      md += `| ${r.nombre} | ${bug.tipo} | \`${bug.selector}\` | ${severidad(bug)} | ${bug.detalle} |\n`;
    }
  }
  if (totalBugs === 0 && conError.length === 0) {
    md += `| (ninguna) | — | — | — | Sin hallazgos en esta corrida |\n`;
  }

  md += `\nScreenshots completos en \`docs/auditorias/screenshots_mobile/\`.\n`;

  writeFileSync(reportPath, md);
  process.stderr.write(`\nReporte: ${reportPath}\n`);

  if (json) {
    console.log(JSON.stringify(resultados, null, 2));
  } else {
    console.log(md);
  }

  // Exit code no-cero si hay P0 (overlap o error de carga) — para uso en
  // CI si en algún momento se agrega a un pipeline.
  const hayP0 = resultados.some((r) => r.error || r.bugs.some((b) => severidad(b) === 'P0'));
  process.exitCode = hayP0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
