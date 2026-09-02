# Plan offline — Etapa 0: mapa de operaciones y reglas de conflicto

**Fecha:** 2026-08-07.

> ## ⚠ Actualización — 2026-08-07 (más tarde el mismo día)
> Este documento se había perdido (no estaba en el zip que se auditó
> originalmente) y se reconstruyó desde cero en una sesión posterior sin
> tenerlo a la vista. Ese día, más tarde, apareció el original y se
> recuperó — es el que sigue abajo, sin tocar. Pero en el tiempo que
> estuvo "perdido" se avanzó igual en la Etapa 3 (ítems 1, 2 y 3), y ese
> trabajo **ya resolvió una parte del hallazgo de la Sección 1**. Para no
> dejar el documento diciendo algo que ya no es cierto, se deja esta nota
> arriba en vez de reescribir la Sección 1 y la tabla de la Sección 3 (así
> se puede auditar qué se sabía en el momento original vs. qué cambió
> después — mismo criterio que ya usás en las auditorías del proyecto).
>
> **Qué cambió respecto a lo que dice la Sección 1 y la tabla de la
> Sección 3:**
>
> | Función RPC | Estado en este documento (original) | Estado real hoy |
> |---|---|---|
> | `ajustar_stock` | Solo lock `FOR UPDATE` (201), sin idempotencia offline | ✅ `p_offline_local_id` agregado — migración 443. Encolable desde `stock-offline.js` (admin), integrado en `stock.js` |
> | `registrar_conteo_stock` | No estaba en la tabla original con RPC propia (se agrupaba conceptualmente con `ajustar_stock`) | ✅ `p_offline_local_id` agregado — migración 443. Mismo módulo `stock-offline.js` |
> | `registrar_cobro_completo` | "El caso que el propio plan marca como más delicado" — sin idempotencia, solo `FOR UPDATE` (417) | ✅ `p_offline_local_id` agregado — migración 444 (atado al `offline_local_id` de la entrega del chofer, sufijo `-cobro`) |
> | Entregas / no-entregas / devoluciones (chofer) | No tenían RPC/tabla con idempotencia offline propia | ✅ `offline_local_id` en `entregas` y `devoluciones` — migración 444. `chofer-offline.js` ya las encola |
> | Seguridad de las 3 funciones tocadas por 443/444 | — | Migración 445 revocó `EXECUTE` de `anon` sobre las tres (habían quedado abiertas por el `DROP FUNCTION` + `GRANT` por defecto del schema) |
>
> **Lo que la Sección 1 decía que faltaba y sigue faltando de verdad:**
> `crear_pedido_cliente` no usa `p_offline_local_id` — usa un mecanismo
> distinto y preexistente (`idempotency_key`, ya estaba desde antes del
> plan offline, pensado para reintentos de doble-tap en mobile). Funciona
> para el mismo propósito y `cliente-offline.js` ya lo reutiliza, pero
> vale aclararlo porque no es el mismo patrón que 443/444/445. El resto
> de la tabla de la Sección 3 (`transferir_stock_entre_depositos`,
> `crear_orden_compra`, `registrar_movimiento_puntos`, etc.) sigue tal
> cual estaba: sin idempotencia offline, como dice el documento original.
>
> **Estado real de la Etapa 3 a esta fecha:** ítem 1 (pedido offline,
> cliente y admin) ✅, ítem 2 (ajuste de stock / conteos, depositero) ✅,
> ítem 3 (entrega/devolución chofer) ✅. Ítems 4 (cobros y cta-cte fuera
> del cobro atado a una entrega) y 5 (transferencias entre depósitos)
> siguen pendientes.

**Objetivo de este documento:** el entregable que pedía la Etapa 0 de
`PLAN_OFFLINE_COMPLETO.md` — clasificar las funciones RPC que mutan
datos en las 3 categorías (lectura cacheable / escritura encolable /
bloqueante de verdad), definir regla de conflicto por entidad, y decidir
la arquitectura de storage local. Es la base de la que dependen todas
las etapas siguientes.

**Metodología:** se relevaron las 85 funciones RPC realmente invocadas
desde `lib/repos/*.js` y `lib/handlers/*.js` (`grep` sobre `.rpc(`), y
se leyó la definición SQL vigente de cada una que iba a quedar en
categoría 2 o 3, para confirmar si ya tiene locking (`FOR UPDATE`) o
algún mecanismo de idempotencia — no se clasificó solo por el nombre.

---

## 1. Hallazgo que condiciona toda la Etapa 3

