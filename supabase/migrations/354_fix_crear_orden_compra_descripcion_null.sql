-- =============================================================
-- 354_fix_crear_orden_compra_descripcion_null.sql
-- Bug: crear_orden_compra() (mig. 192) inserta ordenes_compra_items
-- sin completar la columna `descripcion` (solo guarda producto_id).
-- stock-auto.js sí la completa para las OC auto-generadas, por eso
-- el portal proveedor mostraba "—" únicamente en las OC creadas a
-- mano desde el admin (ej. OC-00185). Detectado por Ruben en el
-- portal de proveedor — ver AUDITORIA_2026.
--
-- Fix:
--  1) crear_orden_compra ahora completa descripcion = productos.nombre
--     al momento de insertar (igual que stock-auto.js).
--  2) Backfill de los items históricos con descripcion NULL, tomando
--     el nombre actual del producto.
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

  INSERT INTO ordenes_compra_items (orden_id, producto_id, descripcion, cantidad, precio_costo, precio_unitario, subtotal, iva_pct)
  SELECT v_oc_id,
         (elem->>'producto_id')::UUID,
         p.nombre,
         (elem->>'cantidad')::NUMERIC,
         (elem->>'precio_costo')::NUMERIC,
         (elem->>'precio_costo')::NUMERIC,
         (elem->>'cantidad')::NUMERIC * (elem->>'precio_costo')::NUMERIC,
         COALESCE((elem->>'iva_pct')::NUMERIC, 21)
  FROM jsonb_array_elements(p_items) AS elem
  LEFT JOIN productos p ON p.id = (elem->>'producto_id')::UUID;

  RETURN jsonb_build_object('ok', true, 'orden_id', v_oc_id, 'numero', v_numero);
END $function$;

-- Backfill: OCs manuales históricas con descripcion NULL (p.ej. OC-00185),
-- completando con el nombre actual del producto.
UPDATE ordenes_compra_items oci
SET descripcion = p.nombre
FROM productos p
WHERE oci.producto_id = p.id
  AND oci.descripcion IS NULL;
