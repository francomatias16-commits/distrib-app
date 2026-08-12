# v646 — Plan offline, Etapa 3: aplicación REAL contra Supabase (441-445)

## Contexto crítico

Al retomar la sesión, verifiqué contra el Supabase real y ninguna de las
migraciones de idempotencia offline de las últimas dos sesiones (441, 442,
443, "444") había llegado a producción — ni las columnas `offline_local_id`
(fuera de `ventas_pos`, de la migración 119) ni los parámetros nuevos en
`ajustar_stock` / `registrar_conteo_stock` / `registrar_cobro_completo`
existían en la base real. El código ya deployado en v644/v645
(`lib/handlers/pedidos.js`, `chofer-offline.js`, `cliente-offline.js`)
asume que sí existen — sin este delta, cualquier reintento offline de
confirmar entrega, devolución o cobro rompía contra producción.

## Aplicado ahora (verificado contra Supabase, no solo escrito)

- **443** (`ajustar_stock` + `registrar_conteo_stock`): tenía un bug propio
  — el `DROP FUNCTION` explícito solo cubría `ajustar_stock`. Como
  `registrar_conteo_stock` suma dos parámetros nuevos, un `CREATE OR
  REPLACE` sin el `DROP` previo habría creado un overload ambiguo en vez
  de reemplazar la función. Agregado el `DROP FUNCTION` que faltaba +
  `REVOKE ALL FROM PUBLIC` / `GRANT ... TO authenticated, service_role`
  explícito en ambas (el `DROP` resetea los grants).
- **444** (`entregas` / `devoluciones` / `cobros` + `registrar_cobro_completo`):
  los archivos locales `441_offline_dedup_entregas_devoluciones.sql` y
  `442_offline_dedup_registrar_cobro_completo.sql` del repo nunca se
  aplicaron con esos números — ya estaban tomados por otras dos
  migraciones no relacionadas (`441_fix_reportes_stock_criticos...`,
  `442_fix_actualizar_estado_lotes...`). Además el borrador local de
  `registrar_cobro_completo` (442) era de **antes** de que la función
  sumara soporte multi-factura (`p_facturas_aplicadas` /
  `cobro_facturas_aplicadas`) — aplicarlo tal cual habría hecho retroceder
  esa función en producción. Reescribí la migración partiendo de la
  definición real vigente (`pg_get_functiondef` contra Supabase) y le
  agregué únicamente `p_offline_local_id` (fast-path + backstop por
  `unique_violation`), sin tocar el resto de la lógica.
- **445** (fix post-aplicación): las tres funciones tocadas quedaron con
  `anon` en el `EXECUTE` grant — el `default privilege` del schema
  (rol `postgres`) se lo otorga automáticamente a toda función nueva, y el
  `DROP FUNCTION` + `CREATE` de 443/444 dispara ese default. Mismo patrón
  que ya venía apareciendo en el historial del proyecto
  (`fix_sec012_revocar_exec_anon_funciones_de_negocio` y afines). Revocado
  `anon` explícitamente en las tres.

## Verificado en producción (transacciones de prueba con ROLLBACK, sin tocar datos reales)

- `ajustar_stock`: reintento con el mismo `offline_local_id` devuelve
  `ya_existia:true` y el stock no se duplica.
- `registrar_conteo_stock`: `p_stock_sistema_esperado` desalineado rechaza
  el conteo con `tipo:conflicto_stock_cambio`; alineado, lo aplica normal.
- `registrar_cobro_completo`: reintento con el mismo `offline_local_id`
  devuelve el mismo `cobro_id` con `ya_existia:true`; confirmado que el
  soporte multi-factura sigue intacto (respuesta trae `facturas_aplicadas`
  cuando corresponde).
- Sin overloads duplicados: cada una de las tres funciones quedó con una
  sola firma en `pg_proc`.
- Grants finales: `authenticated`, `postgres`, `service_role` únicamente
  (sin `anon`) en las tres.

## Archivos

- `supabase/migrations/443_offline_dedup_ajuste_stock.sql` (corregido)
- `supabase/migrations/444_offline_dedup_entregas_devoluciones_cobro.sql` (nuevo, reemplaza a los 441/442 locales stale)
- `supabase/migrations/445_fix_revoke_anon_offline_dedup_funciones.sql` (nuevo)
- Registradas en `schema_migrations_registry` (ids 83, 84 — falta agregar 445 si querés llevar el registro completo)

## Pendiente

- Los archivos locales `441_offline_dedup_entregas_devoluciones.sql` y
  `442_offline_dedup_registrar_cobro_completo.sql` en tu repo quedaron
  huérfanos (esos números ya fueron usados por otra cosa y su contenido
  está desactualizado). Sugiero borrarlos del repo para que nadie los
  vuelva a aplicar por error — ya están reemplazados por el 444 de esta
  entrega.
- Con esto se cierra completo el ítem 2 y 3 de la Etapa 3 del plan
  offline (ajuste/conteo de stock + confirmaciones del chofer). Falta
  confirmar si queda algún ítem más en la Etapa 3 o si corresponde pasar
  a la Etapa 4.
