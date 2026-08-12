-- 423b_fix_revoke_anon_authenticated_listar_movimientos_stock.sql
-- Fix de seguridad post-423: el REVOKE ALL ... FROM PUBLIC de 423 no
-- alcanza a anon/authenticated porque este proyecto tiene default
-- privileges que les otorgan EXECUTE automático en funciones nuevas
-- del schema public (mismo problema que motivó 197_revoke_execute_public_secdef
-- y varias otras migraciones de hardening del historial).
--
-- Se revoca explícito para dejar la función accesible solo por
-- service_role, como el resto del catálogo de tools del asistente.
--
-- NOTA: aplicada en producción (proyecto jgiquzjwoedmzwqgzubr) el 2026-07-31.

REVOKE EXECUTE ON FUNCTION public.listar_movimientos_stock(UUID, TEXT, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.listar_movimientos_stock(UUID, TEXT, TEXT, INT) FROM authenticated;

COMMENT ON FUNCTION public.listar_movimientos_stock IS
  'Tool del asistente: historial de movimientos de stock (ingresos/egresos/ajustes/transferencias) en los últimos N días, opcionalmente filtrado por producto y/o tipo (máx. 20 filas mostradas, total_movimientos es el real). Fix 423b: esta empresa tiene default privileges que auto-otorgan EXECUTE a anon/authenticated en funciones nuevas de public — se revoca explícito, mismo patrón que 197_revoke_execute_public_secdef.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '423b_fix_revoke_anon_authenticated_listar_movimientos_stock.sql', '423b', 'claude-session',
        'Fix de seguridad post-423: el REVOKE ALL FROM PUBLIC no alcanza a anon/authenticated porque el proyecto tiene default privileges que les otorgan EXECUTE automático en funciones nuevas de public (mismo problema que motivó 197_revoke_execute_public_secdef y varias más del historial). Se revoca explícito para dejar la función accesible solo por service_role, como el resto del catálogo de tools del asistente.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
