# v301 — Causa raíz real del cuelgue: `supabase.auth.getUser()` sin timeout

**Fecha:** 2026-07-12

## Por qué v300 no alcanzaba

El fix de v300 (timeout en el rate limiter) era correcto pero **no era la
causa real** — solo tapaba un síntoma parcial. Comparando `admin.js` contra
`piloto.js`/`score.js` (que nunca se cuelgan): estos últimos no hacen
ninguna llamada de red a Supabase Auth — verifican un JWT local
(`verificarToken()`, `lib/auth-helpers.js`, puro CPU). `admin.js` es el
único módulo de los que fallaban que llama a `supabase.auth.getUser(token)`
— una request real contra el servicio Auth (GoTrue) de Supabase — y esa
llamada específica es la que se cuelga sin tirar error, comiéndose los 60s
completos de Vercel mientras el resto de la lambda (ya caliente, sirviendo
otros módulos en paralelo) responde normal.

## Fix

`lib/handlers/admin.js`, función `autenticar()`: se agrega
`getUserConTimeout()`, que envuelve `supabase.auth.getUser(token)` en un
`Promise.race()` con un límite de 8 segundos. Si Auth no contesta a tiempo,
se corta con `503` y un mensaje claro ("reintentá en unos segundos") en vez
de colgar hasta que Vercel mate la función a los 60s.

**Importante — esto es un fail-FAST, no fail-open:** a diferencia del rate
limiter (donde dejar pasar la request ante un timeout es aceptable), acá no
se puede "permitir igual" sin autenticar — sería un agujero de seguridad.
Lo que se gana es que ahora, en el peor caso, el usuario ve un error a los
8 segundos y puede reintentar, en vez de una pantalla colgada 60 segundos
que parece "no carga nada".

## Lo que este fix NO resuelve

La causa de fondo — por qué `auth.getUser()` se cuelga intermitentemente en
la primera tanda de requests de cada carga del dashboard — sigue sin
explicación definitiva. Es consistente con un problema conocido de
conexiones keep-alive reusadas en mal estado entre invocaciones de lambda
(Node `fetch`/`undici` + entorno serverless), pero no se pudo confirmar con
certeza total. Si esto se sigue repitiendo seguido (no solo el primer load
de vez en cuando), vale la pena escalarlo a soporte de Vercel con los
`request_id` de los timeouts, o migrar `admin.js` a `verificarToken()`
(JWT local) si el panel admin puede vivir sin depender de Supabase Auth
directamente — pero eso es un cambio más grande, no algo para hacer bajo
presión de incidente.

## Verificación

- `node --check lib/handlers/admin.js` OK.
- No cambia la firma de `autenticar()` ni el contrato de la respuesta en el
  camino feliz (Auth contesta rápido, como pasa el 95% de las veces según
  los logs).
