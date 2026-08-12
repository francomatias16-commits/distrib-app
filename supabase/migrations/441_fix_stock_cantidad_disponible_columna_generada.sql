-- 441_fix_stock_cantidad_disponible_columna_generada.sql
--
-- [reconstruido retroactivamente desde el estado real de producción — el
--  archivo original vivía en db/, carpeta ausente en los exports/zips del
--  repo. Definiciones verificadas contra pg_get_functiondef() e
--  information_schema.columns de la base viva. Las 3 funciones de negocio
--  (registrar_venta_pos, anular_venta_pos, transferir_stock_entre_depositos)
--  se reproducen en su versión VIGENTE hoy, que ya incluye los ajustes de
--  las migraciones posteriores 181/416/429/443/444 — no es exactamente el
--  diff puntual que corrió esta migración en su momento, pero deja el
--  repo consistente con lo que realmente hay corriendo.]
--
-- F4-04 (auditoría de páginas, Fase 4): cantidad_disponible pasa a ser
-- columna generada (GREATEST(cantidad - cantidad_reservada, 0)) en vez de
-- un valor que cada función debía sincronizar a mano. Se elimina el
-- trigger trg_sync_stock_disponible (obsoleto) y se repatchean las 6
-- funciones que la escribían directo: registrar_venta_pos,
-- anular_venta_pos, transferir_stock_entre_depositos, fn_crear_producto,
-- fn_deposito_crear_stock_inicial, fn_productos_crear_stock_inicial.
--
-- Confirmado contra la base real que rpc_crear_pedido (única función que
-- alguna vez calculó cantidad_disponible distinto, por lotes/FEFO) ya no
-- está en uso y ya no lo hace en producción.

BEGIN;

-- 1) Columna generada (solo si todavía no lo es).
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock'
       AND column_name = 'cantidad_disponible' AND is_generated = 'NEVER'
  ) THEN
    ALTER TABLE public.stock DROP COLUMN cantidad_disponible;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stock'
       AND column_name = 'cantidad_disponible'
  ) THEN
    ALTER TABLE public.stock
      ADD COLUMN cantidad_disponible numeric
      GENERATED ALWAYS AS (GREATEST(COALESCE(cantidad, 0) - COALESCE(cantidad_reservada, 0), 0)) STORED;
  END IF;
END
$do$;

-- 2) Trigger obsoleto que la sincronizaba a mano.
DROP TRIGGER IF EXISTS trg_sync_stock_disponible ON public.stock;
DROP FUNCTION IF EXISTS public.trg_fn_sync_stock_disponible();

-- 3) Repatch de las 6 funciones: ninguna escribe más cantidad_disponible
--    directo (postgres lo rechaza en una columna GENERATED).

