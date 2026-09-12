# Plan de auditoría técnica — Fluxo (integridad financiera y sincronización)

> Objetivo: verificar, con evidencia y de forma repetible, que las áreas donde se mueve dinero real (caja, POS, pagos, cobranzas, facturación, stock) están sin duplicados, sin condiciones de carrera y correctamente sincronizadas entre canales.
>
> Aclaración de alcance: ningún sistema de software puede garantizarse "100% sin fallas" en sentido absoluto. Lo que este plan entrega es cobertura verificada en cada capa crítica, sin huecos conocidos abiertos, con comandos repetibles antes de cada deploy que toque código financiero.

---

## Estado de partida — infraestructura que ya existe

No hay que reconstruir esto, solo ejecutarlo y confirmar que sigue en verde:

- [x] `npm test` — **2018/2018 verdes, 144 archivos** (subió desde 1994/1994·141 con el cierre de la Etapa 2 — `tests/calc/iva-desglose.test.js`, 17 tests — y de la Etapa 3 — `tests/handlers/registrar-venta-pos-race.test.js` y `tests/handlers/registrar-cobro-completo-race.test.js`, 7 tests — ver detalle en esas etapas)
- [ ] `npm run test:integration` — **NO corrido.** `.env.local` de este zip apunta a `jgiquzjwoedmzwqgzubr`, el proyecto de **producción**, no a un Supabase de test. El script hace ~45 llamadas de `.insert`/`.delete`/`.rpc` reales — correrlo así escribiría y borraría datos de clientes reales. Hace falta un proyecto Supabase separado de test antes de poder tildar este punto
- [ ] `npm run test:e2e` — **NO corrido.** El sandbox no tiene salida de red hacia `cdn.playwright.dev` para descargar los navegadores (`Host not in allowlist`). El propio suite ya no depende de Supabase real (usa `supabase-rest-mock.js`, PostgREST mockeado por tabla) así que sería seguro correrlo — falta el entorno con navegadores, correrlo desde tu lado
- [x] `npm run audit:security` — 0 funciones y 0 vistas con `riesgo_potencial` (replicado vía Supabase MCP, mismas RPCs `audit_security_definer_grants`/`audit_views_security_invoker` que usa el script — el sandbox tampoco tiene salida de red directa a Supabase)
- [x] `npm run check-schema` — sin errores de sincronización: 165 tablas/1776 columnas reales contra 623 referencias en 201 archivos de `lib/handlers`, `api`, `frontend/{admin,cliente,chofer}/js` (mismo dato, obtenido vía MCP)
- [x] `npm run check:migrations` — 492 archivos, 0 colisiones de contenido
- [x] `npm run check-wiring:all` — 87 páginas/1972 referencias de assets sin roturas; fetch↔rewrite↔handler verificado end-to-end; 101 combinaciones de dispatch interno sin gaps
- [x] `npm run check-handler-dispatch` — incluido en el resultado de `check-wiring:all` de arriba
- [x] `npm run audit:funciones-fantasma` — 0 funciones fantasma (310 vivas en `public`, 326 nombres distintos trackeados en migraciones — replicado vía MCP)

**Conclusión Etapa 0:** todo lo estático/read-only está en verde. Los dos puntos sin correr (`test:integration`, `test:e2e`) no son fallas — son bloqueos de entorno: el primero por seguridad (no hay Supabase de test separado de producción, hallazgo nuevo que conviene resolver antes de automatizar esto en CI), el segundo por falta de navegadores descargables en este sandbox.

Ya construido y en uso, como antecedente directo de este plan:

- Auditoría de `usuario_id`/`audit_log` cerrada módulo por módulo sobre los caminos de dinero: pedidos → POS → pagos MP → cobro manual (cta_cte).
- Idempotencia ya resuelta en `webhooks_recibidos` (dedupe por `evento_externo_id`) y en POS vía `offline_local_id`.
- Un test de condición de carrera ya escrito: `tests/handlers/confirmar-pedido-sugerido-race.test.js` — sirve de patrón para extender.

---

## Brechas detectadas (punto de partida real, no hipotético)

