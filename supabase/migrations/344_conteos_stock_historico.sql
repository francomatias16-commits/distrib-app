-- =============================================================================
-- 344_conteos_stock_historico.sql
--
-- Roadmap v341, "Corrección de inventario / Conteo físico": antes, un ajuste
-- directo de stock (motivo inventario/conteo_fisico) solo dejaba un registro
-- en movimientos_stock con el delta aplicado — se perdía el detalle de
-- "cuánto decía el sistema" vs. "cuánto se contó realmente", que es
-- justamente lo que permite auditar recuentos periódicos y detectar
-- patrones de diferencia recurrentes por producto/depósito.
--
-- Esta migración agrega:
--   1) conteos_stock: snapshot histórico de cada conteo físico (sistema vs.
--      contado, con la diferencia ya calculada).
--   2) registrar_conteo_stock(): hace el ajuste atómico de stock (mismo
--      patrón de lock + sync de lotes/FEFO que ajustar_stock) Y registra el
--      snapshot en conteos_stock, en la misma transacción.
--
-- Aplicado directamente en producción el 2026-07-16.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.conteos_stock (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  producto_id        uuid NOT NULL REFERENCES public.productos(id) ON DELETE CASCADE,
  deposito_id        uuid NOT NULL REFERENCES public.depositos(id) ON DELETE CASCADE,
  cantidad_sistema   numeric NOT NULL,
  cantidad_contada   numeric NOT NULL,
  diferencia         numeric NOT NULL,
  motivo             text,
  notas              text,
  usuario_id         uuid REFERENCES public.usuarios(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conteos_stock_producto_dep ON public.conteos_stock(producto_id, deposito_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conteos_stock_empresa       ON public.conteos_stock(empresa_id, created_at DESC);

ALTER TABLE public.conteos_stock ENABLE ROW LEVEL SECURITY;

CREATE POLICY conteos_stock_empresa ON public.conteos_stock
  FOR ALL
  USING (empresa_id = get_empresa_id())
  WITH CHECK (empresa_id = get_empresa_id());

COMMENT ON TABLE public.conteos_stock IS
  'Snapshot histórico de cada conteo físico/corrección de inventario: cantidad '
  'que decía el sistema vs. la contada, con la diferencia ya calculada. '
  'Permite reconstruir patrones de diferencia recurrentes por producto/depósito '
  'a lo largo del tiempo (algo que un único movimiento de ajuste no permite). '
  'Poblada por registrar_conteo_stock().';

CREATE OR REPLACE FUNCTION public.registrar_conteo_stock(
  p_producto_id      uuid,
  p_deposito_id      uuid,
  p_cantidad_contada numeric,
  p_motivo           text DEFAULT 'conteo_fisico',
  p_notas            text DEFAULT NULL,
  p_usuario_id       uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id     UUID;
  v_stock_sistema  NUMERIC;
  v_diferencia     NUMERIC;
  v_conteo_id      UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_cantidad_contada IS NULL OR p_cantidad_contada < 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad contada debe ser un número mayor o igual a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_id FROM public.depositos WHERE id = p_deposito_id;
  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_sistema
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_sistema := COALESCE(v_stock_sistema, 0);
  v_diferencia := p_cantidad_contada - v_stock_sistema;

  UPDATE public.stock SET cantidad = p_cantidad_contada, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  IF v_diferencia > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_id,
      'CONTEO-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_diferencia, v_diferencia,
      'activo'
    );
  ELSIF v_diferencia < 0 THEN
    PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(v_diferencia), p_motivo, p_usuario_id);
  END IF;

  IF v_diferencia <> 0 THEN
    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
    VALUES
      (p_producto_id, p_deposito_id, 'ajuste', ABS(v_diferencia), p_motivo, p_usuario_id, p_notas);
  END IF;

  INSERT INTO public.conteos_stock
    (empresa_id, producto_id, deposito_id, cantidad_sistema, cantidad_contada, diferencia, motivo, notas, usuario_id)
  VALUES
    (v_empresa_id, p_producto_id, p_deposito_id, v_stock_sistema, p_cantidad_contada, v_diferencia, p_motivo, p_notas, p_usuario_id)
  RETURNING id INTO v_conteo_id;

  RETURN json_build_object(
    'ok',               true,
    'stock_nuevo',      p_cantidad_contada,
    'cantidad_sistema', v_stock_sistema,
    'diferencia',       v_diferencia,
    'conteo_id',        v_conteo_id
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.registrar_conteo_stock(uuid, uuid, numeric, text, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.registrar_conteo_stock IS
  'Ajuste de stock por conteo físico: fija el stock al valor contado (mismo '
  'patrón de lock + sync de lotes/FEFO que ajustar_stock) y además deja un '
  'snapshot histórico en conteos_stock (sistema vs. contado) para poder '
  'auditar recuentos periódicos a lo largo del tiempo.';

NOTIFY pgrst, 'reload schema';
