# Plan de robustez y escalabilidad profesional — Fluxo (2026)

**Inicio:** 2026-08-28
**Relación con otros planes:** complementa (no reemplaza) `AUDITORIA_2026/etapas/07_performance_escalabilidad.md`,
que ya cerró la capa de base de datos (índices, RLS, políticas duplicadas). Este plan ataca todo lo que
esa etapa **no cubre**: la arquitectura alrededor de la DB — CI/CD, caching, resiliencia ante picos,
retención de datos, y capacidad real del sistema bajo carga.

**Diagnóstico de partida (verificado en vivo, no supuesto):**
- `get_advisors(performance)` hoy solo devuelve hallazgos `INFO` de índices sin uso — la capa de queries
  está limpia. El problema de escalabilidad de Fluxo **no está en el SQL**.
- **No hay CI/CD.** No existe `.github/workflows/`. Los scripts `predeploy`, `test` (vitest, ~1200 casos) y
  `test:e2e` (Playwright) existen y funcionan, pero nada los corre automáticamente antes de un merge o un
  deploy — dependen de que se ejecuten a mano. Un push directo a `main` llega a producción sin gate.
- **No hay capa de caché** (Redis/Upstash/similar). Cada lectura, incluidas las "calientes" (catálogo de
  cliente, KPIs de dashboard, `plan-limits.js`), pega directo a Postgres vía PostgREST en cada request.
- **`scripts/load-test.js` cubre 9 endpoints de `/api/admin/*`**, nacido puntualmente del incidente RL-01
  (504s de 2026-07-12). No cubre el checkout de cliente, el webhook de WhatsApp, ni el POS — las tres
  superficies con más tráfico real esperado.
- **No hay política de retención** en tablas de crecimiento no acotado: `eventos_negocio`, `notif_log`,
  `security_audit_historial`, `whatsapp_conversaciones`/mensajes, logs de auditoría. Hoy son chicas; en 6-12
  meses de uso real no lo serán, y nada las purga o particiona.
- **Circuit breaker + retry ya existen** (`lib/circuit-breaker.js`) y desde 2026-08-28 cubren también ARCA/AFIP
  (WSAA/WSFEv1) y WhatsApp Business API (`notif.js`/`piloto.js`), además del asistente de IA y pagos
  (`lib/repos/pagos.js`) — ver Etapa 5, ya cerrada.
- **Rate limiting distribuido** (Etapa 11) y **backups automatizados** (Etapa 9) ya están resueltos a nivel
  profesional — no se repiten acá.
- No hay documento de capacidad: cuántos usuarios concurrentes soporta hoy el plan actual de Vercel/Supabase,
  ni un runbook de qué mirar primero si el sistema se degrada bajo carga real.

---

## Estado general

| # | Etapa | Estado | Por qué importa |
|---|-------|--------|------------------|
| 1 | CI/CD real (gate automático) | 🟢 Completa (2026-08-29) | Hoy nada impide que código roto llegue a producción; los ~1200 tests existen pero no corren solos |
| 2 | Retención/particionado de tablas de alto crecimiento | 🟢 Completa (2026-08-29) | `eventos_negocio`/`notif_log`/logs crecen sin límite; sin esto, la Etapa 7 (índices) se degrada sola con el tiempo |
| 3 | Capa de caché para lecturas calientes | 🟡 Generalizada al catálogo de cliente (2026-08-29); `plan-limits.js` descartado por riesgo (ver detalle) — falta medir con load test | Catálogo de cliente y KPIs pegan a Postgres en cada request; un pico de tráfico multiplica carga innecesaria |
| 4 | Load testing ampliado (checkout, WhatsApp webhook, POS) | 🟡 Script escrito — falta que lo corras vos (necesita credenciales/env vars tuyas) y confirmar resultados | El único load test que existe nació de un incidente puntual de admin, no cubre las superficies con más tráfico real |
| 5 | Resiliencia de integraciones externas (circuit breaker/retry) | 🟢 Completa | Se confirmó el gap (WSAA/WSFEv1 y WhatsApp sin breaker) y se cerró — ver detalle en la sección de la etapa |
| 6 | Límites de funciones serverless (timeout/memoria Vercel) | 🟡 Instrumentado — falta que se acumule tráfico real para medir p95/p99 | Mapear qué endpoints están cerca del límite de 60s más allá del incidente ya resuelto (RL-01) |
| 7 | Capacidad de base de datos (plan Supabase, connection scaling) | 🟢 Completa | Se confirmó plan Free directo por API (sin depender de que lo mires vos en el dashboard) y se documentó el camino de upgrade — ver detalle en la sección de la etapa |
| 8 | Documento de capacidad + runbook de incidentes de carga | 🟢 Completa (2026-08-29) — cifras de load test (Etapa 4) quedan pendientes de actualizar cuando la corras | Hoy no hay número de referencia de "cuánto aguanta el sistema", ni pasos documentados si se degrada |
| 9 | Observabilidad — cierre de OBS-03 | 🟡 Bloqueada por vos | Ya documentado en Etapa 8 de AUDITORIA_2026: falta setear `INTERNAL_PUSH_SECRET` en Vercel y redeployar |

