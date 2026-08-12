-- ═══════════════════════════════════════════════════════════════════════════
-- 321_saas_mi_plan_tier.sql
--
-- Contexto: al portar el bloque de cambio de plan self-service (self-serve
-- upgrade/downgrade, saas_tenant_cambiar_plan() / migración 187) desde la
-- página huérfana mi-suscripcion.html hacia la vista tenant de
-- saas-billing.html, la vista tenant necesita saber el plan_tier
-- ('basico'/'pro'/'enterprise') actual de la empresa para poder marcar
-- "tu plan actual" y decidir si cada opción es upgrade o downgrade.
--
-- saas_mi_suscripcion() (migración 319, fix en 320) ya resuelve esto para
-- el resto de los datos de suscripción, pero esta migración no toca esa
-- función: no tenemos su definición actual en este working copy (319/320
-- se aplicaron directo contra producción en una sesión anterior y no están
-- en este ZIP), así que reescribirla a ciegas con CREATE OR REPLACE
-- arriesgaría perder el fix de e.activa u otro detalle ya validado en
-- producción. En cambio, se agrega una función nueva, chica y aditiva,
-- que replica únicamente el patrón de acceso ya usado ahí: JOIN con
-- usuarios (u.id = auth.uid(), u.activo = true), SECURITY DEFINER, SIN
-- filtro e.activa (ese es justamente el bug que se corrigió en 320 — una
-- empresa suspendida sigue necesitando ver/cambiar esto).
--
-- No requiere cambios de RLS ni de policies existentes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.saas_mi_plan_tier()
RETURNS public.plan_tier
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.plan_tier
  FROM public.usuarios u
  JOIN public.empresas e ON e.id = u.empresa_id
  WHERE u.id = auth.uid()
    AND u.activo = true;
$$;

COMMENT ON FUNCTION public.saas_mi_plan_tier() IS
  'Devuelve el plan_tier de la empresa del usuario autenticado, incluso si la empresa está suspendida (no filtra por e.activa). Usado por la vista tenant de saas-billing.html para el selector de cambio de plan self-service (migración 321, complementa 187/319/320).';

REVOKE ALL ON FUNCTION public.saas_mi_plan_tier() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.saas_mi_plan_tier() TO authenticated;
