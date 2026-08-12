-- =============================================================================
-- 043_fix_rls_reglas_score.sql
-- FIX: Habilitar RLS en tabla reglas_score (omitida en migración 036)
--
-- PROBLEMA:
--   036_score_cliente.sql crea la tabla reglas_score con empresa_id y la
--   usa para almacenar multiplicadores y umbrales de scoring por empresa.
--   Sin embargo, nunca ejecutó ALTER TABLE ... ENABLE ROW LEVEL SECURITY,
--   ni definió política de acceso. Las tablas hermanas (scores_cliente,
--   alertas_score) sí tienen RLS. reglas_score quedó desprotegida.
--
-- IMPACTO:
--   Cualquier consulta directa con anon/authenticated key (sin el filtro
--   application-level de empresa_id) expone las reglas de scoring de TODAS
--   las empresas. Violación de la regla: "RLS Obligatorio — No se permiten
--   lecturas ni escrituras públicas desprotegidas."
--
-- FIX:
--   Habilitar RLS y crear política empresa-scoped siguiendo la convención
--   canónica de 039_fix_rls_y_categorias.sql: get_empresa_id() (STABLE +
--   SECURITY DEFINER, definida allí y en 002_rls.sql).
-- =============================================================================

ALTER TABLE public.reglas_score ENABLE ROW LEVEL SECURITY;

-- Eliminar si existe alguna versión previa (idempotente)
DROP POLICY IF EXISTS reglas_score_empresa ON public.reglas_score;

CREATE POLICY reglas_score_empresa ON public.reglas_score
  FOR ALL
  USING (empresa_id = public.get_empresa_id());