Leyenda: 🟢 completa · 🟡 bloqueada/en progreso · ⚪ no iniciada

---

## Etapa 1 — CI/CD real ✅ (2026-08-29)
**Objetivo:** que sea imposible mergear o deployar código que rompe tests, wiring checks o el smoke test.
- **Hecho:** `.github/workflows/ci.yml` — en cada push/PR a `main` corre `npm ci`, `npm run predeploy`
  (schema drift, smoke test frontend, asset wiring, api wiring, handler dispatch) y `npm test` (vitest, 1200
  casos). Node 24.x (igual que `engines` en `package.json`), con `concurrency`/`cancel-in-progress` para no
  acumular runs viejos. Confirmado que ninguno de estos comandos toca Supabase ni credenciales reales —
  `check-schema.js` (el único script del repo que sí las necesita) no forma parte de `predeploy` y queda
  fuera del workflow a propósito. Detalle completo en
  `docs/changelogs/v800-984/CHANGELOG_v1004_etapa1_ci_cd_gate_automatico.md`.
- **Hecho:** ruleset de GitHub sobre la rama por defecto (`main`) con "Require status checks to pass"
  apuntando al check `predeploy + test`, activo (no en modo `Disabled`). Un PR con el check en rojo ya
  bloquea el merge — el gate es real, no solo informativo.
- `test:e2e` (Playwright) queda fuera del gate obligatorio por ahora (es más lento) — correrlo nightly o
  manual antes de releases grandes, no en cada push.
- Opcional, fase 2: agregar `npm run loadtest` (ver Etapa 4) como job manual disparable desde Actions,
  no automático, tal como ya está pensado en el script actual. Se deja para cuando la Etapa 4 esté corrida.

## Etapa 2 — Retención/particionado de tablas de alto crecimiento ✅ (2026-08-28 / ampliada 2026-08-29)
**Objetivo:** que ninguna tabla crezca sin límite ni estrategia.
- Las 6 tablas del diagnóstico original están cubiertas: `notif_log`, `eventos_negocio`, `audit_log`
  (2026-08-28) + `security_audit_historial`, `whatsapp_conversaciones`/`whatsapp_mensajes`,
  `asistente_conversaciones`/`asistente_mensajes` (ampliación 2026-08-29). Ninguna tiene relación con
  facturación/AFIP, así que no aplicó la salvedad de retención legal del diagnóstico original.
- **Decisión:** se archiva (a tabla `_historico` espejo, mismas columnas) antes de purgar — nunca un
  `DELETE` directo. Job programado: cron diario de Vercel (`/api/retencion`, 03:50 UTC), no borrado ad-hoc.
- Retención de 180 días, compartida entre las 6 tablas por simplicidad (si en el futuro hace falta un valor
  distinto por tabla — ej. más retención forense en `security_audit_historial` — se parametriza cuando
  aparezca esa necesidad concreta, no antes).
- Reglas de selección más allá de la fecha en las tablas con estado propio: `whatsapp_conversaciones` solo
  purga conversaciones `estado='cerrada'` (una activa nunca se toca, sin importar su antigüedad);
  `asistente_conversaciones` no tiene ese concepto, purga directo por `actualizado_en`. En ambos casos
  (padre/hijo) los mensajes se archivan antes que la conversación, para no dejar huérfanos en `_historico`.
- Trabajo real en el RPC `archivar_y_purgar_retencion` (SECURITY DEFINER, solo `service_role`); el handler
  (`lib/handlers/retencion.js`) autentica el cron (`CRON_SECRET`) o permite un trigger manual para
  dueño/admin. Detalle completo en `docs/changelogs/v800-984/CHANGELOG_v1005_etapa2_retencion_ampliada.md`.