**Hoy solo `registrar_venta_pos` tiene el patrón de idempotencia real**
(`p_offline_local_id`, agregado recién en la migración 181 porque la 119
había dejado el dedup roto — el índice único existía pero la función
nunca lo usaba). Ninguna otra de las ~45 funciones de escritura lo
tiene. Esto significa que **cada módulo que se mueva a la Etapa 3 no
solo necesita el trabajo de frontend (outbox, validación en JS) — cada
RPC de categoría 2 necesita antes una migración que le agregue
`p_offline_local_id` + índice único + manejo de `unique_violation` como
backstop**, replicando lo que la 181 ya resolvió para POS. Es trabajo de
backend real, no solo de cliente, y no estaba explícito como línea de
esfuerzo separada en el plan original — conviene sumarlo a la
estimación de cada módulo en la Etapa 3.

---

## 2. Categoría 1 — Solo lectura, cacheable

Sin riesgo de conflicto porque no escriben. Se sirven del último dato
conocido (mismo patrón que ya usa `sw-admin.js` para dashboard/pedidos/
stock). Es la base de la Etapa 2.

| Función RPC | Para qué se usa |
|---|---|
| `obtener_kpis_dashboard`, `obtener_dashboard_ejecutivo_resumen`, `obtener_comparativa_mensual` | KPIs y dashboards |
| `cliente_productos_disponibles`, `resolver_precios_cliente` | Catálogo + precios del cliente |
| `buscar_articulos_asistente`, `obtener_sugeridos_para_whatsapp` | Búsqueda/sugerencias (bot WhatsApp, no crítico para portales) |
| `calcular_deuda_cliente`, `calcular_score_cliente` | Cta-cte, scoring de riesgo |
| `comparar_precios_proveedores`, `ranking_ahorro_proveedores` | Comparador de compras |
| `resumen_turno_caja` | Resumen de caja (lectura previa al cierre) |
| `conciliacion_buscar_candidatos` | Conciliación bancaria (lectura) |
| `analizar_stock_autonomo`, `detectar_anomalias_auditoria` | Paneles de análisis/auditoría |
| `resolver_cliente_por_telefono` | Bot WhatsApp (backend, no aplica a portales offline) |

**Nota:** `resolver_precios_cliente` es lectura hoy, pero **la Etapa 3
la va a necesitar reimplementada en JS** (no solo cacheada) porque
`crear_pedido_cliente` offline necesita poder calcular el precio sin
llamar al servidor — está listada acá porque hoy es de solo lectura,
pero es una dependencia directa de la categoría 2.

---

## 3. Categoría 2 — Escritura encolable

Cada fila indica la regla de conflicto propuesta y si ya tiene locking
server-side (lo que dice qué tan protegido está el camino "online",
pero no resuelve nada del camino offline — el lock solo actúa en el
momento de sincronizar, no evita que dos dispositivos offline tomen la
misma decisión sin verse).

