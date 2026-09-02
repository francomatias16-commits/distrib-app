// server.js — Local dev server for Replit preview.
//
// This project is built for Vercel (static frontend + a single serverless
// function at api/index.js, routed via vercel.json `rewrites`). Replit
// previews need a normal long-running HTTP server, so this file:
//   1. Serves static files from the repo root (frontend/, etc).
//   2. Replays vercel.json's `rewrites` generically (regex source -> query-
//      string destination), so clean URLs like /admin/empresa-config and
//      /api/empresa/datos keep working exactly like on Vercel.
//   3. Delegates every /api/* request to the same api/index.js handler
//      Vercel would call, since Express req/res are Node http req/res.
//
// Backend calls that need Supabase/JWT/etc. secrets will fail until those
// env vars are configured — that does not block working on static
// frontend/CSS files.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qs from 'qs';

// Lazy-loaded so a broken/misconfigured backend module (missing secrets,
// external services, etc.) never prevents the static frontend from serving.
let apiHandlerPromise = null;
function getApiHandler() {
  if (!apiHandlerPromise) {
    apiHandlerPromise = import('./api/index.js').then((m) => m.default);
  }
  return apiHandlerPromise;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5000;

const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'vercel.json'), 'utf8'));

function toRegex(source) {
  // vercel path patterns use (.*) style regex groups already; anchor them.
  return new RegExp('^' + source + '$');
}

const rewrites = (vercelConfig.rewrites || []).map((r) => ({
  regex: toRegex(r.source),
  destination: r.destination,
}));

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const [pathname, existingQuery] = req.url.split('?');
  for (const { regex, destination } of rewrites) {
    const match = pathname.match(regex);
    if (!match) continue;
    let destPath = destination;
    // Substitute capture groups $1, $2, ... into the destination path.
    match.slice(1).forEach((group, i) => {
      destPath = destPath.replace(new RegExp(`\\$${i + 1}`, 'g'), group ?? '');
    });
    const [newPath, destQuery] = destPath.split('?');
    const params = new URLSearchParams(destQuery || '');
    if (existingQuery) {
      for (const [k, v] of new URLSearchParams(existingQuery)) params.append(k, v);
    }
    const qsStr = params.toString();
    req.url = qsStr ? `${newPath}?${qsStr}` : newPath;
    // Express 4 ya computó req.query con la URL ORIGINAL (lo hace en un
    // middleware interno que corre antes que cualquier app.use() nuestro —
    // ver express/lib/application.js: this._router.use(query(...)) en
    // default(), registrado primero). Reescribir req.url acá NO alcanza:
    // req.query queda "congelado" con la query vieja, sin _mod/_svc/accion,
    // y api/index.js recibe mod=undefined -> 404 "Módulo de API desconocido".
    // Lo recalculamos a mano con el mismo parser (qs) que usa Express.
    req.query = qs.parse(qsStr);
    break;
  }
  next();
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  getApiHandler()
    .then((handler) => handler(req, res))
    .catch((err) => {
      console.error('[server] /api handler failed to load or run:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'API no disponible (backend sin configurar en este entorno)' });
      }
    });
});

app.use(express.static(__dirname, { extensions: ['html'] }));

// Clean-URL fallback: /admin/foo -> frontend/admin/foo.html, when no
// explicit vercel.json rewrite matched (most admin pages aren't listed
// individually in rewrites; they're served by folder convention).
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  const segments = req.path.split('/').filter(Boolean);
  if (segments.length === 0) return next();
  const [area, ...rest] = segments;
  if (!['admin', 'chofer', 'cliente', 'proveedor'].includes(area)) return next();
  const page = rest.length ? rest.join('/') : 'login';
  const candidate = path.join(__dirname, 'frontend', area, `${page}.html`);
  if (fs.existsSync(candidate)) return res.sendFile(candidate);
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});