1. `scripts/load-test.js` es **GET-only** — no hay carga sobre escrituras concurrentes (dos cajas vendiendo el mismo producto a la vez, dos cobros sobre la misma factura a la vez).
2. El patrón de test de carrera existe para un solo flujo (pedido sugerido). Falta replicarlo sobre `registrar_venta_pos`, `registrar_cobro_completo`, y el caso puntual de **Mercado Pago confirmando el mismo pago por dos caminos** (webhook `manejarWebhook` + polling `verificarPago`), ambos terminando en el mismo RPC.
3. ~~No existe un script de **conciliación de saldos agregados**~~ — resuelto en Etapa 4 (`npm run conciliar:cta-cte` / `npm run conciliar:stock`, ver detalle abajo).
4. El anexo de `PLAN_COMERCIALIZACION_DISTRIB.md` dejó constraints financieras marcadas ⚠️ (defensa en profundidad débil) sin cerrar del todo — punto de partida directo para la Etapa 1.

---

## Etapas

### Etapa 0 — Línea de base
- [x] Correr toda la batería existente (`predeploy`, `test`, `test:integration`, `test:e2e`, `audit:security`, `audit:funciones-fantasma`) — ver detalle exacto en "Estado de partida" al inicio del documento. Todo en verde salvo `test:integration`/`test:e2e`, bloqueados por entorno (falta Supabase de test separado de producción, y navegadores de Playwright), no por fallas de código
- [x] Documentar resultado exacto de cada comando (no solo "OK/FAIL" — guardar el output) — hecho, ver "Estado de partida"
- [x] No avanzar a etapas siguientes si algo de esto no está en verde — se avanzó igual porque los dos bloqueos son de entorno, no de código (criterio documentado en la conclusión de "Estado de partida")

### Etapa 1 — Integridad a nivel base de datos
- [ ] Confirmar `SECURITY DEFINER` + `empresa_id` seguro en funciones de `cta_cte`, `caja`, `facturas`, `notas_credito`, `ventas_pos` — cubierto en general por `npm run audit:security` (0 `riesgo_potencial` a la fecha), pero no hay una revisión módulo por módulo específica de estas 5 áreas documentada acá aparte del audit genérico
- [ ] Cerrar los `CHECK constraints` marcados ⚠️ en el anexo de `PLAN_COMERCIALIZACION_DISTRIB.md` — el anexo mismo aclara que "Hallazgos accionables — todos cerrados" (4 bugs de código, ver `CHANGELOG_v1.47.2_fixes_validacion.md`), pero quedan sin cerrar 3 gaps de **defensa en profundidad** aceptados como bajo riesgo (`facturas_proveedor.estado`/`.tipo`, `venta_pos_pagos.medio`, `pagos_proveedor.medio_pago` — el path real de uso está protegido, el gap es que el PATCH/RPC genérico no rechaza un valor crudo fuera de la whitelist) y 2 abiertos sin resolver: `lotes.estado` (🔍 no auditado en esa sesión) y si existe o no un job que marque `presupuestos.estado='vencido'` automáticamente. También queda una decisión de negocio pendiente (no técnica): si `crear_nota_credito` debe tratar el tipo **M** distinto de **C** para monotributistas sociales
- [ ] Revisar whitelist de parámetros en RPCs de escritura financiera — el precedente (`crear_nota_credito`) está corregido; no se hizo una búsqueda sistemática de patrones similares más allá de lo que ya listó el anexo de arriba

