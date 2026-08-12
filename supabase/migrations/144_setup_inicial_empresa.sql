-- =============================================================
-- MIGRACIÓN 108: setup_inicial_empresa — RPC de onboarding
-- v125 | Auditoría 2026-06-25
-- NOTA: RPC encontrado ya existente en producción pero ausente en repo.
-- Se registra aquí para sincronizar. Si ya existe en DB, el CREATE OR REPLACE
-- es idempotente.
-- =============================================================
CREATE OR REPLACE FUNCTION public.setup_inicial_empresa(
  p_empresa_nombre    text,
  p_empresa_cuit      text,
  p_empresa_domicilio text DEFAULT NULL,
  p_empresa_telefono  text DEFAULT NULL,
  p_empresa_email     text DEFAULT NULL,
  p_usuario_id        uuid DEFAULT NULL,
  p_usuario_nombre    text DEFAULT NULL,
  p_usuario_email     text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_empresa_id UUID; v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.empresas;
  IF v_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'El sistema ya fue inicializado. Contactá al administrador.');
  END IF;
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
    RETURN jsonb_build_object('ok', false, 'error', 'El nombre del dueño es requerido.');
  END IF;
  IF p_usuario_email IS NULL OR trim(p_usuario_email) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El email del dueño es requerido.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_usuario_id) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'El usuario no existe en el sistema de autenticación.');
  END IF;
  INSERT INTO public.empresas (nombre, cuit, domicilio, telefono, email, activa)
  VALUES (trim(p_empresa_nombre), trim(p_empresa_cuit),
          p_empresa_domicilio, p_empresa_telefono, p_empresa_email, true)
  RETURNING id INTO v_empresa_id;
  INSERT INTO public.usuarios (id, empresa_id, nombre, email, rol, activo)
  VALUES (p_usuario_id, v_empresa_id, trim(p_usuario_nombre),
          trim(p_usuario_email), 'dueno', true);
  INSERT INTO public.depositos (empresa_id, nombre, es_principal)
  VALUES (v_empresa_id, 'Depósito Principal', true);
  INSERT INTO public.listas_precios (empresa_id, nombre, es_default)
  VALUES (v_empresa_id, 'Lista General', true);
  INSERT INTO public.contadores_empresa (empresa_id, tipo, ultimo_numero)
  VALUES (v_empresa_id, 'factura_b', 0),
         (v_empresa_id, 'remito', 0),
         (v_empresa_id, 'presupuesto', 0)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'empresa_id', v_empresa_id,
    'mensaje', 'Sistema inicializado correctamente.');
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El CUIT ya está registrado.');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Error interno: ' || SQLERRM);
END;
$$;
