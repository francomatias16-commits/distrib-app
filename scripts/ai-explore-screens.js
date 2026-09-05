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
 *  - GEMINI_API_KEY                   : free tier de Gemini
 *  - GEMINI_MODEL / GEMINI_FALLBACK_MODEL : opcionales, mismos defaults
 *    que scripts/ai-review-pr.js
 *  - EXPLORE_PAGINAS   : opcional, lista separada por comas de páginas
 *    admin a recorrer (sin ".html"). Default: subset curado abajo.
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
const DELAY_MS = Number(process.env.EXPLORE_DELAY_MS || 4500);

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

async function callGeminiVisionOnce(model, prompt, imageBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
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
    const err = new Error(`Gemini API (${model}) -> ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
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

// Mismo patrón que scripts/ai-review-pr.js: reintenta el modelo principal
// ante 503 (sobrecarga) o 429 (rate limit) con backoff corto, y si sigue
// sin responder, cae al modelo de respaldo (con un reintento propio más
// corto, porque en la práctica el free tier de Gemini puede tener el
// mismo pico de demanda pegándole a los dos modelos a la vez — ver la
// corrida real del 2026-09, donde ambos devolvieron 503 seguido en varias
// páginas). Cualquier otro error (400, JSON inválido, etc.) no tiene
// sentido reintentarlo y se propaga directo.
async function callGeminiVision(prompt, imageBase64) {
  const RETRYABLE = [503, 429];
  const delaysMs = [2000, 5000];

  let lastErr;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await callGeminiVisionOnce(GEMINI_MODEL, prompt, imageBase64);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE.includes(err.status) || attempt === delaysMs.length) break;
      console.warn(`[ai-explore] ${GEMINI_MODEL} respondió ${err.status}, reintentando en ${delaysMs[attempt]}ms...`);
      await sleep(delaysMs[attempt]);
    }
  }

  if (!RETRYABLE.includes(lastErr.status) || !GEMINI_FALLBACK_MODEL || GEMINI_FALLBACK_MODEL === GEMINI_MODEL) {
    throw lastErr;
  }

  console.warn(`[ai-explore] ${GEMINI_MODEL} no respondió tras los reintentos, probando modelo de respaldo ${GEMINI_FALLBACK_MODEL}...`);
  const fallbackDelaysMs = [3000];
  for (let attempt = 0; attempt <= fallbackDelaysMs.length; attempt++) {
    try {
      return await callGeminiVisionOnce(GEMINI_FALLBACK_MODEL, prompt, imageBase64);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE.includes(err.status) || attempt === fallbackDelaysMs.length) break;
      console.warn(`[ai-explore] ${GEMINI_FALLBACK_MODEL} también respondió ${err.status}, reintentando en ${fallbackDelaysMs[attempt]}ms...`);
      await sleep(fallbackDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

function buildPrompt(nombrePagina) {
  return `Sos un tester visual de QA para "Fluxo", un ERP de distribuidora. Te muestro un
screenshot de la pantalla "${nombrePagina}" del panel admin, cargada con datos de
prueba (así que valores en cero o listas vacías NO son un problema en sí mismos).

Buscá específicamente problemas VISUALES reales:
- texto cortado, solapado o desbordado de su contenedor
- elementos superpuestos entre sí
- botones o campos que se ven rotos, sin estilo, o mal alineados
- imágenes rotas (ícono de "imagen no encontrada")
- contraste ilegible (texto que se pierde contra el fondo)
- layout que se ve claramente descuadrado para una pantalla de escritorio

NO reportes: falta de datos de prueba, campos vacíos porque no hay contenido,
opiniones de gusto/estética, ni nada que no sea un defecto visual concreto.

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
  await page.waitForTimeout(500);

  const screenshotBuffer = await page.screenshot({ fullPage: false });
  return { screenshotBuffer, erroresConsola: filtrarRuidoRed(errores) };
}

function buildIssueBody(resultados, fechaISO) {
  const lines = [MARKER, `### 🔎 Exploración automática de pantallas (IA, ${fechaISO})`, ''];
  lines.push(
    '_Generado por un agente con visión (Gemini free tier) recorriendo pantallas del admin cargadas con datos de prueba. Revisar cada hallazgo antes de asumir que es un bug real — puede haber falsos positivos._'
  );
  lines.push('');
  lines.push(`Los screenshots de esta corrida quedaron como artifact en la Action que generó este issue.`);
  lines.push('');

  const conHallazgos = resultados.filter((r) => r.problemas.length > 0);
  for (const r of conHallazgos) {
    lines.push(`#### \`${r.pagina}\``);
    for (const p of r.problemas) lines.push(`- ${p}`);
    if (r.erroresConsola.length > 0) {
      lines.push(`- _(${r.erroresConsola.length} error(es) de consola detectados también, ver logs del job)_`);
    }
    lines.push('');
  }

  const sinRevisar = resultados.filter((r) => r.error);
  if (sinRevisar.length > 0) {
    lines.push('#### Páginas que no se pudieron revisar en esta corrida');
    for (const r of sinRevisar) lines.push(`- \`${r.pagina}\`: ${r.error}`);
  }

  return lines.join('\n');
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.warn('[ai-explore] Falta GEMINI_API_KEY — se omite la exploración.');
    return;
  }
  if (!GITHUB_TOKEN || !REPO) {
    console.warn('[ai-explore] Falta GITHUB_TOKEN/GITHUB_REPOSITORY — se omite la apertura de issue.');
  }

  const paginas = (process.env.EXPLORE_PAGINAS
    ? process.env.EXPLORE_PAGINAS.split(',').map((s) => s.trim()).filter(Boolean)
    : PAGINAS_DEFAULT);

  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const staticServer = await startStaticServer();
  const browser = await chromium.launch();
  const resultados = [];

  try {
    for (const nombre of paginas) {
      const page = await browser.newPage();
      try {
        await prepararRedComun(page);
        await loguearComoAdmin(page);
        const { screenshotBuffer, erroresConsola } = await explorarPagina(page, staticServer.baseURL, nombre);

        await writeFile(path.join(SCREENSHOTS_DIR, `${nombre}.png`), screenshotBuffer);

        const veredicto = await callGeminiVision(buildPrompt(nombre), screenshotBuffer.toString('base64'));
        resultados.push({ pagina: nombre, problemas: veredicto.problemas || [], erroresConsola });
        console.log(`[ai-explore] ${nombre}: ${(veredicto.problemas || []).length} hallazgo(s)`);
      } catch (err) {
        console.error(`[ai-explore] Error explorando "${nombre}" (no bloqueante):`, err.message);
        resultados.push({ pagina: nombre, problemas: [], erroresConsola: [], error: err.message });
      } finally {
        await page.close().catch(() => {});
      }
      await sleep(DELAY_MS);
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