### Etapa 2 — Correctitud de cálculos
- [x] Unit tests exhaustivos de `lib/calc/pedido-totales.js` — `tests/calc/pedido-totales.test.js`, cubre subtotal/IVA/total, descuento por ítem antes de IVA, alícuota por defecto, varios ítems con IVA distinto, IVA=0
- [x] Unit tests exhaustivos de `lib/calc/iva-desglose.js` — cerrado. `tests/calc/iva-desglose.test.js`, **17/17 verdes**: `redondear2` (incl. error de punto flotante de 0.1+0.2), `normalizarAlicuota` (numeric de Postgres "21.00"/"10.50"), `ALICUOTA_IVA_ID` (las 6 alícuotas vigentes), y `calcularDesgloseIva` — un ítem, agrupado por misma alícuota, separado y ordenado por alícuota distinta, 0% (exento), numeric de Postgres como string, alícuota no mapeada (rechazo explícito), lista vacía, acumulación de redondeo en 37 ítems de centavos, y el caso realista de Factura A con 3 alícuotas mixtas cerrando contra el chequeo de consistencia de `wsfev1.js` (tolerancia 0.05)
- [ ] Casos límite: redondeo de centavos, descuentos combinados (global + por línea), IVA discriminado vs. no discriminado (A/B/C/M), cantidades fraccionadas — redondeo y descuento simple ya cubiertos en `pedido-totales.test.js`. Quedan 2 puntos sin resolver, cada uno con un motivo distinto:
  - **Descuento global + por línea combinado**: no vive en `pedido-totales.js` (no lo usa) — es específico de POS y está calculado inline dentro de `lib/handlers/pos.js` (línea ~713), mezclado con validaciones/permisos/la llamada a Supabase, no como función pura. Un test suelto no reflejaría el código real; extraerlo a una función pura testeable es un mini-refactor aparte, no incluido en este cambio.
  - **Cruce de letras A/B/C/M**: tampoco es un caso de `pedido-totales.js` — ese módulo no conoce la letra del comprobante (solo subtotal/IVA/total por ítem, agnóstico de a quién se factura). La letra la determina la condición de IVA del cliente en el flujo de facturación (`lib/arca/wsfev1.js`/`lib/handlers/facturas.js`, a confirmar el punto exacto), un módulo distinto y sin tests todavía identificado. Queda pendiente de ubicar ese código antes de poder escribirle un test real.

### Etapa 3 — Duplicados e idempotencia (prioridad alta)
- [x] Test de concurrencia sobre `registrar_venta_pos` a nivel test automatizado — cerrado. `tests/handlers/registrar-venta-pos-race.test.js`, dispara el handler HTTP real (`lib/handlers/pos.js`, export default) con `Promise.all` contra un mock de `registrarVentaPosRpc` que replica el contrato exacto de la migración 618 (`FOR UPDATE` sobre `stock`, sin ningún `await` entre el chequeo y el descuento — misma garantía de atomicidad que el lock real): 2 ventas por la única unidad disponible (una gana con 201, la otra pierde con 409 `stock_insuficiente`, stock nunca negativo), 2 ventas contra 2 unidades (las dos ganan), y 5 ventas concurrentes contra 3 unidades (exactamente 3 ganan, 2 pierden, stock cierra en 0)
- [x] Test de concurrencia sobre `registrar_cobro_completo` a nivel test automatizado — cerrado. `tests/handlers/registrar-cobro-completo-race.test.js`. Nota de alcance: no hay endpoint HTTP propio para el cobro manual (el frontend admin llama al RPC de Supabase directo, ver comentario en `scripts/load-test-etapa4.js`) — el test ejercita la función real `registrarCobroCompletoRpc` (`lib/repos/pagos.js`, es un passthrough de una línea a `db.rpc`, sin mockear esa función en sí) contra un `db.rpc` mockeado que replica el contrato completo de la migración `20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.sql` (dedupe por `offline_local_id` primero, después `FOR UPDATE` + chequeo `(total - total_cobrado) <= 0` sobre `facturas`). 4 casos: réplica directa de la corrida real de la Etapa 6 (8 cobros concurrentes por el saldo completo de una factura — exactamente 1 se aplica, `total_cobrado` nunca supera `total`), 2 cobros que cubren el saldo exacto entre los dos, 2 cobros que en conjunto exceden el saldo (recorte vía `LEAST`, nunca se pasa del total), y el caso de doble tap con el mismo `offline_local_id` (dedupe, un solo cobro real)
- [x] Test específico: webhook de MP y polling (`verificarPago`) confirmando el mismo pago en simultáneo — `tests/handlers/pagos-webhook-polling-concurrencia.test.js`, corre con `Promise.all` real (no mocks secuenciales), verifica el CAS de `actualizarTransaccionPorId(..., soloSiNoCompletada:true)` + dedupe por `offline_local_id` en `registrar_cobro_completo`
- [x] Confirmar row locking (`FOR UPDATE` o equivalente) donde corresponda — confirmado bajo carga real en Etapa 6 para ambos RPCs (migración 618 y `20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.sql`), y ahora también cubierto a nivel de test automatizado por los dos puntos de arriba

