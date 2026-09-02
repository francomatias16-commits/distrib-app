-- Etapa 2 (ampliación) del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md
--
-- 20260828213422_etapa2_retencion_archivado_notif_eventos_audit.sql ya cubrió
-- notif_log / eventos_negocio / audit_log. El diagnóstico original del plan
-- listaba 3 tablas más de crecimiento no acotado que quedaron pendientes:
-- security_audit_historial, whatsapp_conversaciones/mensajes y
-- asistente_conversaciones/mensajes. Esta migración las suma al mismo ciclo
-- diario (mismo cron /api/retencion, mismo criterio: archivar a _historico
-- antes de purgar, nunca un DELETE directo).
--
-- Reglas de selección específicas de cada tabla (a diferencia de
-- notif_log/eventos_negocio/audit_log, que se archivan solo por fecha):
--   - whatsapp_conversaciones: SOLO conversaciones con estado='cerrada' Y
--     ultima_interaccion vieja. Una conversación activa nunca se purga
--     aunque sea vieja — evita cortar un hilo en curso con un cliente.
--   - asistente_conversaciones: por actualizado_en. Son sesiones de chat
--     corto (HISTORIAL_MAX_MENSAJES en asistente.js ya limita cuánto se lee
--     en runtime); no hay un estado "abierta/cerrada" que cuidar acá.
--   - security_audit_historial: por ejecutado_en, mismo criterio que
--     audit_log — es un log de corridas diarias, no datos operativos.
-- En los dos casos con padre/hijo (asistente, whatsapp) los mensajes/turnos
-- se archivan PRIMERO usando el mismo criterio de selección del padre, y
-- recién después se archiva el padre — así nunca queda un mensaje huérfano
-- en _historico sin su conversación, ni una conversación en _historico con
-- mensajes que se quedaron en la tabla viva.
--
-- Ninguna de estas 3 tablas tiene relación con facturación/AFIP — no aplica
-- la salvedad de retención legal que menciona el plan para datos contables.

-- ── Tablas _historico (mismo patrón que la migración anterior: columnas y
--    defaults idénticos, solo el índice que realmente se va a usar) ────────
CREATE TABLE public.security_audit_historial_historico (LIKE public.security_audit_historial INCLUDING DEFAULTS);
CREATE TABLE public.asistente_conversaciones_historico (LIKE public.asistente_conversaciones INCLUDING DEFAULTS);
CREATE TABLE public.asistente_mensajes_historico (LIKE public.asistente_mensajes INCLUDING DEFAULTS);
CREATE TABLE public.whatsapp_conversaciones_historico (LIKE public.whatsapp_conversaciones INCLUDING DEFAULTS);
CREATE TABLE public.whatsapp_mensajes_historico (LIKE public.whatsapp_mensajes INCLUDING DEFAULTS);

CREATE INDEX idx_security_audit_historial_historico_ejecutado_en
  ON public.security_audit_historial_historico(ejecutado_en);
CREATE INDEX idx_asistente_conversaciones_historico_empresa
  ON public.asistente_conversaciones_historico(empresa_id, actualizado_en);
CREATE INDEX idx_asistente_mensajes_historico_conv
  ON public.asistente_mensajes_historico(conversacion_id, creado_en);
CREATE INDEX idx_whatsapp_conversaciones_historico_empresa
  ON public.whatsapp_conversaciones_historico(empresa_id, ultima_interaccion);
CREATE INDEX idx_whatsapp_mensajes_historico_conv
  ON public.whatsapp_mensajes_historico(conversacion_id, created_at);

ALTER TABLE public.security_audit_historial_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistente_conversaciones_historico  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistente_mensajes_historico        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversaciones_historico   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_mensajes_historico         ENABLE ROW LEVEL SECURITY;

-- security_audit_historial_historico: mismo criterio que la tabla original
-- (20260828041000) — RLS habilitado sin políticas, solo service_role. Es
-- información sensible de auditoría de seguridad, no un dato operativo que
-- el panel admin necesite mostrar.
REVOKE ALL ON public.security_audit_historial_historico FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.security_audit_historial_historico TO service_role;

-- asistente_/whatsapp_*_historico: mismo criterio de visibilidad SELECT que
-- las tablas originales (204 / 247) — lectura scopeada por empresa para el
-- panel admin, escritura solo vía service_role (el RPC de abajo).
CREATE POLICY asistente_conversaciones_historico_empresa ON public.asistente_conversaciones_historico
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

CREATE POLICY asistente_mensajes_historico_empresa ON public.asistente_mensajes_historico
  FOR SELECT USING (
    conversacion_id IN (
      SELECT id FROM public.asistente_conversaciones_historico
      WHERE empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    )
  );

CREATE POLICY whatsapp_conversaciones_historico_empresa ON public.whatsapp_conversaciones_historico
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

CREATE POLICY whatsapp_mensajes_historico_empresa ON public.whatsapp_mensajes_historico
  FOR SELECT USING (
    conversacion_id IN (
      SELECT id FROM public.whatsapp_conversaciones_historico
      WHERE empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    )
  );

