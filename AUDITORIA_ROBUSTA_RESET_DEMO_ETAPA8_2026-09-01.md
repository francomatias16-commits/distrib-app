# Auditoría robusta del reinicio automático de la demo — Etapa 8
Fecha: 2026-09-01/02 · Proyecto Supabase: `jgiquzjwoedmzwqgzubr` (Distribuidora del Litoral S.A. — empresa demo)

## Alcance
Auditoría de punta a punta del mecanismo `fn_snapshot_demo_v2` / `fn_reset_demo_v2` (cron
`demo_reset_periodico`, corre cada 6 horas — **no** una vez al día) contra el esquema real vivo
en producción: 90 tablas del ciclo de negocio + tablas satélite, foreign keys con `ON DELETE
CASCADE` / `SET NULL` / `NO ACTION`, jobs de `cron.job`, y verificación funcional corriendo el
ciclo completo snapshot → reset sobre la empresa demo real.

## 1. Bug confirmado y corregido (ya aplicado y validado en producción)
Dos tablas hijas quedaban fuera del ciclo de snapshot/reset pero con FK `ON DELETE CASCADE`
hacia una tabla que el reset sí borra y reinserta, y una tabla de contadores quedaba fuera del
ciclo por completo:

- `captura_competencia_items` (cascada desde `captura_competencia`)
- `asistente_acciones_pendientes` (cascada desde `asistente_conversaciones`)
- `contadores_empresa` (numeración correlativa de facturas/remitos/OC — no se borraba ni
  restauraba, solo avanzaba para siempre)

**Fix**: las 3 tablas se agregaron al mismo mecanismo genérico (`fn_snapshot_demo_v2` /
`fn_reset_demo_v2`), respetando orden de dependencias. Migraciones ya registradas en la base:
`etapa8_fix_snapshot_demo_tablas_perdidas` (20260902015538) y
`etapa8_fix_reset_demo_tablas_perdidas` (20260902015827). Archivo local:
`supabase/migrations/20260901220000_etapa8_fix_reset_demo_tablas_perdidas_y_contador.sql`.

**Validación en esta auditoría**: se corrió `fn_snapshot_demo_v2()` → `fn_reset_demo_v2()` una
vez más sobre la empresa demo real. Resultado: sin errores; `contadores_empresa` con 6 filas
consistentes; las dos tablas hijas antes huérfanas, correctamente vacías/consistentes con el
snapshot (no fueron borradas por cascada sin restaurar).

## 2. Revisión adicional (nueva, esta sesión) — sin bugs nuevos de la misma severidad
Se comparó el set completo de tablas con columna `empresa_id` contra las 90 cubiertas por el
snapshot/reset, y se revisaron todas las FKs de las tablas no cubiertas hacia las tablas sí
cubiertas:

- **Ya no quedan FKs `ON DELETE CASCADE`** desde tablas no cubiertas hacia tablas que el reset
  borra/reinserta (el hallazgo de la sección 1 era el único caso — ahora corregido).
- `usuarios.cliente_id` y `clientes.usuario_id` tienen `ON DELETE SET NULL` / dependen del ciclo
  de `clientes`, pero **ya están cubiertos**: el reset llama a
  `fn_relink_portal_clientes_demo()` al final, que re-vincula por teléfono. Verificado en esta
  sesión: 0 usuarios con `rol='cliente'` y `cliente_id` nulo después del reset.
- `migracion_sesiones` / `migracion_plantillas_mapeo` referencian `depositos`/`listas_precios`
  con `NO ACTION`: el reset ya los des-vincula antes de borrar y los re-vincula después. Correcto.

## 3. Hallazgos menores (no son pérdida de datos silenciosa — quedan documentados, no urgentes)
- **`cola_financiera`** (290 filas hoy): cola de reintentos de `fn_cierre_financiero_entrega`,
  con FK `CASCADE` hacia `empresas` (no hacia una tabla que el reset borre). No participa del
  ciclo de snapshot/reset; al ser una cola de procesamiento interna (no una sección visible de
  reportes), el impacto de que no se resetee es bajo, pero puede ir acumulando filas de un ciclo
  demo a otro referenciando entidades ya reseteadas. Sugerido a futuro: agregar una limpieza
  periódica de filas `estado='completado'` con más de N días.
- **`puntos_log`** y **`puntos_saldo`**: tablas legacy, no referenciadas por ninguna función
  activa (reemplazadas por `movimientos_puntos` / `saldo_puntos`, que sí están en el ciclo).
  No representan riesgo de pérdida de datos porque nada las escribe ni las lee hoy; candidatas a
  limpieza de código muerto en otra etapa, no afectan la demo.

## 4. Estado general confirmado
- `pedidos`, `facturas`, `cta_cte`, `stock`, fechas y demás módulos: 100% consistentes, lo
  corregido en sesiones previas se mantiene.
- Cron `demo_reset_periodico`: activo, `0 */6 * * *` → `fn_reset_demo_cron()` → `fn_reset_demo_v2()`.
- Ciclo completo snapshot→reset corrido en esta sesión sin errores sobre datos reales de hoy.

## Conclusión
El hallazgo de pérdida de datos que motivó la etapa 8 (tablas huérfanas + contador sin resetear)
está corregido y validado en producción. La revisión ampliada de esta sesión, cubriendo todas las
tablas con `empresa_id` y sus relaciones FK, no encontró otro caso de la misma clase (cascada
silenciosa fuera del ciclo de reset). Los dos hallazgos menores de la sección 3 quedan
documentados para una futura limpieza, sin impacto en la integridad de la demo hoy.
