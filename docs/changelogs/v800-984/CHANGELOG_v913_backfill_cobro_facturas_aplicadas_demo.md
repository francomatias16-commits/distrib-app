# v913 — Backfill de `cobro_facturas_aplicadas` para los 140 cobros históricos de la empresa demo

## Motivo

El v912 dejó documentado como pendiente sin resolver: el componente
Pagos del score de confianza ya lee de `cobro_facturas_aplicadas` (fix
correcto), pero esa tabla recién empezó a poblarse desde la migración
del 2026-08-18 — los 140 cobros históricos de la empresa demo
(`empresa_id = 4462586e-e11a-4d34-a405-17103bb9cf9f`) no tenían fila
ahí. Como además la empresa demo se resetea todas las noches a las 5am
desde un snapshot fijo (`demo_snapshots`) tomado antes de que la tabla
tuviera datos, el componente Pagos iba a seguir en default en el
entorno demo indefinidamente, salvo que se backfilleara el histórico y
se retomara el snapshot. Se confirmó con el usuario antes de tocar
nada.

## Hallazgo previo al backfill

`cta_cte.factura_id` nunca se completa para filas `tipo='cobro'` (0 de
140) — confirmado, coincide con lo ya documentado en v912. No hay en
ningún lado un vínculo cobro→factura explícito y verificable para el
histórico; hubo que reconstruirlo.

Se detectó además que `SUM(cobros.monto)` ($22.236.279,09) no coincide
con `SUM(facturas.total_cobrado)` ($22.576.151,15) — diferencia de
$339.872,06 (1,5%). Se descartó que viniera de cheques, QR/POS u otro
medio de cobro (revisados, no explican la diferencia). Es ruido
preexistente de la carga original de datos demo, no introducido por
este trabajo ni por v912.

## Reconstrucción (backfill)

No existe una fuente de verdad de qué cobro pagó qué factura puntual en
el histórico, así que se reconstruyó por **FIFO cronológico por
cliente**: para cada cliente, sus cobros ordenados por fecha se aplican
contra sus facturas más antiguas con saldo pendiente (`total_cobrado`),
en el mismo orden en que lo haría un cajero real. Corrido vía `DO $$`
directo en Supabase (proyecto `jgiquzjwoedmzwqgzubr`), sin migración de
esquema — es una operación de datos, no de estructura.

Resultado: **220 filas** insertadas en `cobro_facturas_aplicadas`.

Validado post-corrida:
- Los 140 cobros quedaron aplicados al 100% de su monto (`SUM(monto_aplicado)
  = SUM(cobros.monto)` exacto), sin exceder ningún cobro individual.
- Ninguna factura quedó con `monto_aplicado` por encima de su
  `total_cobrado` real.
- El 100% del residuo de $339.872,06 cae en una sola factura
  (`0003-00001004`), cuyo cliente no tiene ningún cobro cargado en la
  tabla `cobros` — es la factura "pre-pagada sin cobro real" del
  hallazgo anterior. Se dejó sin fila (no se inventó un cobro que no
  existió).

## Snapshot

Se corrió `fn_snapshot_demo_v2('4462586e-e11a-4d34-a405-17103bb9cf9f')`
para retomar el snapshot de la empresa demo. Verificado que
`demo_snapshots.datos->'cobro_facturas_aplicadas'` trae las 220 filas.

No se tocó `fn_reset_demo_v2` ni `fn_snapshot_demo_v2` — desde la
migración 524 ya tenían `cobro_facturas_aplicadas` incluida en el
pipeline (orden 56 de la lista de tablas que snapshotean/resetean), así
que este trabajo fue solo backfill + re-snapshot sobre la plomería
existente.

## Alcance

Empresa demo únicamente, mismo criterio que v610. No es idempotente:
si se vuelve a correr sobre `cobro_facturas_aplicadas` ya poblada,
duplicaría filas — antes de re-correr, limpiar la tabla para esa
empresa.

## Pendiente / a considerar

- Si se recarga la semilla demo desde cero, hay que volver a correr
  este backfill (o adaptarlo) antes de snapshotear — no quedó
  automatizado como parte del seed.
- La factura `0003-00001004` sigue sin cobro real que explique su
  `total_cobrado`. No afecta el componente Pagos del score (que mide
  días vencimiento→cobro sobre pares cobro↔factura existentes, no
  sobre facturas sin cobro), pero queda como inconsistencia de dato
  conocida por si en algún momento se audita el histórico completo de
  la empresa demo.
