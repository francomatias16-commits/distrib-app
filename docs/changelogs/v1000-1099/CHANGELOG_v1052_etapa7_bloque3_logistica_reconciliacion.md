# v1052 — Etapa 7, Bloque 3 (Logística/Rutas): reconciliación de migraciones

## Contexto

Reconciliación de migraciones del Bloque 3 según
`PLAN_AUDITORIA_FUNCIONAL_ETAPA7_2026.md`: v823-v827, v864, v866,
v868-v869, v893-v894, v962, v972 (12 changelogs).

## Reconciliación de migraciones

A diferencia de Bloque 1 y Bloque 2, ninguno de los 12 changelogs del
rango toca schema de Supabase — son refactors de tokens de color en JS
(v823, v824, v826, v827), fixes de UI/dashboard (v864, v866, v869, v893,
v972), un fix de XSS en frontend (v962) y dos fixes de lógica de
filtrado/sincronización sobre datos existentes (v825, v868, v894), todos
explícitos en no tocar backend/migraciones/RPCs. **Sin gaps de backfill —
no aplica el patrón de la migración 483 acá.**

## Verificación de un pendiente abierto — v894

v894 (\"Pedidos para despachar vacío\") había dejado documentado un punto
pendiente de decisión operativa: 145 registros de `entregas`
(`pendiente`/`en_camino`) huérfanas de rutas ya `completada`/`cancelada`,
sin resolver si correspondía cerrarlas como entregadas o reprogramarlas.

Verificado contra el proyecto real: **0 registros** hoy cumplen esa
condición. El fix de código (excluir rutas `completada`/`cancelada` del
bloqueo) sigue en pie; el dato histórico ya no está — probablemente se
resolvió manualmente o el set de datos cambió desde entonces. No hizo
falta ninguna acción; se deja constancia de que se revisó y no quedó
pendiente real.

## Bloque 3 — estado

Reconciliación de migraciones cerrada. Falta, si se quiere profundizar
antes de pasar a Bloque 4: revisión línea por línea del código de rutas
(`frontend/admin/js/rutas.js`, geocodificación, sincronización
offline→online) y el pase manual en navegador de los casos borde del plan
(entrega sin geolocalizar, ruta con chofer desasignado a mitad de camino).