| Función RPC | Entidad | Regla de conflicto propuesta | Lock server-side hoy |
|---|---|---|---|
| `registrar_venta_pos` | Venta POS | Ya resuelto — `offline_local_id`, gana el primero en llegar, reintentos son no-op (409 idempotente) | ✅ Sí (ref. del patrón a copiar) |
| `crear_pedido_cliente` | Pedido | Gana el primero en llegar. **Excepción:** si el cliente es cta-cte y queda cerca del límite de crédito, no confirmar en firme al sincronizar — dejar en estado "a revisar" para que un admin decida (este es el caso límite que el plan ya señalaba como ejemplo de categoría 3; en la práctica es 2 con una salida a revisión, no un bloqueo total) | Parcial (valida stock/precio, no lockea saldo de crédito entre pedidos concurrentes) |
| `confirmar_pedido_sugerido`, `generar_pedido_sugerido_cliente`, `generar_pedidos_sugeridos` | Pedido sugerido | Gana el primero; el segundo se descarta silenciosamente si el pedido ya fue confirmado (no es un dato financiero, bajo riesgo) | — |
| `ajustar_stock` | Stock | **El más sensible del lote.** Gana el primero en llegar; el segundo ajuste offline se reaplica sobre el stock ya actualizado (no sobre el valor que tenía el dispositivo cuando estaba offline) — es decir, los ajustes se tratan como *deltas*, no como *set absoluto*, para que dos conteos offline en depósitos distintos no se pisen | ✅ Sí (`FOR UPDATE`, migración 201) |
| `transferir_stock_entre_depositos` | Stock | Mismo criterio que `ajustar_stock` (delta, no set); si el origen no tiene stock suficiente al sincronizar, la transferencia queda en estado `error_permanente` para revisión manual, no se fuerza | ✅ Sí (`FOR UPDATE` con orden determinístico — ya mencionado en el plan) |
| `incrementar_stock_reservado`, `liberar_stock_reservado` | Stock (reserva) | Van siempre atadas a `crear_pedido_cliente`/cancelación — mismo idempotency key que el pedido que las dispara, no se encolan sueltas | — |
| `fn_lotes_dar_de_baja` | Lote | Gana el primero; reintento sobre lote ya dado de baja es no-op | — |
| `anular_venta_pos`, `rpc_registrar_devolucion_pos` | Venta POS | Mismo esquema de idempotencia que `registrar_venta_pos` (son su contracara) | Parcial — no revisado en detalle, asumir que necesita el mismo fix que la 181 |
| `crear_orden_compra`, `recepcionar_orden_compra` | Compras | Gana el primero; caso de uso real es el depositero recibiendo mercadería con mala señal, bajo riesgo de choque (una sola persona por recepción) | — |
| `crear_nota_credito`, `aplicar_nota_credito_cta_cte` | Notas de crédito / cta-cte | Se generan sobre una factura puntual — el conflicto real ya está cubierto por el patrón de F3-05 (recarga de `facturacion.html` al emitir); offline solo agrega la cola, la regla es "gana el primero, el segundo intento sobre la misma factura ya anulada es no-op" | — |
| `registrar_cobro_completo`, `asentar_movimiento_cta_cte_factura` | Cta-cte / cobros | **El caso que el propio plan marca como "más delicado".** No se pueden sumar a ciegas dos cobros offline del mismo cliente: cada cobro se encola con su propio `offline_local_id` (nunca se pisan entre sí, son inserts independientes — coincide con el patrón ya verificado en la Fase 4 de la auditoría: `insertarMovimiento()` + trigger que recalcula el saldo desde cero), **pero** si dos vendedores registran cobros por un monto que en conjunto supera la deuda real del cliente, el sistema no lo va a detectar hasta sincronizar — ahí se necesita una notificación post-sync ("este cobro dejó al cliente con saldo a favor, revisar"), no un bloqueo | ✅ Parcial — `FOR UPDATE` sobre el saldo, migración 417 |
| `registrar_movimiento_puntos`, `canjear_recompensa`, `sumar_saldo_puntos_fallback`, `revertir_puntos_pedido_cancelado` | Puntos/fidelización | Mismo riesgo de saldo compartido que los cobros (`canjear_recompensa` ya lockea con `FOR UPDATE` en migración 297, pero solo protege contra carrera *online*). Regla: canje offline queda en estado "a confirmar" hasta sincronizar — no se descuenta el saldo local de forma definitiva, para no dejar al cliente ver un saldo que después el servidor rechaza | ✅ Sí (297) pero no cubre offline |
| `registrar_pago_proveedor` | Pagos a proveedor | Gana el primero; bajo riesgo (una persona hace el pago) | — |
| `reservar_remito_nro` | Numeración de remito | Necesita el mismo tipo de reserva atómica que ya tiene la numeración de venta (migración 078) — si dos remitos offline piden número sin verse, hay que resolver al sincronizar cuál se queda con qué número, no antes | A revisar — no confirmado si ya es atómico para el caso offline |
| `registrar_notif_sugerencia` | Notificaciones internas | Sin riesgo real — encolable trivial, duplicados no importan | — |
| `importar_productos_lote` | Catálogo | Tarea de escritorio (carga masiva), no es un caso de uso offline real — se puede dejar fuera del alcance práctico de la Etapa 3 aunque técnicamente sea "escritura encolable" | — |
| `conciliacion_auto_matchear_lote`, `conciliacion_confirmar_match`, `conciliacion_deshacer_match`, `conciliar_oc_factura`, `conciliar_recepcion` | Conciliación | Igual que arriba: tarea de oficina con buena señal, baja prioridad para Etapa 3 aunque sea técnicamente encolable | — |

---

## 4. Categoría 3 — Bloqueante de verdad

| Función / dependencia | Por qué no puede ser offline |
|---|---|
| Emisión de CAE (AFIP/ARCA, `lib/arca/*`) | Depende de un servicio externo de terceros en el momento exacto — ya cubierto por el diseño de la Etapa 5 (factura queda "pendiente de CAE") |
| Cobro con Mercado Pago (`lib/handlers/pagos.js`) | Comunicación sincrónica con la pasarela, no encolable por naturaleza |
| Mensajes entrantes de WhatsApp | No existen sin red por definición |
| `validar_token_invitacion_chofer`, `validar_token_portal_proveedor`, `validar_token_scanner_pos` | Validación de acceso — tiene que confirmarse contra el servidor, es la puerta de entrada al resto del sistema |
| `cerrar_turno_caja`, `forzar_cierre_turno_caja` | Aunque técnicamente se podría encolar, involucra manejo de dinero y arqueo — el riesgo de un cierre de caja mal sincronizado (dos cierres offline del mismo turno, o un cierre que no ve movimientos que llegaron después) pesa más que el beneficio. Se recomienda dejarlo bloqueante: si no hay señal, el cajero espera, no cierra a ciegas |

