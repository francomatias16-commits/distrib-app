-- FAC-002/FAC-003: persistencia atómica e idempotente de una NC con CAE.
CREATE OR REPLACE FUNCTION public.persistir_nc_y_anular_factura(
  p_empresa_id uuid,
  p_factura_original_id uuid,
  p_cliente_id uuid,
  p_neto numeric,
  p_iva numeric,
  p_total numeric,
  p_cae text,
  p_cae_vto date,
  p_numero text,
  p_tipo text,
  p_motivo text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_original public.facturas%ROWTYPE;
  v_nc public.facturas%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR p_empresa_id IS DISTINCT FROM public.get_empresa_id()) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT * INTO v_original
    FROM public.facturas
   WHERE id = p_factura_original_id
     AND empresa_id = p_empresa_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Factura original no encontrada';
  END IF;

  -- Si el proceso ya persistió una NC para el origen, devolverla sin insertar otra.
  SELECT * INTO v_nc
    FROM public.facturas
   WHERE factura_origen_id = p_factura_original_id
     AND empresa_id = p_empresa_id
     AND tipo IN ('NC_A', 'NC_B', 'NC_C')
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.facturas
       SET estado = 'anulada'::public.estado_factura
     WHERE id = p_factura_original_id;
    RETURN json_build_object('ok', true, 'factura_nc_id', v_nc.id, 'reutilizada', true);
  END IF;

  INSERT INTO public.facturas (
    empresa_id, cliente_id, pedido_id, tipo, neto, iva, total,
    cae, cae_vto, numero, estado, fecha_emision, factura_origen_id
  ) VALUES (
    p_empresa_id, p_cliente_id, NULL, p_tipo, p_neto, p_iva, p_total,
    p_cae, p_cae_vto, p_numero, 'emitida'::public.estado_factura,
    now(), p_factura_original_id
  )
  RETURNING * INTO v_nc;

  UPDATE public.facturas
     SET estado = 'anulada'::public.estado_factura,
         notas_error = NULL
   WHERE id = p_factura_original_id;

  RETURN json_build_object('ok', true, 'factura_nc_id', v_nc.id, 'reutilizada', false);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.persistir_nc_y_anular_factura(uuid,uuid,uuid,numeric,numeric,numeric,text,date,text,text,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.persistir_nc_y_anular_factura(uuid,uuid,uuid,numeric,numeric,numeric,text,date,text,text,text) TO service_role;
