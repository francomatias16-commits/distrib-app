-- 440b: mismo hardening de search_path que el resto de las funciones del
-- proyecto (ver serie de migraciones fix_search_path_*). El advisor de
-- seguridad marcó banco_codigos_producto_set_actualizado_en() con
-- search_path mutable apenas se aplicó la 440 — se corrige acá antes de
-- que quede como deuda técnica.
CREATE OR REPLACE FUNCTION public.banco_codigos_producto_set_actualizado_en()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$function$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '440b_fix_search_path_banco_codigos_trigger.sql', '440b', 'claude-session',
        'Fix del linter de seguridad: search_path mutable en banco_codigos_producto_set_actualizado_en (mismo patrón que el resto de las funciones del proyecto).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
