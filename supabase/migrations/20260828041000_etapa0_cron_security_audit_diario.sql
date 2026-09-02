-- =============================================================
-- 20260828041000_etapa0_cron_security_audit_diario.sql
-- Etapa 0 — cierre del gap real detectado hoy: secnew_02 /
-- audit_security_grants_v2 / v3 quedaron aplicadas en la base
-- directo por SQL Editor, sin archivo en el repo ni fila en
-- schema_migrations_registry, y nadie se enteró hasta esta sesión.
--
-- Como el deploy es directo con Vercel CLI sin GitHub (no hay
-- GitHub Actions posible acá), el chequeo diario no puede vivir en
-- CI — vive adentro de Supabase con pg_cron, mismo patrón que ya
-- usa 'saas_email_sender_hourly' (131_fix_cron_email_sender_no_vault).
--
-- Qué corre todos los días:
--   1. audit_security_definer_grants()  (funciones SECURITY DEFINER)
--   2. audit_views_security_invoker()   (vistas sin security_invoker)
-- Ambas son RPCs SQL, viven en la base, no dependen del filesystem del
-- repo — por eso SÍ pueden correr desde un cron de DB. La tercera pata
-- de la auditoría (audit-funciones-fantasma.js, que compara la base
-- contra los archivos del repo) NO puede correr acá porque necesita el
-- filesystem del repo: sigue siendo manual / a criterio de quien
-- despliegue, hasta que haya CI real.
--
-- Se guarda cada corrida en security_audit_historial (para tener
-- rastro aunque no haya hallazgos) y, si hay al menos un
-- riesgo_potencial=true, se dispara un email vía la Edge Function
-- security-audit-alert (net.http_post, sin esperar la respuesta —
-- mismo patrón fire-and-forget que saas_email_sender_hourly).
-- =============================================================

-- ─── Tabla de historial ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.security_audit_historial (
  id                 bigserial   PRIMARY KEY,
  ejecutado_en       timestamptz NOT NULL DEFAULT now(),
  funciones_riesgo   integer     NOT NULL DEFAULT 0,
  vistas_riesgo      integer     NOT NULL DEFAULT 0,
  detalle            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  alerta_disparada   boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_security_audit_historial_ejecutado_en
  ON public.security_audit_historial (ejecutado_en DESC);

COMMENT ON TABLE public.security_audit_historial IS
  'Historial de corridas diarias de audit_security_definer_grants() /
   audit_views_security_invoker() vía pg_cron. alerta_disparada indica que
   se llamó a net.http_post hacia la Edge Function security-audit-alert
   (no confirma que el email llegó — eso queda en los logs de Resend).';

-- RLS habilitado sin políticas: solo service_role, mismo criterio que
-- audit_log_pendientes y el resto de las tablas internas de auditoría.
ALTER TABLE public.security_audit_historial ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.security_audit_historial FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.security_audit_historial TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.security_audit_historial_id_seq TO service_role;

-- ─── Función que corre la auditoría y dispara la alerta ──────────────────
CREATE OR REPLACE FUNCTION public.ejecutar_auditoria_seguridad_diaria()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_funciones_riesgo jsonb;
  v_vistas_riesgo     jsonb;
  v_cant_funciones    integer;
  v_cant_vistas       integer;
  v_payload           jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb), count(*)
    INTO v_funciones_riesgo, v_cant_funciones
    FROM public.audit_security_definer_grants() f
    WHERE f.riesgo_potencial;

  SELECT coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb), count(*)
    INTO v_vistas_riesgo, v_cant_vistas
    FROM public.audit_views_security_invoker() v
    WHERE v.riesgo_potencial;

  v_payload := jsonb_build_object(
    'ejecutado_en', now(),
    'funciones_riesgo', v_funciones_riesgo,
    'vistas_riesgo', v_vistas_riesgo
  );

  INSERT INTO public.security_audit_historial
    (funciones_riesgo, vistas_riesgo, detalle, alerta_disparada)
  VALUES
    (v_cant_funciones, v_cant_vistas, v_payload, (v_cant_funciones + v_cant_vistas) > 0);

  -- Fire-and-forget: no bloquea el cron esperando la respuesta HTTP.
  -- Si pg_net no está disponible por algún motivo, no queremos que la
  -- auditoría en sí falle — se registra igual en el historial de arriba.
  IF (v_cant_funciones + v_cant_vistas) > 0 THEN
    BEGIN
      PERFORM net.http_post(
        url     := 'https://jgiquzjwoedmzwqgzubr.supabase.co/functions/v1/security-audit-alert',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body    := v_payload
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ejecutar_auditoria_seguridad_diaria: fallo al llamar security-audit-alert: %', SQLERRM;
    END;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.ejecutar_auditoria_seguridad_diaria() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ejecutar_auditoria_seguridad_diaria() TO service_role;

-- ─── Cron diario ──────────────────────────────────────────────────────────
-- 03:30 UTC — fuera del horario pico y separado de saas_email_sender_hourly
-- (corre en el minuto 0 de cada hora), para no competir por pg_net en el
-- mismo instante.
SELECT cron.unschedule('security_audit_diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'security_audit_diario');

SELECT cron.schedule(
  'security_audit_diario',
  '30 3 * * *',
  $$ SELECT public.ejecutar_auditoria_seguridad_diaria(); $$
);

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260828041000_etapa0_cron_security_audit_diario.sql',
  'etapa0_cron_security_audit_diario',
  'claude_assistant',
  'Etapa 0: cierra el gap de "cambios aplicados directo por SQL Editor sin CI" con un pg_cron diario (03:30 UTC) que corre audit_security_definer_grants() + audit_views_security_invoker(), guarda cada corrida en security_audit_historial, y si hay riesgo_potencial dispara la Edge Function security-audit-alert por email (net.http_post, fire-and-forget). audit-funciones-fantasma.js queda fuera del cron porque depende del filesystem del repo, no de la base.'
)
ON CONFLICT DO NOTHING;
