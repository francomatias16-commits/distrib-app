-- =============================================================
-- 188_fix_cron_activacion_check_dias_desde_alta.sql
-- Bug real (encontrado en QA del ítem 1 del plan comercial, sin
-- probar en navegador todavía): saas_cron_activacion_check() usaba
-- dias_desde_alta = 3 (igualdad exacta). Si el cron diario no corría
-- justo ese día, la empresa perdía el nudge de onboarding para
-- siempre — ya pasó antes con el cron de trial (ver ítem 2.3 del
-- plan, fix de vault secret faltante).
--
-- Fix: >= 3, consistente con el criterio de en_riesgo en
-- saas_dashboard_kpis(). El dedup por saas_email_log(empresa_id,
-- tipo) ya existía, así que no genera envíos duplicados.
-- =============================================================

CREATE OR REPLACE FUNCTION public.saas_cron_activacion_check()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT empresa_id, email, nombre, tiene_productos, tiene_pedidos, tiene_ventas_pos
    FROM public.saas_panel_admin
    WHERE saas_plan = 'trial'
      AND saas_suspendida = false
      AND activada = false
      AND dias_desde_alta >= 3   -- antes: = 3
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.saas_email_log
      WHERE empresa_id = rec.empresa_id AND tipo = 'onboarding_nudge'
    ) THEN
      INSERT INTO public.saas_email_log (empresa_id, tipo, destinatario)
      VALUES (rec.empresa_id, 'onboarding_nudge', rec.email);
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.saas_cron_activacion_check IS
  'Detecta trials sin actividad real desde el día 3 de antigüedad y dispara un único email de onboarding (v186, fix >=3 en v188)';
