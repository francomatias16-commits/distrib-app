-- =============================================================
-- 555_cliente_ahorro_acumulado.sql
--
-- PLAN_CAPTURA_COMPETENCIA.md, Fase 2 (Capa 3 — retención): contador de
-- ahorro acumulado por cliente contra el precio de competencia congelado
-- en su captura_competencia de origen (migración 551).
--
-- Numeración: producción ya tenía 551-554 aplicadas con otro contenido/
-- nombres de archivo (el 554 real fue revoke_anon_fn_captura_matchear_
-- producto). Este es el próximo número real disponible.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.cliente_ahorro_acumulado (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id            uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  empresa_id            uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  ahorro_acumulado      numeric(12,2) NOT NULL DEFAULT 0,
  pedidos_con_ahorro    integer NOT NULL DEFAULT 0,
  ultimo_pedido_id      uuid REFERENCES public.pedidos(id) ON DELETE SET NULL,
  ultima_actualizacion  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cliente_id)
);

CREATE TABLE IF NOT EXISTS public.ahorro_competencia_movimientos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id      uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  empresa_id      uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  pedido_id       uuid NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  ahorro_pedido   numeric(12,2) NOT NULL,
  detalle         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pedido_id)
);

CREATE INDEX IF NOT EXISTS idx_ahorro_competencia_movimientos_cliente
  ON public.ahorro_competencia_movimientos(cliente_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ahorro_competencia_movimientos_empresa
  ON public.ahorro_competencia_movimientos(empresa_id, created_at DESC);

ALTER TABLE public.cliente_ahorro_acumulado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ahorro_competencia_movimientos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cliente_ahorro_acumulado_select ON public.cliente_ahorro_acumulado;
CREATE POLICY cliente_ahorro_acumulado_select ON public.cliente_ahorro_acumulado
  FOR SELECT USING (
    es_admin()
    OR cliente_id IN (SELECT clientes.id FROM public.clientes WHERE clientes.usuario_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS ahorro_competencia_movimientos_select ON public.ahorro_competencia_movimientos;
CREATE POLICY ahorro_competencia_movimientos_select ON public.ahorro_competencia_movimientos
  FOR SELECT USING (
    es_admin()
    OR cliente_id IN (SELECT clientes.id FROM public.clientes WHERE clientes.usuario_id = (select auth.uid()))
  );

REVOKE ALL ON public.cliente_ahorro_acumulado FROM anon, authenticated;
REVOKE ALL ON public.ahorro_competencia_movimientos FROM anon, authenticated;
GRANT SELECT ON public.cliente_ahorro_acumulado TO authenticated;
GRANT SELECT ON public.ahorro_competencia_movimientos TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_registrar_ahorro_competencia(
  p_pedido_id     uuid,
  p_cliente_id    uuid,
  p_empresa_id    uuid,
  p_ahorro_pedido numeric,
  p_detalle       jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_filas int;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_ahorro_pedido IS NULL OR p_ahorro_pedido <= 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.ahorro_competencia_movimientos
    (cliente_id, empresa_id, pedido_id, ahorro_pedido, detalle)
  VALUES (p_cliente_id, p_empresa_id, p_pedido_id, p_ahorro_pedido, p_detalle)
  ON CONFLICT (pedido_id) DO NOTHING;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.cliente_ahorro_acumulado
    (cliente_id, empresa_id, ahorro_acumulado, pedidos_con_ahorro, ultimo_pedido_id, ultima_actualizacion)
  VALUES (p_cliente_id, p_empresa_id, p_ahorro_pedido, 1, p_pedido_id, now())
  ON CONFLICT (cliente_id) DO UPDATE
    SET ahorro_acumulado     = public.cliente_ahorro_acumulado.ahorro_acumulado + p_ahorro_pedido,
        pedidos_con_ahorro   = public.cliente_ahorro_acumulado.pedidos_con_ahorro + 1,
        ultimo_pedido_id     = p_pedido_id,
        ultima_actualizacion = now();
END;
$$;

REVOKE ALL ON FUNCTION public.fn_registrar_ahorro_competencia FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_registrar_ahorro_competencia TO service_role;

COMMENT ON TABLE public.cliente_ahorro_acumulado IS
  'Fase 2 (PLAN_CAPTURA_COMPETENCIA.md): ahorro acumulado por cliente contra el precio de competencia congelado en su captura_competencia de origen. 1 fila por cliente.';
COMMENT ON TABLE public.ahorro_competencia_movimientos IS
  'Historial de ahorro por pedido (Fase 2). UNIQUE(pedido_id): un pedido acredita ahorro una sola vez, aunque se reintente.';
COMMENT ON FUNCTION public.fn_registrar_ahorro_competencia IS
  'Fase 2 (PLAN_CAPTURA_COMPETENCIA.md): único camino de escritura de ahorro acumulado. Atómica (insert movimiento + upsert acumulado en la misma transacción) e idempotente por pedido_id.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '555_cliente_ahorro_acumulado.sql', '555', 'claude-session',
  'Fase 2 de PLAN_CAPTURA_COMPETENCIA.md: tablas cliente_ahorro_acumulado y ahorro_competencia_movimientos + fn_registrar_ahorro_competencia (RPC atómica e idempotente por pedido_id). RLS con aislamiento por cliente (auth.uid() en subquery) desde el día uno.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
