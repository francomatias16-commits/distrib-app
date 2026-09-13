# v1073 — Fix: regresión de signo en `transferir_stock()` + nueva RPC de conciliación por depósito

## Contexto

Continuación de `PLAN_CIERRE_DEFINITIVO_2026-09.md`, hallazgo **A2**
("Conciliación de stock por depósito no es posible hoy"). El plan atribuía
el problema a que `movimientos_stock` nunca había tenido columna de
dirección para `tipo='transferencia'`. Al reverificar el hallazgo no solo
contra el código vigente sino contra el **historial completo** de
migraciones que tocaron `transferir_stock()`, apareció algo más específico
y más grave que "falta una columna": una regresión real, ya en producción.

## Hallazgo

- `400_fix_signo_movimientos_transferencia.sql` (migración anterior, ya en
  el repo) había resuelto esto hace tiempo: el movimiento del depósito
  **origen** se guardaba con `cantidad` **negativa**, el de **destino**
  positiva — exactamente para poder sumar por depósito sin ambigüedad.
- `446_offline_dedup_transferencia_stock.sql` (posterior, agregó el dedup
  de `offline_local_id`) reescribió `transferir_stock()` completo y, al
  hacerlo, **perdió el `-p_cantidad` del origen sin que ninguna nota lo
  mencione** — una regresión silenciosa, no un cambio de criterio. `465` y
  `508` heredaron el bug sin tocarlo.
- Confirmado en vivo contra producción (`jgiquzjwoedmzwqgzubr`,
  `pg_get_functiondef`): la función que corría hasta hoy insertaba
  `p_cantidad` (positivo) en **ambos** lados.
- Confirmado que la función hermana `transferir_stock_entre_depositos`
  (migración 471, usada solo desde el POS vía `lib/repos/pos.js`) **sí**
  tenía el signo correcto (`-p_cantidad` en origen) — nunca sufrió la
  regresión porque es código separado. Esa asimetría es la prueba de que
  `446` fue un descuido, no una decisión.
- `transferir_stock()` es la que usan **el panel admin**
  (`frontend/admin/js/stock.js`) y **el asistente IA**
  (`lib/asistente-tools/stock.js`) — los dos caminos de transferencia
  *manual* entre depósitos, que son justo los que un depositero usaría.
- Impacto real en datos: solo 2 filas `tipo='transferencia'` existían en
  toda la base de producción (un único movimiento de prueba, 2026-08-19,
  10 unidades), ambas con `cantidad=+10`. Bajo, pero el bug era real y
  activo para cualquier transferencia manual nueva.

## Fix

- `CREATE OR REPLACE` de `transferir_stock()`: vuelve a insertar
  `-p_cantidad` en el movimiento del depósito origen (igual que `400` y
  que la función hermana `471`). Sin ningún otro cambio de comportamiento
  respecto de la versión vigente (`508`).
- Backfill puntual de la única fila de producción afectada — identificada
  sin ambigüedad por su `ctid` físico (el `INSERT` del origen corre antes
  que el del destino dentro de la misma transacción, así que su `ctid`
  queda antes).
- Nueva RPC de solo lectura `conciliar_stock_por_deposito(empresa_id)`:
  ahora que `transferencia` viene con signo correcto, se puede sumar junto
  con `ingreso`/`egreso`/`ajuste` agrupando por `(producto_id,
  deposito_id)` y comparar contra `stock.cantidad` fila por fila — lo que
  `conciliar_stock_por_producto` (migración 620) no podía hacer por
  diseño (esa agrega solo por producto, y a propósito excluye
  `transferencia` porque antes de este fix sumar por depósito daba en
  falso). `service_role` únicamente, mismo criterio de seguridad que 620.
- Migración: `supabase/migrations/20260912200000_624_fix_regresion_signo_transferir_stock_y_conciliar_por_deposito.sql`.

## Verificación (simulación antes/después contra producción)

1. Se ejecutó una transferencia real de prueba (3 unidades) con
   `transferir_stock()` ya parcheada.
2. Se confirmó que el movimiento del depósito origen quedó en `-3` y el
   de destino en `+3` en `movimientos_stock` (antes del fix ambos hubieran
   quedado en `+3`).
3. Se llamó a `conciliar_stock_por_deposito()` y se confirmó que el
   depósito destino (sin otro historial) cerró en diferencia `0`
   (`cantidad_mostrada=3`, `cantidad_recalculada=3`) — prueba de que la
   nueva RPC efectivamente usa el signo para reconstruir el neto por
   depósito.
4. Se revirtió manualmente la transferencia de prueba (stock, movimiento y
   lote de prueba eliminados) para dejar la base exactamente como estaba.

## Límite conocido, no resuelto acá

`conciliar_stock_por_deposito()` también puede mostrar diferencias
"reales" pero no accionables cuando el stock de un depósito se sembró
directo en la tabla `stock` (seed/demo) sin sus movimientos históricos
correspondientes en `movimientos_stock` — se vio en la simulación de
verificación: un depósito con stock legítimo pero sin historial de
`ingreso`/`ajuste` que lo explique muestra una diferencia grande que no es
un desvío real, es simplemente historial faltante. Mismo patrón que **A3**
del plan (inconsistencia de datos semilla, no bug de mecanismo). La RPC
es correcta; interpretar sus resultados en depósitos con historial
incompleto requiere criterio humano, no es automatizable sin más contexto.

## Pendiente (no tocado en este fix)

- No se migró el hallazgo de seguridad ya documentado en 620 (RPCs de
  conciliación otorgadas de más a `anon`/`authenticated` en producción) —
  sigue abierto, es un fix de hardening separado.
- `conciliar_stock_por_producto` (620) no se modificó: sigue excluyendo
  `transferencia` de su total agregado, lo cual sigue siendo correcto (una
  transferencia interna nunca cambia el total de la empresa, con o sin
  signo).
