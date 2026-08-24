-- MIGRACIÓN 457: fix migracion_mapear_bulk no marcaba mapeado_en
--
-- Contexto: en producción hay una migración "fix_sec010_lote1_resolvers_y_mapear_bulk"
-- (aplicada 2026-07-11) que NO está guardada en este repo (falta el .sql local
-- — recomendado hacer `supabase db pull` para traer también esa y cualquier
-- otra que se haya aplicado directo sin commitear). Esa migración le agregó a
-- migracion_mapear_bulk el chequeo de tenant (auth.role() <> 'service_role' Y
-- empresa distinta → RAISE EXCEPTION), pero reescribió el cuerpo a partir de
-- la versión de la migración 152 (anterior a que 167 agregara la columna
-- mapeado_en), así que el UPDATE dejó de asignar mapeado_en = now().
--
-- Efecto en producción: obtenerLoteSinMapear() siempre encontraba las mismas
-- filas "sin mapear" (mapeado_en nunca se seteaba), el loop de mapeo del
-- frontend (mapearHastaTerminar / confirmarMapeo) nunca veía hay_mas=false y
-- reprocesaba el mismo lote hasta pegar contra el techo de 500 vueltas —con
-- archivos de ~1000 filas esto tardaba 20-30+ minutos antes de tirar el error
-- "El mapeo no terminó luego de muchos lotes".
--
-- Este fix solo reincorpora "mapeado_en = now()" al SET; el chequeo de
-- tenant y el resto del cuerpo quedan exactamente como los dejó sec010.
-- Ya aplicado en producción (proyecto jgiquzjwoedmzwqgzubr) el 2026-08-13.
CREATE OR REPLACE FUNCTION public.migracion_mapear_bulk(p_sesion_id uuid, p_filas jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_sesion uuid;
  v_count int;
BEGIN
  SELECT empresa_id INTO v_empresa_sesion
    FROM public.migracion_sesiones WHERE id = p_sesion_id;

  IF v_empresa_sesion IS NULL THEN
    RAISE EXCEPTION 'Sesion de migracion no encontrada';
  END IF;

  IF auth.role() <> 'service_role' AND v_empresa_sesion IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

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
  SELECT COUNT(*)::INT INTO v_count FROM actualizadas;

  RETURN v_count;
END;
$function$;
