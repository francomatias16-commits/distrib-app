-- Plan de comercialización, ítem 3.1/3.3.
-- empresas.saas_plan ya existe pero es un ESTADO DE CUENTA (trial/activo/suspendido/cancelado),
-- no un nivel de servicio. Se agrega plan_tier como concepto separado: el nivel
-- contratado (básico/pro/enterprise), independiente de si la cuenta está al día.

CREATE TYPE public.plan_tier AS ENUM ('trial', 'basico', 'pro', 'enterprise');

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS plan_tier public.plan_tier NOT NULL DEFAULT 'trial';

-- Empresas que ya están 'activo' (pagando) pero sin tier definido pasan a 'basico'
-- por default, para no dejarlas sin límite real tras esta migración.
UPDATE public.empresas SET plan_tier = 'basico' WHERE saas_plan = 'activo' AND plan_tier = 'trial';

COMMENT ON COLUMN public.empresas.plan_tier IS
  'Nivel de servicio contratado (independiente de saas_plan, que es el estado de la cuenta). '
  'Define los límites de uso vía la tabla planes_limites.';

-- Tabla de límites por tier, editable sin redeploy.
CREATE TABLE public.planes_limites (
  tier            public.plan_tier PRIMARY KEY,
  max_usuarios    INT,   -- NULL = ilimitado
  max_clientes    INT,
  max_pedidos_mes INT,
  nombre_visible  TEXT NOT NULL,
  precio_mes      NUMERIC(12,2),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.planes_limites (tier, max_usuarios, max_clientes, max_pedidos_mes, nombre_visible, precio_mes) VALUES
  ('trial',      1,  50,  100, 'Trial',      0),
  ('basico',     3,  200, NULL, 'Básico',     25000),
  ('pro',        10, NULL, NULL, 'Pro',        55000),
  ('enterprise', NULL, NULL, NULL, 'Enterprise', NULL);

ALTER TABLE public.planes_limites ENABLE ROW LEVEL SECURITY;
-- Lectura pública (la landing/wizard necesita mostrar precios y límites sin estar logueado).
CREATE POLICY planes_limites_lectura_publica ON public.planes_limites FOR SELECT USING (true);
-- Solo service_role escribe (el admin SaaS edita límites/precios vía backend, no directo).
REVOKE ALL ON public.planes_limites FROM anon, authenticated;
GRANT SELECT ON public.planes_limites TO anon, authenticated;
GRANT ALL ON public.planes_limites TO service_role;
