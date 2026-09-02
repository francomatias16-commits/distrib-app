# v444 — Fase 3.3 del plan de acción: test de carga básico (autocannon)

**Contexto:** continúa `plan-de-accion.md`. Cierra la Fase 3 completa
(3.1 CI, 3.2 tests unitarios, 3.3 test de carga).

## Por qué

El incidente RL-01 (2026-07-12, ver `CHANGELOG_v300` y `CHANGELOG_v303`) —
los 9 endpoints de `/api/admin/*` devolviendo 504 tras migrar el rate
limiter a un contador en Supabase — se hubiera detectado con un test de
carga de unos minutos antes de deployar, sin necesidad de que Cristian lo
descubriera en producción.

## Qué hace `scripts/load-test.js`

- Pega contra los 9 endpoints exactos del incidente, uno por vez (no todos
  en simultáneo, para poder aislar cuál falla si algo falla):
  `kpis`, `pedidos`, `stock/bajo`, `reportes/ventas-diarias`, `alertas`,
  `onboarding`, `dashboard-ejecutivo`, `comparativa-mensual`,
  `resumen-arranque`.
- 30 conexiones concurrentes x 20 segundos por endpoint por defecto
  (dentro del rango 20-50 que pide el plan), ajustable con las env vars
  `CONNECTIONS` y `DURATION`.
- Hace login real contra Supabase Auth (`SUPABASE_URL` + `SUPABASE_ANON_KEY`
  + `LOAD_TEST_EMAIL`/`LOAD_TEST_PASSWORD`) para conseguir un
  `access_token` real — `/api/admin/*` valida ese token directo contra
  Supabase Auth (`supabase.auth.getUser(token)`, ver `lib/handlers/admin.js`),
  no la cookie del login propio de `/api/auth/login` (ese es otro sistema,
  para el portal cliente).
- Todos los endpoints listados son GET-only — el propio dispatcher de
  `admin.js` rechaza cualquier otro método con 405 — así que el script no
  escribe nada en la base. Seguro de correr contra un preview o incluso
  producción sin riesgo de efectos secundarios, más allá de la carga en sí.
- Por endpoint reporta: requests/seg, latencia p50/p99, cantidad de
  timeouts y de respuestas 5xx.
- Sale con código de error (`exit 1`) si algún endpoint tuvo timeouts,
  algún 5xx, o latencia p99 por encima de 5 segundos — el mismo tipo de
  señal que hubiera marcado RL-01 antes del deploy en vez de después.

## Salvaguardas

- Si `BASE_URL` no apunta a `localhost`/`127.0.0.1`, el script se niega a
  correr salvo que se pase `CONFIRM_PROD=yes` — para no terminar
  golpeando producción por un typo o por copiar el comando de otra
  sesión sin pensarlo.
- Todas las credenciales (Supabase, usuario de prueba) van por variable de
  entorno, nada hardcodeado.

## Cómo correrlo

```bash
BASE_URL=https://tu-preview.vercel.app \
SUPABASE_URL=https://jgiquzjwoedmzwqgzubr.supabase.co \
SUPABASE_ANON_KEY=eyJ... \
LOAD_TEST_EMAIL=admin-de-prueba@ejemplo.com \
LOAD_TEST_PASSWORD=************ \
npm run loadtest
```

**Cuándo:** antes de un cambio grande en `lib/rate-limit.js` o en
cualquiera de estos 9 handlers — no es parte del CI de cada push, tal
como pide el plan.

## Verificado en esta entrega

- `node --check scripts/load-test.js` OK.
- Salvaguarda de `CONFIRM_PROD` probada: sin la variable, con `BASE_URL`
  no-local, corta antes de intentar nada.
- Falta de credenciales (`SUPABASE_URL`, etc.) probada: corta con mensaje
  claro antes de gastar la corrida.
- Llamada programática a `autocannon` probada de forma aislada contra un
  servidor HTTP local de prueba (no contra el proyecto real, que necesita
  credenciales de Supabase que no están disponibles en este entorno) —
  confirma que la integración con la librería funciona como se espera.
- No se corrió contra un deploy real de `distrib` en esta sesión (no hay
  `SUPABASE_ANON_KEY` ni usuario de prueba a mano); queda para que
  Cristian lo corra con sus credenciales antes del próximo cambio grande
  en rate limiting.

## Archivos

- `scripts/load-test.js` (nuevo)
- `package.json` (`autocannon` devDependency, script `loadtest`)
- `plan-de-accion.md` (3.3 marcada — cierra la Fase 3 completa)
