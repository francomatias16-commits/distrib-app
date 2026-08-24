-- DB: fn_reset_demo_cron fallaba porque jsonb_populate_recordset intenta
-- convertir números JSON como 60.000 directamente a integer. El modelo stock
-- usa integer, por lo que normalizamos solo valores numéricamente enteros antes
-- de invocar el reset genérico.
CREATE OR REPLACE FUNCTION public.fn_reset_demo_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_col record;
  v_table_data jsonb;
  v_normalized jsonb;
BEGIN
  v_empresa_id := (SELECT id FROM public.empresas WHERE es_demo = true LIMIT 1);
  IF v_empresa_id IS NULL THEN
    RAISE NOTICE 'fn_reset_demo_cron: no hay ninguna empresa demo — nada que resetear';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.demo_snapshots WHERE empresa_id = v_empresa_id) THEN
    PERFORM public.fn_snapshot_demo_v2(v_empresa_id);
    RETURN;
  END IF;

  -- jsonb_populate_recordset rechaza `3.000` para integer aunque el valor
  -- sea matemáticamente entero. Normalizamos todas las columnas enteras de
  -- todas las tablas presentes en el snapshot, no solo stock.
  UPDATE public.demo_snapshots
     SET datos = datos
   WHERE empresa_id = v_empresa_id;

  FOR v_col IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('smallint', 'integer', 'bigint')
  LOOP
    v_table_data := (SELECT datos FROM public.demo_snapshots WHERE empresa_id = v_empresa_id)->v_col.table_name;
    IF jsonb_typeof(v_table_data) = 'array' THEN
      SELECT COALESCE(jsonb_agg(
        CASE
          WHEN elem ? v_col.column_name
           AND (elem->>v_col.column_name) ~ '^-?[0-9]+(\.[0-9]+)?$'
          THEN jsonb_set(
            elem,
            ARRAY[v_col.column_name],
            to_jsonb(trunc((elem->>v_col.column_name)::numeric)::bigint),
            true
          )
          ELSE elem
        END
      ), '[]'::jsonb)
      INTO v_normalized
      FROM jsonb_array_elements(v_table_data) elem;

      UPDATE public.demo_snapshots
         SET datos = jsonb_set(datos, ARRAY[v_col.table_name], v_normalized, false)
       WHERE empresa_id = v_empresa_id;
    END IF;
  END LOOP;

  PERFORM public.fn_reset_demo_v2(v_empresa_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_reportes_stock_valorizacion()
RETURNS TABLE(
  deposito_id uuid,
  deposito_nombre text,
  cantidad_productos bigint,
  unidades numeric,
  costo_total numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    COALESCE(d.nombre, 'Sin nombre')::text,
    COUNT(*)::bigint,
    COALESCE(SUM(s.cantidad), 0)::numeric,
    COALESCE(SUM(s.cantidad * s.costo_promedio), 0)::numeric
  FROM public.stock s
  JOIN public.depositos d ON d.id = s.deposito_id
  WHERE d.empresa_id = v_empresa_id
  GROUP BY d.id, d.nombre
  ORDER BY costo_total DESC;
END;
$function$;
