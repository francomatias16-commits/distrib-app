-- Auditoría 2026: cierre de funciones sensibles expuestas a anon/public.
-- Aplicar primero en el entorno de prueba autorizado; no usar en producción real.

REVOKE EXECUTE ON FUNCTION public.arca_lock_adquirir(uuid, integer, integer, integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.arca_lock_adquirir(uuid, integer, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.arca_lock_adquirir(
  p_empresa_id uuid,
  p_punto_venta integer,
  p_tipo_cbte integer,
  p_stale_seconds integer DEFAULT 90
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_token uuid := gen_random_uuid();
BEGIN
  IF auth.role() <> 'service_role' AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  BEGIN
    INSERT INTO public.arca_lock_emision (empresa_id, punto_venta, tipo_cbte, locked_at, locked_token)
    VALUES (p_empresa_id, p_punto_venta, p_tipo_cbte, now(), v_token);
    RETURN v_token;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.arca_lock_emision
       SET locked_at = now(), locked_token = v_token
     WHERE empresa_id = p_empresa_id
       AND punto_venta = p_punto_venta
       AND tipo_cbte = p_tipo_cbte
       AND locked_at < now() - (p_stale_seconds || ' seconds')::interval;

    IF FOUND THEN
      RETURN v_token;
    END IF;

    RETURN NULL;
  END;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.anular_nota_cta_cte(uuid, uuid, uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.anular_nota_cta_cte(uuid, uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.anular_nota_cta_cte(
  p_empresa_id uuid,
  p_id uuid,
  p_usuario_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.cta_cte%ROWTYPE;
  v_rol public.rol_usuario;
BEGIN
  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_usuario_id) THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  SELECT rol INTO v_rol FROM public.usuarios WHERE id = p_usuario_id AND empresa_id = p_empresa_id;
  IF v_rol IS NULL OR v_rol NOT IN ('dueno', 'admin', 'contador') THEN
    RETURN json_build_object('ok', false, 'error', 'Sin permisos para anular notas');
  END IF;

  SELECT * INTO v_row FROM public.cta_cte WHERE id = p_id AND empresa_id = p_empresa_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Nota no encontrada');
  END IF;

  IF v_row.tipo NOT IN ('nota_credito', 'nota_debito') THEN
    RETURN json_build_object('ok', false, 'error', 'Este movimiento no es una nota de crédito/débito');
  END IF;

  IF v_row.anulado THEN
    RETURN json_build_object('ok', false, 'error', 'Esta nota ya está anulada');
  END IF;

  UPDATE public.cta_cte
     SET anulado = true,
         anulado_motivo = p_motivo,
         anulado_at = now(),
         anulado_por = p_usuario_id
   WHERE id = p_id
     AND empresa_id = p_empresa_id;

  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_conteos_stock_kpis(uuid, text, date, date) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.fn_conteos_stock_kpis(uuid, text, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_conteos_stock_kpis(
  p_deposito_id uuid DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_desde date DEFAULT NULL,
  p_hasta date DEFAULT NULL
)
RETURNS TABLE(total_conteos bigint, con_diferencia bigint, diferencia_acumulada numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  IF auth.role() <> 'service_role' AND get_empresa_id() IS NULL THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  IF NOT (get_rol_usuario() IN ('admin', 'dueno', 'depositero')) THEN
    RAISE EXCEPTION 'Sin autorización';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE cs.diferencia <> 0)::bigint,
    COALESCE(SUM(cs.diferencia), 0)::numeric
  FROM public.conteos_stock cs
  WHERE cs.empresa_id = get_empresa_id()
    AND (p_deposito_id IS NULL OR cs.deposito_id = p_deposito_id)
    AND (p_motivo IS NULL OR cs.motivo = p_motivo)
    AND (p_desde IS NULL OR cs.created_at >= p_desde::timestamptz)
    AND (p_hasta IS NULL OR cs.created_at < (p_hasta + 1)::timestamptz);
END;
$function$;