- Verificado con la suite completa (`npx vitest run`): 73 archivos, 1192 tests, sin regresiones.

## Etapa 3 — Capa de caché para lecturas calientes
**Objetivo:** sacarle presión a Postgres en los endpoints de más tráfico sin tocar la lógica de negocio.
- Candidatos concretos, ya identificados en el código: catálogo público de cliente
  (`cliente_productos_disponibles`, ya tiene guard de Etapa 2 de seguridad), `plan-limits.js`, KPIs de
  dashboard (`handleDashboardEjecutivo`/`handleKPIs`, ya tocados en v959).
- **Decisión confirmada con vos (2026-08-28):** caché en memoria (Map + TTL por instancia de lambda), no
  Upstash Redis. Se evaluó Redis (lo sugería el diagnóstico original) pero el proyecto ya tenía el mismo
  patrón probado en producción en `lib/demo-mode.js` (`esEmpresaDemo`) — arrancar por ahí evita sumar una
  dependencia externa, env vars nuevas y una cuenta de Upstash sin necesidad, siguiendo el mismo criterio
  incremental del resto del plan. Si el piloto muestra que hace falta caché compartido entre instancias,
  ese es el momento de sumar Redis — no antes.
- **Piloto elegido (2026-08-28): KPIs del dashboard admin.** Implementado:
  - `lib/cache.js` — módulo genérico (`cacheado(clave, ttlMs, calcular)` + `invalidar(clave)`), reutilizable
    por cualquier otro endpoint sin reinventar el cacheo. Fail-open por diseño: si `calcular()` tira error,
    no se cachea nada.
  - `lib/handlers/admin.js` (`handleKPIs`): se separó el cálculo (`calcularKpisDashboard`, cacheable) de la
    escritura de la respuesta, para no cachear nunca un error. Clave `kpis-dashboard:${empresa_id}:${periodo}`,
    TTL 30s.
  - Sin tests unitarios propios todavía para `handleKPIs` (no existían antes tampoco) — si se agregan, seguir
    el mismo criterio que ya usan `whatsapp-notif-permisos.test.js` y otros: `vi.mock('../../lib/cache.js')`
    para bypassear el caché en tests, igual que ya se hace con `demo-mode.js`.
- **Pendiente:**
  - Medir impacto real con el load test de la Etapa 4 (antes/después) — la Etapa 4 todavía no existe, así
    que por ahora el piloto está sin medición cuantitativa, solo la lógica implementada.
  - Decidir si se generaliza al catálogo de cliente (`cliente_productos_disponibles`) y a `plan-limits.js`
    una vez medido el piloto. El catálogo tiene una complicación extra: precio/ofertas/reglas de volumen se
    resuelven por cliente autenticado, así que ahí conviene cachear solo la parte no personalizada (el RPC
    base), no la respuesta completa — a diseñar cuando se aborde ese candidato.

## Generalización (2026-08-29) — catálogo de cliente

- **`handleClienteCategorias`** (`lib/handlers/stock.js`): 100% no personalizado (solo depende de
  `empresa_id`), se cachea la respuesta completa. Clave `categorias-cliente:${empresa_id}`, TTL 60s — las
  categorías activas cambian con mucha menos frecuencia que el stock.
- **`handleClienteProductos`**: se cachea únicamente la RPC base `cliente_productos_disponibles` (precio de
  lista general + stock agregado — igual para cualquier visitante con la misma
  empresa/categoría/búsqueda/página). Clave `catalogo-cliente:${empresa_id}:${categoria}:${busqueda}:${limit}:${offset}:${solo_destacados}`,
  TTL 15s (más corto que los 30s de KPIs: el stock cambia con cada venta/POS, y una demora en reflejar
  "sin stock" es peor UX en un catálogo público que en un dashboard interno). Todo lo que sigue después de
  la RPC — `resolver_precios_cliente`, ofertas de liquidación, reglas de volumen — sigue corriendo fresco
  en cada request, sin tocar: es exactamente la parte que varía por cliente autenticado, cachearla filtraría
  precios de un cliente a otro.
