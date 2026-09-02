# v303 — Causa raíz confirmada: revertir rate limiter a memoria

**Fecha:** 2026-07-12

## Cómo se confirmó

Comparé `v295` (que Cristian confirmó que anda) contra `v298+` (roto).
`admin.js` es **idéntico** en ambas — mismo `autenticar()`, mismo
`supabase.auth.getUser()` sin timeout, mismo `rateLimit()` en el
dispatcher. Eso descarta todas las teorías anteriores (v300, v301): no es
Auth, no es la lógica de `admin.js`.

La única diferencia real es `lib/rate-limit.js`:

- **v295 (anda):** `Map` en memoria, 100% síncrono, cero llamadas de red.
- **v298+ (roto):** desde RL-01 (2026-07-11), cada request hace un
  `await db.rpc('fn_rate_limit_check', ...)` contra Supabase — una llamada
  de red real, en el primer paso de *cada* request a *cualquier* endpoint
  que use `rateLimit()` — antes de que corra una sola línea de lógica de
  negocio.

Esto explica todo lo que se observó:
- Por qué el timeout era siempre 60s exactos aunque agregué timeouts
  internos en v300/v301 — la request se colgaba en el rate limiter, antes
  de siquiera llegar a `autenticar()`.
- Por qué reducir la concurrencia (v302) no alcanzaba del todo — ayuda,
  pero no ataca la causa: sigue habiendo una llamada de red nueva por
  request que no estaba en la versión que funciona.

## Fix

Se revierte `lib/rate-limit.js` a la implementación en memoria de v295
(`Map`, síncrono). Misma firma pública (`rateLimit`, `rateLimitAuth`,
`rateLimitApi`, `rateLimitPorClave`) — cero cambios en los callers.

## Trade-off consciente (no un descuido)

RL-01 (ayer) migró a un contador en Supabase específicamente para que el
límite sea real entre varias instancias de Vercel corriendo en paralelo
(con el `Map` en memoria, cada instancia lleva su propio contador — el
límite efectivo se multiplica por la cantidad de instancias). Revertir
este fix reintroduce ese problema. Bajo la circunstancia actual (dashboard
completamente caído) restaurar el servicio pesa más que un rate limit
imperfecto — pero es una decisión a revisar con calma, no algo para
resolver bajo presión de incidente. Ideas para cuando haya tiempo:
Upstash/Vercel KV (Redis de verdad, pensado para este uso) en vez de
Postgres vía PostgREST, o investigar por qué específicamente esa llamada a
`fn_rate_limit_check` se cuelga (probablemente el mismo patrón de
conexión-reusada-en-mal-estado que se sospechó antes, pero ahora con
evidencia de que el punto de cuelgue real es este, no `auth.getUser()`).

## Verificación

- `node --check lib/rate-limit.js` OK.
- Confirmado que ningún otro archivo depende de
  `fn_rate_limit_check`/`api_rate_limits` (grep limpio).
- La migración 279 (`entregada`/`motivo` en `notif_log`, del fix de
  logging silencioso) NO se toca — sigue vigente y no tiene relación con
  este problema.