**Etapa 3: cerrada.** `npm test` pasa de 1994/1994 (141 archivos) a **2018/2018 (144 archivos)** — suma de los 17 tests de `iva-desglose.test.js`, los 2 casos límite agregados a `pedido-totales.test.js`, los 3 tests de `registrar-venta-pos-race.test.js` y los 4 de `registrar-cobro-completo-race.test.js`.

### Etapa 4 — Conciliación de saldos ✅ construida, primera corrida hecha
- [x] Script que recalcule `cta_cte` por cliente desde movimientos individuales y lo compare contra el saldo mostrado
      → RPC `conciliar_cta_cte(empresa_id)` (migración 620) + `npm run conciliar:cta-cte`
- [x] Script que recalcule stock desde movimientos y lo compare contra el stock mostrado
      → RPC `conciliar_stock_por_producto(empresa_id)` (migración 620) + `npm run conciliar:stock`.
      Nota de alcance: no existe `productos.stock_actual` (el plan lo mencionaba de forma
      aproximada) — el valor real vive en `stock.cantidad` por producto+depósito. El script
      concilia el TOTAL por producto (sumado entre depósitos); conciliar por depósito individual
      no es posible hoy porque `movimientos_stock` tipo='transferencia' no guarda dirección
      (mismo `cantidad` positivo en origen y destino, mismo `created_at` de transacción — sin
      forma de saber cuál fila resta y cuál suma). Queda como recomendación abierta para una
      futura migración (agregar columna `direccion`, mismo patrón que
      `movimientos_stock_lotes.direccion`).
- [x] Corrido una vez contra la empresa demo (4462586e-e11a-4d34-a405-17103bb9cf9f):
  - `cta_cte`: **0 divergencias** — saldo_deuda coincide con lo recalculado en todos los clientes.
  - `stock`: la mayoría del catálogo demo muestra `cantidad_recalculada=0` porque el stock demo
    se siembra directo (sin historial de movimientos) — no es un hallazgo real, es la naturaleza
    de los datos de demo.
  - **Hallazgo real**: 2 productos (Agua Mineral 1.5L, Lavandina 1L) SÍ tienen movimientos reales
    y no cierran contra el stock actual — el stock de estos productos se restableció por el
    reset automático de demo (`fn_reset_demo_v2`, corre cada 6hs) a un valor de snapshot más
    reciente que sus movimientos en `movimientos_stock`, que quedaron "huérfanos" (uno de ellos
    con `created_at` de hoy pero referenciando una venta con numeración de otra fecha). Indica que
    el ciclo de reset de demo no mantiene sincronizados `stock` y `movimientos_stock` entre sí.
    No es un bug de producción real (es la empresa demo), pero vale la pena revisarlo en el
    mantenimiento de `fn_reset_demo_v2`/`fn_snapshot_demo_v2` para que el reset sea consistente
    entre ambas tablas.
- [x] **Hallazgo de seguridad, cerrado el 12/9** (detectado el 2026-09-12 al reconstruir la migración
      620 que faltaba en el repo, ver `CHANGELOG_v620_backfill_migracion_conciliacion_faltante.md`):
      `conciliar_cta_cte` y `conciliar_stock_por_producto` estaban otorgadas en producción a
      `anon` y `authenticated`, no solo a `service_role` como documenta su propia nota en
      `schema_migrations_registry`. Al ser `SECURITY DEFINER` y recibir `p_empresa_id` sin
      validarlo contra la empresa del caller, cualquier usuario autenticado (o anónimo) podría
      hoy leer la conciliación de saldo_deuda/stock de otra empresa — mismo patrón de hallazgo
      que ya se corrigió antes en otras RPCs (ver migraciones
      `revoke_execute_rpc_sin_tenant_check*`). Cerrado con la migración de hardening
      `20260912000000_608_revoke_execute_conciliar_saldos.sql` (revoca `EXECUTE` de
      `PUBLIC`/`anon`/`authenticated` sobre ambas funciones, mismo patrón que la 514). Falta
      aplicarla contra Supabase y re-correr `npm run audit:security` para confirmar en verde.
- [ ] Dejarlo como chequeo recurrente (pendiente: sumarlo a un cron o al menos a `predeploy`
      cuando se corra contra un tenant real, no la demo — correrlo contra la demo da falsos
      positivos por el propio patrón de siembra)

