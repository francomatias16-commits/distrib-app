#!/usr/bin/env node
/**
 * ai-explore-screens.js
 *
 * Aproximación gratuita al "agente recorriendo pantallas como tester manual"
 * (Fase 2 del plan). Reusa la MISMA infraestructura que ya usa
 * tests/e2e/specs/smoke-universal.spec.js (server estático, mocks de
 * Supabase/API, helpers de login) — la diferencia es el criterio final:
 * en vez de solo comprobar "no explota", le pide a un modelo con visión
 * (Gemini free tier) que juzgue si la pantalla se ve bien.
 *
 * Pensado para correr semanal (cron) o manual (workflow_dispatch), NUNCA
 * en cada commit: usar visión gasta cuota mucho más rápido que texto.
 *
 * Requiere (env vars, inyectadas desde el workflow):
 *  - GITHUB_TOKEN, GITHUB_REPOSITORY  : para abrir/actualizar el issue
 *  - GEMINI_API_KEYS  : free tier de Gemini, una o más keys separadas por
 *    coma. Con más de una, el script rota a la siguiente key del mismo
 *    modelo apenas una se queda sin cuota, en vez de caer directo al
 *    modelo de respaldo — estira la cuota gratuita total disponible.
 *    (GEMINI_API_KEY, singular, se sigue aceptando como alias de una sola
 *    key, por compatibilidad con el setup anterior.)
 *  - GEMINI_MODEL / GEMINI_FALLBACK_MODEL : opcionales, mismos defaults
 *    que scripts/ai-review-pr.js
 *  - EXPLORE_PAGINAS   : opcional, lista separada por comas de páginas
 *    admin a recorrer (sin ".html"). Default: subset curado abajo.
 *  - EXPLORE_VIEWPORTS : opcional, lista separada por comas de anchos de
 *    escritorio a probar por página, formato "ANCHOxALTO" (ej.
 *    "1280x800,1920x1080"). Default: dos anchos (ver VIEWPORTS_DEFAULT
 *    abajo). Cada viewport extra MULTIPLICA la cantidad de llamadas a
 *    Gemini (páginas × viewports) — con GEMINI_API_KEYS rotando varias
 *    keys alcanza la cuota, pero si se agranda EXPLORE_PAGINAS conviene
 *    achicar esto, y viceversa. El rango mobile (<=768px) ya lo cubre
 *    aparte scripts/audit-mobile.js con un criterio programático (no
 *    visión); acá el foco es breakpoints de escritorio "intermedios" —
 *    el caso real que motivó esto: a 1846px .filtros-der (pedidos,
 *    stock, clientes, facturación) fragmentaba mal el botón Excel, bug
 *    que ni 1280px ni el mobile audit podían haber detectado.
 *  - EXPLORE_DELAY_MS  : opcional, pausa entre llamadas a Gemini para no
 *    pasarse del free tier (default 4500ms ≈ 13 req/min).
 *
 * No agrega dependencias nuevas: usa Playwright (ya devDependency para
 * el E2E existente) y fetch nativo de Node 24.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startStaticServer } from '../tests/e2e/helpers/static-server.js';
import { vendorizarDexie, vendorizarSupabase, filtrarRuidoRed } from '../tests/e2e/helpers/mock-network.js';
import { mockearRestGenerico, mockearApiGenerico } from '../tests/e2e/helpers/supabase-rest-mock.js';
import { loguearComoAdmin } from '../tests/e2e/helpers/auth-helper.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
const DELAY_MS = Number(process.env.EXPLORE_DELAY_MS || 4500);

// Últimos 4 caracteres de la key, solo para poder distinguir en los logs
// cuál está agotada sin imprimir la key completa.
function etiquetaKey(key) {
  return key ? `...${key.slice(-4)}` : '(sin key)';
}

// Dos anchos de escritorio por defecto: uno "angosto" (1280, el viejo
// fijo original) y uno "ancho" (1920, cerca del 1846 real que disparó el
// bug de .filtros-der). No incluye mobile a propósito, ver EXPLORE_VIEWPORTS
// arriba — eso ya lo cubre scripts/audit-mobile.js.
const VIEWPORTS_DEFAULT = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

function parseViewports(raw) {
  if (!raw) return VIEWPORTS_DEFAULT;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((par) => {
      const m = /^(\d+)x(\d+)$/i.exec(par);
      if (!m) {
        throw new Error(`EXPLORE_VIEWPORTS: "${par}" no tiene el formato "ANCHOxALTO" (ej. 1920x1080).`);
      }
      return { width: Number(m[1]), height: Number(m[2]) };
    });
  return parsed.length ? parsed : VIEWPORTS_DEFAULT;
}

const VIEWPORTS = parseViewports(process.env.EXPLORE_VIEWPORTS);
const etiquetaViewport = (vp) => `${vp.width}x${vp.height}`;

// Marcador oculto para encontrar y actualizar SIEMPRE el mismo issue en vez
// de abrir uno nuevo por cada corrida semanal.
const MARKER = '<!-- ai-explore-bot:marker -->';

// Subset curado por defecto: pantallas de alto tráfico / alto impacto visual
// si algo se rompe. La lista completa de 52 páginas vive en
// tests/e2e/specs/smoke-universal.spec.js (fuente de verdad para el smoke
// funcional) — acá mantenemos una lista más corta a propósito: cada página
// extra es una llamada más a la cuota gratuita de visión de Gemini.
// Para una pasada completa, seteá EXPLORE_PAGINAS con la lista que quieras.
const PAGINAS_DEFAULT = [
  'dashboard', 'pedidos', 'pos', 'productos', 'stock', 'clientes',
  'facturacion', 'cta-cte', 'cobranzas', 'rutas', 'cheques', 'reportes-ventas',
];

const PAGINAS_SIN_NAV_ROOT = new Set([
  'cta-cte', 'dashboard', 'liquidacion', 'lotes', 'presupuestos',
  'setup-wizard', 'setup', 'superadmin', 'suspendida',
]);

const SCREENSHOTS_DIR = path.join(process.cwd(), 'ai-explore-screenshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── GitHub API (mismo patrón que scripts/ai-review-pr.js) ──────────────

async function githubApi(apiPath, options = {}) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${apiPath} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function findMarkerIssue() {
  const res = await githubApi(`/repos/${REPO}/issues?state=open&labels=exploracion-ia&per_page=50`);
  const issues = await res.json();
  return issues.find((i) => i.body?.includes(MARKER)) || null;
}

async function upsertIssue(body, hayHallazgos) {
  const existing = await findMarkerIssue().catch(() => null);

  if (!hayHallazgos) {
    if (existing) {
      await githubApi(`/repos/${REPO}/issues/${existing.number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed', body }),
      });
      console.log(`[ai-explore] Sin hallazgos — issue #${existing.number} cerrado.`);
    } else {
      console.log('[ai-explore] Sin hallazgos, nada que reportar.');
    }
    return;
  }

  if (existing) {
    await githubApi(`/repos/${REPO}/issues/${existing.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, state: 'open' }),
    });
    console.log(`[ai-explore] Issue #${existing.number} actualizado con los hallazgos de esta corrida.`);
  } else {
    const title = 'Exploración IA — hallazgos visuales en pantallas del admin';
    try {
      const res = await githubApi(`/repos/${REPO}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, labels: ['exploracion-ia'] }),
      });
      const issue = await res.json();
      console.log(`[ai-explore] Issue #${issue.number} creado.`);
    } catch (err) {
      // Si el label "exploracion-ia" no existe en el repo, reintentamos sin
      // labels en vez de perder el reporte entero.
      console.warn('[ai-explore] Falló con labels, reintentando sin labels:', err.message);
      const res = await githubApi(`/repos/${REPO}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const issue = await res.json();
      console.log(`[ai-explore] Issue #${issue.number} creado (sin label).`);
    }
  }
}

// ── Gemini con visión (mismo retry/fallback que ai-review-pr.js) ───────

async function callGeminiVisionOnce(model, apiKey, prompt, imageBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/png', data: imageBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Gemini API (${model}, key ${etiquetaKey(apiKey)}) -> ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    // Un 429 puede ser rate-limit de corto plazo (vale la pena reintentar)
    // o cuota realmente agotada (RPD/billing) — reintentar esto último es
    // tiempo y llamadas tirados a la basura. Google marca el segundo caso
    // con este texto específico en el body.
    err.cuotaAgotada = res.status === 429 && /exceeded your current quota/i.test(body);
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Respuesta de Gemini (${model}) sin contenido utilizable.`);
  // A pesar de pedir responseMimeType: 'application/json', Gemini a veces
  // igual envuelve la respuesta en un bloque markdown (```json ... ```).
  // Sacamos los backticks antes de parsear para no perder el veredicto de
  // la página entera por un problema de formato, no de contenido.
  const textLimpio = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(textLimpio);
  } catch (err) {
    throw new Error(`Respuesta de Gemini (${model}) no es JSON válido tras limpiar markdown: ${err.message}`);
  }
}

// Memoria de "esta combinación modelo+key ya se sabe agotada" — se llena
// apenas una combinación recibe un error de cuota real (no sobrecarga
// transitoria) y se respeta el resto de la corrida, para no gastar tiempo
// ni llamadas reintentando contra una pared que no se va a mover hasta
// que resetee la cuota.
const combosAgotados = new Set();
const claveCombo = (model, apiKey) => `${model}::${apiKey}`;

function marcarSiAgotado(model, apiKey, err) {
  const combo = claveCombo(model, apiKey);
  if (err.cuotaAgotada && !combosAgotados.has(combo)) {
    combosAgotados.add(combo);
    console.warn(`[ai-explore] ${model} (key ${etiquetaKey(apiKey)}): cuota realmente agotada — se deja de usar esa combinación por el resto de esta corrida.`);
  }
}

// Reintenta un modelo dado con backoff corto ante 503/429 transitorio, y
// si la cuota de la key activa se agota de verdad, rota a la SIGUIENTE
// key configurada (GEMINI_API_KEYS) para ese mismo modelo antes de darse
// por vencido — con 2+ keys gratuitas (de proyectos/cuentas distintas en
// Google AI Studio) esto estira la cuota diaria disponible sin pagar.
// Solo cuando TODAS las keys quedan agotadas para este modelo se propaga
// el error, para que el llamador decida si cae al modelo de respaldo.
async function intentarModelo(model, prompt, imageBase64) {
  const RETRYABLE = [503, 429];
  const delaysMs = [2000, 5000];
  let lastErr;

  for (const apiKey of GEMINI_API_KEYS) {
    if (combosAgotados.has(claveCombo(model, apiKey))) continue;

    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        return await callGeminiVisionOnce(model, apiKey, prompt, imageBase64);
      } catch (err) {
        lastErr = err;
        marcarSiAgotado(model, apiKey, err);
        if (err.cuotaAgotada) break; // no tiene sentido esperar, pasar a la próxima key ya
        if (!RETRYABLE.includes(err.status) || attempt === delaysMs.length) break;
        console.warn(`[ai-explore] ${model} (key ${etiquetaKey(apiKey)}) respondió ${err.status}, reintentando en ${delaysMs[attempt]}ms...`);
        await sleep(delaysMs[attempt]);
      }
    }

    // Error no reintentable y no es cuota (ej. 400 malformado): pasar de
    // key no va a cambiar nada, cortamos acá directo.
    if (!lastErr.cuotaAgotada && !RETRYABLE.includes(lastErr.status)) throw lastErr;
  }

  throw lastErr || new Error(`Sin GEMINI_API_KEYS configuradas para probar ${model}.`);
}

async function callGeminiVision(prompt, imageBase64) {
  try {
    return await intentarModelo(GEMINI_MODEL, prompt, imageBase64);
  } catch (err) {
    if (!GEMINI_FALLBACK_MODEL || GEMINI_FALLBACK_MODEL === GEMINI_MODEL) throw err;
    if (err.status && ![503, 429].includes(err.status) && !err.cuotaAgotada) throw err;
    console.warn(`[ai-explore] ${GEMINI_MODEL} agotado en las ${GEMINI_API_KEYS.length} key(s) disponibles, probando modelo de respaldo ${GEMINI_FALLBACK_MODEL}...`);
    return await intentarModelo(GEMINI_FALLBACK_MODEL, prompt, imageBase64);
  }
}

function buildPrompt(nombrePagina, anchoViewport) {
  return `Sos un tester visual de QA para "Fluxo", un ERP de distribuidora. Te muestro un
screenshot de la pantalla "${nombrePagina}" del panel admin, renderizada en un navegador de
escritorio de ${anchoViewport}px de ancho, cargada con datos de prueba (así que valores en
cero o listas vacías NO son un problema en sí mismos).

Buscá específicamente problemas VISUALES reales:
- texto cortado, solapado o desbordado de su contenedor
- elementos superpuestos entre sí
- botones o campos que se ven rotos, sin estilo, o mal alineados
- imágenes rotas (ícono de "imagen no encontrada")
- contraste ilegible (texto que se pierde contra el fondo)
- layout que se ve claramente descuadrado para una pantalla de escritorio

NO reportes: falta de datos de prueba, campos vacíos porque no hay contenido,
opiniones de gusto/estética, spinners o textos de "Cargando..." en sí mismos
(son un estado normal, no un defecto), ni nada que no sea un defecto visual
concreto.

Verificación obligatoria antes de reportar cada ítem: mirá de nuevo esa zona
exacta de la imagen y confirmá con certeza que el problema está ahí. Si un
spinner o overlay de carga está cerca de otro elemento, no asumas que lo tapa
o superpone — reportá una superposición solo si podés señalar los dos
elementos concretos y ver que sus píxeles se pisan. Ante la duda, no lo
reportes: preferimos menos hallazgos y que todos sean reales, a una lista
larga con detalles inventados.

Devolvé SOLO un JSON válido, sin backticks ni texto extra:
{
  "ok": true | false,
  "problemas": ["descripción corta de cada problema encontrado, en español"]
}
Si no ves ningún problema, "ok": true y "problemas": [].`;
}

async function prepararRedComun(page) {
  await vendorizarDexie(page);
  await vendorizarSupabase(page);
  mockearRestGenerico(page);
  mockearApiGenerico(page);
}

async function explorarPagina(page, baseURL, nombre) {
  const url = `${baseURL}/frontend/admin/${nombre}.html`;
  const errores = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errores.push(msg.text());
  });

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  if (!response || response.status() >= 400) {
    throw new Error(`${url} respondió ${response?.status()}`);
  }

  if (!PAGINAS_SIN_NAV_ROOT.has(nombre)) {
    await page.waitForSelector('#nav-root', { state: 'attached', timeout: 10_000 }).catch(() => {});
  } else {
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  }
  // Esperar a que la red se calme (los mocks de Supabase/API resuelven,
  // React re-renderiza) en vez de un timeout fijo corto — un fixed
  // 500ms venía congelando la foto a mitad de un spinner "Cargando..."
  // global (visto en pedidos.png de la corrida real del 2026-09: el
  // overlay de carga tapando el dropdown "Todos los canales" no es un
  // bug de superposición, es la foto sacada antes de que el mock
  // terminara de resolver).
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(800);

  // fullPage: true en vez de false — con captura solo del viewport,
  // cualquier página más alta que el alto configurado quedaba cortada a
  // mitad de fila (visto en dashboard.png: la fila de Comprobantes ARCA /
  // Automatización / Reportes críticos truncada por el borde de la
  // captura, no por un overflow real de CSS). Con fullPage no hay
  // recorte artificial sea cual sea el alto real. El ANCHO sí queda fijo
  // al de newPage({ viewport }) — eso es intencional, es lo que permite
  // reproducir bugs de breakpoint (ver VIEWPORTS_DEFAULT / EXPLORE_VIEWPORTS).
  const screenshotBuffer = await page.screenshot({ fullPage: true });
  return { screenshotBuffer, erroresConsola: filtrarRuidoRed(errores) };
}

function buildIssueBody(resultados, fechaISO) {
  const lines = [MARKER, `### 🔎 Exploración automática de pantallas (IA, ${fechaISO})`, ''];
  lines.push(
    '_Generado por un agente con visión (Gemini free tier) recorriendo pantallas del admin cargadas con datos de prueba, en varios anchos de escritorio. Revisar cada hallazgo antes de asumir que es un bug real — puede haber falsos positivos, y algunos problemas solo aparecen en ciertos anchos._'
  );
  lines.push('');
  lines.push(`Anchos probados: ${VIEWPORTS.map((v) => `${v.width}px`).join(', ')}. Los screenshots de esta corrida (uno por página+ancho) quedaron como artifact en la Action que generó este issue.`);
  lines.push('');

  // Agrupar por página primero (una página puede tener hallazgos en un
  // ancho y no en otro — se listan juntos bajo el mismo título en vez de
  // duplicar la sección por página).
  const porPagina = new Map();
  for (const r of resultados) {
    if (!porPagina.has(r.pagina)) porPagina.set(r.pagina, []);
    porPagina.get(r.pagina).push(r);
  }

  for (const [pagina, filas] of porPagina) {
    const conHallazgos = filas.filter((f) => f.problemas.length > 0);
    if (conHallazgos.length === 0) continue;
    lines.push(`#### \`${pagina}\``);
    for (const f of conHallazgos) {
      lines.push(`- **@ ${f.ancho}px**`);
      for (const p of f.problemas) lines.push(`  - ${p}`);
      if (f.erroresConsola.length > 0) {
        lines.push(`  - _(${f.erroresConsola.length} error(es) de consola detectados también, ver logs del job)_`);
      }
    }
    lines.push('');
  }

  const sinRevisar = resultados.filter((r) => r.error);
  if (sinRevisar.length > 0) {
    lines.push('#### Páginas que no se pudieron revisar en esta corrida');
    for (const r of sinRevisar) lines.push(`- \`${r.pagina}\` @ ${r.ancho}px: ${r.error}`);
  }

  return lines.join('\n');
}

async function main() {
  if (GEMINI_API_KEYS.length === 0) {
    console.warn('[ai-explore] Falta GEMINI_API_KEYS (o GEMINI_API_KEY) — se omite la exploración.');
    return;
  }
  if (!GITHUB_TOKEN || !REPO) {
    console.warn('[ai-explore] Falta GITHUB_TOKEN/GITHUB_REPOSITORY — se omite la apertura de issue.');
  }
  console.log(`[ai-explore] ${GEMINI_API_KEYS.length} key(s) de Gemini configurada(s).`);

  const paginas = (process.env.EXPLORE_PAGINAS
    ? process.env.EXPLORE_PAGINAS.split(',').map((s) => s.trim()).filter(Boolean)
    : PAGINAS_DEFAULT);

  const totalLlamadas = paginas.length * VIEWPORTS.length;
  console.log(
    `[ai-explore] ${paginas.length} página(s) × ${VIEWPORTS.length} viewport(s) ` +
    `(${VIEWPORTS.map(etiquetaViewport).join(', ')}) = ${totalLlamadas} llamada(s) a Gemini en esta corrida.`
  );

  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const staticServer = await startStaticServer();
  const browser = await chromium.launch();
  const resultados = [];

  try {
    for (const nombre of paginas) {
      for (const viewport of VIEWPORTS) {
        const vpLabel = etiquetaViewport(viewport);
        // viewport se pasa a newPage (no page.setViewportSize después) para
        // que la página cargue y renderice directo al ancho final — cambiar
        // el viewport post-carga puede dejar reflows a mitad de camino que
        // no reflejan cómo se ve realmente una carga fresca a ese ancho.
        const page = await browser.newPage({ viewport });
        try {
          await prepararRedComun(page);
          await loguearComoAdmin(page);
          const { screenshotBuffer, erroresConsola } = await explorarPagina(page, staticServer.baseURL, nombre);

          await writeFile(path.join(SCREENSHOTS_DIR, `${nombre}-${vpLabel}.png`), screenshotBuffer);

          const veredicto = await callGeminiVision(buildPrompt(nombre, viewport.width), screenshotBuffer.toString('base64'));
          resultados.push({ pagina: nombre, viewport: vpLabel, ancho: viewport.width, problemas: veredicto.problemas || [], erroresConsola });
          console.log(`[ai-explore] ${nombre} @ ${vpLabel}: ${(veredicto.problemas || []).length} hallazgo(s)`);
        } catch (err) {
          console.error(`[ai-explore] Error explorando "${nombre}" @ ${vpLabel} (no bloqueante):`, err.message);
          resultados.push({ pagina: nombre, viewport: vpLabel, ancho: viewport.width, problemas: [], erroresConsola: [], error: err.message });
        } finally {
          await page.close().catch(() => {});
        }
        await sleep(DELAY_MS);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    staticServer.server.close();
  }

  const hayHallazgos = resultados.some((r) => r.problemas.length > 0);
  if (GITHUB_TOKEN && REPO) {
    const body = buildIssueBody(resultados, new Date().toISOString().slice(0, 10));
    await upsertIssue(body, hayHallazgos).catch((err) => {
      console.error('[ai-explore] Error actualizando el issue (no bloqueante):', err.message);
    });
  }
}

main().catch((err) => {
  // Nunca bloqueamos el job por esto — es una corrida informativa.
  console.error('[ai-explore] Error general (no bloqueante):', err.message);
});
