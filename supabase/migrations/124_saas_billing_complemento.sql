-- 124_saas_billing_complemento.sql
-- Complemento de 123: índices adicionales y ajustes post-deploy.
-- Idempotente.

-- Agregar índice en empresas para queries de cron (plan + suspendida)
CREATE INDEX IF NOT EXISTS idx_empresas_saas_plan
  ON public.empresas(saas_plan, saas_suspendida)
  WHERE saas_plan IN ('trial','activo','suspendido');

-- Vista pública para que cada empresa vea su propio estado SaaS (en el panel de billing del cliente)
CREATE OR REPLACE VIEW public.saas_mi_estado AS
SELECT
  e.saas_plan,
  e.saas_trial_fin,
  e.saas_suspendida,
  e.saas_precio_mes,
  e.saas_suspendida_at,
  f.numero          AS ultima_factura_numero,
  f.monto           AS ultima_factura_monto,
  f.estado          AS ultima_factura_estado,
  f.fecha_vencimiento AS ultima_factura_vencimiento,
  (SELECT cbu   FROM public.saas_config WHERE id = 1) AS cbu,
  (SELECT alias FROM public.saas_config WHERE id = 1) AS alias_cbu,
  (SELECT titular FROM public.saas_config WHERE id = 1) AS titular_cbu,
  (SELECT banco FROM public.saas_config WHERE id = 1) AS banco_cbu
FROM public.empresas e
LEFT JOIN LATERAL (
  SELECT numero, monto, estado, fecha_vencimiento
  FROM public.saas_facturas
  WHERE empresa_id = e.id
  ORDER BY created_at DESC
  LIMIT 1
) f ON true
WHERE e.id = public.get_empresa_id();

COMMENT ON VIEW public.saas_mi_estado IS 'Vista para el panel de la empresa: muestra su propio estado SaaS y datos de pago';
