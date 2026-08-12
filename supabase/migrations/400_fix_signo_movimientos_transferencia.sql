-- =============================================================================
-- 400_fix_signo_movimientos_transferencia.sql
--
-- Aplicada directamente en producción; este archivo deja el cambio
-- registrado en el repo para no perder el historial.
--
-- Bug (mismo patrón que v399 para 'ajuste'): transferir_stock() guardaba
-- p_cantidad (siempre positivo) en movimientos_stock para AMBOS lados de la
-- transferencia (origen y destino), distinguiéndolos solo por deposito_id.
-- Como tipo='transferencia' es igual en las dos filas, no había forma de
-- saber -a partir de una sola fila- si ese depósito perdió o ganó stock,
-- lo que rompía cualquier suma/reporte que agregue por depósito (ver panel
-- "Productos modificados" en stock.js).
--
-- Fix: guardar la cantidad CON SIGNO: negativa en origen, positiva en
-- destino. No requiere backfill (no había filas tipo='transferencia' en
-- producción al momento de aplicar este fix).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.transferir_stock(
  p_producto_id      uuid,
  p_deposito_origen  uuid,
  p_deposito_destino uuid,
  p_cantidad         numeric,
  p_motivo           text DEFAULT 'transferencia_manual',
  p_notas            text DEFAULT NULL,
  p_usuario_id       uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_origen      UUID;
  v_empresa_destino     UUID;
  v_dep_lock1           UUID;
  v_dep_lock2           UUID;
  v_stock_origen        NUMERIC;
  v_stock_destino       NUMERIC;
  v_stock_origen_nuevo  NUMERIC;
  v_stock_destino_nuevo NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_origen  FROM public.depositos WHERE id = p_deposito_origen;
  SELECT empresa_id INTO v_empresa_destino FROM public.depositos WHERE id = p_deposito_destino;

  IF v_empresa_origen IS NULL OR v_empresa_destino IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF v_empresa_origen <> v_empresa_destino THEN
    RETURN json_build_object('ok', false, 'error', 'Ambos depósitos deben pertenecer a la misma empresa');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_origen
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_origen
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_origen, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_destino, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  -- Orden determinístico de locking (por id) para evitar deadlocks si dos
  -- transferencias cruzadas (A->B y B->A) corren en paralelo.
  IF p_deposito_origen < p_deposito_destino THEN
    v_dep_lock1 := p_deposito_origen;
    v_dep_lock2 := p_deposito_destino;
  ELSE
    v_dep_lock1 := p_deposito_destino;
    v_dep_lock2 := p_deposito_origen;
  END IF;

  PERFORM cantidad FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = v_dep_lock1 FOR UPDATE;
  PERFORM cantidad FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = v_dep_lock2 FOR UPDATE;

  SELECT cantidad INTO v_stock_origen
    FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;
  SELECT cantidad INTO v_stock_destino
    FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

  v_stock_origen_nuevo  := COALESCE(v_stock_origen, 0) - p_cantidad;
  v_stock_destino_nuevo := COALESCE(v_stock_destino, 0) + p_cantidad;

  IF v_stock_origen_nuevo < 0 THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'Stock insuficiente en el depósito de origen para transferir',
      'stock_disponible', COALESCE(v_stock_origen, 0)
    );
  END IF;

  UPDATE public.stock SET cantidad = v_stock_origen_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;

  UPDATE public.stock SET cantidad = v_stock_destino_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

  PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_origen, p_cantidad, p_motivo, p_usuario_id);

  INSERT INTO public.lotes (
    empresa_id, producto_id, deposito_id,
    numero_lote, cantidad, cantidad_disponible,
    estado
  ) VALUES (
    v_empresa_origen, p_producto_id, p_deposito_destino,
    'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
    p_cantidad, p_cantidad,
    'activo'
  );

  -- v400: cantidad CON SIGNO (negativa en origen) — antes se guardaba
  -- p_cantidad positivo en ambos lados y no se podía distinguir la
  -- dirección a partir de una sola fila.
  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
  VALUES
    (p_producto_id, p_deposito_origen, 'transferencia', -p_cantidad, p_motivo, p_deposito_destino, p_usuario_id, p_notas);

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
  VALUES
    (p_producto_id, p_deposito_destino, 'transferencia', p_cantidad, p_motivo, p_deposito_origen, p_usuario_id, p_notas);

  RETURN json_build_object(
    'ok',                   true,
    'stock_origen_nuevo',   v_stock_origen_nuevo,
    'stock_destino_nuevo',  v_stock_destino_nuevo,
    'deposito_origen',      p_deposito_origen,
    'deposito_destino',     p_deposito_destino,
    'cantidad',             p_cantidad
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.transferir_stock(uuid, uuid, uuid, numeric, text, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.transferir_stock IS
  'Transferencia atómica de stock entre dos depósitos de la misma empresa. '
  'Lockea ambas filas de stock (FOR UPDATE, orden determinístico anti-deadlock), '
  'rechaza (ok:false) si el origen quedaría negativo, sincroniza lotes/FEFO en '
  'ambos lados y registra un movimiento por depósito en movimientos_stock. '
  'v400: la cantidad en movimientos_stock ahora se guarda CON SIGNO (negativa '
  'en origen, positiva en destino) porque tipo=transferencia es el mismo en '
  'ambas filas y no distingue dirección por sí solo (mismo motivo que v399 '
  'para tipo=ajuste).';
