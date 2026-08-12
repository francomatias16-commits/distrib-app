-- =============================================================================
-- 342_transferir_stock_atomico.sql
--
-- Etapa 2, Hallazgo 3 (ver CHANGELOG_v341): la transferencia entre depósitos
-- se hacía con DOS llamadas RPC separadas a ajustar_stock (débito en origen,
-- crédito en destino) + lógica de reversión manual del lado cliente si la
-- segunda fallaba. Eso dejaba una ventana real de inconsistencia: si el
-- proceso del navegador se interrumpía entre ambas llamadas (cierre de
-- pestaña, corte de red) el stock quedaba débitado de origen sin acreditar
-- en destino, sin ninguna transacción de por medio que lo evite.
--
-- Fix: una única función SQL que hace débito + crédito dentro de la misma
-- transacción de Postgres. La atomicidad la garantiza la base, no el cliente.
--
-- Detalles:
--   - Valida que origen y destino no sean el mismo depósito.
--   - Valida que ambos depósitos pertenezcan a la misma empresa.
--   - Lockea ambas filas de stock en orden determinístico (por id) para
--     evitar deadlocks si dos transferencias cruzadas corren en paralelo.
--   - Rechaza (ok:false) si el origen quedaría en negativo, sin tocar nada.
--   - Sincroniza lotes/FEFO: consume FEFO en origen, crea lote nuevo en
--     destino (mismo patrón que ajustar_stock).
--   - Inserta un movimiento en movimientos_stock por cada lado (tipo
--     'transferencia'), cada uno con referencia_id apuntando al depósito
--     opuesto, para poder reconstruir el par desde cualquiera de los dos.
--
-- Aplicado directamente en producción el 2026-07-16; esta migración deja
-- el cambio registrado en el repo para no perder el historial.
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

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
  VALUES
    (p_producto_id, p_deposito_origen, 'transferencia', p_cantidad, p_motivo, p_deposito_destino, p_usuario_id, p_notas);

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
  'Reemplaza el patrón de dos llamadas a ajustar_stock con reversión manual '
  'del lado cliente (ver CHANGELOG_v341).';
