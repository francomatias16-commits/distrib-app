-- ============================================================
-- MIGRACIÓN 085 — Facturación ARCA (WSFEv1 / WSAA)
-- distrib v104+  |  reemplaza al proveedor anterior (FacturAPI)
--
-- NOTA: esta migración ya fue aplicada en producción. Este
-- archivo documenta el esquema real existente en Supabase
-- (verificado contra information_schema.columns). Si se corre
-- de nuevo, los IF NOT EXISTS hacen que sea inocua.
-- ============================================================

-- ============================================================
-- TABLA 1: facturacion_config
--   Una fila por empresa. Guarda CUIT, punto de venta, condición
--   de IVA, domicilio y las credenciales del certificado ARCA
--   (cert/clave). El cert y la clave NUNCA deben ser legibles
--   desde el frontend: por eso quedan fuera de
--   get_facturacion_config() y la tabla solo es accesible por
--   service_role.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.facturacion_config (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cuit             text NOT NULL,
  punto_venta      integer NOT NULL DEFAULT 1,
  condicion_iva    text,
  razon_social     text,
  domicilio        text,
  cert_pem         text,
  key_pem          text,
  homologacion     boolean NOT NULL DEFAULT true,
  activo           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id)
);

ALTER TABLE public.facturacion_config ENABLE ROW LEVEL SECURITY;

-- Nadie en authenticated puede leer/escribir esta tabla directo.
-- Todo pasa por service_role (backend) o por la RPC de abajo.
DROP POLICY IF EXISTS service_role_all_facturacion_config ON public.facturacion_config;
CREATE POLICY service_role_all_facturacion_config ON public.facturacion_config
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- TABLA 2: tokens_wsaa
--   Caché del token de autenticación WSAA por empresa. Máximo
--   1 fila por empresa_id; se sobreescribe cuando vence.
--   `expiration` guarda el vencimiento del token (no se separa
--   generation_time / expiration_time).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tokens_wsaa (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  token            text NOT NULL,
  sign             text NOT NULL,
  expiration       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_tokens_wsaa_expiration
  ON public.tokens_wsaa USING btree (expiration);

ALTER TABLE public.tokens_wsaa ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_tokens_wsaa ON public.tokens_wsaa;
CREATE POLICY service_role_all_tokens_wsaa ON public.tokens_wsaa
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- RPC: get_facturacion_config()
--   Devuelve el estado de configuración para el frontend, SIN
--   exponer cert_pem ni key_pem. Solo accesible por usuarios
--   autenticados de la propia empresa.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_facturacion_config()
RETURNS TABLE (
  configurado    boolean,
  cuit           text,
  punto_venta    integer,
  condicion_iva  text,
  razon_social   text,
  domicilio      text,
  homologacion   boolean,
  activo         boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    true,
    fc.cuit,
    fc.punto_venta,
    fc.condicion_iva,
    fc.razon_social,
    fc.domicilio,
    fc.homologacion,
    fc.activo
  FROM public.facturacion_config fc
  JOIN public.usuarios u ON u.empresa_id = fc.empresa_id
  WHERE u.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_facturacion_config FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_facturacion_config TO authenticated;

COMMENT ON FUNCTION public.get_facturacion_config IS
  'Devuelve el estado de configuración de facturación ARCA de la empresa del '
  'usuario logueado. Nunca expone cert_pem ni key_pem: esos campos solo se '
  'leen vía service_role desde el backend (lib/arca/wsaa.js, wsfev1.js).';

COMMIT;
