-- 277_fix_search_path_empresa_whatsapp_trigger.sql
--
-- Contexto: get_advisors(security) detectó search_path mutable en
-- set_empresa_whatsapp_actualizado_en() (trigger de empresa_whatsapp,
-- migración 272). Mismo fix ya aplicado a otras funciones del proyecto
-- (ver 107/108): fijar search_path evita que un search_path manipulado
-- en la sesión haga resolver algún objeto sin calificar contra un schema
-- distinto al esperado.

CREATE OR REPLACE FUNCTION public.set_empresa_whatsapp_actualizado_en()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '277_fix_search_path_empresa_whatsapp_trigger.sql', '277', 'claude-session', 'Fix search_path mutable detectado por get_advisors en trigger de empresa_whatsapp')
ON CONFLICT DO NOTHING;
