-- ============================================================================
-- 079_anomalias_revisadas.sql
-- Tabla para persistir el estado "revisado" de cada patrón anómalo detectado.
-- No tiene FK a una tabla de anomalías (son efímeras, se recalculan cada vez);
-- la clave natural es (empresa_id, tipo_anomalia, usuario_id, entidad_id).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.anomalias_revisadas (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid        NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo_anomalia text        NOT NULL,
  usuario_id    uuid,       -- usuario que generó la anomalía (puede ser null para tipo d)
  entidad_id    uuid,       -- entidad afectada (puede ser null)
  resuelto_por  uuid        NOT NULL REFERENCES public.usuarios(id),
  notas         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalias_revisadas_key
  ON public.anomalias_revisadas (empresa_id, tipo_anomalia, COALESCE(usuario_id,'00000000-0000-0000-0000-000000000000'), COALESCE(entidad_id,'00000000-0000-0000-0000-000000000000'));

CREATE INDEX IF NOT EXISTS idx_anomalias_revisadas_empresa
  ON public.anomalias_revisadas (empresa_id, created_at DESC);

ALTER TABLE public.anomalias_revisadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY anomalias_revisadas_empresa ON public.anomalias_revisadas
  USING (empresa_id IN (
    SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()
  ));