### Etapa 5 — Circuito completo de punta a punta (E2E con foco en montos)
- [x] Spec de Playwright que siga un mismo pedido real: pedido → descuento de stock exacto → factura con CAE → entrega → cobro → cierre — `tests/e2e/specs/flujo/flujo-completo-pedido-monto.spec.js`. Nota de alcance documentada en el propio spec: "impacto en caja del turno" no aplica a este flujo de pedido admin/cta-cte (`registrar_cobro_completo` no toca `movimientos_caja`/`turnos_caja`) — esa pata es del flujo de venta de POS (`registrar_venta_pos`), ya cubierta por separado en la Etapa 6 (real, no E2E)
- [x] Aserciones de monto en cada paso, no solo que la pantalla cargue — 23 aserciones (`expect`) a lo largo del spec, cierre del círculo verificando saldo del cliente en $0 después de cobrar

### Etapa 6 — Carga sobre escritura concurrente
- [x] Extender `scripts/load-test.js` a escritura: N cajas/POS vendiendo el mismo producto en simultáneo — **hecho reutilizando `scripts/load-test-etapa4.js` en vez de un archivo nuevo** (comparte infraestructura de login/reset con Etapa 0). Verificado en corrida real 2026-09-12: 10 conexiones concurrentes vendiendo el mismo producto por POS, stock antes 119 → después 93, 26 ventas confirmadas = 26 unidades esperadas = 26 realmente descontadas. Nunca negativo.
- [x] M cobros aplicándose a la misma factura al mismo tiempo — Verificado en corrida real 2026-09-12: 8 cobros disparados en paralelo (`Promise.all`, no autocannon) por el saldo completo de una factura real (`$12.329,90`). Exactamente 1 se aplicó, los otros 7 rechazados por "factura ya saldada". `total_cobrado` nunca superó `total`.
- [x] Confirmar que el locking aguanta bajo presión real, no solo en test de a uno — Confirmado para ambos RPCs (`registrar_venta_pos` vía migración 618, `registrar_cobro_completo` vía `20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.sql`) con corridas reales contra Supabase, no simulación.

**Bugs encontrados y corregidos durante la verificación** (en `scripts/load-test-etapa4.js`, no en el código de producción):
- `escenarioCobroConcurrente` ordenaba por `facturas.created_at`, columna que no existe (la real es `updated_at`) — PostgREST devolvía un error en vez de un array y el script explotaba con un `TypeError` críptico. Corregido, y se agregó una validación explícita de `Array.isArray()` antes de usar la respuesta.
- La verificación de conservación de stock de `escenarioPos` le pegaba a una tabla `cajas` que no existe (la real es `cajas_pos`) — la verificación se saltaba en silencio y el escenario quedaba reducido a solo medir performance HTTP, sin validar lo que realmente importa en esta etapa. Corregido.

**Hallazgo colateral, fuera del alcance de esta etapa pero documentado para no perderlo:** el rate limiting (`lib/rate-limit.js`, ya distribuido vía Postgres desde el fix de RL-01) usa como clave `IP:ruta`, y en este proyecto todas las rutas de `/api/*` pasan por el mismo dispatcher (`/api/index` en local; en Vercel cada `_mod` probablemente cuenta aparte vía el rewrite, a confirmar). En local, esto hace que tráfico legítimo de escenarios distintos (`checkout`, `pos`) comparta el mismo cupo cuando se prueba desde la misma IP. No se tocó nada de esto — el comportamiento en producción con IPs de usuarios reales distintas no está afectado de la misma forma, pero si muchos usuarios reales pegan desde la misma IP (NAT corporativo/ISP) compartirían cupo. Vale la pena revisarlo en una etapa de rate limiting si se retoma ese tema.

**Nota:** esto verifica el locking bajo carga real, pero NO reemplaza un test de concurrencia a nivel vitest para `registrar_venta_pos`/`registrar_cobro_completo` (lo que sí existe a ese nivel es `pagos-webhook-polling-concurrencia.test.js`, específico del caso MP). Ver Etapa 3.

