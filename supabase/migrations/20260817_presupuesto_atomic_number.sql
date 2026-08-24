-- PED-023/PED-024: numeración y persistencia atómicas de presupuestos.
CREATE OR REPLACE FUNCTION public.crear_presupuesto_con_items(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_vendedor_id uuid,
  p_estado text,
  p_subtotal numeric,
  p_total numeric,
  p_notas text,
  p_fecha_vencimiento timestamptz,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_numero text;
  v_next integer;
  v_presupuesto_id uuid;
  v_item jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'El presupuesto necesita al menos un ítem';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_empresa_id::text || ':presupuesto', 0));

  SELECT COALESCE(MAX((substring(numero FROM 'PRES-([0-9]+)'))::integer), 0) + 1
    INTO v_next
    FROM public.presupuestos
   WHERE empresa_id = p_empresa_id
     AND numero ~ '^PRES-[0-9]+$';
  v_numero := 'PRES-' || lpad(v_next::text, 5, '0');

  INSERT INTO public.presupuestos (
    empresa_id, cliente_id, vendedor_id, numero, estado,
    subtotal, total, notas, fecha_vencimiento
  ) VALUES (
    p_empresa_id, p_cliente_id, p_vendedor_id, v_numero, p_estado,
    p_subtotal, p_total, p_notas, p_fecha_vencimiento
  ) RETURNING id INTO v_presupuesto_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.presupuesto_items (
      presupuesto_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_presupuesto_id,
      (v_item->>'producto_id')::uuid,
      (v_item->>'cantidad')::numeric,
      (v_item->>'precio_unitario')::numeric,
      COALESCE((v_item->>'descuento_pct')::numeric, 0),
      (v_item->>'subtotal')::numeric
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'presupuesto_id', v_presupuesto_id,
    'numero', v_numero,
    'total', p_total
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.crear_presupuesto_con_items(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz,jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.crear_presupuesto_con_items(uuid,uuid,uuid,text,numeric,numeric,text,timestamptz,jsonb) TO service_role;
