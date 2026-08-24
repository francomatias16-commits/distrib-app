-- ============================================================================
-- Fix: cruce OC↔Factura mostraba "No encontrado" en TODOS los ítems cuando
-- la factura simplemente no tenía ítems cargados (facturas_proveedor_items
-- vacío para esa factura_id — ej. facturas creadas solo con totales, sin
-- pasar por la pestaña "Ítems" ni por "Importar desde OC").
--
-- El matching en sí (por producto_id o similarity() de descripción) funciona
-- bien: si no hay ningún ítem de factura contra el cual comparar, cada ítem
-- de la OC necesariamente da "no encontrado". No es un bug de matching, pero
-- la UI no distinguía ese caso de una discrepancia real, así que el usuario
-- veía la tabla entera en rojo sin entender por qué.
--
-- Este fix agrega 'items_factura_count' al resumen para que el frontend
-- pueda mostrar un mensaje claro ("esta factura no tiene ítems cargados")
-- en lugar de una lista de discrepancias falsas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.conciliar_oc_factura(
  p_orden_id   uuid,
  p_factura_id uuid,
  p_umbral_pct numeric DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_items    jsonb := '[]'::jsonb;
  v_disc     jsonb := '[]'::jsonb;
  v_oc_item  record;
  v_fac_item jsonb;
  v_cant_fac   numeric;
  v_precio_fac numeric;
  v_diff_cant  numeric;
  v_diff_prec  numeric;
  v_alerta     boolean;
  v_items_factura_count int;
BEGIN
  SELECT count(*) INTO v_items_factura_count
  FROM public.facturas_proveedor_items
  WHERE factura_id = p_factura_id;

  -- Iterar cada ítem de la OC (se mantiene aunque la factura no tenga
  -- ítems cargados, para que el usuario vea igual qué esperaba la OC;
  -- el frontend usa 'sin_items_factura' del resumen para no pintar todo
  -- de rojo como si fueran discrepancias reales).
  FOR v_oc_item IN
    SELECT
      oci.id,
      oci.producto_id,
      oci.descripcion,
      oci.cantidad        AS cant_oc,
      oci.precio_unitario AS precio_oc,
      p.nombre            AS producto_nombre,
      p.codigo            AS producto_codigo
    FROM public.ordenes_compra_items oci
    LEFT JOIN public.productos p ON p.id = oci.producto_id
    WHERE oci.orden_id = p_orden_id
  LOOP
    -- Buscar ítem equivalente en la factura (por producto_id o similaridad de descripción)
    SELECT elem INTO v_fac_item
    FROM jsonb_array_elements(
      (SELECT jsonb_agg(
          jsonb_build_object(
            'producto_id',     fpi.producto_id,
            'descripcion',     fpi.descripcion,
            'cantidad',        fpi.cantidad,
            'precio_unitario', fpi.precio_unitario
          )
        )
        FROM public.facturas_proveedor_items fpi
        WHERE fpi.factura_id = p_factura_id
      )
    ) AS elem
    WHERE
      (v_oc_item.producto_id IS NOT NULL AND (elem->>'producto_id')::uuid = v_oc_item.producto_id)
      OR
      (similarity(LOWER(elem->>'descripcion'), LOWER(COALESCE(v_oc_item.producto_nombre, v_oc_item.descripcion))) > 0.4)
    ORDER BY
      CASE WHEN (elem->>'producto_id')::uuid = v_oc_item.producto_id THEN 0 ELSE 1 END,
      similarity(LOWER(elem->>'descripcion'), LOWER(COALESCE(v_oc_item.producto_nombre, v_oc_item.descripcion))) DESC
    LIMIT 1;

    v_cant_fac   := COALESCE((v_fac_item->>'cantidad')::numeric, NULL);
    v_precio_fac := COALESCE((v_fac_item->>'precio_unitario')::numeric, NULL);

    v_diff_cant := CASE
      WHEN v_cant_fac IS NULL OR v_oc_item.cant_oc = 0 THEN NULL
      ELSE ABS(v_cant_fac - v_oc_item.cant_oc) / v_oc_item.cant_oc * 100
    END;

    v_diff_prec := CASE
      WHEN v_precio_fac IS NULL OR v_oc_item.precio_oc = 0 THEN NULL
      ELSE ABS(v_precio_fac - v_oc_item.precio_oc) / v_oc_item.precio_oc * 100
    END;

    v_alerta := (
      v_cant_fac IS NULL OR
      COALESCE(v_diff_cant, 0) > p_umbral_pct OR
      COALESCE(v_diff_prec, 0) > p_umbral_pct
    );

    v_items := v_items || jsonb_build_object(
      'oc_item_id',      v_oc_item.id,
      'producto_id',     v_oc_item.producto_id,
      'nombre',          v_oc_item.producto_nombre,
      'descripcion',     v_oc_item.descripcion,
      -- OC
      'cant_oc',         v_oc_item.cant_oc,
      'precio_oc',       v_oc_item.precio_oc,
      'subtotal_oc',     ROUND(v_oc_item.cant_oc * v_oc_item.precio_oc, 2),
      -- Factura
      'cant_fac',        v_cant_fac,
      'precio_fac',      v_precio_fac,
      'subtotal_fac',    CASE WHEN v_cant_fac IS NOT NULL AND v_precio_fac IS NOT NULL
                           THEN ROUND(v_cant_fac * v_precio_fac, 2) ELSE NULL END,
      -- Diferencias
      'diff_cant_pct',   ROUND(COALESCE(v_diff_cant, 0)::numeric, 1),
      'diff_precio_pct', ROUND(COALESCE(v_diff_prec, 0)::numeric, 1),
      'alerta',          v_alerta,
      'match',           (v_fac_item IS NOT NULL)
    );

    IF v_alerta THEN
      v_disc := v_disc || jsonb_build_array(jsonb_build_object(
        'nombre',          v_oc_item.producto_nombre,
        'cant_oc',         v_oc_item.cant_oc,
        'cant_fac',        v_cant_fac,
        'precio_oc',       v_oc_item.precio_oc,
        'precio_fac',      v_precio_fac,
        'diff_cant_pct',   ROUND(COALESCE(v_diff_cant, 0)::numeric, 1),
        'diff_precio_pct', ROUND(COALESCE(v_diff_prec, 0)::numeric, 1),
        'tipo',            CASE
          WHEN v_cant_fac IS NULL      THEN 'no_encontrado'
          WHEN COALESCE(v_diff_cant,0) > p_umbral_pct THEN 'cantidad'
          WHEN COALESCE(v_diff_prec,0) > p_umbral_pct THEN 'precio'
          ELSE 'ambos'
        END
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',            true,
    'items',         v_items,
    'discrepancias', v_disc,
    'resumen', jsonb_build_object(
      'total_items',      jsonb_array_length(v_items),
      'items_ok',         jsonb_array_length(v_items) - jsonb_array_length(v_disc),
      'items_con_alerta', jsonb_array_length(v_disc),
      'umbral_pct',       p_umbral_pct,
      'items_factura_count', v_items_factura_count,
      'sin_items_factura',   (v_items_factura_count = 0)
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Los GRANT/REVOKE de las migraciones 135/136 ya dejaron el EXECUTE limitado a
-- service_role; CREATE OR REPLACE no toca privilegios, así que no hace falta
-- repetirlos acá.