- **`plan-limits.js` (`exigirLimitePlan`) — descartado, no es un buen candidato.** A diferencia de KPIs o
  catálogo (lecturas puras), esta función es un **gate de enforcement**: se llama antes de crear un
  recurso (cliente, usuario, pedido) para decidir si la empresa ya llegó al límite de su plan. Cachear el
  resultado de "¿llegué al límite?" con cualquier TTL, por corto que sea, abre una ventana donde varias
  creaciones concurrentes leen el mismo "todavía no llegaste" cacheado y lo superan — justo el escenario
  que un pico de tráfico (lo que la Etapa 3 quiere abaratar) hace más probable, no menos. El ahorro de
  carga acá no vale el riesgo de negocio de un enforcement que se puede saltear bajo ráfaga. Si en algún
  momento hace falta abaratar esta RPC, la vía correcta es optimizar `chequear_limite_plan` en SQL o cachear
  solo el numerador/denominador para mostrarlo en UI (no para la decisión de bloqueo), nunca el resultado
  binario de la que depende el enforcement.
- Test de cobertura: `tests/cache.test.js` (el módulo `lib/cache.js` en sí no tenía tests — cubre TTL,
  fail-open y `invalidar()`, hereda a cualquier handler que lo use, no solo a estos dos).
- Verificado con la suite completa: 74 archivos, 1197 tests (1192 + 5 nuevos), sin regresiones. `npm run
  predeploy` sin cambios en los 6 warnings preexistentes del dispatch heurístico (no relacionados).
- Sigue pendiente medir el impacto real con la Etapa 4 (antes/después) una vez que corras el load test.

## Etapa 4 — Load testing ampliado
**Objetivo:** que el load test cubra lo que el negocio realmente usa bajo tráfico, no solo lo que ya falló una vez.
- **Decisiones confirmadas con vos (2026-08-28):**
  - Tenant de prueba: la **empresa demo pública**, reseteada a su snapshot base al final del script vía
    `fn_reset_demo_v2` (mismo mecanismo que ya usa el botón de reset de la demo en el panel superadmin) —
    no un tenant nuevo dedicado.
  - Webhook de WhatsApp: **solo se mide la recepción** (validación de firma HMAC + parseo + intento de
    resolución de teléfono), sin disparar envíos salientes reales.
- **Hecho:** `scripts/load-test-etapa4.js` (script hermano de `load-test.js`, no lo reemplaza) +
  `npm run loadtest:etapa4`. Tres escenarios (corribles juntos o por separado con `ESCENARIOS=...`):
  - **Checkout de cliente:** login como usuario de portal cliente de la demo → trae un producto real con
    stock del catálogo propio → confirma pedidos en loop (`forma_pago: pago_inmediato`, para no generar
    deuda de cta_cte real; `idempotency_key` distinto por request para no dedupear el load real).
  - **POS:** login como admin/vendedor de la demo → abre turno en la primera caja activa → vende el mismo
    producto en loop (pago en efectivo, monto de sobra para no tener que calcular el total exacto
    server-side) → cierra el turno al terminar.
  - **Webhook de WhatsApp:** payload con `phone_number_id` y número `from` sintéticos que no matchean
    ninguna empresa/cliente real — el handler igual valida firma y parsea (que es el costo real que se
    quiere medir), pero nunca resuelve a un cliente real, así que nunca dispara una respuesta automática,
    en ningún entorno donde corra esto.
  - Al final (si corrió `checkout` y/o `pos`) resetea la empresa demo — salvo `SKIP_DEMO_RESET=yes`. El
    reset requiere credenciales de superadmin (`LOAD_TEST_SUPERADMIN_EMAIL/PASSWORD`) y
    `LOAD_TEST_DEMO_EMPRESA_ID` explícito — nunca se manda `empresa_id` vacío al RPC de reset, para no
    arriesgarse a un alcance más amplio del documentado.
  - Umbral de alerta: mismo criterio que `load-test.js` (5000ms p99), configurable si hace falta ajustarlo
    por escenario más adelante.
- **Pendiente, acción tuya:** correrlo. Necesita variables que no tengo (`LOAD_TEST_CLIENTE_EMAIL/PASSWORD`
  del portal cliente de la demo, `LOAD_TEST_SUPERADMIN_EMAIL/PASSWORD`, `LOAD_TEST_DEMO_EMPRESA_ID`,
  `WA_APP_SECRET`) y no pude ejecutarlo yo mismo (sin red en este entorno) — no está verificado contra el
  servidor real todavía, solo sintaxis y lectura del código de los handlers que llama. Antes de confiar en
  los resultados: correrlo primero contra local/preview, revisar que la empresa demo tenga al menos un
  producto con stock y una caja activa, y confirmar que el reset al final deja la demo como estaba.
- Con esto corrido antes/después, recién ahí se puede medir el impacto real del piloto de caché de la
  Etapa 3 (hoy el piloto está sin esa medición cuantitativa).

