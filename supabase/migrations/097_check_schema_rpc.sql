
-- migracion_v51_check_schema_rpc.sql
--
-- Crea funciones RPC para que service_role pueda leer information_schema
-- (necesario para check-schema.js, ya que PostgREST no lo expone)
--
-- Para desplegar:
-- psql -h localhost -p 5432 -U postgres -d postgres -f migracion_v51_check_schema_rpc.sql

-- Función para obtener columnas de tablas públicas
CREATE OR REPLACE FUNCTION public.check_schema_columns()
RETURNS TABLE (
    table_name text,
    column_name text,
    data_type text,
    is_nullable text,
    column_default text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.table_name::text,
        c.column_name::text,
        c.data_type::text,
        c.is_nullable::text,
        c.column_default::text
    FROM
        information_schema.columns c
    WHERE
        c.table_schema = 'public'
    ORDER BY
        c.table_name, c.ordinal_position;
END;
$$;

-- Función para obtener nombres de funciones (RPCs) públicas
CREATE OR REPLACE FUNCTION public.check_schema_functions()
RETURNS TABLE (
    routine_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.routine_name::text
    FROM
        information_schema.routines r
    WHERE
        r.routine_schema = 'public' AND r.routine_type = 'FUNCTION'
    ORDER BY
        r.routine_name;
END;
$$;

-- Otorgar permisos a service_role para ejecutar estas funciones
GRANT EXECUTE ON FUNCTION public.check_schema_columns() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_schema_functions() TO service_role;

-- Revocar permisos a anon y authenticated (si se hubieran dado por error)
REVOKE EXECUTE ON FUNCTION public.check_schema_columns() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_schema_functions() FROM anon, authenticated;
