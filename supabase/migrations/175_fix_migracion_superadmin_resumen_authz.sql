-- 175_fix_migracion_superadmin_resumen_authz.sql
--
-- GAP DE SEGURIDAD encontrado al sincronizar el frontend con la migración
-- 174: migracion_superadmin_resumen() quedó SECURITY DEFINER sin ningún
-- chequeo de autorización interno (a diferencia de get_saas_panel_admin,
-- que sí valida is_saas_owner() antes de devolver nada). Como es una
-- función SQL plana sin RLS de por medio y con permisos EXECUTE por
-- default a PUBLIC (comportamiento estándar de Postgres al crear una
-- función), cualquier usuario autenticado — o incluso anónimo — podía
-- invocarla directo vía supabase-js (`sb.rpc('migracion_superadmin_resumen')`)
-- y leer sesiones de migración de TODAS las empresas (nombre de empresa,
-- cantidad de filas, estado, fecha). No llegó a explotarse porque nada del
-- frontend la llamaba todavía — se detectó al escribir esa parte ahora.
--
-- Fix: mismo patrón que get_saas_panel_admin — se convierte a plpgsql y
-- se agrega el guard is_saas_owner() al principio, antes de tocar
-- migracion_sesiones/empresas.
CREATE OR REPLACE FUNCTION public.migracion_superadmin_resumen()
RETURNS TABLE (
  empresa_id      UUID,
  empresa_nombre  TEXT,
  sesion_id       UUID,
  entidad         TEXT,
  estado          TEXT,
  total_filas     INT,
  filas_validas   INT,
  filas_con_error INT,
  created_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_saas_owner() THEN
    RAISE EXCEPTION 'Acceso no autorizado al panel de migraciones';
  END IF;

  RETURN QUERY
  SELECT ms.empresa_id, e.nombre, ms.id, ms.entidad, ms.estado,
         ms.total_filas, ms.filas_validas, ms.filas_con_error, ms.created_at
    FROM migracion_sesiones ms
    JOIN empresas e ON e.id = ms.empresa_id
   WHERE ms.estado IN ('error', 'confirmando', 'mapeado', 'validado', 'subido')
      OR ms.created_at > now() - interval '14 days'
   ORDER BY
     CASE WHEN ms.estado = 'error' THEN 0 ELSE 1 END,
     ms.created_at DESC
   LIMIT 300;
END;
$function$;