## Etapa 5 — Resiliencia de integraciones externas ✅ (2026-08-28)
**Objetivo:** confirmar que ninguna integración externa caída tumbe flujos internos.
- Auditado `lib/circuit-breaker.js`: confirmado que WSAA/WSFEv1 (ARCA/AFIP) y WhatsApp Business API tenían
  timeout (y en algunos casos retry) pero **no** circuit breaker, a diferencia de pagos/asistente.
- Aplicado el mismo patrón ya usado en pagos/asistente (`breaker.exec(() => ...)`, un breaker por servicio
  externo), sin inventar uno nuevo:
  - `wsaaBreaker` (`lib/arca/wsaa.js`) envolviendo `llamarWSAA()`. Sin retry a propósito: un TRA ya firmado
    no se puede reenviar sin generar uno nuevo (ver comentario en el archivo).
  - `wsfev1Breaker` (`lib/arca/wsfev1.js`) envolviendo los dos puntos de `llamarSOAP()`
    (`FECompUltimoAutorizado`, con retry existente, y `FECAESolicitar`, sin retry por el mismo motivo que
    WSAA — no es seguro reintentar una solicitud de CAE a ciegas). `timeoutMs` del breaker puesto por encima
    del `AbortController` interno (20s vs 15s) para que el mensaje de timeout específico de ARCA siga siendo
    el que se ve, no uno genérico.
  - `waBreaker` (`lib/handlers/notif.js`, exportado y reusado en `lib/handlers/piloto.js`) envolviendo
    `whatsappHandler` (templates) y `enviarTextoWhatsApp` (texto libre), preservando el reintento manual ya
    existente (131030 + transitorios) por dentro del `exec()`. `piloto.js` no tenía timeout ni breaker; se le
    sumó un `AbortController` de 10s que faltaba, además del breaker compartido.
  - `facturas.js`: el test de credenciales ARCA ahora distingue `CircuitBreakerOpenError` (503 + retryAfter)
    de un error real de credenciales (400), mismo patrón que auth.js/pagos.js.
- Verificado con la suite completa (`npx vitest run`): 73 archivos, 1191 tests, sin regresiones.

## Etapa 6 — Límites de funciones serverless 🟡 (2026-08-28, instrumentado)
**Objetivo:** evitar un RL-01 (504 en cascada) en un endpoint distinto al que ya se corrigió.
- Se intentó mapear con `get_runtime_errors`/`get_runtime_logs` de Vercel, pero el plan Hobby solo retiene
  logs crudos **1 hora** (7d/24h devuelven error de retención), y en esa ventana no había tráfico. Tampoco
  hay instrumentación de duración en ningún punto del código — sin eso, ni con más retención se podría haber
  calculado p95/p99.
- Se agregó logging de duración por request en `api/index.js` (el dispatcher único cubre los ~40 handlers
  desde un solo lugar): una línea `[PERF] mod=... ruta=... method=... status=... duration_ms=...` por
  request, con `console.warn` en vez de `console.log` cuando `duration_ms >= 45000` (75% del límite de 60s)
  para poder filtrar solo los casos de riesgo con `level=warning` en `get_runtime_logs`.
- **Pendiente:** dejar correr tráfico real y volver a consultar `get_runtime_logs` con `query="[PERF]"`
  (respetando la ventana de 1h del plan Hobby, hace falta consultar seguido, no una sola vez tarde) para
  recién ahí poder priorizar handlers de reportes/exports pesados (contable, ventas, stock) con datos reales
  en vez de sospecha.

## Etapa 7 — Capacidad de base de datos ✅ (2026-08-28)
**Objetivo:** saber de antemano el camino de upgrade antes de necesitarlo en caliente.
- Confirmado por API (`get_organization`), sin depender del dashboard: la organización `distribuidora_prueba`
  está en **plan Free** de Supabase.
- Estado actual de uso (medido directo en la base, proyecto `jgiquzjwoedmzwqgzubr`): **74 MB de 500 MB**
  (15%) de almacenamiento — la tabla más pesada es `productos` con 5.4 MB / 466 filas. Volumen típico de
  pilot/demo, lejos del techo.
