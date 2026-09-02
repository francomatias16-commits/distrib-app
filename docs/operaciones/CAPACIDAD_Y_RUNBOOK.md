# Capacidad del sistema y runbook de incidentes de carga

Etapa 8 del `PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md`. Objetivo: tener
un número de referencia y una secuencia de pasos ya pensada, no improvisar en
el momento del pico. Todo lo que sigue está confirmado en vivo (código,
`vercel.json`, Supabase por API) — nada es una suposición sobre "cómo debería
estar configurado".

---

## 1. Números de referencia de hoy (2026-08-29)

### Infraestructura
| Capa | Plan actual | Límite relevante |
|---|---|---|
| Vercel | **Hobby** | Funciones: `maxDuration: 60` configurado en `api/index.js` (el dispatcher único que atiende los ~40 handlers). Logs crudos (`get_runtime_logs`) solo se retienen **1 hora** en este plan — 7d/24h devuelven error. |
| Supabase | **Free** (org `distribuidora_prueba`, proyecto `jgiquzjwoedmzwqgzubr`) | 500 MB storage, 60 conexiones directas / 200 vía pooler (Supavisor). Auto-pausa a los 7 días sin tráfico. Sin backups automáticos ni PITR. |

### Uso actual (medido, no estimado)
- **Storage:** 74 MB de 500 MB (15%) — `productos` es la tabla más pesada (5.4 MB / 466 filas). Volumen de pilot/demo.
- **Conexiones DB:** 5 activas, todas de infraestructura propia de Supabase (`postgrest`, `pg_cron`, `pg_net`, `postgres_exporter`, `mgmt-api`) — **cero** conexiones directas abiertas por la app. Toda la app habla con Postgres vía el cliente REST de `@supabase/supabase-js` (PostgREST), nunca `postgres://` directo (`lib/repos/_db.js`, `lib/supabase-lazy.js`). El límite de conexiones no es un riesgo mientras se mantenga ese patrón.
- **Duración de requests:** instrumentado desde el 2026-08-28 (`[PERF] mod=... ruta=... duration_ms=...` en `api/index.js`, `console.warn` si `duration_ms >= 45000` — 75% del límite de 60s). **Sin datos reales todavía**: falta que se acumule tráfico o se corra la Etapa 4 para tener p95/p99 reales. Ver sección 4.

### Rate limiting y resiliencia (ya resueltos, no repetir trabajo)
- **Rate limiting distribuido** (`lib/rate-limit.js`): contador en Postgres (tabla `rate_limits`, RPC `rl_check_and_increment`, atómico), compartido entre todas las instancias/regiones de Vercel — no depende de memoria por proceso. Si Supabase no responde, degrada a un `Map` local en memoria como red de contención, con log siempre que esto pasa. 34 de 35 módulos de `lib/handlers/` tienen al menos un limiter (login 5/min, registro 5/hora, webhook WhatsApp 60/min, etc.).
- **Circuit breaker** (`lib/circuit-breaker.js`, patrón CLOSED/OPEN/HALF_OPEN): cubre pagos (`mpBreaker`), asistente de IA, y desde el 2026-08-28 también ARCA/AFIP (`wsaaBreaker`, `wsfev1Breaker`) y WhatsApp (`waBreaker`). Un servicio externo caído responde 503 con `retryAfter` en vez de colgar el request hasta el timeout.

---

## 2. Qué falta para tener el cuadro completo (Etapa 4, pendiente de vos)

Este documento **no incluye todavía** un número de "cuántos usuarios
concurrentes aguanta el sistema" porque depende de `scripts/load-test-etapa4.js`
(checkout de cliente, venta de POS, webhook de WhatsApp — las tres superficies
con más tráfico real esperado, que `scripts/load-test.js` original no cubre).
El script está escrito pero necesita tus credenciales de prueba (`LOAD_TEST_*`,
`WA_APP_SECRET`) y corre contra la empresa demo pública. Cuando lo corras:

1. Guardá la salida (throughput, latencia p50/p95, errores por endpoint).
2. Volvé a este documento y completá la sección 1 con los números reales.
3. Cruzalos con los `[PERF] duration_ms=...` de `get_runtime_logs` de esa
   misma ventana para confirmar que el load test reprodujo lo que se ve en
   producción, no solo en el entorno de prueba.

---

## 3. Runbook — pasos si aparecen 504 / latencia alta en producción

Orden pensado para llegar a la causa raíz más probable primero, sin perder
tiempo revisando lo que ya se sabe que está bien.

1. **`get_runtime_logs` (Vercel) con `query="[PERF]"`, `level=warning`.**
   Encuentra los requests con `duration_ms >= 45000` de la última hora (único
   rango que retiene el plan Hobby — consultar seguido, no una sola vez tarde
   si el incidente ya pasó). El log trae `mod=` y `ruta=`: ahí está el handler
   concreto que está tardando, no hace falta adivinar.
2. **`get_runtime_errors` (Vercel).** Confirma si son timeouts puros (504) o
   si hay excepciones no capturadas antes del timeout — cambia el diagnóstico
   (código roto vs. dependencia externa lenta).
3. **`get_advisors(performance)` (Supabase).** Si el handler lento hace
   queries, esto descarta o confirma un problema de índices nuevo (la
   auditoría de performance ya cerró esta capa el 2026-08-28, pero un patrón
   de acceso nuevo puede introducir uno). Hoy solo devuelve hallazgos `INFO`
   sin uso — cualquier cosa más grave es una señal real.
4. **Tabla `rate_limits` (vía `query_logs` o `execute_sql`, Supabase).** Si el
   pico es tráfico anómalo (bot, reintento en loop de un cliente), un spike
   de filas con el mismo `key` lo muestra. Si el rate limiter está en modo
   fallback (`Map` local — se loguea explícitamente cuando pasa esto en los
   logs de Vercel), el límite efectivo es más laxo hasta que Supabase
   responda de nuevo: no es un bug, pero conviene saber que está pasando.
5. **Estado de los circuit breakers** (`wsaaBreaker`, `wsfev1Breaker`,
   `waBreaker`, `mpBreaker`): si el handler lento llama a ARCA, WhatsApp o
   Mercado Pago, un breaker en `OPEN` ya está devolviendo 503 rápido en vez
   de colgar — revisar si el problema es el propio breaker reintentando
   `HALF_OPEN` contra un servicio que sigue caído, no algo para arreglar en
   el código.
6. **Storage/conexiones de Supabase** (`get_project`, o directo en el
   dashboard): solo relevante si el storage se acerca al 70-80% (Etapa 7) o
   si por algún motivo aparece una conexión directa (`postgres://`) que no
   debería existir — hoy no hay ninguna.

### Qué NO es una señal de alarma
- `cron.job_run_details` mostrando 100% de éxito **no confirma** que un cron
  con `net.http_post` (fire-and-forget) haya recibido una respuesta 200 real
  — solo que se encoló. Esto ya causó un incidente real (OBS-03, ver
  `docs/auditorias/AUDITORIA_2026/etapas/08_observabilidad.md`) y quedó
  resuelto del lado de la base, pendiente del lado de Vercel — no repetir el
  diagnóstico desde cero si vuelve a aparecer un patrón similar.

---

## 4. Próxima revisión de este documento

Actualizar cuando:
- Se corra `loadtest:etapa4` por primera vez (completa la sección 1).
- El storage de Supabase pase el 50% (250 MB) — mitad de camino al
  disparador de upgrade de la Etapa 7.
- Se sume el primer cliente real con datos que importa no perder (dispara la
  necesidad de Pro + backups/PITR, según la Etapa 7).
