# v445 — Fase 4.1 del plan de acción: Sentry en el backend (error tracking)

**Contexto:** continúa `plan-de-accion.md`, Fase 4 (observabilidad). Retoma
el trabajo de una sesión anterior que había dejado agregado únicamente el
`import * as Sentry from '@sentry/node'` en `api/index.js`, sin el
`Sentry.init()` ni la dependencia en `package.json` — quedó así tras
reorganizar el import junto a los demás y dejar el bootstrap "para
después". Esta entrega cierra esa parte pendiente.

## Qué cambia

- `api/index.js`:
  - `Sentry.init()` después de todos los imports, activado solo si existe
    la env var `SENTRY_DSN`. Sin esa variable, Sentry directamente no se
    inicializa — no rompe local ni previews sin configurar.
  - `environment` se toma de `VERCEL_ENV` (o `NODE_ENV` como fallback), así
    Sentry distingue producción de preview.
  - `tracesSampleRate: 0` — esta fase es solo error tracking, no tracing de
    performance (eso, si se quiere, es un paso aparte).
  - En el `catch` final del dispatcher (mismo lugar que ya arma el
    `correlation_id` para BUG-03), se agrega `Sentry.captureException(err, {
    tags: { modulo, correlation_id } })`. El `correlation_id` que ya se le
    devuelve al cliente y se loguea en consola ahora también queda como tag
    en Sentry — permite ir del error que reporta un usuario/QA directo al
    evento en Sentry sin tener que grepear logs de Vercel primero.
- `package.json`: `@sentry/node ^10.68.0` como dependencia de producción
  (no dev — corre en el runtime serverless).

## Por qué solo backend por ahora

La sesión anterior había explorado también instrumentar el frontend
(relevó `frontend/env-config.js` y contó las páginas HTML que lo incluyen
como candidatas), pero eso no llegó a implementarse y es un alcance
aparte — sección propia del plan. Esta entrega cierra primero el
dispatcher, que es donde pasan *todos* los errores de *todos* los módulos
(es la ventaja del dispatcher único: un solo lugar para instrumentar en
vez de 34 handlers).

## Pendiente / próximo paso

- Setear `SENTRY_DSN` en las env vars del proyecto en Vercel (prod y,
  opcionalmente, preview) — sin eso Sentry queda inactivo por diseño.
- Evaluar Sentry en el frontend (browser SDK) sobre las páginas admin que
  incluyen `env-config.js`, si se decide continuar esa rama del plan.

## Verificado en esta entrega

- `node --check api/index.js` OK.
- `package.json` válido tras agregar la dependencia.
- Con `SENTRY_DSN` sin definir, el `if` que envuelve `Sentry.init()` y el
  que envuelve `Sentry.captureException()` no ejecutan — comportamiento
  idéntico al de antes de este cambio.

## Archivos

- `api/index.js` (`Sentry.init()` + `captureException` en el catch)
- `package.json` (`@sentry/node` como dependencia)
- `plan-de-accion.md` (pendiente marcar 4.1 — no está en este export del
  proyecto, marcar en el repo real)
