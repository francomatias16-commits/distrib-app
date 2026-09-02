-- =============================================================
-- 551_captura_competencia_tablas.sql
--
-- Fase 0.2 + 1 de PLAN_CAPTURA_COMPETENCIA.md (Capa 2 — MVP):
-- vendedor de campo saca una foto de la factura/remito de un
-- competidor en el mostrador, el sistema extrae los renglones por
-- visión (ver lib/handlers/captura-competencia/_extraccion.js),
-- los matchea contra el catálogo propio (fn_captura_matchear_producto,
-- migración 552) y muestra el ahorro antes de convertir a pedido.
--
-- Mismo criterio de multi-tenant que el resto del proyecto: RLS por
-- empresa_id vía public.get_empresa_id(), y el INSERT/UPDATE real lo
-- hace siempre el handler con SERVICE_ROLE_KEY (nunca el browser
-- directo vía PostgREST) — mismo patrón que
-- asistente_acciones_pendientes (419).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.captura_competencia (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                    uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id                    uuid REFERENCES public.clientes(id) ON DELETE SET NULL, -- null: todavía es prospecto sin alta
  vendedor_id                   uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  proveedor_competencia_nombre  text,
  imagen_original_url           text NOT NULL, -- PATH dentro del bucket privado 'capturas-competencia' (no URL pública, ver storage-urls.js)
  fecha_captura                 timestamptz NOT NULL DEFAULT now(),
  estado                        text NOT NULL DEFAULT 'pendiente_revision'
                                  CHECK (estado IN ('pendiente_revision', 'revisado', 'convertido_pedido', 'descartado')),
  total_competencia             numeric(12,2),
  total_propio_cotizado         numeric(12,2),
  ahorro_absoluto               numeric(12,2),
  ahorro_porcentual             numeric(5,2),
  metadata                      jsonb NOT NULL DEFAULT '{}'::jsonb, -- respuesta cruda de la extracción por visión
  pedido_id                     uuid REFERENCES public.pedidos(id) ON DELETE SET NULL, -- se completa al convertir (accion=convertir)
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.captura_competencia_items (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captura_id                    uuid NOT NULL REFERENCES public.captura_competencia(id) ON DELETE CASCADE,
  texto_original                text NOT NULL, -- lo que la extracción por visión leyó, sin procesar — se conserva siempre (plan 1.5) para auditar/reprocesar
  producto_id                   uuid REFERENCES public.productos(id) ON DELETE SET NULL, -- null hasta que se matchea/confirma
  cantidad                      numeric(10,2) NOT NULL DEFAULT 0,
  precio_unitario_competencia   numeric(12,2),
  precio_unitario_propio        numeric(12,2),
  confianza_match                numeric(3,2), -- 0.00–1.00, score de fn_captura_matchear_producto
  confirmado_manualmente        boolean NOT NULL DEFAULT false,
  descartado                    boolean NOT NULL DEFAULT false,
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_captura_competencia_empresa_estado
  ON public.captura_competencia(empresa_id, estado, fecha_captura DESC);

CREATE INDEX IF NOT EXISTS idx_captura_competencia_vendedor
  ON public.captura_competencia(vendedor_id, estado);

CREATE INDEX IF NOT EXISTS idx_captura_competencia_items_captura
  ON public.captura_competencia_items(captura_id);

ALTER TABLE public.captura_competencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captura_competencia_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS captura_competencia_empresa ON public.captura_competencia;
CREATE POLICY captura_competencia_empresa ON public.captura_competencia
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

-- captura_competencia_items no tiene empresa_id propio (evita duplicar la
-- columna en cada renglón) — RLS via join contra la captura dueña, mismo
-- criterio que ya usa el proyecto para tablas *_items (ver
-- ordenes_compra_items / pedidos_items).
DROP POLICY IF EXISTS captura_competencia_items_empresa ON public.captura_competencia_items;
CREATE POLICY captura_competencia_items_empresa ON public.captura_competencia_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.captura_competencia cc
      WHERE cc.id = captura_competencia_items.captura_id
        AND cc.empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    )
  );

REVOKE ALL ON public.captura_competencia FROM anon, authenticated;
REVOKE ALL ON public.captura_competencia_items FROM anon, authenticated;
GRANT SELECT ON public.captura_competencia TO authenticated;
GRANT SELECT ON public.captura_competencia_items TO authenticated;

COMMENT ON TABLE public.captura_competencia IS
  'Fase 1 (PLAN_CAPTURA_COMPETENCIA.md): snapshot de cada factura/remito de competencia relevado por un vendedor en el mostrador, con la comparación de precios contra el catálogo propio.';
COMMENT ON TABLE public.captura_competencia_items IS
  'Renglones parseados de una captura_competencia (uno por producto de la factura de competencia), con su match (o no) contra productos propios.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '551_captura_competencia_tablas.sql', '551', 'claude-session',
  'Fase 0.2/1 de PLAN_CAPTURA_COMPETENCIA.md: tablas captura_competencia y captura_competencia_items, con RLS multi-tenant. Base de la Capa 2 (MVP): captura y comparación de factura de competencia en el mostrador.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
