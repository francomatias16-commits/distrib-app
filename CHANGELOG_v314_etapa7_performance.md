# v314 — Auditoría 2026, Etapa 7: Performance y escalabilidad

Esta etapa no requirió cambios de código de aplicación — todo el trabajo
fue directo en la base de Supabase (migraciones SQL) y en la documentación
de la auditoría (`AUDITORIA_2026/etapas/07_performance_escalabilidad.md`).

## Contexto
El archivo de la etapa 7 venía marcado "🟢 Cerrada" pero estaba reconstruido
a partir de otra sesión y no coincidía con el estado real de la base. Al
retomarla se corrió `get_advisors(performance)` de nuevo: **479 hallazgos
vigentes**, no los 3 documentados.

## Corregido (migración `etapa7_perf_rls_initplan_batch2_y_fk_indices_y_dup_index`)
- 3 políticas RLS (`notas_internas`, `internal_secrets`, `cta_cte`) que
  re-evaluaban `auth.uid()`/`auth.role()` por cada fila en vez de una vez
  por statement — envueltas en `(select ...)`, mismo patrón que un batch1
  previo. Verificado que la lógica de autorización no cambió (`get_advisors`
  security sin hallazgos nuevos).
- Índice faltante en `entregas.cobro_id` (FK sin índice de soporte).
- Índice duplicado en `notas_credito` (`idx_nc_factura` == `idx_notas_credito_factura`) — se eliminó el redundante.

## Verificado, sin acción (para no romper nada a ciegas)
- **`unused_index` (118 hallazgos):** falso positivo — incluye índices tan
  centrales como el primary key de `pedido_items` (13.482 filas, uso
  diario). Los contadores de uso de índices están en cero por el mismo
  reseteo de estadísticas ya diagnosticado en PERF-02. No se borró nada;
  recomendado re-evaluar en unas semanas con estadísticas frescas.
- **`no_primary_key` (91 hallazgos):** 100% en el schema
  `backup_pre_wipe_20260702` (una snapshot de backup, no tablas de
  producción). Pendiente de decisión: si ya no se necesita ese backup,
  eliminar el schema resuelve esto de un saque.
- **`multiple_permissive_policies` (266 filas → 54 combinaciones reales,
  42 tablas):** políticas RLS permissive duplicadas para la misma
  tabla+acción (patrón típico: una política `*_all`/`service_role_all_*`
  conviviendo con la política específica). Overhead menor, no es un
  problema de seguridad. Pendiente de decisión del usuario por el volumen
  de tablas que tocaría consolidar.

## Pendiente de decisión (ver tablero maestro, PERF-04/05)
1. ¿Se puede borrar `backup_pre_wipe_20260702`?
2. ¿Vale la pena consolidar las 54 políticas RLS duplicadas?
