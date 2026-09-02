#!/usr/bin/env node
// scripts/diagnostico-rewrites.js
//
// Standalone: replica EXACTAMENTE la lógica de rewrite de server.js contra
// el vercel.json real que tengas en el repo, y muestra qué regla matchea
// (o si no matchea ninguna) para las URLs que estamos depurando.
//
// Uso: node scripts/diagnostico-rewrites.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Si guardás este archivo en scripts/, vercel.json está un nivel arriba.
// Si lo guardás en la raíz del repo, cambiá esta línea a './vercel.json'.
const vercelJsonPath = fs.existsSync(path.join(__dirname, 'vercel.json'))
  ? path.join(__dirname, 'vercel.json')
  : path.join(__dirname, '..', 'vercel.json');

console.log(`[diagnostico] Leyendo: ${vercelJsonPath}`);
const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));

function toRegex(source) {
  return new RegExp('^' + source + '$');
}

const rewrites = (vercelConfig.rewrites || []).map((r, i) => ({
  index: i,
  source: r.source,
  regex: toRegex(r.source),
  destination: r.destination,
}));

console.log(`[diagnostico] ${rewrites.length} rewrites cargadas.\n`);

function simular(url) {
  const [pathname, existingQuery] = url.split('?');
  const matches = rewrites.filter((r) => r.regex.test(pathname));

  console.log(`── ${url}`);
  if (matches.length === 0) {
    console.log('   ✗ NINGUNA regla matchea este pathname. Ese es el bug.');
    console.log('');
    return;
  }
  matches.forEach((m, i) => {
    const primera = i === 0;
    console.log(`   ${primera ? '→ USADA' : '  (ignorada, ya matcheó una antes)'} [#${m.index}] ${m.source} -> ${m.destination}`);
  });

  // Reproducir el merge de query string tal cual hace server.js
  const m = matches[0];
  const match = pathname.match(m.regex);
  let destPath = m.destination;
  match.slice(1).forEach((group, i) => {
    destPath = destPath.replace(new RegExp(`\\$${i + 1}`, 'g'), group ?? '');
  });
  const [newPath, destQuery] = destPath.split('?');
  const params = new URLSearchParams(destQuery || '');
  if (existingQuery) {
    for (const [k, v] of new URLSearchParams(existingQuery)) params.append(k, v);
  }
  const qs = params.toString();
  const resultado = qs ? `${newPath}?${qs}` : newPath;
  console.log(`   req.url final: ${resultado}`);
  console.log(`   _mod resultante: ${new URLSearchParams(qs).get('_mod') ?? '(NINGUNO — 404 en el dispatcher)'}`);
  console.log('');
}

simular('/api/pos?accion=cajas');
simular('/api/pos/cajas');
simular('/api/saas?_svc=demo-reset');
simular('/api/saas/demo-reset');
