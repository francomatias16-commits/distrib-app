# v263 — Trigger de sincronización cheques.vencimiento ↔ fecha_vto

## Qué se hizo
Se cerró de raíz el problema detectado en v262: `cheques.vencimiento` y
`cheques.fecha_vto` ya no dependen de que cada código de escritura recuerde
completar las dos. Se agregó un trigger de sincronización automática, igual
en espíritu al que ya existe para `facturas` (migración 094).

## Migración aplicada
`supabase/migrations/252_cheques_sync_vencimiento_fecha_vto_trigger.sql`
— aplicada directamente en producción (proyecto `jgiquzjwoedmzwqgzubr`) el
2026-07-09 vía `apply_migration`.

Contenido:
1. **Backfill**: sincronizó las filas existentes que tenían una de las dos
   columnas en NULL (los 5 casos detectados en v262 quedaron corregidos).
2. **Trigger `trg_cheques_sync_vencimiento`** (`BEFORE INSERT OR UPDATE`):
   si se escribe una sola de las dos columnas, replica el valor en la otra.
   Si se escriben ambas explícitamente (como hace `cheques.js` hoy), no
   pisa nada.
3. Comentarios de columna actualizados para reflejar que la sincronización
   ahora es automática.

## Verificación
- Post-backfill: `0` filas con `vencimiento IS DISTINCT FROM fecha_vto` de
  189 cheques totales (antes había 5 desincronizadas).
- Prueba funcional dentro de una transacción con `ROLLBACK` (no quedaron
  datos de prueba en la base): un INSERT que solo completaba `fecha_vto`
  resultó en `vencimiento` autocompletado con el mismo valor.

## Nota
El fix de v262 (que hace que la alerta de cheques vencidos filtre por
`fecha_vto` en vez de `vencimiento`) **se mantiene sin cambios** — sigue
siendo válido y ahora es además redundante con este trigger, lo cual está
bien: dos capas de protección para el mismo problema.

## Fuera de alcance (sigue pendiente si se quiere retomar)
- El tema de las 44 transacciones de MercadoPago / integración de pagos
  inactiva, dejado de lado desde el principio de esta serie de cambios.
