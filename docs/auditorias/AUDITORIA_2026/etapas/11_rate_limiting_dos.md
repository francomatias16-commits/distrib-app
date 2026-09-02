# Etapa 11 — Rate limiting y protección DoS

**Estado:** 🟢 RL-01 resuelto (v297, 2026-07-11) — ver resolución al final de esa sección. RL-02 (decisión de negocio) cerrado. Queda RL-03 (menor) documentado más abajo.

## Contexto: lo que YA está bien hecho
Antes de los hallazgos, vale decir que la cobertura de rate limiting es
**amplia**: 34 de 35 módulos de `lib/handlers/` tienen al menos un limiter
aplicado (`lib/rate-limit.js`), con presets razonables por sensibilidad
(login 5/min, registro 5/hora, webhook WhatsApp 60/min, asistente de IA con
su propio límite — ver más abajo). El webhook de WhatsApp además valida el
rate limit **antes** de validar la firma HMAC y de tocar la base, que es el
orden correcto para no gastar cómputo en tráfico basura. Esta etapa no
encontró ningún endpoint sensible completamente desprotegido.

## RL-01 (el hallazgo principal) — El rate limiting HTTP depende de un `Map` en memoria por instancia, no compartido entre instancias de Vercel

`lib/rate-limit.js` guarda los contadores en un `Map` de proceso. En Vercel
Serverless, cada instancia paralela que se levanta ante un pico de tráfico
**tiene su propio `Map`, vacío** — no hay memoria compartida entre
instancias. Bajo tráfico normal (pocas instancias, mayormente en warm start)
esto funciona razonablemente bien. Pero en el escenario que más importa —
un ataque de fuerza bruta contra el login, o un flood a cualquier endpoint
público — Vercel escala horizontalmente exactamente como reacciona ante ese
patrón, y el límite efectivo real se multiplica por la cantidad de
instancias concurrentes en vez de mantenerse en el valor configurado.

**Esto no es un hallazgo nuevo del proyecto — ya fue detectado y corregido una vez, parcialmente:**
el changelog de `lib/handlers/asistente.js` (v220) documenta este exacto
problema y lo resolvió ahí moviendo el contador a una consulta persistente
contra `asistente_uso` en Supabase, en vez de `rateLimitPorClave()` en
memoria. La cita del propio código:

> "Con varias instancias de Vercel corriendo en paralelo (típico ante un pico
> de tráfico a la demo pública), cada una lleva su propio contador — el
> límite real efectivo se multiplica justo en el escenario donde más importa
> controlar el costo."

El problema es que ese fix se aplicó **solo** al asistente de IA (por costo
de API de Gemini), y el mismo patrón vulnerable sigue vigente en **los otros
34 handlers** — incluyendo el más sensible de todos: `rateLimitAuth`/
`limiterLogin` en `auth.js`, que es la única barrera contra fuerza bruta de
contraseñas.

**Impacto real:** no es una vulnerabilidad de acceso (no salta autenticación
ni aislamiento entre empresas, a diferencia de los hallazgos de la Etapa 2),
es un debilitamiento de una mitigación — el límite de 5 intentos/min de login
podría ser, en la práctica, N veces más alto bajo un ataque distribuido, sin
que se note en ningún log (cada instancia ve "solo 5 intentos" desde su
propia perspectiva).

**Opciones de fix (no se aplicó código todavía, es una decisión de
arquitectura, no un 1-liner):**
1. **Redis compartido** (Upstash tiene un free tier que integra nativo con
   Vercel) — la opción estándar de la industria para rate limiting
   serverless, sub-milisegundo, no le pega a Postgres.
2. **Mismo patrón que ya se usó en `asistente.js`**: contador contra una
   tabla de Supabase. Más simple (cero infraestructura nueva) pero le agrega
   una query a cada request de login/registro/etc. — aceptable para login
   (bajo volumen), no ideal para endpoints de alto tráfico como el catálogo
   público o el webhook de WhatsApp.
3. **Reglas de rate limiting a nivel Vercel WAF** (edge, antes de que la
   request llegue a la función) — ver RL-02, depende del plan.

### Resolución (v297, 2026-07-11)

Se eligió la **opción 2** (contador contra Supabase), coherente con la
decisión de negocio de seguir en planes Free/Hobby sin costo adicional —
Redis/Upstash quedó descartado por presupuesto, no por mérito técnico
(seguiría siendo la opción más eficiente si en algún momento se reconsidera
el upgrade).

Implementación: tabla `api_rate_limits` + función `fn_rate_limit_check`
(atómica, `SECURITY DEFINER`, solo `service_role`) en
`supabase/migrations/rl01_rate_limit_contador_supabase.sql`, y
`lib/rate-limit.js` reescrito para consultarla en vez del `Map` local —
ahora `rateLimit()` y `rateLimitPorClave()` son `async`, con `await`
agregado en los 52 call-sites de los 34 handlers (incluido `rateLimitAuth`
en `auth.js`) más los 2 usos de `rateLimitPorClave()` en `_push.js`/
`_auto-push.js`. Detalle completo en
`CHANGELOG_v297_rl01_rate_limit_contador_supabase.md`.

**Trade-off aceptado conscientemente:** cada request ahora paga una query
extra a Supabase (antes era memoria pura). Para login/registro (bajo
volumen) es irrelevante; para el catálogo público o el webhook de WhatsApp
(alto tráfico) es el mismo costo que ya paga, por ejemplo, cualquier fetch
de datos del propio handler — no debería ser el cuello de botella, pero no
se midió con una prueba de carga real (queda anotado como pendiente menor
en el changelog).

