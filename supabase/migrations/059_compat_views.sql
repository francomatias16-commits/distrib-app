-- =============================================================================
-- 059_compat_views.sql
-- Views de compatibilidad para nombres inconsistentes en el código v65
-- =============================================================================

-- ── 1. cuenta_corriente → cta_cte ────────────────────────────────────────────
-- Usado en: frontend/cliente/js/checkout.js línea 71
-- Tabla real en backup: cta_cte
-- La view hereda RLS automáticamente de la tabla base en Postgres

CREATE OR REPLACE VIEW public.cuenta_corriente AS
SELECT
  id,
  empresa_id,
  cliente_id,
  saldo,
  limite_credito,
  updated_at
FROM public.cta_cte;

GRANT SELECT ON public.cuenta_corriente TO authenticated;

COMMENT ON VIEW public.cuenta_corriente IS
  'Vista de compatibilidad: mapea cta_cte → cuenta_corriente (usado en checkout.js)';


-- ── 2. perfiles → usuarios ────────────────────────────────────────────────────
-- NOTA (v69): lib/handlers/empresa.js fue corregido para usar .from('usuarios')
-- directamente — ya no depende de esta vista. Se deja creada por compatibilidad
-- retroactiva (por si algún otro módulo no incluido en este paquete la usa),
-- pero el código de este repo ya no la necesita.
-- Usado en: lib/handlers/empresa.js (empresa_id, rol lookup por auth.uid())
-- Tabla real en backup: usuarios
-- Expone solo las columnas que empresa.js necesita

CREATE OR REPLACE VIEW public.perfiles AS
SELECT
  id,
  empresa_id,
  rol,
  email,
  nombre,
  activo,
  created_at
FROM public.usuarios;

GRANT SELECT ON public.perfiles TO authenticated;

COMMENT ON VIEW public.perfiles IS
  'Vista de compatibilidad: mapea usuarios → perfiles (usado en handlers/empresa.js)';
