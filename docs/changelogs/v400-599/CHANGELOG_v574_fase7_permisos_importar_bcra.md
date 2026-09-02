# v574 — Fase 7, sección 2: `importar.js` y `bcra.js` migrados a PermisosService

Continuación de `CHANGELOG_v573_fase7_cta_cte.md`. Tercer y cuarto módulo
migrados a `lib/permisos-service.js` (después de `reglas-automatizacion.js`
y `export-contable.js`) — los dos candidatos confirmados como
autocontenidos en la sección 2 de `FASE7_PLAN_ARRANQUE.md`: cada uno tenía
un único array `ROLES_*` cubriendo todo el handler, sin re-exports hacia
otros archivos (a diferencia de `usuarios.js` y `migracion.js`, que quedan
afuera por mayor blast radius — ver el plan).

## Qué se hizo

- **`lib/permisos-service.js`** — 2 entradas nuevas en la tabla `REGLAS`:
  - `importar: { cargar: ['dueno', 'admin'] }` — replica
    `ROLES_IMPORTAR` de `importar.js`. Un único gate para todo el handler
    (CSV vía RPC y OCR/Vision por igual; el original no distinguía entre
    los dos modos).
  - `bcra: { consultar: ['dueno', 'admin', 'contador'] }` — replica
    `ROLES_PERMITIDOS` de `bcra.js`. Un único gate para las 5 acciones del
    handler (entidades, denunciado, situación, cheques-rechazados,
    verificar-cliente).
- **`lib/handlers/importar.js`** — `ROLES_IMPORTAR.includes(perfil.rol)`
  reemplazado por `puede(perfil, 'cargar', 'importar')`. `grep
  ROLES_IMPORTAR lib/handlers/importar.js` → 0.
- **`lib/handlers/bcra.js`** — `ROLES_PERMITIDOS.includes(perfil.rol)`
  reemplazado por `puede(perfil, 'consultar', 'bcra')`. `grep
  ROLES_PERMITIDOS lib/handlers/bcra.js` → 0.
- Sintaxis verificada con `node --check` en los 3 archivos tocados antes
  de correr la suite.

## Tests

Ninguno de los dos handlers tenía cobertura previa (mismo hallazgo que
`export-contable.js` en el paso anterior — el gate de permisos nunca se
había probado, solo el motor de negocio de cada uno, cuando existía).

- **`tests/permisos-service.test.js`** — ampliado con los casos de
  `importar`/`bcra` (roles permitidos/denegados por recurso).
- **`tests/handlers/importar-permisos.test.js`** (nuevo, 7 casos) — gate
  único de carga: dueño/admin sin 403 y llegan a `supabase.rpc(...)`,
  el resto 403 sin llamar la RPC, 401 sin token antes que el gate.
- **`tests/handlers/bcra-permisos.test.js`** (nuevo, 8 casos) — mismo
  patrón; `fetch` global mockeado (el propio handler advierte en su
  comentario de cabecera que nunca se probó contra la API real de BCRA,
  y el host no está en ningún allowlist de egress de todos modos) para
  que el test cubra solo el gate, no la integración externa.

Suite completa: **260/260 OK** (245 antes de este paso + 15 nuevos).

## Qué queda

Quedan ~29 constantes `ROLES_*` más repartidas en handlers, sin contar
`usuarios.js` y `migracion.js` (descartados por blast radius — ver
sección 2 del plan). Próxima entrega: elegir el siguiente candidato
autocontenido de esa lista.
