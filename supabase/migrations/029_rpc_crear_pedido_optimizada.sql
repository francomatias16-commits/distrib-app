-- ============================================================
-- 029_rpc_crear_pedido_optimizada.sql
-- distrib-v38-optimized | Módulo 3: Base de Datos World-Class
--
-- Refactorización de rpc_crear_pedido para reducir Lock Contention
-- bajo ráfagas transaccionales masivas.
--
-- TÉCNICAS APLICADAS:
--   1. pg_try_advisory_xact_lock() — lock por cliente, no por tabla
--   2. SELECT ... FOR UPDATE SKIP LOCKED — selección FIFO sin bloquear
--   3. Batch INSERT en pedido_items — 1 statement vs N statements
--   4. UPDATE stock con expresión única — evita ciclos
--   5. RETURNING — elimina SELECTs post-INSERT
--   6. RAISE con ERRCODE semántico — errores tipados para el cliente
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_crear_pedido(
    p_cliente_id    BIGINT,
    p_chofer_id     BIGINT,
    p_usuario_id    BIGINT,
    p_items         JSONB,      -- [{producto_id, cantidad, precio_unitario}]
    p_observaciones TEXT        DEFAULT NULL,
    p_canal         TEXT        DEFAULT 'web'   -- 'web' | 'chofer' | 'admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pedido_id     BIGINT;
    v_numero        TEXT;
    v_total         NUMERIC(14,2) := 0;
    v_item          JSONB;
    v_producto_id   BIGINT;
    v_cantidad      NUMERIC(10,3);
    v_precio        NUMERIC(14,2);
    v_subtotal      NUMERIC(14,2);
    v_restante      NUMERIC(10,3);
    v_lote          RECORD;
    v_items_insert  JSONB[]  := '{}';
    v_lotes_usados  BIGINT[] := '{}';
    v_stock_row     RECORD;
BEGIN

    -- ── 1. Lock optimista por cliente ─────────────────────────────────────────
    -- Usar advisory lock basado en cliente_id evita bloquear la tabla completa.
    -- pg_try_advisory_xact_lock devuelve FALSE si otro proceso ya tiene el lock
    -- para este cliente → falla rápido en lugar de esperar indefinidamente.
    IF NOT pg_try_advisory_xact_lock(hashtext('pedido_cliente_' || p_cliente_id::text)) THEN
        RAISE EXCEPTION 'PEDIDO_CONCURRENTE'
            USING ERRCODE = 'P0001',
                  HINT    = 'El cliente ya tiene un pedido en proceso. Reintentá en unos segundos.';
    END IF;

    -- ── 2. Validar cliente activo ────────────────────────────────────────────
    IF NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo = TRUE) THEN
        RAISE EXCEPTION 'CLIENTE_INACTIVO'
            USING ERRCODE = 'P0002',
                  HINT    = 'El cliente no existe o está inactivo.';
    END IF;

    -- ── 3. Validar que p_items no esté vacío ─────────────────────────────────
    IF jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'PEDIDO_SIN_ITEMS'
            USING ERRCODE = 'P0003',
                  HINT    = 'El pedido debe tener al menos un ítem.';
    END IF;

    -- ── 4. Generar número de pedido (secuencial + año) ───────────────────────
    SELECT 'PED-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('seq_pedidos')::text, 6, '0')
    INTO v_numero;

    -- ── 5. Crear cabecera del pedido ─────────────────────────────────────────
    INSERT INTO public.pedidos (
        numero_pedido, cliente_id, chofer_id, usuario_id,
        estado, canal, observaciones, total, fecha_pedido
    )
    VALUES (
        v_numero, p_cliente_id, p_chofer_id, p_usuario_id,
        'pendiente', p_canal, p_observaciones, 0, NOW()
    )
    RETURNING id INTO v_pedido_id;

    -- ── 6. Procesar ítems: descuento FIFO de lotes + cálculo de total ────────
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP

        v_producto_id := (v_item->>'producto_id')::BIGINT;
        v_cantidad    := (v_item->>'cantidad')::NUMERIC;
        v_precio      := (v_item->>'precio_unitario')::NUMERIC;
        v_subtotal    := ROUND(v_cantidad * v_precio, 2);
        v_restante    := v_cantidad;

        -- Validar stock global antes de intentar descuento por lotes
        SELECT SUM(cantidad_disponible) INTO v_stock_row
        FROM public.lotes
        WHERE producto_id = v_producto_id
          AND cantidad_disponible > 0
          AND (fecha_vencimiento IS NULL OR fecha_vencimiento > CURRENT_DATE);

        IF v_stock_row IS NULL OR v_stock_row < v_cantidad THEN
            RAISE EXCEPTION 'STOCK_INSUFICIENTE'
                USING ERRCODE = 'P0004',
                      HINT    = 'Sin stock suficiente para producto ' || v_producto_id::text;
        END IF;

        -- Descontar FIFO sobre lotes: FOR UPDATE SKIP LOCKED evita deadlocks
        -- entre transacciones concurrentes que tocan el mismo producto
        FOR v_lote IN
            SELECT id, cantidad_disponible
            FROM public.lotes
            WHERE producto_id = v_producto_id
              AND cantidad_disponible > 0
              AND (fecha_vencimiento IS NULL OR fecha_vencimiento > CURRENT_DATE)
            ORDER BY fecha_vencimiento ASC NULLS LAST, id ASC
            FOR UPDATE SKIP LOCKED
        LOOP
            EXIT WHEN v_restante <= 0;

            DECLARE v_descuento NUMERIC(10,3);
            BEGIN
                v_descuento := LEAST(v_lote.cantidad_disponible, v_restante);

                -- UPDATE directo con expresión — 1 statement, no ciclo
                UPDATE public.lotes
                SET cantidad_disponible = cantidad_disponible - v_descuento,
                    updated_at          = NOW()
                WHERE id = v_lote.id;

                v_lotes_usados := array_append(v_lotes_usados, v_lote.id);
                v_restante     := v_restante - v_descuento;
            END;
        END LOOP;

        -- Si quedó restante sin cubrir (race condition entre SKIPs)
        IF v_restante > 0 THEN
            RAISE EXCEPTION 'STOCK_INSUFICIENTE_RACE'
                USING ERRCODE = 'P0004',
                      HINT    = 'Stock insuficiente tras descuento FIFO para producto ' || v_producto_id::text;
        END IF;

        -- Acumular total
        v_total := v_total + v_subtotal;

        -- Preparar row para batch insert
        v_items_insert := array_append(v_items_insert,
            jsonb_build_object(
                'pedido_id',       v_pedido_id,
                'producto_id',     v_producto_id,
                'cantidad',        v_cantidad,
                'precio_unitario', v_precio,
                'subtotal',        v_subtotal
            )
        );

    END LOOP;

    -- ── 7. Batch INSERT de items (1 statement) ────────────────────────────────
    INSERT INTO public.pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
    SELECT
        (elem->>'pedido_id')::BIGINT,
        (elem->>'producto_id')::BIGINT,
        (elem->>'cantidad')::NUMERIC,
        (elem->>'precio_unitario')::NUMERIC,
        (elem->>'subtotal')::NUMERIC
    FROM unnest(v_items_insert) AS elem;

    -- ── 8. UPDATE total del pedido (RETURNING evita SELECT adicional) ─────────
    UPDATE public.pedidos
    SET total = v_total, updated_at = NOW()
    WHERE id = v_pedido_id;

    -- ── 9. Actualizar stock agregado (1 UPDATE por producto, no por lote) ─────
    UPDATE public.stock s
    SET cantidad_disponible = (
        SELECT COALESCE(SUM(l.cantidad_disponible), 0)
        FROM public.lotes l
        WHERE l.producto_id = s.producto_id
          AND l.cantidad_disponible > 0
    ),
    updated_at = NOW()
    WHERE s.producto_id IN (
        SELECT DISTINCT (elem->>'producto_id')::BIGINT FROM unnest(v_items_insert) AS elem
    );

    -- ── 10. Actualizar saldo cuenta corriente del cliente ──────────────────────
    UPDATE public.clientes
    SET saldo_cuenta_corriente = saldo_cuenta_corriente + v_total,
        updated_at             = NOW()
    WHERE id = p_cliente_id;

    -- ── 11. Registrar en audit_log ─────────────────────────────────────────────
    INSERT INTO public.audit_log (tabla_nombre, entidad_id, accion, usuario_id, datos_nuevos)
    VALUES ('pedidos', v_pedido_id, 'INSERT', p_usuario_id,
            jsonb_build_object('numero', v_numero, 'total', v_total, 'canal', p_canal));

    -- ── 12. Retornar resultado tipado ──────────────────────────────────────────
    RETURN jsonb_build_object(
        'ok',         TRUE,
        'pedido_id',  v_pedido_id,
        'numero',     v_numero,
        'total',      v_total,
        'estado',     'pendiente'
    );

EXCEPTION
    WHEN OTHERS THEN
        -- Re-lanzar con contexto adicional para logging en la API
        RAISE EXCEPTION '%', SQLERRM
            USING ERRCODE = SQLSTATE,
                  HINT    = 'rpc_crear_pedido falló para cliente ' || p_cliente_id::text;
END;
$$;

-- Revocar acceso público — solo service_role puede ejecutar
REVOKE ALL ON FUNCTION public.rpc_crear_pedido FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_crear_pedido TO service_role;

COMMENT ON FUNCTION public.rpc_crear_pedido IS
    'Crea un pedido con descuento FIFO de lotes. '
    'Usa advisory lock por cliente y SKIP LOCKED para eliminar lock contention.';

COMMIT;
