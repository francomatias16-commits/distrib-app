# v1050 — Etapa 7 (Bloque 1, Devoluciones): reconciliación de migraciones contra Supabase real

## Contexto

Paso 2 de la metodología de la Etapa 7 para el Bloque 1: reconciliar los
changelogs del rango (v796-v808, v904-v905, v962) contra `schema_migrations`
real, buscando el mismo patrón ya visto con la migración 483 — cambios
aplicados directo en Supabase que nunca se backfillearon como archivo de
migración en el repo.

De los 16 changelogs del rango, solo dos tocan schema de base de datos
(el resto son fixes de JS/frontend puros, sin DDL). Los dos tenían el gap:

## Hallazgo 1 — `fn_stock_lista_agrupada` (v796)

El changelog de v796 dice explícitamente "Cambios (Supabase, aplicados
directo — migración 494)". Confirmado contra el proyecto real
(`jgiquzjwoedmzwqgzubr`, `pg_get_functiondef`) que el cambio SÍ está en
producción. Pero el archivo que hoy ocupa el número 494 en el repo
(`494_fn_reportes_stock_valorizacion.sql`) es una función completamente
distinta — choque de numeración, no el cambio real de v796.

Consecuencia concreta: la última versión de `fn_stock_lista_agrupada` que
sí está en el repo (`461_fn_stock_lista_agrupada_agrega_foto_url.sql`)
todavía tiene el filtro `AND p.activo = true` — exactamente el bug que
v796 vino a arreglar (59 productos inactivos con 22.687 unidades de stock
fantasma, invisibles en la pantalla de Stock). Un `supabase db reset` hoy
reconstruiría la versión **rota**, no la que corre en producción.

El trigger que v796 agregó en el mismo changelog
(`trg_guard_desactivar_producto_con_stock`) **no** tenía este problema —
ya había sido backfilleado en la migración 498
(`498_track_funcion_fantasma_guard_desactivar_producto.sql`), como parte
del cierre de funciones fantasma de la Etapa 0.

## Hallazgo 2 — constraints de `devolucion_items` (v805)

v805 (la auditoría post-incidente de los $9,86M) agrega, según su propio
changelog, un constraint "en base (migración
`v805_check_devolucion_items_cantidad_precio`)" — un nombre de archivo que
nunca existió en el repo. Confirmado contra `pg_constraint` en el proyecto
real que los dos CHECK sí están aplicados en producción:

```sql
ALTER TABLE devolucion_items
  ADD CONSTRAINT devolucion_items_cantidad_positiva CHECK (cantidad > 0),
  ADD CONSTRAINT devolucion_items_precio_no_negativo CHECK (precio_unitario >= 0);
```

Sin backfill, un `supabase db reset` reconstruiría `devolucion_items` sin
esta última línea de defensa contra cantidad ≤ 0 o precio negativo — justo
la clase de bug de la que trata todo el incidente que dispara v805.

Nota aparte: el propio changelog de v805, en su sección "Pendiente / no
bloqueante", ya anticipaba con precisión el hallazgo que terminamos
arreglando en v1049 244 versiones después: *"`crear_nota_credito` (RPC) no
valida el total contra la factura vinculada"*.

## Fix

Dos migraciones nuevas, puramente de trazabilidad — **no cambian
comportamiento**, la definición ya vive en producción tal cual:

- `573_backfill_fn_stock_lista_agrupada_v796.sql`: `CREATE OR REPLACE` con
  la definición exacta capturada de producción (`pg_get_functiondef`).
- `574_backfill_constraints_devolucion_items_v805.sql`: `DO` block con
  `IF NOT EXISTS` contra `pg_constraint` antes de cada `ADD CONSTRAINT`,
  para que sea no-op en el proyecto real (ya los tiene) pero sí los cree
  en un ambiente nuevo o un `db reset` local.

Ambas aplicadas contra `jgiquzjwoedmzwqgzubr` y verificadas: no-op
confirmado (mismo estado antes y después).

## Resto del rango reconciliado

v797, v798, v799, v800, v801, v802, v803, v804, v806, v807, v808, v904,
v905, y el changelog `v962_fix_mensaje_error_stock_guardarAjuste`: revisados
por menciones de "Supabase", "migración", `CREATE`, `ALTER TABLE`,
`CONSTRAINT` — sin más DDL sin backfillear. v804 menciona una corrección
"manualmente en Supabase" pero es corrección de **datos** del incidente
(movimientos de stock puntuales), no de schema — no aplica backfill de
migración.

## Pendiente

- Bloque 1: queda la revisión de código línea por línea de los changelogs
  restantes (más allá de la reconciliación de schema hecha acá) y el pase
  manual en navegador, diferido para el cierre de la etapa.
