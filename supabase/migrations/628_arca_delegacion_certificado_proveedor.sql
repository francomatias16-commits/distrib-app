-- ============================================================
-- MIGRACIÓN 628 — Delegación de servicio ARCA (certificado único
-- del proveedor en vez de certificado por empresa)
--
-- Contexto: hasta ahora cada empresa necesitaba generar su propio
-- certificado ARCA (WSASS + Administrador de Certificados) y
-- cargarlo a mano vía scripts/cargar-certificado-arca.js. Eso es
-- inviable como flujo de autoservicio para un cliente final.
--
-- Desde esta migración, el proveedor (Fluxo) tiene UN SOLO
-- certificado propio, y cada empresa nueva solo necesita delegarle
-- el servicio "Factura Electrónica" a la CUIT del proveedor desde
-- su propio Administrador de Relaciones de Clave Fiscal (2 minutos,
-- sin certificados de su lado). El <Auth><Cuit> de cada comprobante
-- sigue siendo el de la empresa (eso no cambia) — lo único que
-- cambia es de qué certificado sale el <Token>/<Sign> del WSAA.
--
-- Empresas ya migradas con certificado propio (facturacion_config
-- con cert_pem/key_pem cargados) quedan automáticamente en
-- modo_certificado='propio' y no se ven afectadas por nada de esto.
-- ============================================================

-- ── 1) Columnas nuevas en facturacion_config ──────────────────
-- modo_certificado: 'propio' (legacy, cert por empresa) o
--   'delegado' (default para empresas nuevas, usa el cert único
--   del proveedor). Empresas existentes con cert_pem ya cargado
--   se marcan 'propio' para no cambiarles nada del flujo.
-- estado_delegacion: cacheado de la última verificación contra
--   ARCA (ver lib/arca/delegacion.js) para no tener que llamar al
--   webservice en cada carga de pantalla del wizard.

ALTER TABLE public.facturacion_config
  ADD COLUMN IF NOT EXISTS modo_certificado text NOT NULL DEFAULT 'delegado'
    CHECK (modo_certificado IN ('propio', 'delegado')),
  ADD COLUMN IF NOT EXISTS estado_delegacion text NOT NULL DEFAULT 'pendiente'
    CHECK (estado_delegacion IN ('pendiente', 'activa', 'rechazada')),
  ADD COLUMN IF NOT EXISTS delegacion_verificada_en timestamptz,
  ADD COLUMN IF NOT EXISTS delegacion_error text;

-- Backfill: cualquier empresa que ya tenga certificado propio
-- cargado se queda en modo 'propio' sin depender de ninguna
-- delegación (evita romper a los clientes ya migrados).
UPDATE public.facturacion_config
   SET modo_certificado = 'propio',
       estado_delegacion = 'activa'
 WHERE cert_pem IS NOT NULL
   AND key_pem IS NOT NULL
   AND modo_certificado = 'delegado';

-- ── 2) arca_proveedor_config ───────────────────────────────────
-- El ÚNICO certificado del proveedor (Fluxo), una fila por
-- ambiente (homologación/producción) — no por empresa. Cargado
-- una sola vez con scripts/cargar-certificado-proveedor.js.

CREATE TABLE IF NOT EXISTS public.arca_proveedor_config (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  homologacion boolean NOT NULL,
  cuit         text NOT NULL,
  cert_pem     text NOT NULL,
  key_pem      text NOT NULL,
  activo       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (homologacion)
);

ALTER TABLE public.arca_proveedor_config ENABLE ROW LEVEL SECURITY;

-- Igual que facturacion_config: nadie autenticado lo lee/escribe
-- directo, solo service_role (backend) o el script de carga.
DROP POLICY IF EXISTS service_role_all_arca_proveedor_config ON public.arca_proveedor_config;
CREATE POLICY service_role_all_arca_proveedor_config ON public.arca_proveedor_config
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.arca_proveedor_config IS
  'Certificado ARCA único del proveedor (Fluxo), usado para facturar en '
  'nombre de las empresas en modo_certificado=''delegado''. Una fila por '
  'ambiente (homologacion true/false), no por empresa. cert_pem/key_pem '
  'cifrados con lib/crypto-secrets.js (misma clave ARCA_SECRETS_KEY que '
  'facturacion_config).';

-- ── 3) tokens_wsaa_proveedor ────────────────────────────────────
-- Caché del token WSAA del proveedor — un solo token por ambiente,
-- compartido por TODAS las empresas en modo 'delegado' (a
-- diferencia de tokens_wsaa, que es 1 fila por empresa). Esto es
-- seguro porque el token identifica quién firma la llamada
-- (el proveedor), no en nombre de quién se factura — eso lo sigue
-- llevando el <Auth><Cuit> de cada request, tomado de
-- facturacion_config.cuit como siempre.

CREATE TABLE IF NOT EXISTS public.tokens_wsaa_proveedor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  homologacion boolean NOT NULL,
  token        text NOT NULL,
  sign         text NOT NULL,
  expiration   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (homologacion)
);

CREATE INDEX IF NOT EXISTS idx_tokens_wsaa_proveedor_expiration
  ON public.tokens_wsaa_proveedor USING btree (expiration);

ALTER TABLE public.tokens_wsaa_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_tokens_wsaa_proveedor ON public.tokens_wsaa_proveedor;
CREATE POLICY service_role_all_tokens_wsaa_proveedor ON public.tokens_wsaa_proveedor
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.tokens_wsaa_proveedor IS
  'Caché del token WSAA del proveedor (Fluxo), 1 fila por ambiente '
  '(homologacion true/false), compartida por todas las empresas en '
  'modo_certificado=''delegado''. Ver lib/arca/wsaa.js.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '628_arca_delegacion_certificado_proveedor.sql', '628', 'claude-session',
        'Arquitectura de delegación de servicio ARCA: agrega modo_certificado/estado_delegacion a facturacion_config (backfill automático a ''propio'' para empresas con cert ya cargado), y las tablas arca_proveedor_config (certificado único del proveedor, 1 fila por ambiente) y tokens_wsaa_proveedor (caché de token compartido por ambiente). Reemplaza el flujo de certificado-por-cliente por delegación de servicio vía Clave Fiscal, sin tocar el <Auth><Cuit> por empresa en wsfev1.js.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

COMMIT;
