# Etapa 7 — Performance y escalabilidad

**Estado:** 🟢 Cerrada (2026-07-19) — las 2 decisiones pendientes de abajo ya se resolvieron, ver sección final.

> **Nota (2026-07-12):** el archivo anterior decía "🟢 Cerrada" y estaba
> reconstruido a partir de otra sesión. Al retomar la etapa se corrió
> `get_advisors(performance)` de nuevo contra la base real y aparecieron
> **479 hallazgos vigentes**, no solo los 3 que este archivo documentaba.
> Se investigó cada categoría antes de tocar nada — el detalle abajo.

## PERF-01 (no accionable) — `pg_timezone_names` consumía el 25% de todo el tiempo de queries
Sin cambios respecto a lo ya documentado: catálogo nativo de Postgres,
patrón apunta al Studio de Supabase, no accionable por código.

## PERF-02 — Ninguna tabla de `public` tenía `ANALYZE` corrido
**Verificado contra la base real:** `pedido_items` refleja hoy sus 13.482
filas reales con `last_analyze` del 2026-07-11. El fix ya está aplicado y
sigue vigente.

## PERF-03 — 11 columnas FK sin índice de soporte
**Verificado:** migración `perf_indices_fk_faltantes_lote1` aplicada. Al
re-correr advisors apareció **1 más** que no estaba en el lote original:
`entregas.cobro_id`. Corregido ahora (ver abajo).

## Hallazgos nuevos encontrados al retomar la etapa (2026-07-12)

### 1. `auth_rls_initplan` — 3 políticas RLS re-evaluaban `auth.*()` por fila
Ya existía un `perf_fix_rls_initplan_batch1_auth_role` de una sesión previa
que corrigió la mayoría; quedaban 3 sin envolver en `(select ...)`:
`notas_internas.notas_internas_empresa`, `internal_secrets.rls_internal_secrets_service_role_only`,
`cta_cte.cta_cte_select`.
**Fix:** migración `etapa7_perf_rls_initplan_batch2_y_fk_indices_y_dup_index` —
mismo patrón que el batch1, sin cambiar la lógica de autorización. Verificado
post-fix con `get_advisors(security)`: no aparece ningún hallazgo nuevo de
seguridad, las 3 políticas siguen filtrando exactamente igual.

### 2. `unindexed_foreign_keys` — `entregas.cobro_id` sin índice
**Fix:** `CREATE INDEX idx_entregas_cobro_id ON entregas(cobro_id)` (misma
migración de arriba).

### 3. `duplicate_index` — 2 índices idénticos en `notas_credito`
`idx_nc_factura` e `idx_notas_credito_factura` eran el mismo índice sobre
`factura_id`. **Fix:** se eliminó `idx_nc_factura` (se conserva el de
nombre más descriptivo).

### 4. `unused_index` (117→118) — probable falso positivo, NO se tocó
Incluye índices tan centrales como `pedido_items_pkey` (tabla con 13.482
filas, uso diario confirmado) marcados con `idx_scan = 0`. Un primary key
de una tabla activa no puede estar "sin uso" de verdad — esto confirma la
misma causa raíz que ya se diagnosticó en PERF-02: los contadores de
`pg_stat_user_indexes` se resetearon (probable `pg_stat_reset()` accidental)
el mismo día que se corrió el `ANALYZE` manual. **No se borró ningún
índice** — hacerlo con estadísticas en cero sería destructivo y arbitrario.
Recomendación: volver a correr `get_advisors(performance)` dentro de 2-3
semanas de uso normal; ahí sí van a ser confiables los que sigan en 0.

### 5. `no_primary_key` (91) — todos en un schema de backup, no en producción
Los 91 hallazgos son 100% del schema `backup_pre_wipe_20260702` (una
snapshot congelada, no tablas activas). No es un bug — las tablas de backup
creadas por `CREATE TABLE AS` no heredan PK. **Pendiente de decisión, no
accionado:** ¿ese backup sigue siendo necesario? Si no, se puede eliminar
el schema completo (`DROP SCHEMA backup_pre_wipe_20260702 CASCADE`) y estos
91 hallazgos desaparecen solos.

### 6. `multiple_permissive_policies` (266 filas → 54 combinaciones reales)
Los 266 hallazgos son el mismo problema repetido ~5 veces por cada rol
técnico (`anon`/`authenticated`/`authenticator`/`dashboard_user`/`supabase_privileged_role`).
Deduplicado: **54 combinaciones tabla+acción** en 42 tablas donde hay 2
políticas permissive que Postgres tiene que evaluar y unir con `OR` para
la misma acción — overhead menor, no es un bug de seguridad. El patrón más
repetido es una política `service_role_all_*`/`*_all` conviviendo con la
política específica de la tabla (`tokens_wsaa`, `ordenes_compra`,
`ordenes_compra_items`, `facturacion_config`, cada una con 3-4 acciones
duplicadas) — el mismo patrón que `etapas/02_seguridad_db.md` ya había
notado puntualmente para `tokens_wsaa` como housekeeping menor. **Pendiente
de decisión, no accionado:** consolidar cada par en una sola política (con
`OR` interno) es seguro pero toca 42 tablas — se prefirió no tocarlo sin
que el usuario confirme que quiere ese trabajo ahora, dado el volumen.

