-- 141_create_superadmin_metrics_view.sql
-- Aplicada en Supabase: 2026-06-30 (auditoría)
--
-- Crea la vista que frontend/admin/superadmin.html espera y que no existía
-- (causaba que el panel de superadmin quedara roto / sin datos, fallando
-- silenciosamente con un console.error).
--
-- IMPORTANTE: el guard `WHERE public.is_saas_owner()` está puesto a propósito.
-- Sin él, cualquier usuario autenticado que consultara esta vista vía
-- supabase-js (sb.from('superadmin_metrics').select('*')) podría intentar ver
-- facturación y cantidad de usuarios/clientes de TODAS las empresas, no solo
-- la propia. El guard de la UI (chequeo de perfil.empresas.nombre ===
-- 'MF Web Solutions' en el JS de superadmin.html) es solo cosmético: no
-- protege la query real a la base. is_saas_owner() ya existe (SECURITY
-- DEFINER) y es la misma función que protege el resto del panel SaaS
-- (saas_panel_listar, saas_dashboard_kpis, etc.), así que mantiene
-- consistencia con el resto del sistema.
--
-- Verificado con SET LOCAL role authenticated + request.jwt.claims simulando
-- dos usuarios reales:
--   - dueño de MF Web Solutions (is_saas_owner()=true): ve las 3 empresas.
--   - dueño de un tenant cualquiera: 0 filas.

CREATE OR REPLACE VIEW public.superadmin_metrics AS
SELECT
  e.id                                          AS empresa_id,
  e.nombre                                      AS empresa,
  e.cuit                                        AS cuit,
  e.activa                                      AS activa,
  e.created_at                                  AS alta,
  COALESCE(u.total_usuarios, 0)                 AS total_usuarios,
  COALESCE(c.total_clientes, 0)                 AS total_clientes,
  COALESCE(f.facturacion_total, 0)              AS facturacion_total
FROM public.empresas e
LEFT JOIN LATERAL (
  SELECT count(*) AS total_usuarios
  FROM public.usuarios
  WHERE usuarios.empresa_id = e.id
) u ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS total_clientes
  FROM public.clientes
  WHERE clientes.empresa_id = e.id
) c ON true
LEFT JOIN LATERAL (
  SELECT sum(facturas.total) AS facturacion_total
  FROM public.facturas
  WHERE facturas.empresa_id = e.id
    AND facturas.estado NOT IN ('anulada', 'error_afip')
) f ON true
WHERE public.is_saas_owner()
ORDER BY e.nombre;

-- Solo lectura, solo autenticado (igual que el resto de la app). anon no la necesita.
REVOKE ALL ON public.superadmin_metrics FROM anon, public;
GRANT SELECT ON public.superadmin_metrics TO authenticated;
