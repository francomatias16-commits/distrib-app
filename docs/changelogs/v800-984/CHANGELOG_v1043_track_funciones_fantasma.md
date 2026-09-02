# v1043 — Trackeo de las 7 funciones fantasma reportadas por audit:funciones-fantasma (2026-08-31)

## Por qué

`npm run audit:funciones-fantasma` (fix de crash en v1041) venía
reportando 7 funciones vivas en `pg_proc` sin ningún `CREATE FUNCTION`
en `supabase/migrations/`: si se recreara el proyecto desde cero (`supabase
db reset`), esas 7 no volverían a existir. Se habían creado en algún
momento a mano desde el SQL editor de Supabase y nunca quedaron
versionadas — mismo caso que `forzar_cierre_turno_caja`, trackeada
recién en la migración 241.

Confirmado real (no falso positivo) con grep en todo el repo:
`resolver_deposito_pedido` solo aparecía *nombrada en un comentario* de
la migración 550, nunca definida ahí ni en ningún otro lado.

## Qué se hizo

Se trajo la definición real de cada una desde producción con
`pg_get_functiondef(oid)` (vía Supabase MCP, no reconstrucción) y se armó
la migración 569 (`CREATE OR REPLACE` puro, no cambia comportamiento):

- `fn_asegurar_piso_reciente_demo` — mantiene "piso" de actividad
  reciente (rutas/facturas) en la empresa demo.
- `fn_extraer_medida` — parsea medidas ("2x500grs", "1.5 kg") para el
  matching de captura de precios de competencia.
- `fn_generar_alertas_stock_autonomo` — genera órdenes de compra
  automáticas y alertas de stock a partir de `analizar_stock_autonomo`.
- `fn_relink_portal_clientes_demo` — re-vincula usuarios del portal
  cliente con su fila en `clientes` por teléfono normalizado.
- `resolver_deposito_pedido` — resuelve qué depósito usar para un
  pedido (explícito → default del cliente → principal de la empresa).
- `trigger_sync_saldo_puntos` + `trigger_saas_avisar_nuevo_tenant` —
  funciones de trigger. Se verificó con `pg_get_triggerdef` que el
  `CREATE TRIGGER` que las conecta a su tabla (`tg_sync_saldo_puntos`
  en `movimientos_puntos`, `trg_saas_avisar_nuevo_tenant` en
  `empresas`) TAMPOCO estaba versionado, así que también se agregó
  (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, ya que esta versión de
  Postgres no tiene `CREATE OR REPLACE TRIGGER`).

Permisos: se dejaron explícitos en la migración los privilegios ya
verificados en producción con `has_function_privilege()` antes de
aplicar — ninguno cambia (Postgres preserva privilegios existentes en
un `REPLACE`), pero quedan documentados para que la migración sea
autocontenida: todo lo `SECURITY DEFINER` es service_role-only, salvo
`fn_extraer_medida` (IMMUTABLE, solo cómputo, se usa desde consultas de
cliente).

## Aplicado

Migración 569 aplicada contra producción y verificada: los 2 triggers
(`tg_sync_saldo_puntos`, `trg_saas_avisar_nuevo_tenant`) siguen
presentes después del `DROP+CREATE`, y el registro quedó en
`schema_migrations_registry`.

## Pendiente

Ninguno de comportamiento — es trackeo puro. Como hallazgo colateral de
esta tarea apareció la migración 568, aplicada en producción pero
ausente del repo (ver v1042): vale la pena correr
`audit:funciones-fantasma` periódicamente (ya está en `predeploy`) pero
no cubre índices/triggers sueltos aplicados a mano — solo funciones.