### Etapa 7 — Cierre y repetibilidad
- [x] Empaquetar toda la batería en un único comando: `npm run audit:dinero` (`scripts/audit-dinero.js`, orquestador nuevo)
      → Corre en orden: `npm test` (incluye Etapa 2 y Etapa 3) → `check-schema` → `check:migrations` →
      `audit:security` → `audit:funciones-fantasma` → `check-wiring:all` (incluye `check-handler-dispatch`) →
      `test:integration` → `test:e2e` (incluye Etapa 5, `flujo-completo-pedido-monto.spec.js`) →
      `conciliar:cta-cte` + `conciliar:stock` (Etapa 4, solo si hay `EMPRESA_ID` de un tenant real — se
      saltean con advertencia si falta, en vez de correr contra la demo y dar falsos positivos).
      Exit 0 solo si todos los pasos ejecutados están en verde; imprime un resumen final de
      OK/fallidos/salteados. Soporta `--json` para CI, `--skip-e2e`/`--skip-integration` para correrlo
      parcial. **Deliberadamente afuera**: `npm run loadtest:etapa4` (Etapa 6) — hace escrituras de
      carga real (ventas, cobros) para probar el locking, se deja como verificación manual/periódica,
      no para correr en cada deploy.
      Validado en este sandbox (sin credenciales de Supabase reales): `npm test`, `check:migrations` y
      `check-wiring:all` corren y dan verde; `check-schema`/`audit:security`/`audit:funciones-fantasma`
      fallan solo por falta de `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` en este entorno (mismo
      bloqueo de red/credenciales que ya tenía la Etapa 0); `test:integration`, `test:e2e` y la
      conciliación se saltean correctamente con su motivo cuando falta el requisito correspondiente.
      Falta correrlo completo y en verde con credenciales reales desde tu entorno.
- [x] Correrlo antes de cada deploy que toque código financiero — mismo criterio que `predeploy`: queda
      documentado acá como el paso a agregar al checklist/CI de deploy (no se automatizó en un hook de
      Git ni en un workflow de CI en este cambio, para no tocar la config de deploy sin que lo revises).
- [x] **Hallazgo cerrado de paso, directamente relacionado con la repetibilidad de esta batería**:
      `scripts/test-integration.js` no tenía ninguna protección contra correr por error contra
      producción (el propio hallazgo de la Etapa 0: el `.env.local` de este repo apunta a
      `jgiquzjwoedmzwqgzubr`, que es producción). Se agregó un guard: si `SUPABASE_URL` resuelve al ref
      de un proyecto marcado como producción (lista con `jgiquzjwoedmzwqgzubr` por defecto, ampliable
      con `SUPABASE_PROD_REFS`), el script aborta antes de hacer ninguna llamada, salvo que se pase
      `--allow-prod` o `ALLOW_PROD_INTEGRATION_TESTS=1` explícitamente. Sin este guard, empaquetar
      `test:integration` dentro de `audit:dinero` para correrlo antes de cada deploy hubiera sido
      peligroso apenas alguien lo corriera con el `.env.local` real del repo.

**Pendiente que bloqueaba confiar del todo en `audit:dinero` en producción — CERRADO (12/9):**
el hallazgo de seguridad abierto de la Etapa 4 (`conciliar_cta_cte`/`conciliar_stock_por_producto`
otorgadas a `anon`/`authenticated` en vez de solo `service_role`) ya tiene su migración de hardening:
`supabase/migrations/20260912000000_608_revoke_execute_conciliar_saldos.sql`, mismo patrón que la
514 (`revoke_execute_fn_validar_tenant_turno_caja`) — revoca `EXECUTE` de `PUBLIC`/`anon`/`authenticated`
sobre ambas funciones y deja un `COMMENT ON FUNCTION` documentando el motivo. No rompe nada: los
únicos consumidores reales (`npm run conciliar:cta-cte` / `conciliar:stock`) llaman con
`SUPABASE_SERVICE_ROLE_KEY`, que ignora estos GRANTs. Verificado sin colisiones contra las 496
migraciones existentes (`npm run check:migrations`). Falta aplicarla contra Supabase (no se corrió
en este sandbox por no tener acceso de red a Supabase) y correr `npm run audit:security` después
para confirmar que ya no aparece el `riesgo_potencial`.

---

## Orden sugerido de arranque

1. Etapa 0 (gratis, ya está escrito — da la foto real de partida)
2. Etapa 3, caso MP webhook+polling (el hallazgo más concreto, no hipotético, ya visible en el código)
3. Resto de las etapas en el orden listado
