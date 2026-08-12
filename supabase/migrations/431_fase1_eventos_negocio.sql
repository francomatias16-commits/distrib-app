-- =============================================================
-- 431_fase1_eventos_negocio.sql
-- PLAN_ERP_SINCRONIZACION_2026.md — Fase 1: tabla de eventos de dominio
-- (outbox pattern).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.eventos_negocio (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tipo_evento   TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  origen        TEXT,
  estado        TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente','procesado','error')),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  procesado_en  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_eventos_negocio_empresa_tipo
  ON public.eventos_negocio(empresa_id, tipo_evento, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_eventos_negocio_pendientes
  ON public.eventos_negocio(creado_en)
  WHERE estado = 'pendiente';

ALTER TABLE public.eventos_negocio ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eventos_negocio_select_empresa ON public.eventos_negocio;
CREATE POLICY eventos_negocio_select_empresa ON public.eventos_negocio
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

REVOKE ALL ON public.eventos_negocio FROM anon, authenticated;
GRANT SELECT ON public.eventos_negocio TO authenticated;

COMMENT ON TABLE public.eventos_negocio IS
  'Fase 1 del plan de sincronización ERP (outbox pattern): registro explícito de cada acción de negocio relevante (pedido_creado, pedido_facturado, factura_anulada, ...), independiente de los efectos colaterales que ya disparan los handlers. Insertado siempre vía lib/eventos.js:emitirEvento() con service_role, fire-and-forget. Base de las fases 2 a 6 del plan.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '431_fase1_eventos_negocio.sql', '431', 'claude-session',
        'Fase 1 de PLAN_ERP_SINCRONIZACION_2026.md: tabla eventos_negocio (outbox pattern) — base física de las fases 2 a 6. Piloto: pedido_creado (crearPedidoParaCliente en pedidos.js), pedido_facturado y factura_anulada (emitirFactura/anularFactura en lib/facturas.js), todos vía el nuevo helper emitirEvento() de lib/eventos.js, fire-and-forget. Todavía no hay despachador escuchando estos eventos (eso es la fase 3) — esta etapa solo deja el rastro.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
