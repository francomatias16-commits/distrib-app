-- =============================================================
-- 557_prospectos_competencia.sql
--
-- Fase 3, Capa 1 (prospección geográfica) de PLAN_CAPTURA_COMPETENCIA.md:
-- comercios NO-clientes que el vendedor carga manualmente (nombre, rubro,
-- ubicación) mientras recorre su zona, para más adelante poder ver cuáles
-- quedan cerca de las paradas de una ruta ya armada y priorizar la visita
-- de captura (Fase 1) sobre ellos.
--
-- Sin PostGIS instalado en el proyecto (verificado antes de diseñar esta
-- migración — ver `SELECT * FROM pg_extension`), así que no hay geography/
-- geometry ni ST_DWithin acá: `lat`/`lng` son numeric simples, igual que
-- clientes.lat/lng (migración 034), y el cálculo de distancia (Haversine)
-- se hace en la capa de aplicación (lib/repos/prospectos-competencia.js),
-- no en SQL — mismo criterio que ya usa el proyecto para no introducir una
-- extensión nueva por una sola funcionalidad chica.
--
-- Mismo patrón de multi-tenant y RLS que captura_competencia (migración
-- 551): RLS de solo-lectura por empresa_id vía public.get_empresa_id(),
-- el INSERT/UPDATE lo hace siempre el handler con SERVICE_ROLE_KEY.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.prospectos_competencia (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  vendedor_id   uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  nombre        text NOT NULL,
  rubro         text,
  direccion     text, -- texto libre, descriptivo — no se geocodifica, lat/lng se cargan aparte (GPS o a mano)
  lat           numeric(10,7) NOT NULL,
  lng           numeric(10,7) NOT NULL,
  notas         text,
  estado        text NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'visita_planificada', 'visitado', 'convertido', 'descartado')),
  captura_id    uuid REFERENCES public.captura_competencia(id) ON DELETE SET NULL, -- se completa cuando la visita termina en una captura (Fase 1)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospectos_competencia_empresa_estado
  ON public.prospectos_competencia(empresa_id, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospectos_competencia_vendedor
  ON public.prospectos_competencia(vendedor_id, estado);

-- Filtro geográfico grueso antes del Haversine exacto en la aplicación
-- (mismo criterio que un bounding-box previo a un cálculo más caro).
CREATE INDEX IF NOT EXISTS idx_prospectos_competencia_lat_lng
  ON public.prospectos_competencia(lat, lng);

ALTER TABLE public.prospectos_competencia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prospectos_competencia_empresa ON public.prospectos_competencia;
CREATE POLICY prospectos_competencia_empresa ON public.prospectos_competencia
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

REVOKE ALL ON public.prospectos_competencia FROM anon, authenticated;
GRANT SELECT ON public.prospectos_competencia TO authenticated;

COMMENT ON TABLE public.prospectos_competencia IS
  'Fase 3, Capa 1 (PLAN_CAPTURA_COMPETENCIA.md): comercios no-clientes cargados manualmente por el vendedor durante su recorrido, para priorizar visitas de captura de competencia por cercanía a rutas ya armadas.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '557_prospectos_competencia.sql', '557', 'claude-session',
  'Fase 3, Capa 1 de PLAN_CAPTURA_COMPETENCIA.md: tabla prospectos_competencia (comercios no-clientes con lat/lng), con RLS multi-tenant. Distancia a paradas de ruta se calcula en la aplicación (sin PostGIS).')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
