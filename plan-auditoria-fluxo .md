# Plan de auditoría técnica — Fluxo (integridad financiera y sincronización)

> Objetivo: verificar, con evidencia y de forma repetible, que las áreas donde se mueve dinero real (caja, POS, pagos, cobranzas, facturación, stock) están sin duplicados, sin condiciones de carrera y correctamente sincronizadas entre canales.
>
> Aclaración de alcance: ningún sistema de software puede garantizarse "100% sin fallas" en sentido absoluto. Lo que este plan entrega es cobertura verificada en cada capa crítica, sin huecos conocidos abiertos, con comandos repetibles antes de cada deploy que toque código financiero.

---

## Estado de partida — infraestructura que ya existe

No hay que reconstruir esto, solo ejecutarlo y confirmar que sigue en verde:

- [ ] `npm test` — unitarios (vitest) sobre `lib/`
- [ ] `npm run test:integration` — CRUD/RPCs reales contra Supabase de test (última corrida documentada: 93/93 OK)
- [ ] `npm run test:e2e` — Playwright sobre el panel admin
- [ ] `npm run audit:security` — funciones `SECURITY DEFINER` sin filtro de `empresa_id`, vistas sin `security_invoker`
- [ ] `npm run check-schema` — tablas/columnas referenciadas en código vs. DB real
- [ ] `npm run check:migrations` — migraciones duplicadas o no registradas
- [ ] `npm run check-wiring:all` — fetch del frontend → rewrite → handler real
- [ ] `npm run check-handler-dispatch` — cada `accion=X` del frontend tiene handler
- [ ] `npm run audit:funciones-fantasma` — funciones en DB no versionadas en migraciones

Ya construido y en uso, como antecedente directo de este plan:

- Auditoría de `usuario_id`/`audit_log` cerrada módulo por módulo sobre los caminos de dinero: pedidos → POS → pagos MP → cobro manual (cta_cte).
- Idempotencia ya resuelta en `webhooks_recibidos` (dedupe por `evento_externo_id`) y en POS vía `offline_local_id`.
- Un test de condición de carrera ya escrito: `tests/handlers/confirmar-pedido-sugerido-race.test.js` — sirve de patrón para extender.

---

## Brechas detectadas (punto de partida real, no hipotético)

1. `scripts/load-test.js` es **GET-only** — no hay carga sobre escrituras concurrentes (dos cajas vendiendo el mismo producto a la vez, dos cobros sobre la misma factura a la vez).
2. El patrón de test de carrera existe para un solo flujo (pedido sugerido). Falta replicarlo sobre `registrar_venta_pos`, `registrar_cobro_completo`, y el caso puntual de **Mercado Pago confirmando el mismo pago por dos caminos** (webhook `manejarWebhook` + polling `verificarPago`), ambos terminando en el mismo RPC.
3. No existe un script de **conciliación de saldos agregados** (cta_cte recalculada vs. mostrada; stock recalculado desde movimientos vs. stock actual en `productos`).
4. El anexo de `PLAN_COMERCIALIZACION_DISTRIB.md` dejó constraints financieras marcadas ⚠️ (defensa en profundidad débil) sin cerrar del todo — punto de partida directo para la Etapa 1.

---

## Etapas

### Etapa 0 — Línea de base
- [ ] Correr toda la batería existente (`predeploy`, `test`, `test:integration`, `test:e2e`, `audit:security`, `audit:funciones-fantasma`)
- [ ] Documentar resultado exacto de cada comando (no solo "OK/FAIL" — guardar el output)
- [ ] No avanzar a etapas siguientes si algo de esto no está en verde

### Etapa 1 — Integridad a nivel base de datos
- [ ] Confirmar `SECURITY DEFINER` + `empresa_id` seguro en funciones de `cta_cte`, `caja`, `facturas`, `notas_credito`, `ventas_pos`
- [ ] Cerrar los `CHECK constraints` marcados ⚠️ en el anexo de `PLAN_COMERCIALIZACION_DISTRIB.md` (26 constraints / 21 tablas relevadas, algunas sin cerrar)
- [ ] Revisar whitelist de parámetros en RPCs de escritura financiera (precedente: `crear_nota_credito` sin whitelist de `tipo`, ya corregido — buscar patrones similares)

### Etapa 2 — Correctitud de cálculos
- [ ] Unit tests exhaustivos de `lib/calc/pedido-totales.js`
- [ ] Unit tests exhaustivos de `lib/calc/iva-desglose.js`
- [ ] Casos límite: redondeo de centavos, descuentos combinados (global + por línea), IVA discriminado vs. no discriminado (A/B/C/M), cantidades fraccionadas

