-- 297_fix_etapa10_h4_canjear_recompensa_puntos_minimos.sql
--
-- Auditoría de módulos, Etapa 10 (Fidelización) — Hallazgo 4.
-- Ya aplicada directo en producción (jgiquzjwoedmzwqgzubr) vía Supabase
-- MCP. Este archivo la deja versionada en el repo.
--
-- programas_fidelizacion.puntos_minimos_canje existe desde la migración
-- original (010_etapa7_fidelizacion.sql), el admin lo configura desde
-- /admin/fidelizacion.html (frontend/admin/js/fidelizacion.js) creyendo
-- que fija un piso general de puntos para poder canjear, y la ayuda al
-- usuario (docs/ayuda/fidelizacion-puntos-y-recompensas.md) lo promete
-- explícitamente ("el sistema exige un mínimo de puntos configurado para
-- poder canjear"). canjear_recompensa() nunca lo leía: solo validaba que
-- el saldo alcance el costo puntual de ESA recompensa. Si una recompensa
-- puntual cuesta menos que el mínimo configurado, el mínimo no se
-- respetaba.
CREATE OR REPLACE FUNCTION public.canjear_recompensa(
  p_empresa_id  uuid,
  p_cliente_id  uuid,
  p_recompensa_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recompensa      RECORD;
  v_saldo_actual    NUMERIC;
  v_saldo_nuevo     NUMERIC;
  v_canje_id        uuid;
  v_puntos_minimos  INT;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT * INTO v_recompensa
    FROM public.recompensas
   WHERE id = p_recompensa_id
     AND empresa_id = p_empresa_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La recompensa no existe';
  END IF;

  IF NOT v_recompensa.activa THEN
    RAISE EXCEPTION 'La recompensa no está activa';
  END IF;

  IF v_recompensa.fecha_inicio IS NOT NULL AND v_recompensa.fecha_inicio > CURRENT_DATE THEN
    RAISE EXCEPTION 'La recompensa todavía no está disponible';
  END IF;

  IF v_recompensa.fecha_fin IS NOT NULL AND v_recompensa.fecha_fin < CURRENT_DATE THEN
    RAISE EXCEPTION 'La recompensa ya venció';
  END IF;

  IF v_recompensa.cantidad_disponible IS NOT NULL
     AND (v_recompensa.cantidad_disponible - COALESCE(v_recompensa.cantidad_canjeada, 0)) <= 0 THEN
    RAISE EXCEPTION 'La recompensa se agotó';
  END IF;

  SELECT COALESCE(puntos_disponibles, 0) INTO v_saldo_actual
    FROM public.saldo_puntos
   WHERE cliente_id = p_cliente_id
     AND empresa_id = p_empresa_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cliente no tiene saldo de puntos';
  END IF;

  IF v_saldo_actual < v_recompensa.puntos_requeridos THEN
    RAISE EXCEPTION 'Saldo insuficiente (disponible: %, requerido: %)', v_saldo_actual, v_recompensa.puntos_requeridos;
  END IF;

  -- FIX Hallazgo 4: aplicar el piso general del programa, además del
  -- costo puntual de la recompensa.
  SELECT puntos_minimos_canje INTO v_puntos_minimos
    FROM public.programas_fidelizacion
   WHERE empresa_id = p_empresa_id AND activo = TRUE;

  IF v_puntos_minimos IS NOT NULL AND v_saldo_actual < v_puntos_minimos THEN
    RAISE EXCEPTION 'Necesitás al menos % puntos para poder canjear (disponible: %)', v_puntos_minimos, v_saldo_actual;
  END IF;

  v_saldo_nuevo := v_saldo_actual - v_recompensa.puntos_requeridos;

  UPDATE public.saldo_puntos
     SET puntos_disponibles = v_saldo_nuevo,
         puntos_canjeados   = COALESCE(puntos_canjeados, 0) + v_recompensa.puntos_requeridos,
         ultimo_movimiento  = now()
   WHERE cliente_id = p_cliente_id
     AND empresa_id = p_empresa_id;

  UPDATE public.recompensas
     SET cantidad_canjeada = COALESCE(cantidad_canjeada, 0) + 1
   WHERE id = p_recompensa_id;

  INSERT INTO public.canjes_recompensas
         (cliente_id, recompensa_id, empresa_id, puntos_gastados, estado)
  VALUES (p_cliente_id, p_recompensa_id, p_empresa_id, v_recompensa.puntos_requeridos, 'pendiente')
  RETURNING id INTO v_canje_id;

  INSERT INTO public.movimientos_puntos
         (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
  VALUES (p_cliente_id, p_empresa_id, 'canje', v_recompensa.puntos_requeridos,
          'Canje: ' || v_recompensa.nombre, v_canje_id);

  RETURN json_build_object(
    'ok', true,
    'canje_id', v_canje_id,
    'saldo_nuevo', v_saldo_nuevo,
    'recompensa_nombre', v_recompensa.nombre
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.canjear_recompensa(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canjear_recompensa(uuid, uuid, uuid) TO service_role;
