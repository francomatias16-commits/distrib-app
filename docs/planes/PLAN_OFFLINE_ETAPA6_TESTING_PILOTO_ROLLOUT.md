# Plan — Etapa 6: Testing, piloto y rollout gradual (offline)

**Fecha:** 2026-08-07.
**Contexto:** Etapas 0 a 5 de `PLAN_OFFLINE_COMPLETO.md` están cerradas en
el código de `distrib_v657_completo.zip` (incluyendo los 5 ítems de
Etapa 3 — pedido, stock/conteos, entrega/devolución chofer, cobros/cta-cte
y transferencias entre depósitos — y los 3 puntos de Etapa 5 — AFIP,
Mercado Pago, WhatsApp). `PLAN_OFFLINE_ETAPA0_MAPA_OPERACIONES.md` quedó
desactualizado en dos ítems (4 y 5 de Etapa 3, que decía pendientes y ya
están); este documento asume el estado real, no el de ese mapa.

**Objetivo de esta etapa:** no habilitar el offline completo a todos los
tenants sin antes (a) cerrar los huecos de testing que ya existen hoy,
(b) probar los escenarios de concurrencia/reconexión que ningún test
unitario cubre, y (c) validar con una sola empresa real antes de un
rollout general — en ese orden, porque un bug de sincronización en este
sistema puede duplicar una venta o perder un cobro, y eso es peor que no
tener offline.

---

## 0. Punto de partida real (auditado)

Lo que ya existe y cubre parte del trabajo de esta etapa:

- **Tests unitarios de outbox por módulo:** `pos-offline.test.js`,
  `stock-offline.test.js`, `chofer-offline.test.js`,
  `cliente-offline.test.js`, `cobros-offline.test.js` — cubren la lógica
  de encolado, dedup por `offline_local_id`/`idempotency_key`, y la UI de
  conflicto genérica de Etapa 4.
- **`es_demo`** (`lib/demo-mode.js`): ya es el punto único que usan AFIP,
  WhatsApp y (potencialmente) cualquier integración real para no disparar
  llamadas reales desde una empresa demo. Es exactamente el mecanismo que
  `PLAN_OFFLINE_COMPLETO.md` proponía para acotar el piloto.
- **`scripts/test-integration.js`** y **`scripts/load-test.js`**: corren
  contra API real, pero ninguno ejercita Service Worker + IndexedDB — son
  Node puro, no browser. No sirven tal cual para la matriz de esta etapa.

Lo que falta y que esta etapa tiene que cerrar antes del piloto (no
después):

1. ~~**Sin test para el outbox de WhatsApp saliente**~~ — **cerrado.**
   `tests/repos/whatsapp-bot.test.js` cubre `obtenerSalientesPendientes`,
   `marcarSalienteFallido` (tope `MAX_INTENTOS_SALIENTE=10`, incluido el
   caso límite exacto — falla justo al llegar al tope) y
   `marcarSalienteEnviado`.
2. ~~**Sin test para el guard de MP**~~ — **cerrado.**
   `tests/repos/pagos.test.js` prueba `esPedidoPilotoWhatsApp()` con los
   casos límite (`canal='web'`, `generado_automatico` string vs boolean,
   pedido ya confirmado); `tests/handlers/pagos-guard-publico.test.js` la
   cubre integrada en `crearPreferenciaPublicaHandler`.
3. **Sin smoke test end-to-end real de WhatsApp** (sigue pendiente): el
   propio changelog v657 lo deja anotado — el reintento transitorio
   (429/5xx) nunca se probó contra `graph.facebook.com` porque el entorno
   de desarrollo no tiene acceso de red saliente. Esto no se puede cerrar
   desde este repo — hay que probarlo a mano contra el número de prueba de
   Meta antes de confiar en el cron de reproceso en producción.
4. ~~**`proveedor/` no tiene escritura offline**~~ — **cerrado (v658).**
   Se decidió meterlo en Etapa 3 en vez de documentarlo como solo-lectura.
   `frontend/proveedor/proveedor-offline.js` (mismo patrón OfflineCore que
   chofer/stock) cubre las dos escrituras del portal —
   `confirmar-entrega` (naturalmente idempotente, es un UPDATE) y
   `subir-factura` (dedup por `offline_local_id`, migración 448, porque es
   un INSERT). Detalle completo en `CHANGELOG_v658_offline_etapa3_proveedor.md`.
   El único punto de esta sección que sigue abierto es el 3 (smoke externo),
   que no depende de código.

