-- 150_sistema_migracion_clientes.sql
-- Wizard de migración asistida de clientes/productos (importación masiva vía
-- CSV/Excel con mapeo de columnas, validación y confirmación en 2 pasos).
--
-- NOTA: esta numeración reemplaza a la "148_sistema_migracion_clientes.sql"
-- referenciada por 149_fix_migracion_confirmar_sesion_idor.sql, que nunca
-- llegó a commitearse al repo (se perdió en una sesión anterior). Se
-- reconstruye acá con el fix de 149 ya incorporado desde el origen (RPC
-- exige get_empresa_id() no nulo y usa IS DISTINCT FROM), así no depende de
-- que 149 corra después. 149 queda en el repo como CREATE OR REPLACE
-- idempotente sobre la misma función, sin romper nada si corre de nuevo.

-- ============================================================
-- TABLA: migracion_sesiones
-- ============================================================
CREATE TABLE IF NOT EXISTS public.migracion_sesiones (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id               UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id               UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
  entidad                  TEXT NOT NULL CHECK (entidad IN ('clientes', 'productos')),
  nombre_archivo_original  TEXT,
  estado                   TEXT NOT NULL DEFAULT 'subido'
                            CHECK (estado IN ('subido', 'mapeado', 'validado', 'confirmando', 'completado', 'error', 'cancelado')),
  columnas_detectadas      JSONB,
  mapeo_columnas           JSONB,
  total_filas              INT DEFAULT 0,
  filas_validas            INT DEFAULT 0,
  filas_con_error          INT DEFAULT 0,
  resumen_errores          JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migracion_sesiones_empresa ON public.migracion_sesiones(empresa_id, created_at DESC);

-- ============================================================
-- TABLA: migracion_staging_rows
-- ============================================================
CREATE TABLE IF NOT EXISTS public.migracion_staging_rows (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sesion_id              UUID NOT NULL REFERENCES public.migracion_sesiones(id) ON DELETE CASCADE,
  fila_numero            INT NOT NULL,
  datos_originales       JSONB NOT NULL,
  datos_mapeados         JSONB,
  es_valida              BOOLEAN NOT NULL DEFAULT false,
  errores                JSONB NOT NULL DEFAULT '[]'::jsonb,
  accion                 TEXT NOT NULL DEFAULT 'crear' CHECK (accion IN ('crear', 'actualizar', 'omitir')),
  entidad_existente_id   UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migracion_staging_sesion ON public.migracion_staging_rows(sesion_id, fila_numero);
CREATE INDEX IF NOT EXISTS idx_migracion_staging_validas ON public.migracion_staging_rows(sesion_id) WHERE es_valida = true;

-- ============================================================
-- RLS — el handler usa la service role key (bypassa RLS), pero se deja
-- la política como defensa en profundidad por si en el futuro se consulta
-- desde el cliente con el JWT del usuario.
-- ============================================================
ALTER TABLE public.migracion_sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migracion_staging_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS migracion_sesiones_empresa ON public.migracion_sesiones;
CREATE POLICY migracion_sesiones_empresa ON public.migracion_sesiones
  FOR ALL USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id())
  WITH CHECK (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

DROP POLICY IF EXISTS migracion_staging_rows_empresa ON public.migracion_staging_rows;
CREATE POLICY migracion_staging_rows_empresa ON public.migracion_staging_rows
  FOR ALL USING (
    sesion_id IN (SELECT id FROM public.migracion_sesiones WHERE empresa_id IS NOT DISTINCT FROM public.get_empresa_id())
  )
  WITH CHECK (
    sesion_id IN (SELECT id FROM public.migracion_sesiones WHERE empresa_id IS NOT DISTINCT FROM public.get_empresa_id())
  );

-- Sin grants a anon/authenticated: todo el acceso pasa por el handler con
-- la service role key (igual que el resto de los handlers del proyecto).
REVOKE ALL ON public.migracion_sesiones FROM anon, authenticated;
REVOKE ALL ON public.migracion_staging_rows FROM anon, authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '150_sistema_migracion_clientes.sql', '150', 'claude-session',
        'Recreación de las tablas base del wizard de migración (148 referenciada por 149 nunca se commiteó). Fix de 149 incorporado desde el origen.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
