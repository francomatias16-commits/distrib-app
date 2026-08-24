CREATE OR REPLACE FUNCTION public.fn_validar_tenant_turno_caja()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_empresa_caja     uuid;
  v_empresa_usuario  uuid;
BEGIN
  SELECT empresa_id INTO v_empresa_caja
  FROM cajas_pos
  WHERE id = NEW.caja_id;

  IF v_empresa_caja IS NULL THEN
    RAISE EXCEPTION 'turnos_caja.caja_id (%) no corresponde a ninguna caja existente', NEW.caja_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT empresa_id INTO v_empresa_usuario
  FROM usuarios
  WHERE id = NEW.usuario_id;

  IF v_empresa_usuario IS NULL THEN
    RAISE EXCEPTION 'turnos_caja.usuario_id (%) no corresponde a ningún usuario existente', NEW.usuario_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_empresa_caja <> v_empresa_usuario THEN
    RAISE EXCEPTION
      'Tenant inconsistente en turnos_caja: la caja % pertenece a la empresa % pero el usuario % pertenece a la empresa %',
      NEW.caja_id, v_empresa_caja, NEW.usuario_id, v_empresa_usuario
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.cerrado_forzado_por IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM usuarios
      WHERE id = NEW.cerrado_forzado_por
        AND empresa_id = v_empresa_caja
    ) THEN
      RAISE EXCEPTION
        'Tenant inconsistente en turnos_caja: cerrado_forzado_por (%) no pertenece a la empresa % de la caja',
        NEW.cerrado_forzado_por, v_empresa_caja
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validar_tenant_turno_caja ON public.turnos_caja;

CREATE TRIGGER trg_validar_tenant_turno_caja
  BEFORE INSERT OR UPDATE OF caja_id, usuario_id, cerrado_forzado_por
  ON public.turnos_caja
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_validar_tenant_turno_caja();

COMMENT ON FUNCTION public.fn_validar_tenant_turno_caja() IS
  'Defensa en profundidad (hallazgo 20/8): garantiza a nivel de DB que caja_id, usuario_id y cerrado_forzado_por de un turno pertenezcan todos a la misma empresa, incluso si el INSERT/UPDATE viene de un import o corrección manual que se salte la validación del handler de aplicación.';
