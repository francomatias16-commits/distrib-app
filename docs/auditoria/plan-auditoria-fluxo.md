# Plan de auditoría técnica — Fluxo (integridad financiera y sincronización)

> Objetivo: verificar, con evidencia y de forma repetible, que las áreas donde se mueve dinero real (caja, POS, pagos, cobranzas, facturación, stock) están sin duplicados, sin condiciones de carrera y correctamente sincronizadas entre canales.
>
> Aclaración de alcance: ningún sistema de software puede garantizarse "100% sin fallas" en sentido absoluto. Lo que este plan entrega es cobertura verificada en cada capa crítica, sin huecos conocidos abiertos, con comandos repetibles antes de cada deploy que toque código financiero.

---

## Estado de partida — infraestructura que ya existe

No hay que reconstruir esto, solo ejecutarlo y confirmar que sigue en verde:

- [x] `npm test` — 1988/1991 verdes (3 fallas preexistentes de `whatsapp-system-prompt.test.js`, por el gap conocido de este zip con el refactor de `armarSystemPromptWhatsApp`, ya resuelto en producción)
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
- [ ] Extender `scripts/load-test.js` a escritura: N cajas/POS vendiendo el mismo producto en simultáneo
- [ ] M cobros aplicándose a la misma factura al mismo tiempo
- [ ] Confirmar que el locking aguanta bajo presión real, no solo en test de a uno

### Etapa 7 — Cierre y repetibilidad
- [ ] Empaquetar toda la batería en un único comando (ej. `npm run audit:dinero`)
- [ ] Correrlo antes de cada deploy que toque código financiero — mismo criterio que `predeploy`

---

## Orden sugerido de arranque

1. Etapa 0 (gratis, ya está escrito — da la foto real de partida)
2. Etapa 3, caso MP webhook+polling (el hallazgo más concreto, no hipotético, ya visible en el código)
3. Resto de las etapas en el orden listado
