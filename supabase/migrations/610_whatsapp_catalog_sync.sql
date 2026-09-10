-- ============================================================
-- MIGRACIÓN 610 — Sincronización de catálogo de WhatsApp (Commerce Manager)
-- distrib
--
-- Pedido de CLAY: ahora que Meta habilitó la cuenta para catálogo, poder
-- sincronizar el catálogo de productos de distrib con el catálogo de
-- WhatsApp/Commerce Manager de cada empresa. Mecanismo replicado del que
-- ya funciona en el proyecto Trejo (ver README_INTEGRACION_META.md de ese
-- proyecto), adaptado acá a multi-tenant (empresa_id en cada fila) y al
-- patrón handler/repo + Vercel Cron de distrib (no Edge Functions).
--
-- Decisiones de diseño (mismas que se le explicaron a CLAY antes de
-- arrancar):
--  1. La tabla `productos` (con su precio/stock reales, gobernados por el
--     ERP) sigue siendo la fuente de verdad. El catálogo de WhatsApp es
--     una vidriera: se sincroniza nombre/descripción/imagen desde acá
--     hacia Meta, y se IMPORTAN productos que falten desde Meta, pero
--     nunca se pisa precio/stock automáticamente — si Meta trae un precio
--     distinto al interno, se marca 'conflicto' para revisión manual.
--  2. `catalog_id` + `catalog_access_token` se agregan a `empresa_whatsapp`
--     (ya existe 1 fila por empresa con sus credenciales de Meta, migración
--     272) en vez de crear una tabla nueva — es la misma cuenta de Meta,
--     solo un permiso más (catalog_management).
--  3. `retailer_id` = `productos.id` (uuid) convertido a texto — mismo
--     criterio que Trejo, identificador estable que no depende de nombres
--     que puedan cambiar.
--  4. `producto_whatsapp_catalog_map` guarda el estado de sincronización
--     por producto (no todo se resuelve con un simple JOIN por
--     retailer_id porque hace falta registrar conflictos de precio,
--     último intento, y errores puntuales sin tumbar el resto del batch).
--  5. RLS: mismo criterio que empresa_whatsapp — sin policies de
--     escritura para anon/authenticated (solo service_role, que usan los
--     handlers), con SELECT de lectura para dueño/admin de la propia
--     empresa (para el resumen en el panel).
-- ============================================================

-- ── empresa_whatsapp: credenciales del catálogo ─────────────────────────
ALTER TABLE public.empresa_whatsapp
  ADD COLUMN IF NOT EXISTS catalog_id             TEXT,
  ADD COLUMN IF NOT EXISTS catalog_access_token    TEXT,
  ADD COLUMN IF NOT EXISTS catalog_conectado_por   UUID REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS catalog_conectado_en    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS catalog_ultima_sync_en  TIMESTAMPTZ;

COMMENT ON COLUMN public.empresa_whatsapp.catalog_access_token IS
  'Cifrado con AES-256-GCM vía lib/crypto-secrets.js (prefijo "v1:"), mismo '
  'criterio que access_token (migración 273). Token de Facebook Login for '
  'Business con permiso catalog_management, INDEPENDIENTE del access_token '
  'de WhatsApp Cloud API — una empresa puede tener uno sin el otro.';

-- ── producto_whatsapp_catalog_map: estado de sync por producto ─────────
CREATE TABLE IF NOT EXISTS public.producto_whatsapp_catalog_map (
  producto_id           UUID PRIMARY KEY REFERENCES public.productos(id) ON DELETE CASCADE,
  empresa_id            UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  retailer_id           TEXT NOT NULL,
  estado                TEXT NOT NULL DEFAULT 'pendiente'
                           CHECK (estado IN ('ok', 'conflicto', 'pendiente', 'error')),
  precio_meta           NUMERIC(12,2),
  precio_meta_raw       TEXT,          -- string tal cual lo devuelve Meta, para diagnóstico
  detalle               TEXT,          -- motivo del conflicto/error, para mostrar en el panel
  origen                TEXT NOT NULL DEFAULT 'push_panel'
                           CHECK (origen IN ('push_panel', 'import_meta')),
  ultima_sincronizacion TIMESTAMPTZ,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS producto_whatsapp_catalog_map_retailer_id_key
  ON public.producto_whatsapp_catalog_map (empresa_id, retailer_id);

CREATE INDEX IF NOT EXISTS idx_producto_whatsapp_catalog_map_empresa_estado
  ON public.producto_whatsapp_catalog_map (empresa_id, estado);

ALTER TABLE public.producto_whatsapp_catalog_map ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.producto_whatsapp_catalog_map FROM anon, authenticated;

DROP POLICY IF EXISTS producto_whatsapp_catalog_map_lectura_dueno_admin ON public.producto_whatsapp_catalog_map;
CREATE POLICY producto_whatsapp_catalog_map_lectura_dueno_admin ON public.producto_whatsapp_catalog_map
  FOR SELECT USING (
    empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    AND public.get_rol_usuario() IN ('dueno', 'admin')
  );

GRANT SELECT ON public.producto_whatsapp_catalog_map TO authenticated;

COMMENT ON TABLE public.producto_whatsapp_catalog_map IS
  'Estado de sincronización por producto contra el catálogo de WhatsApp/'
  'Commerce Manager de Meta (retailer_id = productos.id::text). Escritura '
  'solo service_role (lib/handlers/whatsapp-catalog.js); lectura para '
  'dueño/admin de la propia empresa, usada por el panel de Configuración '
  'para mostrar el resumen creados/actualizados/conflictos.';

-- ── Vista de estado no sensible (mismo patrón que v_empresa_whatsapp_estado) ──
CREATE OR REPLACE VIEW public.v_empresa_whatsapp_catalog_estado AS
SELECT
  ew.empresa_id,
  ew.catalog_id,
  ew.catalog_conectado_por,
  ew.catalog_conectado_en,
  ew.catalog_ultima_sync_en
FROM public.empresa_whatsapp ew;

ALTER VIEW public.v_empresa_whatsapp_catalog_estado SET (security_invoker = true);

DROP POLICY IF EXISTS empresa_whatsapp_lectura_catalog_dueno_admin ON public.empresa_whatsapp;
CREATE POLICY empresa_whatsapp_lectura_catalog_dueno_admin ON public.empresa_whatsapp
  FOR SELECT USING (
    empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    AND public.get_rol_usuario() IN ('dueno', 'admin')
  );

GRANT SELECT (empresa_id, catalog_id, catalog_conectado_por, catalog_conectado_en, catalog_ultima_sync_en)
  ON public.empresa_whatsapp TO authenticated;
GRANT SELECT ON public.v_empresa_whatsapp_catalog_estado TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '610_whatsapp_catalog_sync.sql',
  '610',
  'claude-session',
  'Agrega catalog_id/catalog_access_token (cifrado) a empresa_whatsapp y '
  'la tabla producto_whatsapp_catalog_map (estado por producto: ok/'
  'conflicto/pendiente/error, retailer_id = productos.id::text) para la '
  'sincronización con el catálogo de WhatsApp Commerce Manager. Vista '
  'v_empresa_whatsapp_catalog_estado para el panel, mismo patrón que '
  'v_empresa_whatsapp_estado (migración 272).'
)
ON CONFLICT DO NOTHING;