REVOKE ALL ON public.asistente_conversaciones_historico FROM anon;
REVOKE ALL ON public.asistente_mensajes_historico       FROM anon;
REVOKE ALL ON public.whatsapp_conversaciones_historico  FROM anon;
REVOKE ALL ON public.whatsapp_mensajes_historico        FROM anon;
GRANT SELECT ON public.asistente_conversaciones_historico TO authenticated;
GRANT SELECT ON public.asistente_mensajes_historico       TO authenticated;
GRANT SELECT ON public.whatsapp_conversaciones_historico  TO authenticated;
GRANT SELECT ON public.whatsapp_mensajes_historico        TO authenticated;

-- ── RPC ampliada: CREATE OR REPLACE sobre la misma función y firma que ya
--    usa el cron (archivar_y_purgar_retencion) — el handler/repo/cron no
--    cambian, solo se suma trabajo adentro. p_dias_retencion sigue
--    compartido entre las 6 tablas por simplicidad; si en el futuro hace
--    falta un retention distinto por tabla (ej. security_audit_historial
--    con más valor forense a largo plazo que notif_log), se parametriza
--    cuando aparezca esa necesidad concreta — no antes.
CREATE OR REPLACE FUNCTION public.archivar_y_purgar_retencion(p_dias_retencion int DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notif             int;
  v_eventos           int;
  v_audit             int;
  v_security_audit    int;
  v_asistente_msj     int;
  v_asistente_conv    int;
  v_whatsapp_msj      int;
  v_whatsapp_conv     int;
  v_cutoff            timestamptz;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_dias_retencion < 30 THEN
    RAISE EXCEPTION 'p_dias_retencion no puede ser menor a 30 (guarda contra un valor mal pasado que borre datos recientes)';
  END IF;

  v_cutoff := now() - (p_dias_retencion || ' days')::interval;

  WITH movidos AS (
    DELETE FROM notif_log
    WHERE created_at < v_cutoff
    RETURNING *
  )
  INSERT INTO notif_log_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_notif = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM eventos_negocio
    WHERE creado_en < v_cutoff
    RETURNING *
  )
  INSERT INTO eventos_negocio_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_eventos = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM audit_log
    WHERE created_at < v_cutoff
    RETURNING *
  )
  INSERT INTO audit_log_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM security_audit_historial
    WHERE ejecutado_en < v_cutoff
    RETURNING *
  )
  INSERT INTO security_audit_historial_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_security_audit = ROW_COUNT;

  -- asistente: mensajes primero (mismas conversaciones que se van a purgar
  -- por actualizado_en), después las conversaciones.
  WITH conv_a_purgar AS (
    SELECT id FROM asistente_conversaciones WHERE actualizado_en < v_cutoff
  ),
  movidos AS (
    DELETE FROM asistente_mensajes
    WHERE conversacion_id IN (SELECT id FROM conv_a_purgar)
    RETURNING *
  )
  INSERT INTO asistente_mensajes_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_asistente_msj = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM asistente_conversaciones
    WHERE actualizado_en < v_cutoff
    RETURNING *
  )
  INSERT INTO asistente_conversaciones_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_asistente_conv = ROW_COUNT;

  -- whatsapp: solo conversaciones CERRADAS y viejas — una conversación
  -- 'activa'/'esperando_confirmacion'/'derivada_humano' nunca se toca acá,
  -- sin importar cuán vieja sea ultima_interaccion.
  WITH conv_a_purgar AS (
    SELECT id FROM whatsapp_conversaciones
    WHERE estado = 'cerrada' AND ultima_interaccion < v_cutoff
  ),
  movidos AS (
    DELETE FROM whatsapp_mensajes
    WHERE conversacion_id IN (SELECT id FROM conv_a_purgar)
    RETURNING *
  )
  INSERT INTO whatsapp_mensajes_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_whatsapp_msj = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM whatsapp_conversaciones
    WHERE estado = 'cerrada' AND ultima_interaccion < v_cutoff
    RETURNING *
  )
  INSERT INTO whatsapp_conversaciones_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_whatsapp_conv = ROW_COUNT;

  RETURN jsonb_build_object(
    'notif_log', v_notif,
    'eventos_negocio', v_eventos,
    'audit_log', v_audit,
    'security_audit_historial', v_security_audit,
    'asistente_mensajes', v_asistente_msj,
    'asistente_conversaciones', v_asistente_conv,
    'whatsapp_mensajes', v_whatsapp_msj,
    'whatsapp_conversaciones', v_whatsapp_conv,
    'dias_retencion', p_dias_retencion
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archivar_y_purgar_retencion(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archivar_y_purgar_retencion(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archivar_y_purgar_retencion(int) TO service_role;

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260829000000_etapa2_retencion_ampliada_asistente_whatsapp_security_audit.sql',
  'etapa2_retencion_ampliada',
  'claude_assistant',
  'Etapa 2 (ampliación): suma security_audit_historial, whatsapp_conversaciones/mensajes y asistente_conversaciones/mensajes al mismo RPC/cron de retención que ya cubría notif_log/eventos_negocio/audit_log. whatsapp solo purga conversaciones cerradas; asistente por antigüedad de actualizado_en; security_audit_historial por ejecutado_en. Mensajes/turnos hijos se archivan antes que su conversación padre.'
)
ON CONFLICT DO NOTHING;
