# v1042 — Backfill de la migración 568, aplicada en DB pero ausente del repo (2026-08-31)

## Por qué

Al preparar la migración 569 (trackeo de funciones fantasma) se consultó
`schema_migrations_registry` para elegir el próximo número y aparecieron
566, 567 y 568 ya aplicados en producción — pero el repo (este ZIP, v1041)
solo traía los archivos de 566 y 567. La migración 568
(`fix_dispositivos_push_token_index_no_partial`) se había aplicado
directo contra la base vía Supabase MCP en una sesión anterior y nunca
se volcó a un archivo versionado: exactamente el mismo tipo de deuda
(cambio real en producción sin `CREATE ... ` versionado en
`supabase/migrations/`) que motivó la migración 569.

## Fix

Se reconstruyó `20260831000002_568_fix_dispositivos_push_token_index_no_partial.sql`
a partir de:
- la nota ya guardada en `schema_migrations_registry` para el número 568
  (texto exacto, no reescrito), y
- el `indexdef` real verificado en producción con `pg_indexes`
  (`CREATE UNIQUE INDEX idx_dispositivos_push_token ON public.dispositivos_push
  USING btree (token_push)` — sin `WHERE`, confirmando que el fix de 568 quedó
  aplicado tal como describía su nota).

El `INSERT ... ON CONFLICT DO NOTHING` sobre `schema_migrations_registry`
hace que este archivo sea inocuo si se corre contra la base de producción
(el registro para 568 ya existe desde que se aplicó originalmente) —
esto es puramente para dejar el repo consistente con lo que ya corre.

## Pendiente

Ninguno — es backfill puro, no cambia comportamiento. Sirve como
recordatorio: cualquier cambio aplicado vía MCP directo a la base debe
volcarse a un archivo en `supabase/migrations/` en la misma sesión,
no después.
