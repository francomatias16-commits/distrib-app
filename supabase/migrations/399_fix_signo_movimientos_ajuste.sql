-- =============================================================================
-- 399_fix_signo_movimientos_ajuste.sql
--
-- Aplicada directamente en producción; este archivo deja el cambio
-- registrado en el repo para no perder el historial (ver conversación de
-- diagnóstico del panel "Productos modificados" en stock.js).
--
-- Bug: registrar_conteo_stock() guardaba ABS(diferencia) en
-- movimientos_stock con tipo='ajuste', igual que ajustar_stock() hace con
-- ingreso/egreso. La diferencia es que 'ajuste' es un único tipo para las
-- dos direcciones (sobra/falta), así que sin signo en `cantidad` no hay
-- forma de saber si el conteo encontró más o menos stock que el sistema.
--
-- Fix: guardar v_diferencia (con signo) directamente en `cantidad`, y
-- enlazar el movimiento a su conteo vía `referencia_id`.
-- =============================================================================

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

  INSERT INTO public.conteos_stock
    (empresa_id, producto_id, deposito_id, cantidad_sistema, cantidad_contada, diferencia, motivo, notas, usuario_id)
  VALUES
    (v_empresa_id, p_producto_id, p_deposito_id, v_stock_sistema, p_cantidad_contada, v_diferencia, p_motivo, p_notas, p_usuario_id)
  RETURNING id INTO v_conteo_id;

  IF v_diferencia <> 0 THEN
    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
    VALUES
      (p_producto_id, p_deposito_id, 'ajuste', v_diferencia, p_motivo, v_conteo_id, p_usuario_id, p_notas);
  END IF;

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

COMMENT ON FUNCTION public.registrar_conteo_stock IS
  'Ajuste de stock por conteo físico: fija el stock al valor contado (mismo '
  'patrón de lock + sync de lotes/FEFO que ajustar_stock) y deja un snapshot '
  'histórico en conteos_stock (sistema vs. contado). v399: el movimiento en '
  'movimientos_stock ahora guarda la diferencia CON SIGNO (antes ABS()), '
  'porque tipo=ajuste no trae el signo implícito como ingreso/egreso, y '
  'queda enlazado a su conteo vía referencia_id.';
