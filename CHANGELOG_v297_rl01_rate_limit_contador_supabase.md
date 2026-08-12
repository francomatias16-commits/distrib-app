# v297 — RL-01: rate limiting compartido entre instancias (contador en Supabase)

**Fecha:** 2026-07-11
**Origen:** Etapa 11 de la auditoría 2026 (`AUDITORIA_2026/etapas/11_rate_limiting_dos.md`).
**Contexto de negocio:** tras la decisión de seguir en Vercel Hobby sin
upgrade (sin presupuesto disponible por el momento), no hay WAF/rate-limiting
de edge pago disponible — este fix pasa a ser la única defensa real de rate
limiting a nivel aplicación.

## Problema

`lib/rate-limit.js` guardaba los contadores en un `Map` de proceso. Bajo
varias instancias serverless de Vercel corriendo en paralelo (pico de
tráfico real o un ataque), cada instancia lleva su propio contador — el
límite efectivo se multiplica por la cantidad de instancias activas, justo
en el escenario donde más importa que no lo haga. Afectaba a los 34
handlers que usan `rateLimit()`/`rateLimitAuth`/`rateLimitApi`, incluyendo
el rate limit de login (`auth.js`).

Ya se había corregido el mismo patrón una vez, pero solo para el asistente
de IA (v220, `lib/handlers/asistente.js`), consultando la tabla
`asistente_uso` en vez de un Map local.

## Solución

Se generalizó el mismo criterio (contador centralizado en Supabase) para
todo `lib/rate-limit.js`, sin costo adicional (no se usó Redis/Upstash,
coherente con la decisión de seguir en planes Free/Hobby):

- **Nueva migración** (`supabase/migrations/rl01_rate_limit_contador_supabase.sql`):
  tabla `api_rate_limits` (una fila por clave activa, ventana fija) +
  función `fn_rate_limit_check(p_clave, p_max, p_ventana_ms)` — atómica vía
  `INSERT ... ON CONFLICT DO UPDATE`, `SECURITY DEFINER`, con `EXECUTE`
  revocado de `anon`/`authenticated` (solo `service_role` la puede llamar).
  Incluye limpieza oportunista de filas viejas (sin depender de un cron
  aparte) y **fail-open** ante cualquier error, mismo criterio que
  `excedioLimiteAsistente()` en `asistente.js`.
- **`lib/rate-limit.js`**: `rateLimit()` y `rateLimitPorClave()` ahora
  consultan `fn_rate_limit_check` vía `db.rpc(...)` en vez del `Map` local.
  Ambas pasan a ser `async`.
- **34 handlers**: se agregó `await` a los 52 call-sites de
  `rateLimitApi(req, res)` / `rateLimitAuth(req, res)` / variantes
  (`limiter`, `limiterVenta`, etc.) que antes se llamaban de forma síncrona.
  Sin este `await`, el cambio a async hubiera hecho que **todas** las
  requests se rechazaran con 429 (un `if (Promise)` siempre es truthy).
- **`lib/handlers/_push.js`** y **`lib/handlers/_auto-push.js`**: se agregó
  `await` a los 2 usos de `rateLimitPorClave()` (envío de push individual y
  automatizado), por el mismo motivo.

## Verificación

- `node --check` sobre los 30 handlers modificados + `lib/rate-limit.js` +
  `_push.js` + `_auto-push.js`: sin errores de sintaxis (confirma que todos
  los `await` agregados están dentro de funciones `async`, como ya lo
  requería el contrato original de estas funciones — ver el docstring de
  `rateLimit()`, que ya mostraba `if (await limiter(req, res)) return;`
  como uso esperado).
- `Supabase:get_advisors` (security) tras aplicar la migración: la nueva
  tabla `api_rate_limits` aparece con el mismo patrón esperado que
  `asistente_uso`/`demo_snapshots` (RLS habilitado sin políticas, nivel
  INFO — acceso exclusivo vía función `SECURITY DEFINER`). `fn_rate_limit_check`
  **no** aparece en los warnings de funciones ejecutables por `anon`/
  `authenticated` — confirma que el `REVOKE` quedó bien aplicado.

## Pendiente (no bloquea este fix)

- No se ejecutó ninguna prueba de carga real; la corrección es correcta por
  diseño (contador atómico compartido) pero no se midió el overhead de
  latencia de la consulta extra a Supabase por request. Si en el futuro esto
  se vuelve un cuello de botella, considerar cachear el resultado por unos
  segundos o revisar el `windowMs` de los límites más permisivos.
