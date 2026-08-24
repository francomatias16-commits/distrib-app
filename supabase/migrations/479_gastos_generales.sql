-- ============================================================================
-- 479_gastos_generales.sql
--
-- Cierra la brecha para que "Ganancia Neta" sea de verdad neta: hasta acá
-- reportes-financieros.js calculaba Margen Bruto (ingresos - costo de
-- producto vendido) pero no restaba los gastos fijos del negocio
-- (alquiler, sueldos, servicios, impuestos, etc). Con esta migración:
--   Ganancia Neta = Margen Bruto - Gastos Generales del período.
--
-- 1) Tabla gastos_generales: carga manual de gastos por categoría, con
--    soft-delete vía `activo` (mismo criterio que el resto del sistema).
--    RLS: una única política ALL por empresa_id (mismo criterio que el
--    resto de tablas post Fase 18 — el filtro por rol de escritura vive en
--    permisos-service.js, no en RLS).
--
-- 2) obtener_resumen_gastos_generales(): total + desglose por categoría
--    del período pedido. Sigue la convención de 478_...: si la migración
--    no corrió todavía en una empresa, el handler la llama con Promise.all
--    junto a lo demás y, si falla, degrada el campo a null.
--
-- NOTA: esta migración ya fue aplicada directamente en producción (ver
-- schema_migrations_registry, numero 479). Este archivo documenta el
-- estado real de la base para mantener el repo sincronizado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.gastos_generales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  categoria    TEXT NOT NULL CHECK (categoria IN ('alquiler','sueldos','servicios','impuestos','otros')),
  descripcion  TEXT NOT NULL,
  monto        NUMERIC(14,2) NOT NULL CHECK (monto >= 0),
  fecha        DATE NOT NULL,
  recurrente   BOOLEAN NOT NULL DEFAULT false,
  notas        TEXT,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gastos_generales_empresa_fecha
  ON public.gastos_generales (empresa_id, fecha DESC)
  WHERE activo = true;

ALTER TABLE public.gastos_generales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gastos_generales_empresa ON public.gastos_generales;
CREATE POLICY gastos_generales_empresa ON public.gastos_generales
  FOR ALL USING (
    empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.obtener_resumen_gastos_generales(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH periodo AS (
    SELECT * FROM gastos_generales
    WHERE empresa_id = p_empresa_id
      AND activo = true
      AND fecha >= p_desde::date AND fecha <= p_hasta::date
  ),
  por_categoria AS (
    SELECT categoria, COALESCE(SUM(monto), 0) AS total, COUNT(*) AS cantidad
    FROM periodo
    GROUP BY categoria
  )
  SELECT jsonb_build_object(
    'total_periodo',    COALESCE((SELECT SUM(monto) FROM periodo), 0),
    'cantidad_periodo', (SELECT COUNT(*) FROM periodo),
    'por_categoria', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'categoria', categoria, 'total', total, 'cantidad', cantidad
      ) ORDER BY total DESC)
      FROM por_categoria
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_resumen_gastos_generales FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_resumen_gastos_generales TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '479_gastos_generales.sql', '479', 'claude-session', 'Tabla gastos_generales (categoría/descripción/monto/fecha/recurrente, soft-delete) + RPC obtener_resumen_gastos_generales() para que Ganancia Neta en Reportes → Finanzas sea Margen Bruto - Gastos Generales del período, y para la tab "Gastos" del Panel principal')
ON CONFLICT DO NOTHING;