---

## 5. Fuera de alcance (no es parte de los 4 portales operativos)

Estas funciones existen y mutan datos, pero pertenecen al panel
superadmin de gestión del SaaS (vos administrando las empresas
clientes) o a migraciones de datos one-shot — no son parte del uso
diario de admin/cliente/chofer/proveedor y no tiene sentido que
funcionen offline:

- `saas_config_actualizar`, `saas_confirmar_pago`, `saas_empresa_cambiar_precio`, `saas_empresa_cancelar`, `saas_empresa_reactivar`, `saas_suspender_empresa`, `saas_panel_listar`, `saas_dashboard_kpis`, `registrar_empresa_saas`, `setup_inicial_empresa`
- Las 11 `migracion_confirmar_*_lote` + `migracion_deshacer_sesion` + `migracion_mapear_bulk` + `migracion_precheck_advertencias` + `migracion_superadmin_resumen`
- `fn_incrementar_contador_api` (métrica interna de backend)

---

## 6. Decisión de arquitectura: IndexedDB puro vs. librería de sync

**Recomendación: IndexedDB puro, pero con Dexie.js como capa de
ergonomía — no `dexie-syncable` ni RxDB.**

Razones:
- El frontend no tiene build step (todo `<script src>` directo, sin
  bundler — confirmado en `package.json`, que solo tiene dependencias
  de backend). Dexie es UMD y se puede cargar por CDN sin tocar nada
  de la infraestructura actual, igual que ya se hace con otras libs.
- `dexie-syncable`/RxDB resuelven sync genérico, pero acá el problema
  real no es sincronizar datos — es **encolar llamadas a RPCs de
  Supabase con reglas de negocio específicas por entidad** (las de la
  sección 3). Ninguna librería genérica sabe que un ajuste de stock es
  un delta y un cobro no se puede sumar a ciegas — esa lógica hay que
  escribirla a mano de cualquier forma, así que la parte que sí
  resuelve una librería (boilerplate de IndexedDB: transacciones,
  índices, promesas) es la única parte donde vale la pena una
  dependencia.
- `pos-offline.js` ya reimplementa a mano exactamente lo que Dexie da
  gratis (ver `abrirDB`, `idbGet`, `idbPut`, `idbGetAll`, `idbDelete` —
  ~70 líneas de wrapper de promesas). Generalizar eso a stores
  dinámicos por entidad (objetivo de la Etapa 1) es mucho menos código
  con Dexie que manteniendo el patrón manual.
- Con un solo desarrollador, la superficie de mantenimiento importa:
  Dexie tiene mejor documentación y comunidad que mantener a mano el
  manejo de versiones de esquema IndexedDB (`onupgradeneeded`) en cada
  nuevo store.

---

## 7. Entregable de esta etapa — checklist

- [x] Clasificación de las 85 funciones RPC en las 3 categorías + fuera de alcance
- [x] Regla de conflicto por entidad para las de categoría 2
- [x] Confirmado que solo `registrar_venta_pos` tiene idempotencia real hoy — costo oculto para la Etapa 3
- [x] Decisión de arquitectura: IndexedDB + Dexie.js (sin librería de sync genérica)
- [ ] Falta (fuera del alcance de este documento, es trabajo de Etapa 1): definir el esquema exacto de stores de Dexie y el esquema de estados del outbox único

## Cómo sigue
Con esto cerrado, la Etapa 0 está completa. Los próximos pasos posibles
(según la recomendación del plan original):
- **Etapa 2, cliente/proveedor** — Service Worker + manifest desde cero,
  no depende de las decisiones de esta etapa (es solo lectura).
- **Etapa 1** — capa de datos local genérica con Dexie, usando el mapa
  de la sección 3 para decidir qué stores crear primero.
- **Etapa 3, ítem 3 (chofer)** — ahora ya tiene base: la regla de
  conflicto de "confirmar entrega/devolución" queda pendiente de
  definir en el mismo formato de la sección 3 cuando se arranque ese
  módulo puntual.

*(Ver la nota de actualización al principio del documento — a la fecha
de esta lectura, los ítems 1, 2 y 3 de la Etapa 3 ya se hicieron.)*

