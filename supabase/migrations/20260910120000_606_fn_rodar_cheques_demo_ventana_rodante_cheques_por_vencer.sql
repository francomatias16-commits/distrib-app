-- =============================================================
-- 606_fn_rodar_cheques_demo_ventana_rodante_cheques_por_vencer
--
-- Mismo patrón que 605 (lotes), aplicado a cheques. El cron real
-- /api/notif/cheques-por-vencer (handleChequesCron) filtraba
-- estado = 'pendiente' — estado que nunca se usa en la práctica (ver fix
-- de código en lib/repos/notif.js, CHANGELOG_v1067). El estado real para
-- "cheque en cartera, todavía sin cobrar" es 'en_cartera', tal como lo usa
-- correctamente obtenerChequesVencidos en lib/repos/admin.js.
--
-- Además, fn_redistribuir_fechas_demo no incluye la tabla cheques, así
-- que aunque se arregle el filtro de estado, los cheques "en_cartera"
-- quedaban con fecha_vto/vencimiento fija del snapshot y se alejaban de
-- la ventana de aviso con el paso de los días reales.
--
-- Este fix agrega una función de mantenimiento de demo (mismo patrón que
-- fn_redistribuir_fechas_demo / fn_rodar_lotes_trigger_demo) que re-ancla
-- los cheques en cada corrida del reset periódico (pg_cron,
-- demo_reset_periodico, cada 6h), con una garantía determinística de que
-- siempre hay al menos un cheque en_cartera dentro de la ventana de aviso
-- (DIAS_AVISO = 3 días).
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_rodar_cheques_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id         uuid;
  v_cheque_garantia_id uuid;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar cheques';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  DROP TABLE IF EXISTS corr_map_cheques;
  CREATE TEMP TABLE corr_map_cheques (entity_id uuid PRIMARY KEY, correction_days integer) ON COMMIT DROP;

  -- Mismo criterio que el resto de fn_redistribuir_fechas_demo: hash
  -- determinístico mod 216 días hacia atrás desde hoy, anclado a
  -- fecha_recepcion (o created_at si no tiene) para preservar el plazo
  -- real entre recepción y vencimiento de cada cheque.
  INSERT INTO corr_map_cheques
  SELECT id,
    (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int))
      - COALESCE(fecha_recepcion, created_at::date)
  FROM cheques WHERE empresa_id = v_empresa_id;

  UPDATE cheques c
  SET created_at      = created_at + (cm.correction_days || ' days')::interval,
      updated_at      = updated_at + (cm.correction_days || ' days')::interval,
      fecha_recepcion = CASE WHEN fecha_recepcion IS NOT NULL THEN (fecha_recepcion + (cm.correction_days||' days')::interval)::date END,
      fecha_vto       = (fecha_vto + (cm.correction_days || ' days')::interval)::date,
      vencimiento     = (vencimiento + (cm.correction_days || ' days')::interval)::date
  FROM corr_map_cheques cm WHERE c.id = cm.entity_id;

  -- GARANTÍA "el aviso de cheques siempre tiene algo que avisar": el
  -- spread por hash no asegura que algún cheque en_cartera caiga dentro
  -- de la ventana de DIAS_AVISO (3 días) del cron real de cheques por
  -- vencer. Se fuerza de forma determinística el cheque en_cartera con
  -- vencimiento más próximo a vencer en 2 días desde hoy.
  SELECT id INTO v_cheque_garantia_id
  FROM cheques
  WHERE empresa_id = v_empresa_id AND estado = 'en_cartera'
  ORDER BY fecha_vto ASC
  LIMIT 1;

  IF v_cheque_garantia_id IS NOT NULL THEN
    UPDATE cheques
    SET fecha_vto   = CURRENT_DATE + 2,
        vencimiento = CURRENT_DATE + 2,
        updated_at  = now()
    WHERE id = v_cheque_garantia_id;
  END IF;
END;
$function$;

-- Wireado a fn_reset_demo_cron (idéntico al que ya corre en producción):
CREATE OR REPLACE FUNCTION public.fn_reset_demo_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
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

  PERFORM public.fn_reset_demo_v2(v_empresa_id);
  PERFORM public.fn_redistribuir_fechas_demo(v_empresa_id);
  PERFORM public.fn_generar_alertas_stock_autonomo(v_empresa_id);
  PERFORM public.fn_rodar_lotes_trigger_demo(v_empresa_id);
  -- FIX 606: idem para cheques — fn_redistribuir_fechas_demo tampoco
  -- incluye la tabla cheques, así que los "en cartera" quedaban con
  -- fecha_vto fija del snapshot. fn_rodar_cheques_demo los re-ancla
  -- (spread por hash + garantía de al menos 1 dentro de la ventana de
  -- aviso) para que el cron real de cheques-por-vencer tenga insumo.
  PERFORM public.fn_rodar_cheques_demo(v_empresa_id);
END;
$function$;
