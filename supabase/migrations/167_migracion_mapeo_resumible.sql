ALTER TABLE public.migracion_staging_rows
  ADD COLUMN IF NOT EXISTS mapeado_en TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_migracion_staging_sin_mapear
  ON public.migracion_staging_rows (sesion_id, fila_numero)
  WHERE mapeado_en IS NULL;

CREATE OR REPLACE FUNCTION public.migracion_mapear_bulk(p_sesion_id uuid, p_filas jsonb)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH actualizadas AS (
    UPDATE migracion_staging_rows t
       SET datos_mapeados        = f.datos_mapeados,
           es_valida              = f.es_valida,
           errores                = f.errores,
           accion                 = f.accion,
           entidad_existente_id   = f.entidad_existente_id,
           mapeado_en             = now()
      FROM jsonb_to_recordset(p_filas) AS f(
             id UUID, datos_mapeados JSONB, es_valida BOOLEAN,
             errores JSONB, accion TEXT, entidad_existente_id UUID
           )
     WHERE t.id = f.id AND t.sesion_id = p_sesion_id
    RETURNING t.id
  )
  SELECT COUNT(*)::INT FROM actualizadas;
$function$;
