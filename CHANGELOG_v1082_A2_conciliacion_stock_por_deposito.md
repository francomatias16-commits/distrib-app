# v1082 — A2 cerrado: conciliación de stock por depósito

## Contexto

`PLAN_CIERRE_DEFINITIVO_2026-09.md`, hallazgo A2: "Conciliación de stock
por depósito no es posible hoy... `movimientos_stock` no tiene columna de
dirección para `tipo='transferencia'`... un robo o error de picking en un
depósito específico puede no detectarse aunque el total del sistema
cierre".

## Lo que se encontró al verificar en vivo

La premisa del hallazgo estaba desactualizada: la migración
`400_fix_signo_movimientos_transferencia.sql` (aplicada a producción
**antes** de que se escribiera el plan) ya hace tiempo que guarda la
`cantidad` de las filas `tipo='transferencia'` **con signo** — negativa en
el depósito de origen, positiva en el de destino — junto con
`referencia_id` cruzado al depósito contraparte. Verificado contra el
único par de filas de transferencia que hay en producción hoy:
`cantidad=-10` / `cantidad=+10`, mismo `producto_id`, `deposito_id`
cruzados en `referencia_id`.

No hacía falta agregar una columna `direccion` nueva (como sugería el
comentario de la migración 620, "mismo patrón que
`movimientos_stock_lotes.direccion`") — el signo ya cumple esa función.
Lo que realmente faltaba era la RPC que la usara a nivel (producto,
depósito), no una columna nueva en la tabla.

## Fix

- **Migración 621** (`conciliar_stock_por_deposito_etapa4`, ya aplicada
  en Supabase): nueva RPC `conciliar_stock_por_deposito(empresa_id)`,
  mismo criterio que `conciliar_stock_por_producto()` pero agrupando
  también por depósito, sumando `tipo='transferencia'` tal cual (ya viene
  signada). Los pares a evaluar salen de un `UNION` de `stock` y
  `movimientos_stock`, no de un `CROSS JOIN` productos×depósitos.
  `SECURITY DEFINER`, sin grant a `authenticated` — mismo patrón de
  seguridad que las RPCs hermanas de la migración 620.
- **Nuevo** `scripts/conciliar-stock-por-deposito.js`: mismo formato y
  banderas (`--json`, `--tolerancia=`) que `conciliar-stock.js`.
- `package.json`: nuevos scripts `conciliar:stock-deposito` /
  `:json`, sumados a `conciliar:all`.
- `scripts/audit-dinero.js`: nuevo paso de Etapa 4, mismo gateo por
  `EMPRESA_ID` que los otros dos (se saltea contra la demo).
- `scripts/conciliar-stock.js`: corregido el comentario que repetía la
  premisa desactualizada del hallazgo — ahora aclara que la exclusión de
  `transferencia` en ese script puntual es intencional (correcto para el
  TOTAL por producto), no una limitación de la base.

## Verificado en vivo (demo, `4462586e-e11a-4d34-a405-17103bb9cf9f`)

Corrida directa de la nueva RPC contra la empresa demo: además del ruido
esperado (el dataset demo tiene `stock` sembrado sin historial de
movimientos — mismo caveat ya documentado para `conciliar-stock.js`, no
es un bug), la RPC identificó correctamente los 2 productos que A3 ya
había señalado — y ahora, a diferencia de la versión por-producto, indica
en qué depósito está el desvío:

- **Agua Mineral 1.5L** — Depósito Central — mostrado: 240, recalculado:
  -10, diferencia: 250.
- **Lavandina 1L** — Depósito Central — mostrado: 90, recalculado: 30,
  diferencia: 60.

## Alcance / lo que NO cambia

- No se tocó `conciliar_stock_por_producto()` ni `conciliar-stock.js` en
  su comportamiento — solo se corrigió su comentario.
- No se agregó ninguna columna nueva a `movimientos_stock`: el signo ya
  existente alcanza.
- Sin uso real (`audit:dinero` gatea por `EMPRESA_ID` de un tenant real),
  este chequeo no corre en la demo ni afecta ningún flujo de producción.

## Archivos tocados

- `supabase/migrations/621_conciliar_stock_por_deposito_etapa4.sql` (nuevo)
- `scripts/conciliar-stock-por-deposito.js` (nuevo)
- `scripts/conciliar-stock.js` (comentario corregido)
- `scripts/audit-dinero.js`
- `package.json`

## DB (ya aplicado, no requiere acción)

- Migración `conciliar_stock_por_deposito_etapa4` (proyecto
  `jgiquzjwoedmzwqgzubr`), aplicada en esta sesión.
