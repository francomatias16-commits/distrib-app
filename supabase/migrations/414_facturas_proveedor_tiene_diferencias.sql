-- ============================================================
-- 414_facturas_proveedor_tiene_diferencias.sql
--
-- Control en la UI de facturas de proveedor con diferencias contra la OC
-- (badge en la lista, tarjeta KPI, filtro "solo con diferencias" y alerta
-- en la campanita del topbar — ver handleAlertas en admin.js).
--
-- discrepancias (jsonb) ya existe desde la 056 y la llena conciliar_oc_factura()
-- con un array de ítems fuera de umbral. Antes había que evaluar en JS
-- "¿discrepancias no es null y tiene elementos?" en cada lugar que lo
-- necesitaba (badge, KPI, filtro, alerta) — se agrega una columna generada
-- para poder filtrar/indexar directo en Postgres, una sola fuente de verdad.
-- ============================================================

ALTER TABLE public.facturas_proveedor
  ADD COLUMN IF NOT EXISTS tiene_diferencias boolean
  GENERATED ALWAYS AS (
    discrepancias IS NOT NULL AND jsonb_array_length(discrepancias) > 0
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_fp_tiene_diferencias
  ON public.facturas_proveedor (empresa_id, tiene_diferencias)
  WHERE tiene_diferencias = true;
