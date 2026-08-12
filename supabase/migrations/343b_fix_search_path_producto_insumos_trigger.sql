-- 343b_fix_search_path_producto_insumos_trigger.sql
--
-- El advisor de seguridad de Supabase marcó fn_producto_insumos_touch_updated_at
-- (creada en la 343) con "Function Search Path Mutable" porque no tenía
-- SET search_path fijo. Mismo patrón de hardening que el resto de las
-- funciones del proyecto (ver 107_functions_search_path_fix, etc.).
--
-- Aplicado directamente en producción el 2026-07-16.

CREATE OR REPLACE FUNCTION public.fn_producto_insumos_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $trig$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$trig$;
