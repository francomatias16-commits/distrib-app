# v1004 — Etapa 1 del plan de robustez: CI/CD real (gate automático)

## Contexto

`docs/planes/PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md` — Etapa 1.
Hasta ahora no existía `.github/workflows/`: los ~1200 tests de vitest y los
checks de `predeploy` (schema drift, smoke test frontend, asset wiring, api
wiring, handler dispatch) existían y funcionaban, pero nada los corría
automáticamente. Un push directo a `main` llegaba a producción sin gate.

## Cambio

Agregado `.github/workflows/ci.yml`:

- Dispara en `push`/`pull_request` sobre `main`.
- `actions/checkout` + `actions/setup-node` (Node 24.x, igual que `engines`
  en `package.json`), con cache de npm.
- `npm ci` → `npm run predeploy` → `npm test`.
- `concurrency` con `cancel-in-progress` para no acumular runs viejos
  cuando hay varios pushes seguidos a la misma rama/PR.

Verificado que ninguno de los checks del workflow toca Supabase ni
credenciales reales:

- `predeploy` encadena `check-migraciones-registro.js` (solo filesystem,
  sin `--db`), `smoke-test-frontend.js`, `check-asset-wiring.js`,
  `check-api-wiring.js`, `check-handler-dispatch.js` — los cinco leen
  archivos del repo, ninguno abre conexión de red.
- `npm test` (vitest) no usa variables de entorno reales contra Supabase de
  producción (así lo documenta el propio `vitest.config.js`).
- `check-schema.js` (el único script del proyecto que sí necesita
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) **no** está en la cadena de
  `predeploy` — queda fuera del workflow a propósito, no requiere secrets en
  GitHub Actions.

`test:e2e` (Playwright) queda fuera del gate obligatorio, tal como especifica
el plan — corre nightly o manual antes de releases grandes, no en cada push.

## Fuera de alcance al momento de este changelog (cerrado después, ver v1006)

- **Branch protection**: cerrado por Luc el 2026-08-29 vía ruleset de GitHub sobre la rama por defecto
  ("Require status checks to pass" → `predeploy + test`, enforcement Active). Detalle en
  `docs/changelogs/v800-984/CHANGELOG_v1006_etapa1_branch_protection_activa.md`.
- No se agregó todavía el job manual de `loadtest:etapa4` como paso
  disparable desde Actions (fase 2 opcional que menciona el plan) — se deja
  para cuando la Etapa 4 esté corrida y validada.

## Verificación

- Revisado que `predeploy` y `test` no requieren red ni credenciales (ver
  arriba) — no verificable en este entorno correr el workflow real de
  GitHub Actions (sandbox sin acceso a github.com para Actions), pero la
  sintaxis del YAML y los comandos que invoca son los mismos que ya corren
  localmente en el repo.
