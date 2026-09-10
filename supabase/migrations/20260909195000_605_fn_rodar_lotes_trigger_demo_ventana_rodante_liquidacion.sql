-- =============================================================
-- 605_fn_rodar_lotes_trigger_demo_ventana_rodante_liquidacion
--
-- Retomando PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md: se detectó
-- que ofertas_liquidacion quedaba en cero indefinidamente porque los 2
-- lotes "trigger" de la demo (L-PORVENCER-01, L-VENCIDO-01) tienen fecha
-- de vencimiento fija (calendario absoluto) desde que se cargaron, y
-- fn_redistribuir_fechas_demo (que sí corre cada 6h via pg_cron, job
-- demo_reset_periodico) no toca la tabla lotes — solo pedidos, facturas,
-- cobros, ventas_pos, etc. Una vez que esa fecha fija quedaba en el
-- pasado, actualizar_estado_lotes (lógica real de negocio, vía cron
-- diario /api/stock-auto?accion=analizar) los pasaba a estado='vencido'
-- para siempre, y el cron real de liquidación (/api/liquidacion?accion=
-- generar, 6:30, que solo mira lotes con estado='activo' y vencimiento
-- en los próximos dias_alerta días) dejaba de encontrar candidatos.
--
-- Este fix agrega una función de mantenimiento de demo (mismo patrón que
-- fn_redistribuir_fechas_demo / fn_generar_alertas_stock_autonomo) que
-- re-ancla esos 2 lotes trigger a HOY en cada corrida del reset
-- periódico, para que el cron REAL de liquidación siga generando
-- ofertas reales sobre datos de entrada frescos — sin tocar la lógica
-- de negocio real ni forzar la generación de ofertas manualmente.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_rodar_lotes_trigger_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id       uuid;
  v_offset_porvencer int;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar lotes trigger';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- L-PORVENCER-*: cicla un offset 0..6 según el día del año (sin guardar
  -- estado entre corridas), así siempre cae dentro de la ventana de
  -- alerta por defecto (dias_alerta=7) y de paso recorre los 3 niveles
  -- de descuento de generar_ofertas_liquidacion a lo largo de la semana:
  -- offset 0 -> nivel3 (<=0 días, 25%), offset 1 -> nivel2 (<=1 día, 15%),
  -- offset 2-6 -> nivel1 (10%).
  v_offset_porvencer := extract(doy from CURRENT_DATE)::int % 7;

  UPDATE lotes
  SET fecha_vencimiento   = CURRENT_DATE + v_offset_porvencer,
      estado              = 'activo',
      cantidad            = GREATEST(cantidad, 15),
      cantidad_disponible = GREATEST(cantidad, 15) - cantidad_reservada,
      updated_at          = now()
  WHERE empresa_id = v_empresa_id
    AND numero_lote LIKE 'L-PORVENCER%';

  -- L-VENCIDO-*: representa un lote recién vencido (reportes de mermas/
  -- vencidos) — se re-ancla a "hace 5 días" en vez de quedar fijo en una
  -- fecha calendario que se aleja cada vez más de la fecha real de hoy.
  UPDATE lotes
  SET fecha_vencimiento   = CURRENT_DATE - 5,
      estado              = 'vencido',
      cantidad            = GREATEST(cantidad, 10),
      cantidad_disponible = GREATEST(cantidad, 10) - cantidad_reservada,
      updated_at          = now()
  WHERE empresa_id = v_empresa_id
    AND numero_lote LIKE 'L-VENCIDO%';
END;
$function$;

-- Enganchar en el reset periódico existente (mismo cron demo_reset_periodico,
-- cada 6h — no se crea ningún cron nuevo).
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
  -- Fix 522: regenerar alertas de stock reales tras cada reset, en vez de
  -- depender del cron diario de Vercel (que corre 1 vez por día y el
  -- reset de 6h lo pisa la mayor parte del tiempo).
  PERFORM public.fn_generar_alertas_stock_autonomo(v_empresa_id);
  -- FIX (retomando PLAN_ROBUSTEZ...2026, sep 2026): fn_redistribuir_fechas_demo
  -- no toca lotes.fecha_vencimiento. fn_rodar_lotes_trigger_demo re-ancla los
  -- 2 lotes trigger de liquidación (L-PORVENCER-01/L-VENCIDO-01) a hoy en
  -- cada corrida, para que el cron REAL de liquidación (/api/liquidacion?
  -- accion=generar, 6:30) siempre tenga lotes "por vencer" frescos para
  -- procesar — ver migración 605.
  PERFORM public.fn_rodar_lotes_trigger_demo(v_empresa_id);
END;
$function$;