- Conexiones: el Free tier de Supabase permite 60 conexiones directas y 200 vía pooler (Supavisor). Hoy solo
  hay 5 conexiones activas, **todas de infraestructura propia de Supabase** (`postgrest`, `pg_cron scheduler`,
  `pg_net`, `postgres_exporter`, `mgmt-api`) — cero conexiones directas abiertas por la app. Se confirmó en
  el código (`lib/repos/_db.js`, `lib/supabase-lazy.js`) que toda la app habla con la base exclusivamente vía
  el cliente REST de `@supabase/supabase-js` (Data API / PostgREST), nunca con una connection string
  (`postgres://`) directa — no hay un solo `new Pool()`/`DATABASE_URL` en todo el repo. Conclusión: el límite
  de conexiones **no es un riesgo hoy** para este proyecto, y no lo va a ser mientras se mantenga ese patrón.
- Riesgos reales del plan Free, en orden de probabilidad de impactar primero:
  1. **Auto-pausa por inactividad** (7 días sin tráfico) — el riesgo más inmediato para un pilot/demo con uso
     intermitente: un cliente puede encontrarse la app caída sin que sea un bug.
  2. **Sin backups automáticos ni PITR** — si algo corrompe datos o un `DELETE` sin `WHERE` pasa un
     `bloquearSiSoloLectura`, no hay forma de restaurar a un punto en el tiempo. PITR es un add-on pago
     (~US$100/mes por 7 días de retención) que además requiere Pro como base.
  3. **Compute compartido (500 MB RAM)** — no es throttling hoy con este volumen, pero es lo primero que se
     nota si el tráfico de reportes empieza a competir con el transaccional.
- **Camino de upgrade recomendado:** pasar a Pro (US$25/mes) no está atado a un número de conexiones (no es
  el cuello de botella real acá) sino a dos disparadores de negocio: (a) el momento de sumar el primer
  cliente real con datos que importa no perder — ahí backups/PITR dejan de ser opcionales — o (b) cuando el
  almacenamiento se acerque a ~350-400 MB (70-80% de 500 MB) o el tráfico de dashboard/reportes empiece a
  competir con el transaccional, momento en el que conviene evaluar un read replica (feature de Pro).

## Etapa 8 — Documento de capacidad + runbook ✅ (2026-08-29)
**Objetivo:** tener un número de referencia y un plan de acción, no improvisar en el momento del pico.
- **Hecho:** `docs/operaciones/CAPACIDAD_Y_RUNBOOK.md` — números confirmados de Vercel (Hobby, `maxDuration:
  60`, logs con retención de 1h) y Supabase (Free, 74/500 MB, conexiones, ver Etapa 7), resumen de rate
  limiting distribuido (Etapa 11) y circuit breakers (Etapa 5) ya resueltos, y un runbook ordenado por
  probabilidad de causa raíz: `get_runtime_logs`/`get_runtime_errors` (Vercel) → `get_advisors` (Supabase)
  → tabla `rate_limits` → estado de los breakers → storage/conexiones.
- **Pendiente, no bloqueante:** la sección de "cuántos usuarios concurrentes aguanta" queda con un
  placeholder documentado — depende de que corras `npm run loadtest:etapa4` (Etapa 4, requiere tus
  credenciales de prueba). El documento ya dice exactamente qué actualizar cuando eso pase.

## Etapa 9 — Observabilidad (cierre de pendiente ya documentado)
Ya relevado en `AUDITORIA_2026/etapas/08_observabilidad.md` (OBS-03): falta setear `INTERNAL_PUSH_SECRET`
en las variables de entorno de Vercel con el mismo valor regenerado en Supabase, y redeployar. No requiere
código nuevo — solo esa acción tuya. Se referencia acá porque observabilidad es parte de "escalabilidad
profesional": sin push funcionando, un pico de errores no se entera nadie a tiempo.

---

## Próximos pasos inmediatos (orden sugerido)
1. ~~Etapa 1 (CI/CD)~~ — completa (2026-08-29): workflow + branch protection activos, el gate ya bloquea
   merges con el check en rojo.
2. Etapa 9 (setear el secret pendiente) — es una acción de 5 minutos tuya, no mía.
3. ~~Etapa 2 (retención)~~ — completa (2026-08-28/29), las 6 tablas del diagnóstico original están cubiertas.
4. El resto (Etapas 3, 4, 6), a definir con vos según prioridad de negocio — decime con cuál arrancamos.
   Etapa 9 quedó pausada por vos (secreto expuesto en `08_observabilidad.md` sin resolver todavía).

## Cómo continuar en una sesión nueva
Decime "seguí con el plan de robustez" y retomo desde la tabla de estado de este archivo.
