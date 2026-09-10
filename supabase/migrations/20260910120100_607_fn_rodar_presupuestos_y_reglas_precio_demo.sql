-- =============================================================
-- 607_fn_rodar_presupuestos_y_reglas_precio_demo
--
-- Ver CHANGELOG_v1068. Mismo patrón que 605/606: dos tablas más que
-- fn_redistribuir_fechas_demo no toca, con fecha fija del snapshot que
-- se aleja de "hoy" con el paso de los días reales.
--
-- presupuestos: el presupuesto 'enviado' de la demo queda con
-- fecha_vencimiento pasada, y el cron real vencer-presupuestos-diario lo
-- pasaría a 'vencido' — pero el reset de 6h lo restaura a 'enviado' con
-- la misma fecha vieja. Nunca se ve un presupuesto realmente vigente.
--
-- reglas_precio: resolver_precios_cliente/resolver_precios_etiquetas
-- exigen fecha_hasta >= CURRENT_DATE. La regla "fin de mes" (activa=true)
-- quedaba con fecha_hasta pasada y nunca volvía a aplicar sola.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_rodar_presupuestos_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar presupuestos';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- Re-ancla a "vence en 5 días desde hoy", preservando el plazo original
  -- entre creación y vencimiento.
  UPDATE presupuestos p
  SET fecha_vencimiento = CURRENT_DATE + 5,
      created_at        = created_at + ((CURRENT_DATE + 5) - fecha_vencimiento || ' days')::interval,
      updated_at        = now()
  WHERE p.empresa_id = v_empresa_id
    AND p.estado = 'enviado'
    AND p.fecha_vencimiento < CURRENT_DATE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_rodar_reglas_precio_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar reglas_precio';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- Re-ancla a "vence en 5 días desde hoy", preservando la duración
  -- original de la ventana (fecha_hasta - fecha_desde). Se excluyen a
  -- propósito las reglas cuyo nombre indica que están vencidas/pausadas
  -- como caso de demo intencional — esas deben seguir mostrando ese
  -- estado, no rodar con el resto.
  UPDATE reglas_precio r
  SET fecha_desde = fecha_desde + ((CURRENT_DATE + 5) - fecha_hasta || ' days')::interval,
      fecha_hasta = CURRENT_DATE + 5,
      updated_at  = now()
  WHERE r.empresa_id = v_empresa_id
    AND r.activa = true
    AND r.fecha_hasta IS NOT NULL
    AND r.fecha_hasta < CURRENT_DATE
    AND r.nombre NOT ILIKE '%finalizad%'
    AND r.nombre NOT ILIKE '%pausad%'
    AND r.nombre NOT ILIKE '%vencid%';
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
  PERFORM public.fn_rodar_cheques_demo(v_empresa_id);
  -- FIX 607: idem para presupuestos y reglas_precio.
  PERFORM public.fn_rodar_presupuestos_demo(v_empresa_id);
  PERFORM public.fn_rodar_reglas_precio_demo(v_empresa_id);
END;
$function$;