---

## 1. Matriz de pruebas mínima

Nada de esto se puede automatizar del todo en CI sin un browser real
(Service Worker, IndexedDB, `navigator.onLine`) — la mayoría necesita
Playwright/Puppeteer con emulación de red, o pruebas manuales guiadas con
DevTools. Orden sugerido, de más barato/rápido a más caro:

### 1.1 — Automatizable en CI (Node, sin browser)
- Cerrar los 3 huecos de la sección 0 (WhatsApp outbox, guard MP) como
  tests unitarios estándar, mismo patrón que los `*-offline.test.js`
  existentes.
- Test de regresión sobre `esPedidoPilotoWhatsApp()`: casos límite —
  pedido manual con `canal='web'` (no debe autorizar MP), pedido del bot
  con `generado_automatico=true` (sí debe autorizar), pedido ya
  confirmado (`confirmar_pedido_sugerido` cambió `canal` a `'whatsapp'`).

### 1.2 — Con browser headless (Playwright), automatizable pero más caro

**Actualización 2026-08-09:** al auditar el repo contra este documento se
encontró que esta sección estaba desactualizada — la infraestructura y la
mayoría de los casos YA EXISTEN, escritos en una sesión anterior sin que
este plan se actualizara:

- `tests/e2e/helpers/mock-network.js` ya tiene `irOffline`/`irOnline`
  (corte de red real vía `context.setOffline()` + aborta las rutas
  mockeadas, con el hallazgo documentado de que `setOffline()` solo no
  alcanza para una request ya interceptada por `page.route()`) y
  `mockApi` con soporte de `delayMs` (para simular "el servidor tarda",
  necesario en el escenario de cierre de pestaña a mitad del sync).
  `tests/e2e/helpers/supabase-rest-mock.js` tiene `mockearRpc` para los
  módulos que llaman `sb.rpc(...)` en vez de `fetch('/api/...')`.
- Los 3 escenarios de esta sección (modo avión a mitad de operación,
  cierre de pestaña durante el sync, reconexión intermitente) YA ESTÁN
  escritos y pasan, contra un harness dedicado (`tests/e2e/fixtures/
  harness-*.html` — carga Dexie + `offline-core.js` + el módulo offline
  del portal, sin la página real ni el Service Worker) para **3 de los 5
  módulos offline**: `tests/e2e/specs/pos.spec.js` (4 tests, incluye
  también el de conflicto de negocio), `tests/e2e/specs/chofer.spec.js`
  (3 tests) y `tests/e2e/specs/cliente.spec.js` (4 tests, incluye
  defensa en profundidad de `encolarPedido` sin `idempotency_key`).
  `tests/e2e/specs/proveedor.spec.js` (v658, 3 tests) también los cubre
  para el portal proveedor.
- **Hueco real, no documentado hasta ahora:** `stock-offline.js` y
  `cobros-offline.js` — justamente los dos módulos que la sección 2/3 de
  este mismo plan marca como "los más delicados" — NO tienen spec E2E
  propio. Solo tienen cobertura unitaria (`stock-offline.test.js`,
  `cobros-offline.test.js`, con `procesarAccion` mockeado directo, sin
  browser/IndexedDB real) y wiring de página (`tests/e2e/specs/admin/
  stock.spec.js` — smoke test de UI, no ejercita el outbox real).
  Los dos usan `sb.rpc(...)` (vía `window.authCtx.sb`, el cliente
  supabase-js real), no `fetch('/api/...')` como pos/chofer — necesitan
  `vendorizarSupabase` + `mockearRpc` en vez de `mockApi` simple. Cerrado
  en esta misma sesión: ver `tests/e2e/fixtures/harness-stock.html` /
  `harness-cobros.html` y `tests/e2e/specs/stock.spec.js` /
  `cobros.spec.js` (detalle en CHANGELOG correspondiente).

