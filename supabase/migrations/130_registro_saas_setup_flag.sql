-- 130_registro_saas_setup_flag.sql
-- Actualiza registrar_empresa_saas para que nuevas empresas tengan setup_completado = false

CREATE OR REPLACE FUNCTION public.registrar_empresa_saas(
  p_empresa_nombre    TEXT,
  p_empresa_cuit      TEXT,
  p_empresa_domicilio TEXT DEFAULT NULL,
  p_empresa_telefono  TEXT DEFAULT NULL,
  p_empresa_email     TEXT DEFAULT NULL,
  p_usuario_id        UUID DEFAULT NULL,
  p_usuario_nombre    TEXT DEFAULT NULL,
  p_usuario_email     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_empresa_id UUID;
BEGIN
  IF p_empresa_nombre IS NULL OR trim(p_empresa_nombre) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El nombre de la empresa es requerido.');
  END IF;
  IF p_empresa_cuit IS NULL OR trim(p_empresa_cuit) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El CUIT es requerido.');
  END IF;
  IF p_usuario_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ID de usuario requerido.');
  END IF;
  IF p_usuario_nombre IS NULL OR trim(p_usuario_nombre) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El nombre del responsable es requerido.');
  END IF;
  IF p_usuario_email IS NULL OR trim(p_usuario_email) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El email es requerido.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_usuario_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El usuario no existe en el sistema de autenticación.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.empresas WHERE cuit = trim(p_empresa_cuit)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Ya existe una cuenta registrada con ese CUIT.');
  END IF;

  INSERT INTO public.empresas (
    nombre, cuit, domicilio, telefono, email, activa, setup_completado
  )
  VALUES (
    trim(p_empresa_nombre),
    trim(p_empresa_cuit),
    p_empresa_domicilio,
    p_empresa_telefono,
    p_empresa_email,
    true,
    false
  )
  RETURNING id INTO v_empresa_id;

  INSERT INTO public.usuarios (id, empresa_id, nombre, email, rol, activo)
  VALUES (p_usuario_id, v_empresa_id, trim(p_usuario_nombre), trim(p_usuario_email), 'admin', true);

  INSERT INTO public.depositos (empresa_id, nombre, es_principal)
  VALUES (v_empresa_id, 'Depósito Principal', true);

  INSERT INTO public.listas_precios (empresa_id, nombre, es_default)
  VALUES (v_empresa_id, 'Lista General', true);

  INSERT INTO public.contadores_empresa (empresa_id, tipo, ultimo_numero)
  VALUES
    (v_empresa_id, 'factura_b', 0),
    (v_empresa_id, 'remito', 0),
    (v_empresa_id, 'presupuesto', 0)
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'ok',         true,
    'empresa_id', v_empresa_id,
    'trial_fin',  (SELECT saas_trial_fin::text FROM public.empresas WHERE id = v_empresa_id),
    'mensaje',    'Empresa registrada. Tenés 30 días de prueba gratuita.'
  );

EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El CUIT ya está registrado en el sistema.');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Error interno: ' || SQLERRM);
END;
$$;
