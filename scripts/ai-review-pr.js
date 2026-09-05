#!/usr/bin/env node
/**
 * ai-review-pr.js
 *
 * Reviewer de código con IA para Pull Requests, usando el free tier de la
 * API de Gemini. Corre en modo INFORMATIVO: postea un comentario en el PR
 * con hallazgos, pero nunca falla el job ni bloquea el merge.
 *
 * Fase 1 del plan de CI/CD + agentes IA gratis para Fluxo.
 *
 * Requiere (como env vars, inyectadas desde el workflow):
 *  - GITHUB_TOKEN     : token del job (permissions: pull-requests: write, contents: read)
 *  - GITHUB_REPOSITORY: "owner/repo" (lo pone GitHub Actions automáticamente)
 *  - PR_NUMBER        : número del pull request
 *  - GEMINI_API_KEY   : API key del free tier de Gemini (secret del repo)
 *  - GEMINI_MODEL     : opcional, default "gemini-2.0-flash"
 *
 * No agrega dependencias nuevas: usa fetch nativo (Node 24) y el REST API
 * de GitHub directamente.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // owner/repo
const PR_NUMBER = process.env.PR_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Marcador oculto para poder encontrar y actualizar el mismo comentario
// en pushes sucesivos al PR, en vez de spamear un comentario por commit.
const MARKER = '<!-- ai-review-bot:marker -->';

// Límite de caracteres del diff que mandamos al modelo, para cuidar la
// cuota gratuita diaria y evitar diffs gigantes (ej. lockfiles, dumps SQL).
const MAX_DIFF_CHARS = 45000;

// Rutas del repo consideradas sensibles: acá el reviewer IA solo informa,
// pero el comentario deja explícito que la revisión humana sigue siendo
// obligatoria sin importar lo que diga el modelo.
const SENSITIVE_PATTERNS = [
  { label: 'Mercado Pago (pagos/webhooks)', re: /mercado ?pago/i },
  { label: 'Facturación / AFIP', re: /afip/i },
  { label: 'Cheques (riesgo/scoring)', re: /cheque/i },
  { label: 'Grants / RLS de Supabase', re: /(grants?|rls)/i },
];

function fail(msg) {
  console.error(`[ai-review-pr] ${msg}`);
  process.exit(0); // nunca rompemos el job en modo informativo
}

async function githubApi(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
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
    throw new Error(`GitHub API ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function getDiff() {
  const res = await githubApi(`/repos/${REPO}/pulls/${PR_NUMBER}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  });
  return res.text();
}

async function getChangedFiles() {
  const res = await githubApi(`/repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`);
  const files = await res.json();
  return files.map((f) => f.filename);
}

function detectSensitiveAreas(filenames) {
  const hits = new Set();
  for (const file of filenames) {
    for (const { label, re } of SENSITIVE_PATTERNS) {
      if (re.test(file)) hits.add(label);
    }
  }
  return [...hits];
}

function truncateDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return (
    diff.slice(0, MAX_DIFF_CHARS) +
    `\n\n[... diff truncado, ${diff.length - MAX_DIFF_CHARS} caracteres omitidos por límite de cuota ...]`
  );
}

function buildPrompt(diff) {
  return `Sos un revisor de código senior para "Fluxo", un ERP de distribuidora en producción (Node 24, Express, Supabase/Postgres con RLS, frontend vanilla JS, hosting en Vercel).

Revisá el siguiente diff de un Pull Request y devolvé SOLO un JSON válido (sin markdown, sin backticks, sin texto extra) con esta forma exacta:

{
  "resumen": "una o dos frases sobre el cambio en general",
  "hallazgos": [
    {
      "severidad": "alta" | "media" | "baja",
      "archivo": "ruta/del/archivo",
      "descripcion": "qué está mal o qué revisar, en una o dos frases, en español"
    }
  ],
  "riesgos_seguridad": ["lista corta de riesgos de seguridad si los hay, si no, array vacío"],
  "aprobacion_sugerida": true | false
}

Priorizá en tu revisión:
- Bugs reales y errores de lógica, no solo estilo.
- Seguridad: inyección SQL, RLS/grants de Supabase, manejo de secretos/tokens, validación de inputs en endpoints Express.
- Manejo de errores y casos borde en operaciones de dinero/stock (pedidos, cobranzas, cheques, facturación).
- No repitas comentarios de linter genéricos que ya cubriría eslint.
- Si el diff es trivial (docs, changelogs, estilos), "hallazgos" puede ser un array vacío y "aprobacion_sugerida": true.

Diff del PR:
\`\`\`diff
${diff}
\`\`\`
`;
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API -> ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Respuesta de Gemini sin contenido utilizable.');
  return JSON.parse(text);
}

function severityEmoji(sev) {
  return { alta: '🔴', media: '🟡', baja: '🔵' }[sev] || '⚪';
}

function buildComment(review, sensitiveAreas, diffTruncated) {
  const lines = [];
  lines.push(MARKER);
  lines.push('### 🤖 Revisión automática (IA, modo informativo)');
  lines.push('');
  lines.push(
    '_Este comentario es generado por un reviewer IA (Gemini free tier) y **no bloquea el merge**. Es un insumo más, no reemplaza la revisión humana._'
  );
  lines.push('');

  if (sensitiveAreas.length > 0) {
    lines.push('> ⚠️ **Este PR toca módulos marcados como sensibles:** ' + sensitiveAreas.join(', ') + '.');
    lines.push('> Requieren revisión humana obligatoria antes de mergear, **sin importar** lo que diga este comentario.');
    lines.push('');
  }

  lines.push(`**Resumen:** ${review.resumen || '(sin resumen)'}`);
  lines.push('');

  const hallazgos = Array.isArray(review.hallazgos) ? review.hallazgos : [];
  if (hallazgos.length === 0) {
    lines.push('No se encontraron observaciones puntuales.');
  } else {
    lines.push('**Hallazgos:**');
    lines.push('');
    for (const h of hallazgos) {
      lines.push(`- ${severityEmoji(h.severidad)} \`${h.archivo || '?'}\` — ${h.descripcion}`);
    }
  }
  lines.push('');

  const riesgos = Array.isArray(review.riesgos_seguridad) ? review.riesgos_seguridad : [];
  if (riesgos.length > 0) {
    lines.push('**Riesgos de seguridad detectados:**');
    for (const r of riesgos) lines.push(`- 🔒 ${r}`);
    lines.push('');
  }

  lines.push(
    `**Sugerencia del modelo:** ${review.aprobacion_sugerida ? '✅ sin objeciones bloqueantes' : '✋ conviene revisar antes de mergear'}`
  );

  if (diffTruncated) {
    lines.push('');
    lines.push('_Nota: el diff era grande y se truncó antes de mandarlo al modelo; puede no haber visto el PR completo._');
  }

  return lines.join('\n');
}

async function upsertComment(body) {
  const res = await githubApi(`/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`);
  const comments = await res.json();
  const existing = comments.find((c) => c.body?.includes(MARKER));

  if (existing) {
    await githubApi(`/repos/${REPO}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log('[ai-review-pr] Comentario existente actualizado.');
  } else {
    await githubApi(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log('[ai-review-pr] Comentario nuevo creado.');
  }
}

async function main() {
  if (!GITHUB_TOKEN) return fail('Falta GITHUB_TOKEN.');
  if (!REPO) return fail('Falta GITHUB_REPOSITORY.');
  if (!PR_NUMBER) return fail('Falta PR_NUMBER.');
  if (!GEMINI_API_KEY) {
    console.warn('[ai-review-pr] Falta GEMINI_API_KEY (secret no configurado todavía) — se omite la revisión IA.');
    return;
  }

  try {
    const [rawDiff, filenames] = await Promise.all([getDiff(), getChangedFiles()]);
    const sensitiveAreas = detectSensitiveAreas(filenames);
    const diffTruncated = rawDiff.length > MAX_DIFF_CHARS;
    const diff = truncateDiff(rawDiff);

    if (!diff.trim()) {
      console.log('[ai-review-pr] Diff vacío, nada que revisar.');
      return;
    }

    const review = await callGemini(buildPrompt(diff));
    const comment = buildComment(review, sensitiveAreas, diffTruncated);
    await upsertComment(comment);
  } catch (err) {
    // Modo informativo: si algo falla (cuota de Gemini agotada, error de red,
    // JSON mal formado, etc.) lo logueamos pero NO rompemos el CI.
    console.error('[ai-review-pr] Error durante la revisión IA (no bloqueante):', err.message);
  }
}

main();