- **Modo avión a mitad de una operación**: iniciar una venta POS, cortar
  red vía CDP (`context.setOffline(true)`) a mitad del submit, confirmar
  que queda en el outbox y no se pierde ni se duplica al reconectar.
- **Cerrar la app durante el sync**: encolar 2-3 operaciones, disparar
  reconexión, cerrar la pestaña/matar el Service Worker antes de que
  termine de vaciar el outbox, reabrir y confirmar que Background Sync
  (o el reintento al `online`) termina el trabajo sin duplicar.
- **Reconexión intermitente**: simular varios ciclos online/offline
  cortos (el caso real de un chofer en zona rural) durante el drenado del
  outbox — confirmar que no se disparan dos sync en paralelo sobre el
  mismo outbox (condición de carrera del propio cliente, no del server).

**Estado (2026-08-09, v686): sección 1.2 cerrada para los 5 módulos.**
`stock.spec.js`/`cobros.spec.js` escritos y corridos contra Chromium real
(no solo redactados) — 8/8 nuevos, más los 14 ya existentes de
pos/chofer/cliente/proveedor sin romperse (22/22 en total). Detalle en
`CHANGELOG_v686_fase6_offline_e2e_stock_cobros.md`.

**Hallazgo lateral, sin relación con este cierre (queda anotado, no
resuelto):** al correr la suite completa apareció que
`tests/e2e/specs/admin/stock.spec.js`, `admin/cta-cte.spec.js` y
`admin/cobranzas.spec.js` (specs de wiring de página real, Fase 1 del
PLAN_E2E_COBERTURA_TOTAL.md — no los nuevos `stock.spec.js`/
`cobros.spec.js` de acá) no llaman a `vendorizarDexie(page)` antes de
cargar la página real, a diferencia de `admin/pos.spec.js` que sí lo
hace. En un sandbox con `cdn.jsdelivr.net` bloqueado, `OfflineCore` nunca
carga y esos 3 specs fallan por un error de consola espurio, no por un
bug de la app (mismo patrón ya documentado en
`PLAN_E2E_COBERTURA_TOTAL.md` sección 11.3). No es parte del alcance de
esta etapa — queda para quien retome ese plan.

### 1.3 — Manual, guiado (2 dispositivos/pestañas reales)
Esto es lo que ningún test automatizado reemplaza bien, porque el punto
es la interacción entre dos clientes que no se ven entre sí:
- Dos dispositivos offline editan **la misma entidad** (mismo producto,
  mismo cliente) y sincronizan en momentos distintos → confirmar que se
  dispara la UI de conflicto de Etapa 4 y no un pisado silencioso.
- Cobro del mismo cliente registrado offline por dos vendedores en
  simultáneo → es el caso que el propio plan marca como el más delicado;
  confirmar que **no** se suman a ciegas.
- Transferencia del mismo producto entre depósitos, offline, desde dos
  dispositivos → confirmar que se respeta el mismo criterio anti-carrera
  que ya tiene `transferir_stock()` server-side, ahora también en el
  camino offline.
- Facturación offline (`facturar` en el outbox de POS) con la venta
  todavía sin sincronizar en el mismo outbox → confirmar el orden FIFO
  (la venta se sincroniza antes que su factura, no al revés).

### 1.4 — Smoke test real contra servicios externos (fuera de este repo)
- WhatsApp: mandar un mensaje al número de prueba de Meta con la red del
  entorno cortada a propósito, confirmar que queda `pendiente` y que el
  cron diario (`whatsapp-salientes-reprocesar`) lo saca de ese estado sin
  intervención manual.
- AFIP homologación: repetir el mismo caso con `facturar` en el outbox de
  POS contra el ambiente de homologación de ARCA (no producción).

---

## 2. Piloto acotado

- **Mecanismo:** una sola empresa con `empresas.es_demo = true`
  desactivado explícitamente para offline pero activo para todo lo demás
  — o, si se prefiere separar el flag de negocio del flag de feature,
  vale la pena evaluar acá si conviene un flag propio
  (`offline_habilitado` por empresa) en vez de reusar `es_demo`, porque
  `es_demo` hoy significa "no dispares integraciones reales" y el piloto
  de offline sí necesita que AFIP/WhatsApp/MP funcionen de verdad para
  validar el ciclo completo.
