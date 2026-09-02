-- Etapa 2 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md
-- Archivado + purga con retención de 180 días para notif_log, eventos_negocio
-- y audit_log. Se archiva (no se borra sin más) a tablas _historico espejo,
-- vía DELETE...RETURNING + INSERT en un único statement por tabla (atómico).
-- Aplicada directo en Supabase el 2026-08-28; este archivo es el backfill
-- para no perder trazabilidad (mismo criterio que sesión 9 de AUDITORIA_2026).

-- ── Tablas _historico (mismas columnas/defaults, sin FKs ni índices
--    originales — se agrega solo el índice que realmente se va a usar:
--    consulta por empresa + fecha) ──────────────────────────────────────
CREATE TABLE public.notif_log_historico (LIKE public.notif_log INCLUDING DEFAULTS);
CREATE TABLE public.eventos_negocio_historico (LIKE public.eventos_negocio INCLUDING DEFAULTS);
CREATE TABLE public.audit_log_historico (LIKE public.audit_log INCLUDING DEFAULTS);

CREATE INDEX idx_notif_log_historico_empresa_fecha ON public.notif_log_historico(empresa_id, created_at);
CREATE INDEX idx_eventos_negocio_historico_empresa_fecha ON public.eventos_negocio_historico(empresa_id, creado_en);
CREATE INDEX idx_audit_log_historico_empresa_fecha ON public.audit_log_historico(empresa_id, created_at);

ALTER TABLE public.notif_log_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eventos_negocio_historico ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_historico ENABLE ROW LEVEL SECURITY;

-- Mismo criterio de visibilidad SELECT que la tabla original (staff de la
-- empresa); son tablas de solo-lectura para todos salvo service_role, así
-- que no hace falta política de INSERT/UPDATE/DELETE para roles de app.
CREATE POLICY notif_log_historico_select ON public.notif_log_historico
  FOR SELECT
  USING (
    (SELECT auth.role()) = 'service_role'
    OR (
      get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
      AND empresa_id = auth_empresa_id()
    )
    OR (
      get_rol_usuario() = 'cliente'::rol_usuario
      AND cliente_id = (
        SELECT c.id FROM clientes c JOIN usuarios u ON u.cliente_id = c.id
        WHERE u.id = (SELECT auth.uid()) LIMIT 1
      )
    )
    OR (
      get_rol_usuario() = 'chofer'::rol_usuario
      AND usuario_id = (SELECT auth.uid())
    )
  );

CREATE POLICY eventos_negocio_historico_select ON public.eventos_negocio_historico
  FOR SELECT
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

CREATE POLICY audit_log_historico_select ON public.audit_log_historico
  FOR SELECT
  USING (
    empresa_id IN (
      SELECT usuarios.empresa_id FROM usuarios
      WHERE usuarios.id = (SELECT auth.uid())
        AND usuarios.rol = ANY (ARRAY['dueno','admin','contador']::rol_usuario[])
    )
    OR (empresa_id = get_empresa_id() AND get_rol_usuario() = ANY (ARRAY['dueno','admin']::rol_usuario[]))
  );

-- ── RPC de archivado + purga (solo service_role, invocada por el cron) ──
CREATE OR REPLACE FUNCTION public.archivar_y_purgar_retencion(p_dias_retencion int DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notif   int;
  v_eventos int;
  v_audit   int;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_dias_retencion < 30 THEN
    RAISE EXCEPTION 'p_dias_retencion no puede ser menor a 30 (guarda contra un valor mal pasado que borre datos recientes)';
  END IF;

  WITH movidos AS (
    DELETE FROM notif_log
    WHERE created_at < now() - (p_dias_retencion || ' days')::interval
    RETURNING *
  )
  INSERT INTO notif_log_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_notif = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM eventos_negocio
    WHERE creado_en < now() - (p_dias_retencion || ' days')::interval
    RETURNING *
  )
  INSERT INTO eventos_negocio_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_eventos = ROW_COUNT;

  WITH movidos AS (
    DELETE FROM audit_log
    WHERE created_at < now() - (p_dias_retencion || ' days')::interval
    RETURNING *
  )
  INSERT INTO audit_log_historico SELECT * FROM movidos;
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  RETURN jsonb_build_object(
    'notif_log', v_notif,
    'eventos_negocio', v_eventos,
    'audit_log', v_audit,
    'dias_retencion', p_dias_retencion
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archivar_y_purgar_retencion(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archivar_y_purgar_retencion(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archivar_y_purgar_retencion(int) TO service_role;
