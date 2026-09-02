# v610 — Redistribución de fechas en los datos de la empresa demo

## Motivo

Todos los registros de la empresa demo (`empresa_id =
4462586e-e11a-4d34-a405-17103bb9cf9f`, `es_demo = true`) tenían la fecha
del día en que se cargó la data de prueba. Eso hacía que cualquier
gráfico o reporte que agrupe por período (ventas por mes, evolución de
cta cte, cobranzas, dashboard ejecutivo, etc.) mostrara todo apilado en
un solo día — no servía para mostrar el producto en una demo comercial.

## Cambios

Se corrió manualmente contra el proyecto de Supabase de la empresa demo
un `UPDATE` masivo que resta a cada registro un delta de 0 a 215 días
(rango 1/1/2026 → hoy), calculado de forma determinística por hash MD5
sobre el id del documento. No es una migración de esquema — es una
operación de datos, sobre datos de demo, no se tocó ninguna empresa
real. El detalle completo (28 tablas, en 6 batches) queda documentado y
es reproducible en `scripts/redistribuir-fechas-demo.sql`.

Puntos importantes de la estrategia:

- **Coherencia entre documentos relacionados**: las tablas que dependen
  de otra (cta_cte, cobros, notas de crédito, entregas, recepciones,
  pagos a proveedor, devoluciones, movimientos de stock) no calculan un
  delta propio — reusan el delta de su documento padre (factura,
  pedido, orden de compra, turno de caja) vía su FK. Así se garantiza
  que, por ejemplo, ningún cobro quede fechado antes que la factura que
  cancela. Se verificó post-corrida: 0 casos de `cobro.fecha <
  factura.fecha_emision`.
- **`cta_cte.fecha_date`** es columna generada (`GENERATED ALWAYS AS ...
  STORED`) — no se puede escribir directamente, se recalcula sola al
  actualizar `fecha`.
- **`movimientos_stock`** no tiene `empresa_id` propio ni FK directa a
  un único tipo de documento — se llega a la empresa vía `producto_id`,
  y el delta se toma de `referencia_id` (que apunta indistintamente a
  pedido, orden de compra o venta POS según el tipo de movimiento) con
  fallback al id propio cuando no hay referencia.

## Alcance

Empresa demo únicamente. `lib/demo-mode.js` (`esEmpresaDemo`) sigue
siendo el único punto que decide si una integración externa real
(AFIP/ARCA, WhatsApp, email) debe dispararse o no — este cambio no lo
toca, es ortogonal.

## Pendiente / a considerar

- Si se recarga la semilla demo (`supabase/migrations/003_seed.sql` o
  similar) hay que volver a correr `scripts/redistribuir-fechas-demo.sql`
  a mano — no quedó automatizado como parte del seed ni de un cron.
- No es idempotente: correrlo dos veces sobre el mismo dataset vuelve a
  restar delta sobre fechas ya corridas.
