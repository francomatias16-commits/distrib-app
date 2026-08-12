# v448 — Fix real de deploy: lockfile desincronizado + Node engine insuficiente

**Contexto:** al intentar deployar v447 (bump `firebase-admin` 12→14) a Vercel,
el build falló en `npm ci` con dos problemas que no se podían detectar sin
intentar el deploy real (este sandbox no tiene acceso a Vercel):

## Problema 1 — lockfile desincronizado (esto YA estaba documentado como DEP-02)
`npm ci` exige que `package-lock.json` esté en sync exacto con `package.json`.
Yo había cambiado `package.json` (`firebase-admin` → `^14.2.0`) pero nunca
corrí `npm install` para regenerar el lockfile — no tenía forma de saberlo
sin un deploy real, porque mi sandbox no ejecuta `npm ci` contra Vercel.
**Fix:** `npm install --package-lock-only` para regenerar `package-lock.json`
con el árbol de dependencias real de `firebase-admin@14.2.0` (arrastra, entre
otros, `@google-cloud/firestore@8.7.0`, `google-auth-library@10.9.1`,
`jwks-rsa@4.1.0` — todos como transitivos, no se tocó nada más a mano).
Verificado con `npm ci` real en sandbox: ahora instala 496 paquetes sin error.

## Problema 2 — Node 20.x ya no alcanza (nuevo, no estaba en ningún changelog previo)
El log de Vercel mostró dos avisos separados:
1. `firebase-admin@14.2.0` requiere `node >= 22` (confirmado:
   `node_modules/firebase-admin/package.json` → `engines.node: ">=22"`).
   v12 no tenía esta restricción — es nueva de la v14.
2. Vercel además avisa que **Node 20.x se deprecará el 2026-10-01** en su
   plataforma, independientemente de este bump.
**Fix:** `"engines": { "node": "24.x" }` en `package.json` (antes `"20.x"`).
Se eligió 24.x y no 22.x porque es la versión que Vercel ya usa por default
para proyectos nuevos y evita tener que tocar esto de nuevo antes de octubre.

## Hallazgo colateral — `npm audit` (por primera vez con acceso real al registro)
Auditorías anteriores no podían correr `npm audit` real (sandbox sin acceso a
`registry.npmjs.org`). Acá sí se pudo. Resultado: **20 vulnerabilidades** (10
moderadas, 9 altas, 1 crítica) tras aplicar `npm audit fix` (no-breaking, bajó
de 21 a 20). Desglose por impacto real:

- **17 de las 20 son `devDependencies` (directas o transitivas) de
  testing/build: `vitest`/`vite`/`vite-node`/`@vitest/mocker` (Fase 3.2),
  `autocannon`/`hyperid` (Fase 3.3), `esbuild`.** Ninguna viaja al bundle de
  las funciones serverless de Vercel — no es superficie de ataque en
  producción. La crítica de `vitest` es "Vitest UI server expone lectura de
  archivos arbitraria" — solo explotable si alguien corre `vitest --ui` y lo
  expone a una red no confiable, que no es el caso acá.
- **`sharp` (HIGH, CVEs de `libvips`)** — es dependencia de producción real
  (`lib/handlers/empresa.js`, `importar.js`, `auto-imagenes.js`, procesa
  imágenes subidas por usuarios: logo de empresa, importación de productos,
  fotos automáticas). **No tiene relación con el bump de `firebase-admin`**
  — ya estaba así antes (`^0.33.4`) y no se tocó en este changelog. Vale la
  pena tratarlo aparte, ver "Pendiente" abajo.
- **El resto (`@google-cloud/storage`, `gaxios`, `gcp-metadata`,
  `google-gax`, `rimraf`, `glob`, `minimatch`, `brace-expansion`,
  `teeny-request`, `retry-request`, `uuid`)** son transitivos nuevos que
  entraron **por el bump de `firebase-admin`** (v14 depende de
  `@google-cloud/firestore@8` → `@google-cloud/storage`). Mismo argumento que
  ya usó la auditoría original para DEP-01 (`uuid`): el proyecto solo usa
  `admin.messaging()`, nunca ninguna API de Storage/Firestore ni
  `uuid.v3/v5/v6` con buffer propio — no hay código propio que ejercite estas
  rutas vulnerables. Riesgo real bajo, igual que antes.

**Importante — lo que NO se hizo:** `npm audit fix --force` sugiere,
literalmente, **bajar `firebase-admin` a `10.3.0`** para resolver el aviso de
`@google-cloud/storage` — es decir, deshacer este mismo bump. No tiene
sentido (v10 es más vieja que la v12 de la que veníamos, y perderíamos el fix
real que motivó todo esto). Tampoco se forzaron los bumps de `vitest@4` /
`sharp@0.35` / `autocannon@2` — son major bumps (breaking) que hay que
probar aparte, no meterlos de arriba en el mismo commit que ya toca
`engines` + el lockfile completo.

## Verificado en sandbox
- `npm ci` — OK, 496 paquetes instalados sin error (antes fallaba con
  `EUSAGE`).
- `node --check lib/handlers/_push.js` — OK (ya verificado en v447).
- `package.json`/`package-lock.json` consistentes entre sí.

## Pendiente de tu parte
- [ ] Deploy real a un preview de Vercel con este lockfile — confirmar que
      `npm ci` pasa igual que en sandbox (debería, pero Vercel es el juez
      final).
- [ ] Confirmar que el resto del build (`esbuild` sobre `frontend/**/*.js`)
      sigue funcionando con Node 24 — no debería cambiar nada, pero no se
      probó en este sandbox por no tener el paso de build completo.
- [ ] Decidir si vale la pena, en otro commit aparte, evaluar el bump de
      `sharp` 0.33→0.35 (HIGH, producción real, CVEs de libvips) — no se tocó
      acá para no mezclar dos bumps de riesgo distinto en el mismo commit.