CREATE OR REPLACE FUNCTION public.fn_deposito_crear_stock_inicial()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
  SELECT p.id, NEW.id, 0, 0, COALESCE(p.costo, 0)
  FROM public.productos p
  WHERE p.empresa_id = NEW.empresa_id
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_productos_crear_stock_inicial()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
  SELECT NEW.id, d.id, 0, 0, COALESCE(NEW.costo, 0)
  FROM public.depositos d
  WHERE d.empresa_id = NEW.empresa_id
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_crear_producto(p_nombre text, p_deposito_ids uuid[], p_codigo text DEFAULT NULL::text, p_categoria_id uuid DEFAULT NULL::uuid, p_precio_base numeric DEFAULT 0, p_costo numeric DEFAULT 0, p_stock_minimo numeric DEFAULT 0, p_activo boolean DEFAULT true, p_foto_url text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id  uuid := public.get_empresa_id();
  v_producto_id uuid;
  v_ids_validos uuid[];
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
    RAISE EXCEPTION 'El nombre del producto es obligatorio.';
  END IF;

  SELECT array_agg(d.id) INTO v_ids_validos
  FROM public.depositos d
  WHERE d.empresa_id = v_empresa_id
    AND d.id = ANY(p_deposito_ids);

  IF v_ids_validos IS NULL OR array_length(v_ids_validos, 1) IS NULL THEN
    RAISE EXCEPTION 'Debe seleccionar al menos un depósito válido para el producto nuevo.';
  END IF;

  INSERT INTO public.productos (
    empresa_id, codigo, nombre, categoria_id,
    precio_base, costo, stock_minimo, activo, foto_url
  ) VALUES (
    v_empresa_id, NULLIF(trim(p_codigo), ''), p_nombre, p_categoria_id,
    p_precio_base, p_costo, p_stock_minimo, p_activo, NULLIF(trim(p_foto_url), '')
  )
  RETURNING id INTO v_producto_id;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
  SELECT v_producto_id, d, 0, 0, COALESCE(p_costo, 0)
  FROM unnest(v_ids_validos) AS d
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN v_producto_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_venta_pos(p_empresa_id uuid, p_caja_id uuid, p_turno_id uuid, p_vendedor_id uuid, p_cliente_id uuid, p_deposito_id uuid, p_items jsonb, p_pagos jsonb, p_subtotal numeric, p_iva_total numeric, p_total numeric, p_descuento_global_pct numeric DEFAULT 0, p_offline_local_id text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta_id      UUID;
  v_numero        TEXT;
  v_item          JSONB;
  v_pago          JSONB;
  v_producto_id   UUID;
  v_cantidad      NUMERIC;
  v_disponible    NUMERIC;
  v_suma_pagos    NUMERIC := 0;
  v_limite        NUMERIC;
  v_saldo_actual  NUMERIC;
  v_monto_cta_cte NUMERIC := 0;
  v_existente_id  UUID;
  v_existente_num TEXT;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'tipo', 'no_autorizado', 'error', 'No autorizado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id, numero INTO v_existente_id, v_existente_num
      FROM public.ventas_pos
     WHERE empresa_id = p_empresa_id AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN json_build_object(
        'ok', true, 'venta_id', v_existente_id, 'numero', v_existente_num, 'ya_existia', true
      );
    END IF;
  END IF;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_suma_pagos
    FROM jsonb_array_elements(p_pagos) p;

  IF ABS(v_suma_pagos - p_total) > 1 THEN
    RETURN json_build_object('ok', false, 'tipo', 'pagos_no_coinciden',
      'error', 'La suma de los pagos no coincide con el total de la venta');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.turnos_caja
     WHERE id = p_turno_id AND caja_id = p_caja_id AND estado = 'abierto'
  ) THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_cerrado',
      'error', 'No hay un turno abierto para esta caja');
  END IF;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_monto_cta_cte
    FROM jsonb_array_elements(p_pagos) p WHERE p->>'medio' = 'cuenta_corriente';

  IF v_monto_cta_cte > 0 THEN
    IF p_cliente_id IS NULL THEN
      RETURN json_build_object('ok', false, 'tipo', 'cliente_requerido',
        'error', 'No se puede imputar a cuenta corriente sin un cliente seleccionado');
    END IF;

    SELECT limite_credito, COALESCE(saldo_deuda, 0) INTO v_limite, v_saldo_actual
      FROM public.clientes WHERE id = p_cliente_id;

    IF v_limite > 0 THEN
      IF v_saldo_actual + v_monto_cta_cte > v_limite THEN
        RETURN json_build_object('ok', false, 'tipo', 'limite_credito',
          'error', 'Supera el límite de crédito del cliente');
      END IF;
    END IF;
  END IF;

  SELECT 'POS-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
         LPAD(nextval('public.seq_ventas_pos')::TEXT, 5, '0')
    INTO v_numero;

  INSERT INTO public.ventas_pos (
    empresa_id, caja_id, turno_id, cliente_id, vendedor_id, numero,
    subtotal, iva_total, total, estado, descuento_global_pct,
    offline_local_id, es_offline
  ) VALUES (
    p_empresa_id, p_caja_id, p_turno_id, p_cliente_id, p_vendedor_id, v_numero,
    ROUND(p_subtotal, 2), ROUND(p_iva_total, 2), ROUND(p_total, 2),
    'completada',
    COALESCE(p_descuento_global_pct, 0),
    p_offline_local_id, (p_offline_local_id IS NOT NULL)
  ) RETURNING id INTO v_venta_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_producto_id := (v_item->>'producto_id')::UUID;
    v_cantidad    := (v_item->>'cantidad')::NUMERIC;

    INSERT INTO public.venta_pos_items (
      venta_pos_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_venta_id, v_producto_id, v_cantidad,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      ROUND((v_item->>'subtotal')::NUMERIC, 2)
    );

    SELECT cantidad INTO v_disponible
      FROM public.stock
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id
       FOR UPDATE;

    IF NOT FOUND OR v_disponible < v_cantidad THEN
      RAISE EXCEPTION 'stock_insuficiente:% disponible:%',
        v_producto_id::TEXT, COALESCE(v_disponible, 0)::TEXT;
    END IF;

    UPDATE public.stock
       SET cantidad            = cantidad - v_cantidad,
           updated_at          = NOW()
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id;

    PERFORM fn_lotes_consumir_fefo(
      v_producto_id, p_deposito_id, v_cantidad,
      'Venta POS ' || v_numero, p_vendedor_id
    );

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_producto_id, p_deposito_id, 'egreso', v_cantidad,
       v_venta_id, 'Venta POS ' || v_numero, p_vendedor_id);
  END LOOP;

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO public.venta_pos_pagos (venta_pos_id, medio, monto, referencia)
    VALUES (v_venta_id, v_pago->>'medio', (v_pago->>'monto')::NUMERIC, v_pago->>'referencia');
  END LOOP;

  IF v_monto_cta_cte > 0 THEN
    INSERT INTO public.cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (p_empresa_id, p_cliente_id, 'debito', v_monto_cta_cte,
            'Venta POS ' || v_numero, NOW());
  END IF;

  RETURN json_build_object(
    'ok',       true,
    'venta_id', v_venta_id,
    'numero',   v_numero,
    'total',    p_total
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id, numero INTO v_existente_id, v_existente_num
        FROM public.ventas_pos
       WHERE empresa_id = p_empresa_id AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN json_build_object(
          'ok', true, 'venta_id', v_existente_id, 'numero', v_existente_num, 'ya_existia', true
        );
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'stock_insuficiente:%' THEN
      RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente', 'error', SQLERRM);
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.anular_venta_pos(p_venta_pos_id uuid, p_usuario_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta       record;
  v_item        record;
  v_deposito_id uuid;
  v_pago        record;
  v_factura     record;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RETURN json_build_object('ok', false, 'error', 'El motivo de la anulación es obligatorio');
  END IF;

  SELECT id, empresa_id, estado, cliente_id, numero, total, factura_id
    INTO v_venta
    FROM ventas_pos
   WHERE id = p_venta_pos_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Venta no encontrada');
  END IF;

  IF auth.role() <> 'service_role' AND v_venta.empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF v_venta.estado = 'anulada' THEN
    RETURN json_build_object('ok', true, 'skip', 'ya_anulada');
  END IF;

  SELECT id, estado, cae, total, total_cobrado
    INTO v_factura
    FROM facturas
   WHERE (id = v_venta.factura_id OR venta_pos_id = p_venta_pos_id)
     AND estado <> 'anulada'
   ORDER BY (id = v_venta.factura_id) DESC
   LIMIT 1;

  IF FOUND AND v_factura.cae IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Esta venta ya tiene una factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.');
  END IF;

  SELECT cp.deposito_id INTO v_deposito_id
  FROM ventas_pos vp
  JOIN cajas_pos cp ON cp.id = vp.caja_id
  WHERE vp.id = p_venta_pos_id;

  FOR v_item IN
    SELECT producto_id, cantidad FROM venta_pos_items WHERE venta_pos_id = p_venta_pos_id
  LOOP
    UPDATE stock
       SET cantidad = cantidad + v_item.cantidad
     WHERE producto_id = v_item.producto_id
       AND deposito_id = v_deposito_id;

    INSERT INTO movimientos_stock (
      producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id, notas
    ) VALUES (
      v_item.producto_id, v_deposito_id, 'ingreso', v_item.cantidad,
      v_venta.id, 'Anulación venta POS ' || v_venta.numero, p_usuario_id, p_motivo
    );
  END LOOP;

  SELECT medio, monto INTO v_pago
  FROM venta_pos_pagos
  WHERE venta_pos_id = p_venta_pos_id AND medio = 'cuenta_corriente'
  LIMIT 1;

  IF FOUND AND v_venta.cliente_id IS NOT NULL THEN
    INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (v_venta.empresa_id, v_venta.cliente_id, 'credito', v_pago.monto,
            'Anulación venta POS ' || v_venta.numero, now());
  END IF;

  IF v_factura.id IS NOT NULL AND v_factura.cae IS NULL THEN
    UPDATE facturas
       SET estado = 'anulada'
     WHERE id = v_factura.id;
  END IF;

  UPDATE ventas_pos SET estado = 'anulada' WHERE id = p_venta_pos_id;

  RETURN json_build_object('ok', true, 'factura_anulada', v_factura.id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.transferir_stock_entre_depositos(p_producto_id uuid, p_deposito_origen uuid, p_deposito_destino uuid, p_cantidad numeric, p_usuario_id uuid, p_notas text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_disponible_origen NUMERIC;
  v_costo_promedio    NUMERIC;
  v_empresa_id        UUID;
  v_lote              RECORD;
  v_restante          NUMERIC;
  v_consumir          NUMERIC;
BEGIN
  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'tipo', 'depositos_iguales',
      'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'tipo', 'cantidad_invalida',
      'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_id FROM depositos WHERE id = p_deposito_origen;

  SELECT cantidad, costo_promedio
    INTO v_disponible_origen, v_costo_promedio
    FROM stock
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'sin_stock_origen',
      'error', 'No existe stock de este producto en el depósito de origen');
  END IF;

  IF v_disponible_origen < p_cantidad THEN
    RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente',
      'error', 'Stock insuficiente en origen. Disponible: ' || v_disponible_origen::TEXT);
  END IF;

  UPDATE stock
     SET cantidad            = cantidad - p_cantidad,
         updated_at          = NOW()
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen;

  INSERT INTO stock (producto_id, deposito_id, cantidad, costo_promedio)
  VALUES (p_producto_id, p_deposito_destino, p_cantidad, COALESCE(v_costo_promedio, 0))
  ON CONFLICT (producto_id, deposito_id) DO UPDATE
    SET cantidad            = stock.cantidad + EXCLUDED.cantidad,
        updated_at          = NOW();

  v_restante := p_cantidad;

  FOR v_lote IN
    SELECT id, cantidad_disponible, costo_unitario, fecha_vencimiento, numero_lote, fecha_fabricacion
      FROM lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_origen
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY fecha_vencimiento ASC NULLS LAST, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = NOW()
     WHERE id = v_lote.id;

    INSERT INTO lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_destino,
      COALESCE(v_lote.numero_lote, 'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD')),
      v_consumir, v_consumir,
      v_lote.costo_unitario, v_lote.fecha_fabricacion, v_lote.fecha_vencimiento,
      'activo'
    );

    v_restante := v_restante - v_consumir;
  END LOOP;

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES (p_producto_id, p_deposito_origen, 'transferencia', -p_cantidad,
          'Transferencia a depósito ' || p_deposito_destino::TEXT, p_usuario_id, p_notas);

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES (p_producto_id, p_deposito_destino, 'transferencia', p_cantidad,
          'Transferencia desde depósito ' || p_deposito_origen::TEXT, p_usuario_id, p_notas);

  RETURN json_build_object('ok', true,
    'producto_id', p_producto_id,
    'cantidad', p_cantidad,
    'origen', p_deposito_origen,
    'destino', p_deposito_destino);

EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$function$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '441_fix_stock_cantidad_disponible_columna_generada.sql', '441', 'claude-session',
  'F4-04: cantidad_disponible pasa a ser columna generada (GREATEST(cantidad - cantidad_reservada, 0)) '
  'en vez de un valor que cada función debía sincronizar a mano. Se elimina el trigger '
  'trg_sync_stock_disponible (obsoleto) y se repatchean las 6 funciones que la escribían directo: '
  'registrar_venta_pos, anular_venta_pos, transferir_stock_entre_depositos, fn_crear_producto, '
  'fn_deposito_crear_stock_inicial, fn_productos_crear_stock_inicial. Confirmado contra la base real '
  'que rpc_crear_pedido (única función que alguna vez calculó cantidad_disponible distinto, por '
  'lotes/FEFO) ya no está en uso y ya no lo hace en producción.')
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
