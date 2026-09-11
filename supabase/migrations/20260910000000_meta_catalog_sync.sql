-- ============================================================
-- Sincronización con el catálogo de Meta (WhatsApp Business /
-- Commerce Manager) — versión multi-tenant para distrib/Fluxo.
--
-- Adaptado del prototipo de un solo negocio (Distribuciones Trejo,
-- tabla singleton `meta_integration`) al modelo real del proyecto:
-- cada EMPRESA puede vincular su propio catálogo de Meta, igual que
-- ya pasa con `empresa_whatsapp` (Embedded Signup, Etapa 7).
--
-- Qué agrega:
--   1) Tabla `empresa_catalogo_meta` — credenciales de catálogo por
--      empresa (1 fila por empresa, no singleton global).
--   2) Columna `productos.retailer_id` — identificador estable para
--      matchear cada producto contra un ítem del catálogo de Meta.
--      Se usa el propio `id` (uuid) del producto como texto, así no
--      depende de nombres/códigos que puedan cambiar.
--   3) Unicidad de retailer_id ACOTADA POR EMPRESA (a diferencia del
--      prototipo de un solo negocio, acá dos empresas distintas
--      pueden tener productos con el mismo id sin pisarse — de
--      hecho es imposible que choquen porque son uuid, pero se deja
--      compuesta por prolijidad y para que quede explícito el
--      alcance por tenant).
-- ============================================================

CREATE TABLE IF NOT EXISTS empresa_catalogo_meta (
  empresa_id            UUID PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  catalog_id            TEXT,
  catalog_access_token  TEXT,   -- cifrado con lib/crypto-secrets.js (AES-256-GCM), mismo criterio que facturacion_config.cert_pem
  connected_at          TIMESTAMPTZ,
  ultima_sync_push_at   TIMESTAMPTZ,  -- último sync panel → Meta (carga inicial o push puntual)
  ultima_sync_pull_at   TIMESTAMPTZ,  -- último sync Meta → panel (espejo completo)
  created_at            TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE empresa_catalogo_meta ENABLE ROW LEVEL SECURITY;
-- Sin policies para anon/authenticated a propósito: esta tabla guarda un
-- token de acceso al catálogo de Meta. Solo la service_role (usada por los
-- handlers de lib/handlers/catalogo-meta.js vía lib/repos/_db.js) puede
-- leer/escribir — mismo criterio que empresa_whatsapp.

CREATE INDEX IF NOT EXISTS idx_empresa_catalogo_meta_catalog_id
  ON empresa_catalogo_meta(catalog_id);

-- Identificador estable para matchear contra el catálogo de Meta.
ALTER TABLE productos ADD COLUMN IF NOT EXISTS retailer_id TEXT;

UPDATE productos
  SET retailer_id = id::text
  WHERE retailer_id IS NULL;

-- Autocompletar retailer_id en altas nuevas sin tener que tocar
-- fn_crear_producto ni el resto de los paths de inserción existentes.
CREATE OR REPLACE FUNCTION public.fn_set_retailer_id_default()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.retailer_id IS NULL THEN
    NEW.retailer_id := NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_productos_retailer_id_default ON productos;
CREATE TRIGGER trg_productos_retailer_id_default
  BEFORE INSERT ON productos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_set_retailer_id_default();

CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_empresa_retailer_id
  ON productos(empresa_id, retailer_id);

COMMENT ON TABLE empresa_catalogo_meta IS
  'Credenciales del catálogo de Meta (WhatsApp/Commerce Manager) vinculado por empresa. Ver lib/handlers/catalogo-meta.js y lib/repos/catalogo-meta.js. Basado en el prototipo README_INTEGRACION_META.md (Distribuciones Trejo), adaptado a multi-tenant.';
