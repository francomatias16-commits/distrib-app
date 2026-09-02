# v912 — Fix de los componentes Deuda y Pagos de `calcular_score_cliente()`

## Contexto

Al inyectar historial real de `scores_cliente` para los clientes que
nunca lo tuvieron (v910/v911, modal de confianza vacío), aparecieron dos
bugs en el cálculo del score en sí, independientes de la falta de datos.

## Migración 523 — Componente Deuda (aplicada)

`cta_cte.tipo` real es `'factura'`/`'cobro'`/`'nota_credito'` — el `CASE`
comparaba contra `'debito'`/`'credito'`, valores que nunca existieron en
esa columna. Como nunca matcheaba, siempre caía al `ELSE (-monto)` para
todas las filas, así que el componente Deuda daba **siempre 20/20**, sin
importar la deuda real. Verificado contra `clientes.saldo_deuda`: con el
fix coincide exacto.

Mismo patrón de bug encontrado en `registrar_cobro_completo()`
(desbloqueo automático al cobrar), pero esa función ya lo había corregido
en una migración posterior (2026-08-18, lee `clientes.saldo_deuda`
directamente) — no hacía falta tocarla.

## Migración 524 — Componente Pagos (aplicada)

Medía días entre vencimiento y cobro vía un join `cta_cte.factura_id`,
columna que las filas `tipo='cobro'` **nunca completan** (0 de 140 en la
empresa de prueba) — el componente caía siempre al default (20/40).

`registrar_cobro_completo()` evolucionó y desde el 2026-08-18 trackea el
vínculo cobro↔factura en una tabla dedicada: `cobro_facturas_aplicadas`.
El componente Pagos ahora usa esa tabla en vez del join roto.

**Limitación conocida:** `cobro_facturas_aplicadas` recién empezó a
poblarse con esa migración — los cobros históricos (los 140 de la
empresa de prueba) no tienen fila ahí, así que el componente sigue en
default hasta que haya cobros *nuevos* vinculados a factura. Es la
corrección correcta igual: a partir de ahora cada cobro que aplique a una
factura puntual sí alimenta el score real.

## Recalculo

Se corrió `calcular_score_cliente()` para los 97 clientes del sistema
(2 empresas) después de aplicar el fix de Deuda — 33 clientes pasaron a
`riesgo` por deuda real por encima de su límite de crédito (antes
quedaban en `bueno`/`normal` con el componente Deuda siempre en máximo).
No hizo falta re-correr después del fix de Pagos: sin filas en
`cobro_facturas_aplicadas`, el resultado no cambia.

## Pendiente / a decidir

La empresa demo ("Distribuidora del Litoral S.A.") se resetea todas las
noches a las 5am desde un snapshot fijo (`demo_snapshots`) que quedó
tomado *antes* de que `cobro_facturas_aplicadas` existiera con datos —
o sea, el componente Pagos va a seguir en default ahí después de cada
reset, salvo que alguien registre cobros nuevos manualmente entre reset
y reset. Si se quiere que el modal de confianza se vea con variación real
también en el componente Pagos en el entorno demo, hay dos caminos:
1. Backfillear `cobro_facturas_aplicadas` para los 140 cobros históricos
   de la empresa demo y volver a tomar el snapshot (`fn_snapshot_demo_v2`)
   para que persista tras cada reset diario.
2. Dejarlo como está — igual mejora sobre el estado anterior (Deuda ya
   varía) y el componente Pagos funciona correctamente para clientes
   reales fuera del demo.

No se tocó nada de esto sin confirmar — es la decisión pendiente de este
changelog.
