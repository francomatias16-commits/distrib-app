-- [BACKFILL] Auditoría 2026, Etapa 2 (SEC-014). Aplicada originalmente en
-- producción como "fix_sec014_borrar_token_test_sin_cifrar" (2026-07-11)
-- directamente vía herramienta de migración, sin dejar archivo en el repo.
-- Statement recuperado tal cual desde
-- supabase_migrations.schema_migrations (no es una función, es una
-- limpieza de datos puntual; no aplica reconstrucción vía
-- pg_get_functiondef como en los backfills 279-288).
--
-- Hallazgo: quedaba una fila de test en integraciones_pago (sandbox de
-- Mercado Pago, activa=false) con access_token en texto plano, previa a
-- que 133_mp_access_token_cifrado empezara a cifrar este campo (prefijo
-- 'v1:'). No es una credencial de producción y no está en uso por ningún
-- flujo activo (activa=false).
--
-- Fix: se optó por borrar la fila en vez de re-cifrarla, porque no hay
-- ninguna razón de negocio para conservar una credencial de sandbox
-- inactiva. El WHERE es intencionalmente específico (id + activa=false +
-- access_token NOT LIKE 'v1:%') para que sea un no-op seguro si se corre
-- de nuevo (p. ej. al levantar una branch de desarrollo desde cero, donde
-- la fila puede no existir o ya estar cifrada) — no borra nada que no sea
-- exactamente esa fila de test sin cifrar.

delete from integraciones_pago
where id = '03437134-7353-482a-a503-4b09cdafd5c2'
  and activa = false
  and access_token not like 'v1:%';
