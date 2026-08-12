-- 129_setup_wizard_flag.sql
-- Agrega flag setup_completado a empresas para redirigir al wizard en primer login.

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS setup_completado BOOLEAN NOT NULL DEFAULT false;

-- Las empresas existentes ya tienen setup hecho
UPDATE public.empresas SET setup_completado = true WHERE setup_completado = false;

CREATE OR REPLACE FUNCTION public.marcar_setup_completado()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_empresa_id UUID;
BEGIN
  SELECT empresa_id INTO v_empresa_id
  FROM public.usuarios
  WHERE id = auth.uid() AND activo = true;

  IF v_empresa_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Usuario no encontrado');
  END IF;

  UPDATE public.empresas
  SET setup_completado = true
  WHERE id = v_empresa_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON COLUMN public.empresas.setup_completado IS 'false = empresa recién registrada, debe pasar por el wizard de setup';
COMMENT ON FUNCTION public.marcar_setup_completado IS 'Marca el wizard de setup como completado para la empresa del usuario autenticado';