**Recordatorio importante:** este fix es código (`lib/rate-limit.js` + 34
handlers), no una migración SQL aislada — la tabla y la función ya están
aplicadas y activas en Supabase, pero el nuevo comportamiento de
`lib/rate-limit.js` **no tiene efecto en producción hasta el próximo
deploy** (`git push` → Vercel), igual que los demás fixes de código de esta
auditoría (SEC-013, los 8 XSS de la Etapa 5).

## RL-02 — El proyecto corre en Vercel Hobby (plan gratuito)

Confirmado indirectamente por el propio código: el comentario en
`api/index.js` explica que se consolidaron ~17 handlers en 1 sola Serverless
Function porque **"Vercel Hobby permite máximo 12 Serverless Functions"** —
esa arquitectura de dispatcher único existe específicamente por esa
limitación del plan gratuito.

Esto importa para esta etapa por 2 motivos:
- **Mitigación DDoS de red (L3/L4/L7)**: está activada automáticamente en
  **todos** los planes de Vercel, incluido Hobby, sin configuración — esto
  ya está cubierto, no requiere acción.
- **Reglas de rate limiting del WAF** (a nivel edge, la forma más eficiente
  de frenar un ataque porque ni siquiera llega a ejecutar la función): es
  una funcionalidad con límites y/o costo por plan. No se pudo confirmar el
  número exacto de reglas incluidas en Hobby desde acá (la documentación de
  precios cambia) — para dimensionarlo hay que mirarlo directamente en tu
  dashboard de Vercel (Project → Firewall).

**Hallazgo colateral, no técnico pero relevante:** el plan Hobby de Vercel
**prohíbe explícitamente uso comercial** en sus términos de servicio — y
`distrib` es un SaaS B2B con clientes pagos reales. Es el mismo tipo de
riesgo de negocio que `BACKUP-01` (Supabase Free) de la Etapa 9: no es un
bug, es una decisión de costo con exposición (en este caso, riesgo de
suspensión de cuenta si Vercel lo detecta, más que pérdida de datos).

**Decisión de negocio registrada (2026-07-11): seguís en Vercel Hobby.**
No hay presupuesto disponible por el momento para ningún upgrade pago (ni
Supabase Pro ni Vercel Pro) — la prioridad pasa a ser mitigar lo que se
pueda con herramientas gratuitas:
- El riesgo de ToS (suspensión de cuenta) no tiene mitigación técnica — es
  un riesgo aceptado conscientemente, no accidental.
- El WAF/rate-limiting de edge de pago **no está disponible en Hobby**, así
  que RL-01 (rate limiting en memoria, no compartido entre instancias) pasa
  a ser la única defensa real contra abuso a nivel aplicación. La opción
  gratuita más viable para resolverlo es un contador centralizado en la
  misma base de Supabase (ya hay precedente: así se corrigió el mismo
  patrón en `asistente.js` en v220) en vez de un store pago tipo
  Redis/Upstash — ver RL-01 más arriba.

## RL-03 (menor, agrava a RL-01) — El body de la request se lee y parsea completo antes de que corra cualquier rate limiter

En `api/index.js`, el dispatcher único lee el body crudo completo
(`leerRawBody`) y lo parsea como JSON **antes** de invocar el handler — y el
rate limiter de cada handler se ejecuta **adentro** del handler, después de
ese trabajo. Es decir: toda request no-GET a cualquier endpoint público
(login, registro, catálogo) paga el costo de leer y parsear el body *antes*
de que el límite de requests pueda cortarla.

**Impacto acotado:** Vercel cappea el tamaño máximo de body en ~4.5 MB a
nivel de plataforma (esto es un límite de infraestructura, no depende de la
config de `bodyParser` de la app) — así que no hay riesgo de agotamiento de
memoria sin límite por request. El impacto real es de **costo/cómputo**: con
RL-01 sin resolver (límite efectivo multiplicado entre instancias), cada
request extra que logra colarse paga ese costo de parseo antes de ser
frenada. Es agravante de RL-01, no un hallazgo independiente grave.

## Verificación de cierre
- Se revisaron los 35 módulos de `lib/handlers/` — 34/35 con al menos 1
  limiter, el 1 restante (`asistente.js`) ya usa el patrón correcto (contador
  persistente) por un fix anterior (v220) documentado en el propio código.
- Se confirmó el orden correcto de validación (rate limit → firma HMAC) en
  el webhook de WhatsApp (`notif.js`).
- Se confirmó vía `api/index.js` que el proyecto corre en Vercel Hobby.
- Se verificó (búsqueda web, julio 2026) que el límite de 4.5 MB de body es
  de plataforma, no de configuración de la app — acota el riesgo de RL-03.
- No se aplicó ningún cambio de código en esta etapa — RL-01 es una decisión
  de arquitectura (qué store usar) que te corresponde definir antes de
  implementar.

## Pendiente de decisión (para la próxima sesión de código)
¿Con qué store reemplazamos el `Map` en memoria de `lib/rate-limit.js` — Redis
(Upstash, requiere crear cuenta/integración nueva) o el mismo patrón de
contador contra Supabase que ya se usó en `asistente.js` (sin infra nueva,
pero con 1 query extra por request en los endpoints de mayor tráfico)?
