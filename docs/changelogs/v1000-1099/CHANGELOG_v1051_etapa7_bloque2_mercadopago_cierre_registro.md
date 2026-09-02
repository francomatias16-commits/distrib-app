# v1051 — Etapa 7, Bloque 2 (Mercado Pago): reconciliación cerrada + completar `schema_migrations_registry`

## Contexto

Reconciliación de Bloque 2 (Mercado Pago) contra Supabase real, mismo
método que Bloque 1 (v1050).

## Reconciliación de migraciones — Bloque 2

Rango real con DDL relacionado a MP/pagos: v772, v784, v788, v789 (v912 y
v913, listados inicialmente como candidatos, se descartaron — son de
score de cliente / cta-cte, no de Mercado Pago).

Verificado contra el proyecto real (`jgiquzjwoedmzwqgzubr`):

| Migración | Changelog origen | Archivo en repo | Aplicada en prod |
|---|---|---|---|
| 480 | v772 | sí | sí (columnas de `integraciones_pago` confirmadas) |
| 481 | v772 | sí | sí |
| 489 | v772 | sí | sí (`'descartado'` confirmado en el CHECK real) |
| 490 | v772 | sí | sí |
| 497 | v784 | sí | sí |

**Resultado: sin gaps de backfill en Bloque 2** — a diferencia de Bloque 1,
acá el propio v772 ya había backfillado 480/481 en el momento en que
encontró el gap contra código ya desplegado.

## Hallazgo menor — registro de trazabilidad incompleto

`schema_migrations_registry` tenía filas para 480/481/497, pero **no**
para 489, 490 (Bloque 2) ni 573, 574 (Bloque 1, v1050) — estaban aplicadas
en la base real pero sin registrar. Se completaron las 4 filas faltantes,
usando el `aplicada_en` real tomado de
`supabase_migrations.schema_migrations` (no inventado):

- `489_fix_conciliacion_bancaria_estado_descartado.sql` — 2026-08-16 04:17:55 UTC
- `490_fix_conciliacion_buscar_candidatos_filtro_tipo.sql` — 2026-08-16 04:18:11 UTC
- `573_backfill_fn_stock_lista_agrupada_v796.sql` — 2026-09-01 03:25:04 UTC
- `574_backfill_constraints_devolucion_items_v805.sql` — 2026-09-01 03:25:10 UTC

Sin cambios de comportamiento — solo trazabilidad (`INSERT` en tabla de
registro, no toca schema ni datos de negocio).

## Bloque 2 — cierre

Con esto queda cerrada la reconciliación de migraciones de Bloque 2.
Pendiente (no bloqueante, ya documentado en v772): probar Checkout Pro
end-to-end contra una cuenta MP real, y el pase manual en navegador
(diferido junto con el de Bloque 1).

Falta, si se quiere continuar antes de pasar a Bloque 3: revisión línea
por línea del código de los handlers de MP (`mpOauthCallbackHandler`,
`obtenerAccessTokenMPValido`, `verificarPago`, `manejarWebhook`,
`posQrCobrarHandler`, etc. en `lib/handlers/pagos.js`), más allá de la
reconciliación de schema hecha acá.
