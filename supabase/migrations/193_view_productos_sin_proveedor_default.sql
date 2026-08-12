-- =============================================================
-- 193_view_productos_sin_proveedor_default.sql
-- Gap de datos, no bug de código: ningún producto migrado trae
-- proveedor_id_default (el wizard SÍ lo soporta si el CSV mapea
-- la columna 'proveedor' — se verificó en código, no era bug),
-- así que la nota de débito automática en devoluciones queda
-- inactiva para toda distribuidora migrada hasta completar ese
-- campo. Esta vista da visibilidad al admin del gap por empresa.
--
-- IMPORTANTE: ver 194_fix_leak_crosstenant_v_productos_sin_proveedor_default.sql
-- — esta vista se creó originalmente SIN security_invoker=true,
-- lo que causaba fuga cross-tenant (corría con permisos del owner,
-- bypasseando la RLS de productos). 194 lo corrige. Este archivo
-- se dejó con la definición original tal como se aplicó, para que
-- el historial de migraciones refleje lo que realmente pasó en
-- producción; el fix vive en su propio archivo posterior.
-- =============================================================

CREATE OR REPLACE VIEW public.v_productos_sin_proveedor_default AS
SELECT
  empresa_id,
  count(*) FILTER (WHERE activo) AS productos_activos,
  count(*) FILTER (WHERE activo AND proveedor_id_default IS NULL) AS sin_proveedor_default,
  round(
    100.0 * count(*) FILTER (WHERE activo AND proveedor_id_default IS NULL)::numeric
    / NULLIF(count(*) FILTER (WHERE activo), 0)::numeric,
    1
  ) AS pct_sin_proveedor_default
FROM productos p
GROUP BY empresa_id;
