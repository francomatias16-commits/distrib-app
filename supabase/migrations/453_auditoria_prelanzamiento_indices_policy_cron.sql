-- 453_auditoria_prelanzamiento_indices_policy_cron.sql
-- Documenta en el repo 3 fixes de la Auditoría pre-lanzamiento
-- (AUDITORIA_PRE_LANZAMIENTO.md, secciones 8, 9 y 6) que ya fueron
-- aplicados directamente en Supabase el 2026-08-10. Este archivo es
-- idempotente (IF NOT EXISTS / DROP IF EXISTS) para que correr las
-- migraciones desde cero deje la base en el mismo estado.

BEGIN;

-- ============================================================
-- PASO 1 (sección 8): índices de cobertura para 6 FKs que el
-- advisor de performance marcaba como unindexed_foreign_keys.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_asistente_acciones_pendientes_empresa_id
  ON public.asistente_acciones_pendientes (empresa_id);

CREATE INDEX IF NOT EXISTS idx_banco_codigos_producto_aportado_por
  ON public.banco_codigos_producto (aportado_por);

CREATE INDEX IF NOT EXISTS idx_cta_cte_anulado_por
  ON public.cta_cte (anulado_por);

CREATE INDEX IF NOT EXISTS idx_pos_scanner_tokens_creado_por
  ON public.pos_scanner_tokens (creado_por);

CREATE INDEX IF NOT EXISTS idx_tareas_automatizacion_completada_por
  ON public.tareas_automatizacion (completada_por);

CREATE INDEX IF NOT EXISTS idx_tareas_automatizacion_regla_id
  ON public.tareas_automatizacion (regla_id);

-- ============================================================
-- PASO 2 (sección 9): reglas_automatizacion tenía 2 policies
-- permisivas para el mismo rol/acción SELECT
-- (reglas_automatizacion_modify FOR ALL + reglas_automatizacion_select
-- FOR SELECT). El permiso efectivo no cambia: el OR de ambas quals
-- para SELECT ya equivalía a (empresa_id = get_empresa_id()), la
-- misma condición de la policy _select sola. Se reduce el scope de
-- _modify a solo INSERT/UPDATE/DELETE para eliminar el duplicado.
-- ============================================================

DROP POLICY IF EXISTS reglas_automatizacion_modify ON public.reglas_automatizacion;

CREATE POLICY reglas_automatizacion_insert ON public.reglas_automatizacion
  FOR INSERT
  WITH CHECK (
    (empresa_id = get_empresa_id())
    AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))
  );

CREATE POLICY reglas_automatizacion_update ON public.reglas_automatizacion
  FOR UPDATE
  USING (
    (empresa_id = get_empresa_id())
    AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))
  )
  WITH CHECK (
    (empresa_id = get_empresa_id())
    AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))
  );

CREATE POLICY reglas_automatizacion_delete ON public.reglas_automatizacion
  FOR DELETE
  USING (
    (empresa_id = get_empresa_id())
    AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))
  );

-- ============================================================
-- PASO 3 (sección 6): registrar el job de pg_cron que la
-- migración 078 intentaba crear condicionalmente (solo si pg_cron
-- ya estaba habilitado en ese momento) y que nunca quedó
-- registrado. Misma lógica que 078, con un fix: el schedule de 078
-- era '0 3 * * *' pero su propio comentario decía "3am Argentina ≈
-- 6am UTC" — esa cadena corría a las 3am UTC (medianoche
-- Argentina), no a las 3am Argentina como decía la intención. Acá
-- se usa '0 6 * * *', que sí es 3am Argentina.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vencer-presupuestos-diario') THEN
      PERFORM cron.schedule(
        'vencer-presupuestos-diario',
        '0 6 * * *',  -- 3am Argentina (fix del schedule de la migración 078)
        $sql$
          UPDATE public.presupuestos
             SET estado     = 'vencido',
                 updated_at = now()
           WHERE estado           = 'enviado'
             AND fecha_vencimiento < CURRENT_DATE;
        $sql$
      );
    END IF;
  END IF;
END $$;

COMMIT;