### Etapa 3 — Duplicados e idempotencia (prioridad alta)
- [ ] Test de concurrencia sobre `registrar_venta_pos`
- [ ] Test de concurrencia sobre `registrar_cobro_completo`
- [ ] Test específico: webhook de MP y polling (`verificarPago`) confirmando el mismo pago en simultáneo — verificar que no se acredite dos veces en `cta_cte`
- [ ] Confirmar row locking (`FOR UPDATE` o equivalente) donde corresponda

### Etapa 4 — Conciliación de saldos (a construir)
- [ ] Script que recalcule `cta_cte` por cliente desde movimientos individuales y lo compare contra el saldo mostrado
- [ ] Script que recalcule stock desde movimientos y lo compare contra `productos.stock_actual`
- [ ] Correrlo una vez para detectar divergencias arrastradas, después dejarlo como chequeo recurrente

### Etapa 5 — Circuito completo de punta a punta (E2E con foco en montos)
- [ ] Spec de Playwright que siga un mismo pedido real: pedido → descuento de stock exacto → factura con CAE → entrega → cobro → impacto en caja del turno → cierre
- [ ] Aserciones de monto en cada paso, no solo que la pantalla cargue

### Etapa 6 — Carga sobre escritura concurrente
- [x] Extender `scripts/load-test.js` a escritura: N cajas/POS vendiendo el mismo producto en simultáneo — **hecho reutilizando `scripts/load-test-etapa4.js` en vez de un archivo nuevo** (ver Etapa 7, "empaquetar en un único comando" — con esto ya comparten infraestructura de login/reset). Verificado en corrida real 2026-09-12: 10 conexiones concurrentes vendiendo el mismo producto por POS, stock antes 119 → después 93, 26 ventas confirmadas = 26 unidades esperadas = 26 realmente descontadas. Nunca negativo.
- [x] M cobros aplicándose a la misma factura al mismo tiempo — Verificado en corrida real 2026-09-12: 8 cobros disparados en paralelo (`Promise.all`, no autocannon) por el saldo completo de una factura real (`$12.329,90`). Exactamente 1 se aplicó, los otros 7 rechazados por "factura ya saldada". `total_cobrado` nunca superó `total`.
- [x] Confirmar que el locking aguanta bajo presión real, no solo en test de a uno — Confirmado para ambos RPCs (`registrar_venta_pos` vía migración 618, `registrar_cobro_completo` vía `20260818_p1_sec03_sec08_sync03_sync05_rpcs_financieras.sql`) con corridas reales contra Supabase, no simulación.

**Bugs encontrados y corregidos durante la verificación** (en `scripts/load-test-etapa4.js`, no en el código de producción):
- `escenarioCobroConcurrente` ordenaba por `facturas.created_at`, columna que no existe (la real es `updated_at`) — PostgREST devolvía un error en vez de un array y el script explotaba con un `TypeError` críptico. Corregido, y se agregó una validación explícita de `Array.isArray()` antes de usar la respuesta.
- La verificación de conservación de stock de `escenarioPos` le pegaba a una tabla `cajas` que no existe (la real es `cajas_pos`) — la verificación se saltaba en silencio y el escenario quedaba reducido a solo medir performance HTTP, sin validar lo que realmente importa en esta etapa. Corregido.

**Hallazgo colateral, fuera del alcance de esta etapa pero documentado para no perderlo:** el rate limiting (`lib/rate-limit.js`, ya distribuido vía Postgres desde el fix de RL-01) usa como clave `IP:ruta`, y en este proyecto todas las rutas de `/api/*` pasan por el mismo dispatcher (`/api/index` en local; en Vercel cada `_mod` probablemente cuenta aparte vía el rewrite, a confirmar). En local, esto hace que tráfico legítimo de escenarios distintos (`checkout`, `pos`) comparta el mismo cupo cuando se prueba desde la misma IP. No se tocó nada de esto — el comportamiento en producción con IPs de usuarios reales distintas no está afectado de la misma forma, pero si muchos usuarios reales pegan desde la misma IP (NAT corporativo/ISP) compartirían cupo. Vale la pena revisarlo en una etapa de rate limiting si se retoma ese tema.

### Etapa 7 — Cierre y repetibilidad
- [ ] Empaquetar toda la batería en un único comando (ej. `npm run audit:dinero`)
- [ ] Correrlo antes de cada deploy que toque código financiero — mismo criterio que `predeploy`

---

## Orden sugerido de arranque

1. Etapa 0 (gratis, ya está escrito — da la foto real de partida)
2. Etapa 3, caso MP webhook+polling (el hallazgo más concreto, no hipotético, ya visible en el código)
3. Resto de las etapas en el orden listado
