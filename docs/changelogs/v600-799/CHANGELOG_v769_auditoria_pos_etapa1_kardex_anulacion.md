# CHANGELOG v769 — Auditoría funcional Etapa 1 (POS): kardex en anulación de venta

**Fecha:** 2026-08-16
**Contexto:** Etapa 1 del plan de auditoría funcional pre-lanzamiento
(`PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md`), continuación directa de
la migración 482 (kardex en devoluciones POS) de la sesión anterior.

## POS-AUDIT-02 — `anular_venta_pos` (migración 483)

Dos problemas encontrados al auditar la reversión de stock en la anulación
de una venta de mostrador:

1. **Gap de kardex.** Igual que el hallazgo de ayer en devoluciones: al
   anular una venta se reingresaba stock a la tabla `stock` pero nunca se
   dejaba detalle en `movimientos_stock_lotes`. Confirmado contra las 2
   anulaciones reales que había en producción — ninguna tenía detalle de
   lote.
2. **Depósito incorrecto si la caja fue reasignada.** La función tomaba el
   depósito desde `cajas_pos.deposito_id` (el depósito **actual** de la
   caja), no desde el depósito real usado al momento de la venta. Como el
   depósito de una caja se puede editar después de creada
   (`cajasAdminPostHandler`, acción "editar", sin restricción de ventas
   históricas), reasignar una caja a otro depósito y después anular una
   venta vieja reingresaría el stock al lugar equivocado — stock fantasma
   en un depósito, faltante permanente en el otro. Sin evidencia de que
   haya ocurrido todavía, pero era una condición latente real.

**Fix:** el depósito de reversión ahora se toma del movimiento de egreso
original de esa venta (`movimientos_stock` tipo `'egreso'`), no de la caja.
Se agrega el detalle de lote/kardex con el mismo patrón que la migración
482. Se hizo backfill de las 2 anulaciones ya existentes en producción.

## POS-AUDIT-03 — bug crítico atrapado antes de impactar producción (migración 484)

Al aplicar el fix de arriba se descubrió que la migración **482** (de la
sesión anterior, devoluciones POS) había quedado con un valor inválido:
insertaba `movimientos_stock_lotes.direccion = 'ingreso'`, pero el
constraint real de esa columna solo permite `'consumo'` o `'alta'`
(`movimientos_stock_lotes_direccion_check`). La migración se aplicó sin
error visible — `CREATE OR REPLACE FUNCTION` no ejecuta el cuerpo — así que
el error recién iba a aparecer la primera vez que un usuario hiciera una
devolución real con depósito asignado, en pleno uso.

Se corrigió tanto `rpc_registrar_devolucion_pos` (482) como
`anular_venta_pos` (recién escrita arriba, mismo error) para usar `'alta'`,
el valor correcto — mismo que usan `fn_lotes_crear`, `ajustar_stock`,
`recepcionar_orden_compra` y `producir_con_insumos` para altas de stock. Se
verificó que ninguna otra función del proyecto tenga este mismo error.

## Verificado sin hallazgos
- **Caja (apertura/cierre/forzado):** `cerrar_turno_caja`,
  `forzar_cierre_turno_caja`, `resumen_turno_caja` — usan `FOR UPDATE`,
  validan estado del turno, y `movimientos_caja.tipo` está acotado por
  constraint a `sangria`/`refuerzo`/`retiro_final` (sin riesgo de valor
  espurio afectando el cálculo neto).
- **Venta de mostrador (`registrar_venta_pos`):** lock `FOR UPDATE` por
  ítem contra sobreventa, dedup idempotente por `offline_local_id`,
  chequeo de límite de crédito en cta-cte, tolerancia de redondeo en
  pagos.

## Migraciones aplicadas
- `483_fix_anular_venta_pos_deposito_real_y_kardex`
- `484_fix_direccion_invalida_kardex_devolucion_y_anulacion_pos`

## Terminal Prisma (cobro con tarjeta/QR) — revisado, sin bugs de código
Circuito `prisma-cobrar` → `prisma-verificar` (polling c/3s, timeout 2min) →
`prisma-cancelar`: circuit breaker, reintentos, token cifrado por empresa
(nunca se expone al frontend), `payment_id` de Prisma queda guardado como
`referencia` en `venta_pos_pagos` (reconciliable después).

**Observación (no es bug, es límite de diseño a tener en cuenta):** el
sistema no verifica contra Prisma que el pago se acreditó antes de cerrar
la venta — confía en que el cajero completó el flujo en pantalla. Un
cajero podría marcar una venta como "tarjeta" sin cobrar de verdad; no se
detecta en el arqueo de caja porque no es efectivo. Mitigarlo de verdad
requiere integrar la API de liquidaciones de Prisma — fuera de alcance de
esta auditoría, queda como ítem para una etapa de hardening aparte.

## Ticket térmico
Solo lectura (`GET /api/pos/ticket`), filtrado por `empresa_id`, sin lógica
de negocio — sin hallazgos.

## Numeración de venta
`seq_ventas_pos` es una secuencia global compartida entre todas las
empresas del SaaS — no es un bug (los números siguen siendo únicos), pero
los números de venta no son consecutivos por empresa. A confirmar si eso
importa para AFIP/reportes antes de cerrar la auditoría por completo.

## Cierre de la etapa 1
Con venta de mostrador, anulación, devolución, caja y terminal Prisma
revisados, la etapa 1 (POS) del plan de auditoría queda cerrada. 3
hallazgos reales corregidos y aplicados en Supabase (483, 484). Sigue la
etapa 2 del plan: Pedidos + Facturación AFIP/ARCA + Cobros/cta-cte.
