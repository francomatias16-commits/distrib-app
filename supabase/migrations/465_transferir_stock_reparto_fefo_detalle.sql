-- ═══════════════════════════════════════════════════════════════════════════
-- 465_transferir_stock_reparto_fefo_detalle.sql [reconstruida, ver 462]
--
-- transferir_stock() (usada por el asistente IA): al mover stock entre
-- depósitos, ahora reparte por FEFO real — consume los lotes de origen que
-- vencen antes y clona cada uno al depósito destino preservando
-- numero_lote, fecha_fabricacion, fecha_vencimiento y costo_unitario. Deja
-- el detalle de alta/consumo en movimientos_stock_lotes para ambos
-- movimientos (origen y destino). Si no hay lotes suficientes (stock legado
-- sin lote), el remanente se transfiere igual sin lote — no rompe la
-- transferencia. Orden determinístico de locking por id de depósito para
-- evitar deadlocks con transferencias cruzadas en paralelo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.transferir_stock(
  p_producto_id       uuid,
  p_deposito_origen   uuid,
  p_deposito_destino  uuid,
  p_cantidad          numeric,
  p_motivo            text DEFAULT 'transferencia_manual',
  p_notas             text DEFAULT NULL,
  p_usuario_id        uuid DEFAULT NULL,
  p_offline_local_id  text DEFAULT NULL
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
  v_existente_id        UUID;
  v_mov_origen_id       UUID;
  v_mov_destino_id      UUID;
  v_lote                RECORD;
  v_restante            NUMERIC;
  v_consumir            NUMERIC;
  v_lote_destino_id     UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.movimientos_stock
     WHERE offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad INTO v_stock_origen_nuevo
        FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;
      SELECT cantidad INTO v_stock_destino_nuevo
        FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

      RETURN json_build_object(
        'ok',                   true,
        'stock_origen_nuevo',   COALESCE(v_stock_origen_nuevo, 0),
        'stock_destino_nuevo',  COALESCE(v_stock_destino_nuevo, 0),
        'deposito_origen',      p_deposito_origen,
        'deposito_destino',     p_deposito_destino,
        'cantidad',             p_cantidad,
        'ya_existia',           true
      );
    END IF;
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

  -- offline_local_id: fila de origen se marca tal cual, fila de destino con
  -- sufijo '-destino' (mismo criterio que "entrega + cobro" en
  -- lib/handlers/pedidos.js).
  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, offline_local_id)
  VALUES
    (p_producto_id, p_deposito_origen, 'transferencia', p_cantidad, p_motivo, p_deposito_destino, p_usuario_id, p_notas,
     p_offline_local_id)
  RETURNING id INTO v_mov_origen_id;

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, offline_local_id)
  VALUES
    (p_producto_id, p_deposito_destino, 'transferencia', p_cantidad, p_motivo, p_deposito_origen, p_usuario_id, p_notas,
     CASE WHEN p_offline_local_id IS NOT NULL THEN p_offline_local_id || '-destino' ELSE NULL END)
  RETURNING id INTO v_mov_destino_id;

  -- ── Reparto FEFO real: se consumen los lotes de origen que vencen antes
  -- y se clona cada uno al depósito destino preservando numero_lote,
  -- fecha_fabricacion, fecha_vencimiento y costo_unitario. Si no hay
  -- lotes suficientes (stock legado sin lote), el remanente queda sin
  -- lote igual que en el resto del sistema — no rompe la transferencia.
  v_restante := p_cantidad;

  FOR v_lote IN
    SELECT id, cantidad_disponible, costo_unitario, fecha_vencimiento,
           numero_lote, fecha_fabricacion
      FROM public.lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_origen
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY fecha_vencimiento ASC NULLS LAST, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE public.lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = now()
     WHERE id = v_lote.id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_origen_id, v_lote.id, v_consumir, 'consumo');

    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
    ) VALUES (
      v_empresa_origen, p_producto_id, p_deposito_destino,
      COALESCE(v_lote.numero_lote, 'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI')),
      v_consumir, v_consumir,
      v_lote.costo_unitario, v_lote.fecha_fabricacion, v_lote.fecha_vencimiento,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_consumir, 'alta');

    v_restante := v_restante - v_consumir;
  END LOOP;

  -- Remanente sin lote de origen (stock legado): se crea igual un lote
  -- destino "vacío" para no perder cantidad, tal como se hacía antes,
  -- pero SOLO por la parte que efectivamente no tenía lote de origen.
  IF v_restante > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible, estado
    ) VALUES (
      v_empresa_origen, p_producto_id, p_deposito_destino,
      'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_restante, v_restante,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_restante, 'alta');
  END IF;

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

GRANT EXECUTE ON FUNCTION public.transferir_stock TO authenticated, service_role;

COMMENT ON FUNCTION public.transferir_stock IS
  'Transfiere stock entre depósitos (uso del asistente IA) repartiendo por '
  'FEFO real: consume lotes de origen por vencimiento y los clona al '
  'destino, dejando el detalle en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '465_transferir_stock_reparto_fefo_detalle.sql', '465', 'claude-session',
  'Reconstrucción retroactiva: transferir_stock() (asistente IA) y transferir_stock_entre_depositos() (POS) — ambas ya reparten por FEFO y dejan detalle en movimientos_stock_lotes en producción, solo faltaba versionar el archivo.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
