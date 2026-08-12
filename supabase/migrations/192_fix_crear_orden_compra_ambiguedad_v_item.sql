-- =============================================================
-- 192_fix_crear_orden_compra_ambiguedad_v_item.sql
-- Bug CRÍTICO: crear_orden_compra() nunca funcionó — ambigüedad de
-- variable (v_item colisionaba con una columna/alias del mismo
-- nombre en el contexto de ejecución de PL/pgSQL). El endpoint
-- real "Nueva OC" del admin estaba roto en cualquier uso desde que
-- existe la función. Detectado recién en el stress test de
-- volumen de Fase 13. Ver nota de reconstrucción en 189.
-- =============================================================

CREATE OR REPLACE FUNCTION public.crear_orden_compra(p_empresa_id uuid, p_proveedor_id uuid, p_fecha_esperada date, p_notas text, p_created_by uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_numero TEXT;
  v_oc_id  UUID;
  v_item   JSONB;
  v_sub    NUMERIC := 0;
  v_iva    NUMERIC := 0;
  v_it_sub NUMERIC;
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  v_numero := siguiente_numero_comprobante(p_empresa_id, 'OC');

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_it_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_costo')::NUMERIC;
    v_sub    := v_sub + v_it_sub;
    v_iva    := v_iva + v_it_sub * COALESCE((v_item->>'iva_pct')::NUMERIC, 21) / 100;
  END LOOP;

  INSERT INTO ordenes_compra (
    empresa_id, proveedor_id, fecha_esperada, notas, created_by,
    numero, subtotal, iva_total, total
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_fecha_esperada, p_notas, p_created_by,
    v_numero, v_sub, v_iva, v_sub + v_iva
  ) RETURNING id INTO v_oc_id;

  INSERT INTO ordenes_compra_items (orden_id, producto_id, cantidad, precio_costo, precio_unitario, subtotal, iva_pct)
  SELECT v_oc_id,
         (elem->>'producto_id')::UUID,
         (elem->>'cantidad')::NUMERIC,
         (elem->>'precio_costo')::NUMERIC,
         (elem->>'precio_costo')::NUMERIC,
         (elem->>'cantidad')::NUMERIC * (elem->>'precio_costo')::NUMERIC,
         COALESCE((elem->>'iva_pct')::NUMERIC, 21)
  FROM jsonb_array_elements(p_items) AS elem;

  RETURN jsonb_build_object('ok', true, 'orden_id', v_oc_id, 'numero', v_numero);
END $function$