- **Duración sugerida:** 2-3 semanas de uso real, no una prueba de un
  día — el caso que más importa (chofer con señal intermitente en zona
  rural) necesita varios días de uso normal para aparecer solo.
- **Qué mirar durante el piloto**, con métricas concretas, no solo "andá
  probando":
  - Cantidad de operaciones que entraron al outbox vs. las que
    sincronizaron sin error vs. las que terminaron en conflicto.
  - Tiempo real entre "se encoló offline" y "se sincronizó" (para medir
    si Background Sync realmente despierta el SW con la app cerrada, o
    si en la práctica todo depende de que el usuario reabra la app).
  - Cualquier caso de factura con CAE duplicado o venta duplicada — cero
    tolerancia, si aparece uno se para el piloto.
- **Criterio de salida del piloto:** cero duplicados de venta/factura/
  cobro en las 2-3 semanas, y que el/los conflictos que sí aparecieron se
  hayan resuelto correctamente vía la UI de Etapa 4 (no a mano en la
  base).

---

## 3. Rollout gradual

Mismo orden de prioridad que ya usó la Etapa 3, porque ya está probado en
producción vía el piloto de esa misma empresa:

1. Lectura offline (Etapa 2) para todos los tenants — es el cambio de
   menor riesgo (no escribe nada), se puede habilitar general apenas el
   piloto confirme que no rompe nada de lo existente.
2. Pedido offline (cliente + admin) y ajuste/conteo de stock — módulos
   con menor superficie de conflicto real (un producto, un depósito).
3. Entrega/devolución del chofer — ya validado en el piloto original de
   `sw-chofer.js` antes incluso de este plan; menor riesgo relativo.
4. Cobros/cta-cte y transferencias entre depósitos — los dos módulos que
   el propio plan marca como más delicados; habilitar últimos y con
   monitoreo más cercano las primeras semanas.
5. Etapa 5 (AFIP/MP/WhatsApp tolerantes a offline) — depende de que 1-4
   ya estén estables, porque una factura o un mensaje offline dependen de
   que la venta/pedido que los origina ya haya sincronizado bien.

Cada paso: habilitar, esperar una semana de uso real sin incidentes antes
de pasar al siguiente, no todos juntos.

---

## 4. Estimación de esfuerzo

- Cerrar los 3 huecos de testing (sección 0, ítems 1-3): **1 semana**.
- Matriz 1.1-1.3 (incluye levantar Playwright si no está ya en el repo):
  **2-3 semanas**.
- Piloto (sección 2): **2-3 semanas de calendario**, no de esfuerzo
  dedicado — es mayormente esperar y monitorear.
- Rollout gradual (sección 3): **2-4 semanas de calendario**, un módulo
  por semana aprox.

**Total: 4+ semanas de trabajo activo, dentro de una ventana de calendario
de 6-8 semanas** contando los tiempos de espera del piloto y del rollout
escalonado — coincide con el "4+ semanas, continuo" que ya estimaba
`PLAN_OFFLINE_COMPLETO.md` para esta etapa.

---

## 5. Recomendación para arrancar

No conviene saltar directo a la matriz de pruebas 1.2/1.3 sin antes cerrar
los 3 huecos de la sección 0 — son baratos (una semana) y dos de ellos
(WhatsApp outbox, guard de MP) tocan dinero e integraciones fiscales, así
que tiene más sentido asegurar eso primero que ponerse a simular modo
avión. Orden concreto sugerido:

1. Tests unitarios de los 3 huecos (sección 0).
2. Matriz 1.1 (ya cubierta por el paso anterior) + 1.2 con Playwright.
3. Elegir con qué empresa arranca el piloto y decidir el mecanismo del
   flag (reusar `es_demo` vs. flag propio `offline_habilitado`).
4. Piloto de 2-3 semanas con las métricas de la sección 2.
5. Rollout módulo por módulo (sección 3).

## Cómo continuar
Decime **"arranquemos con los tests de WhatsApp/MP"** o **"definamos el
flag del piloto"** (u otro punto puntual de este documento) y seguimos
desde ahí.