## Verificación de cierre (2026-07-12)
- `get_advisors(performance)` antes y después del fix: `auth_rls_initplan`
  3→0, `unindexed_foreign_keys` 1→0, `duplicate_index` 1→0.
- `get_advisors(security)` post-fix: sin hallazgos nuevos, coincide con lo
  ya documentado en Etapa 2 (SEC-003/SEC-004 pendientes, sin relación con
  este fix).
- Migración `etapa7_perf_rls_initplan_batch2_y_fk_indices_y_dup_index`
  aplicada directo en Supabase (efecto inmediato, sin deploy).

## Cierre de las decisiones pendientes (2026-07-19, sesión de retoma)

### PERF-04 — schema de backup (era decisión pendiente #1)
El usuario confirmó que `backup_pre_wipe_20260702` ya no se necesitaba.
**Fix:** `DROP SCHEMA backup_pre_wipe_20260702 CASCADE` (v402). Los 91
hallazgos `no_primary_key` desaparecieron con la migración, sin necesidad
de tocar tabla por tabla.

### PERF-06 — 5 índices de FK sin cobertura + initplan de puntos
Reaparecieron 5 FKs nuevas sin índice desde el último barrido (v404):
`chofer_invitaciones`, `conteos_stock` (x2), `export_contable_log`,
`producto_insumos`. Además, 4 políticas RLS en `saldo_puntos` /
`movimientos_puntos` / `canjes_recompensas` seguían con `auth.uid()` sin
envolver — mismo patrón de `auth_rls_initplan` que el resto de la etapa,
corregido a `(select auth.uid())` (v403).

### PERF-05 — consolidación de las 54 políticas RLS duplicadas (era decisión pendiente #2)
El usuario confirmó que sí valía la pena. Al recontar contra la base real
al momento de encarar el trabajo, el número había crecido a **271
hallazgos `multiple_permissive_policies`** (43 tablas). Se resolvió en 2
migraciones:
- **v405** — 27 tablas tenían un patrón `FOR ALL` (con rol restringido) +
  `FOR SELECT` separada. Postgres no permite combinar comandos en una sola
  policy, así que se partió el `ALL` en `INSERT`/`UPDATE`/`DELETE`, dejando
  el `SELECT` como única vía de lectura. Mismo comportamiento, sin doble
  evaluación.
- **v406** — 6 pares de políticas `SELECT`-only se fusionaron con `OR` en
  una sola (`carrito_items`, `clientes`, `ofertas_liquidacion`, `pedidos`,
  `saas_facturas`, `audit_log`). Además se encontraron y borraron
  duplicados literales sin motivo: `cheques_select`, `cobros_select`,
  `entregas_select` (idénticas a su policy `ALL`), `fc_delete`/`insert`/`update`
  en `facturacion_config` (redundantes con `service_role_all_facturacion_config`),
  `tw_all` en `tokens_wsaa`, y 2 policies duplicadas en `devoluciones_pos_items`.

Con v405+v406 los 271 hallazgos bajaron a 16, verificado con
`get_advisors(performance)`.

### PERF-07 — caso especial `ordenes_compra` / `ordenes_compra_items`
Al consolidar en v405/v406 se detectó que estas 2 tablas tenían, cada una,
2 policies `FOR ALL` simultáneas: una restringida a `dueno/admin/depositero`
y otra sin ningún filtro de rol (`empresa_id = get_empresa_id()` nomás).
Combinadas con `OR`, la segunda dejaba el chequeo de rol como letra
muerta — cualquier usuario de la empresa podía crear/editar órdenes de
compra en la práctica, no solo esos 3 roles. No era fuga cross-tenant, pero
probablemente no era el permiso que se quiso dar, así que **se dejó afuera
a propósito** de v405/v406 en vez de fusionar arbitrariamente.

Se preguntó al usuario y confirmó: restringir a `dueno/admin/depositero`,
igual que el resto del módulo. **Fix (v407, `oc_restrict_and_dedupe_407`):**
se eliminaron las 2 policies `ALL` sin filtro de rol (`ordenes_compra_empresa`,
`oc_items_empresa`) y se partieron las `ALL` restringidas (`oc_modify`,
`oci_modify`) en `INSERT`/`UPDATE`/`DELETE`, dejando `oc_select`/`oci_select`
como única lectura — mismo patrón que v405. Verificado: `pg_policies`
muestra 4 policies por tabla (una por comando), y `get_advisors(security)`
no reporta ningún hallazgo RLS sobre ninguna de las 2 tablas.

Con esto, los 16 hallazgos restantes post-v406 (todos en `ordenes_compra`/
`ordenes_compra_items`) quedan en 0 y la Etapa 7 se cierra por completo.

