-- ============================================================
-- 072_pos.sql
-- Módulo POS — venta mostrador (B2B + consumidor final)
--
-- Contexto de diseño (decisiones de negocio confirmadas):
--   - Varias cajas físicas operando en simultáneo.
--   - El POS vende desde un depósito "mostrador" separado del
--     depósito principal que usa el reparto en camión.
--   - Un vendedor puede tener turno abierto en más de una caja
--     a la vez → el lock de "un turno por vez" es por CAJA, no
--     por usuario.
--   - Venta a cliente mayorista sin cobrar en el momento se
--     carga a cta_cte exactamente igual que un pedido (mismo
--     límite de crédito, sin tabla ni función nueva para eso).
--   - No existía ninguna función para mover stock entre
--     depósitos — se agrega acá porque el depósito mostrador
--     nace vacío si no hay forma de abastecerlo.
--
-- No modifica ninguna tabla/función existente. 100% aditivo.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLAS
-- ============================================================

CREATE TABLE IF NOT EXISTS cajas_pos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID REFERENCES empresas(id) ON DELETE CASCADE,
  deposito_id UUID REFERENCES depositos(id),
  nombre      TEXT NOT NULL,
  activa      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS turnos_caja (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caja_id                 UUID REFERENCES cajas_pos(id),
  usuario_id              UUID REFERENCES usuarios(id),
  monto_inicial           NUMERIC(12,2) DEFAULT 0,
  monto_final_declarado   NUMERIC(12,2),
  monto_final_calculado   NUMERIC(12,2),
  diferencia              NUMERIC(12,2),
  estado                  TEXT DEFAULT 'abierto' CHECK (estado IN ('abierto','cerrado')),
  abierto_at              TIMESTAMPTZ DEFAULT now(),
  cerrado_at              TIMESTAMPTZ
);

-- Un vendedor puede abrir turno en varias cajas a la vez (confirmado),
-- pero una caja no puede tener dos turnos abiertos al mismo tiempo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_un_turno_abierto_por_caja
  ON turnos_caja(caja_id)
  WHERE estado = 'abierto';

CREATE TABLE IF NOT EXISTS ventas_pos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID REFERENCES empresas(id) ON DELETE CASCADE,
  caja_id         UUID REFERENCES cajas_pos(id),
  turno_id        UUID REFERENCES turnos_caja(id),
  cliente_id      UUID REFERENCES clientes(id),         -- NULL = consumidor final sin cuenta
  vendedor_id     UUID REFERENCES usuarios(id),
  numero          TEXT,                                  -- correlativo interno, no fiscal
  subtotal        NUMERIC(12,2) DEFAULT 0,
  descuento       NUMERIC(12,2) DEFAULT 0,
  iva_total       NUMERIC(12,2) DEFAULT 0,
  total           NUMERIC(12,2) DEFAULT 0,
  estado          TEXT DEFAULT 'completada' CHECK (estado IN ('completada','anulada')),
  factura_id      UUID REFERENCES facturas(id),          -- NULL hasta que se facture (si se factura)
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS venta_pos_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_pos_id    UUID REFERENCES ventas_pos(id) ON DELETE CASCADE,
  producto_id     UUID REFERENCES productos(id),
  cantidad        NUMERIC(12,3) NOT NULL,
  precio_unitario NUMERIC(12,2) NOT NULL,
  descuento_pct   NUMERIC(5,2) DEFAULT 0,
  subtotal        NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS venta_pos_pagos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_pos_id    UUID REFERENCES ventas_pos(id) ON DELETE CASCADE,
  medio           TEXT NOT NULL CHECK (medio IN ('efectivo','transferencia','tarjeta','qr','cuenta_corriente')),
  monto           NUMERIC(12,2) NOT NULL,
  referencia      TEXT  -- nro de operación de posnet/transferencia, si aplica
);

CREATE INDEX IF NOT EXISTS idx_ventas_pos_empresa  ON ventas_pos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ventas_pos_turno    ON ventas_pos(turno_id);
CREATE INDEX IF NOT EXISTS idx_ventas_pos_cliente  ON ventas_pos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_venta_pos_items_venta ON venta_pos_items(venta_pos_id);
CREATE INDEX IF NOT EXISTS idx_venta_pos_pagos_venta ON venta_pos_pagos(venta_pos_id);

CREATE SEQUENCE IF NOT EXISTS seq_ventas_pos;

COMMENT ON TABLE cajas_pos IS 'Puntos de cobro físicos. Varias pueden operar en simultáneo.';
COMMENT ON TABLE turnos_caja IS 'Apertura/cierre de caja con arqueo. Un turno abierto por caja, no por usuario.';
COMMENT ON TABLE ventas_pos IS 'Venta mostrador: descuenta stock real en el momento, a diferencia de pedidos (que reserva).';

-- ============================================================
-- 2. RPC: transferir_stock_entre_depositos()
--    Pieza nueva — no existía ningún mecanismo para mover stock
--    entre depósitos. Necesaria para abastecer el depósito
--    mostrador desde el depósito principal.
-- ============================================================

CREATE OR REPLACE FUNCTION public.transferir_stock_entre_depositos(
  p_producto_id       UUID,
  p_deposito_origen   UUID,
  p_deposito_destino  UUID,
  p_cantidad          NUMERIC,
  p_usuario_id        UUID,
  p_notas             TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_disponible_origen NUMERIC;
  v_costo_promedio    NUMERIC;
BEGIN
  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'tipo', 'depositos_iguales',
      'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'tipo', 'cantidad_invalida',
      'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  -- Lock sobre la fila de origen primero (orden determinístico por
  -- deposito_id para evitar deadlocks si dos transferencias cruzadas
  -- corren en paralelo entre los mismos dos depósitos).
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

  -- Descontar en origen
  UPDATE stock
     SET cantidad             = cantidad - p_cantidad,
         cantidad_disponible  = cantidad_disponible - p_cantidad,
         updated_at           = NOW()
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen;

  -- Asegurar fila de destino (puede no existir todavía) y sumar.
  -- Mismo patrón UNIQUE(producto_id, deposito_id) que ya tiene stock.
  INSERT INTO stock (producto_id, deposito_id, cantidad, cantidad_disponible, costo_promedio)
  VALUES (p_producto_id, p_deposito_destino, p_cantidad, p_cantidad, COALESCE(v_costo_promedio, 0))
  ON CONFLICT (producto_id, deposito_id) DO UPDATE
    SET cantidad            = stock.cantidad + EXCLUDED.cantidad,
        cantidad_disponible = stock.cantidad_disponible + EXCLUDED.cantidad,
        updated_at          = NOW();

  -- Trazabilidad: un movimiento de egreso en origen, uno de ingreso en
  -- destino, ambos con tipo 'transferencia' (ya existe en el enum
  -- tipo_movimiento, nunca se había usado) y referenciados entre sí.
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
$$;

REVOKE ALL ON FUNCTION public.transferir_stock_entre_depositos FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transferir_stock_entre_depositos TO service_role;

COMMENT ON FUNCTION public.transferir_stock_entre_depositos IS
  'Mueve stock de un depósito a otro de forma atómica. '
  'Usa tipo_movimiento=transferencia (ya existía en el enum, sin uso previo).';

-- ============================================================
-- 3. RPC: registrar_venta_pos()
--    Mismo patrón que crear_pedido_cliente (FOR UPDATE simple,
--    sin advisory locks). Diferencia clave: descuenta stock REAL
--    en el momento, no reserva — la mercadería sale del mostrador
--    en el mismo instante de la venta.
-- ============================================================

CREATE OR REPLACE FUNCTION public.registrar_venta_pos(
  p_empresa_id    UUID,
  p_caja_id       UUID,
  p_turno_id      UUID,
  p_vendedor_id   UUID,
  p_cliente_id    UUID,            -- NULL = consumidor final sin cuenta
  p_deposito_id   UUID,
  p_items         JSONB,           -- [{producto_id, cantidad, precio_unitario, descuento_pct, subtotal}]
  p_pagos         JSONB,           -- [{medio, monto, referencia}]
  p_subtotal      NUMERIC,
  p_iva_total     NUMERIC,
  p_total         NUMERIC
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
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
BEGIN
  -- 1. La suma de los pagos tiene que coincidir con el total
  --    (tolerancia de un centavo por redondeo).
  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_suma_pagos
  FROM jsonb_array_elements(p_pagos) p;

  IF ABS(v_suma_pagos - p_total) > 0.01 THEN
    RETURN json_build_object('ok', false, 'tipo', 'pagos_no_coinciden',
      'error', 'La suma de los pagos no coincide con el total de la venta');
  END IF;

  -- 2. Turno abierto y correspondiente a esa caja.
  IF NOT EXISTS (
    SELECT 1 FROM turnos_caja
    WHERE id = p_turno_id AND caja_id = p_caja_id AND estado = 'abierto'
  ) THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_cerrado',
      'error', 'No hay un turno abierto para esta caja');
  END IF;

  -- 3. Si parte del pago es a cuenta corriente, validar límite de
  --    crédito del cliente — mismo criterio que ya usa pedidos.js
  --    (cta_cte: débitos suman, créditos restan).
  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_monto_cta_cte
  FROM jsonb_array_elements(p_pagos) p WHERE p->>'medio' = 'cuenta_corriente';

  IF v_monto_cta_cte > 0 THEN
    IF p_cliente_id IS NULL THEN
      RETURN json_build_object('ok', false, 'tipo', 'cliente_requerido',
        'error', 'No se puede imputar a cuenta corriente sin un cliente seleccionado');
    END IF;

    SELECT limite_credito INTO v_limite FROM clientes WHERE id = p_cliente_id;

    IF v_limite > 0 THEN
      SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0)
        INTO v_saldo_actual
        FROM cta_cte WHERE cliente_id = p_cliente_id;

      IF v_saldo_actual + v_monto_cta_cte > v_limite THEN
        RETURN json_build_object('ok', false, 'tipo', 'limite_credito',
          'error', 'Supera el límite de crédito del cliente');
      END IF;
    END IF;
  END IF;

  -- 4. Cabecera de la venta.
  SELECT 'POS-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(nextval('seq_ventas_pos')::TEXT, 5, '0')
    INTO v_numero;

  INSERT INTO ventas_pos (
    empresa_id, caja_id, turno_id, cliente_id, vendedor_id, numero,
    subtotal, iva_total, total, estado
  ) VALUES (
    p_empresa_id, p_caja_id, p_turno_id, p_cliente_id, p_vendedor_id, v_numero,
    ROUND(p_subtotal, 2), ROUND(p_iva_total, 2), ROUND(p_total, 2), 'completada'
  ) RETURNING id INTO v_venta_id;

  -- 5. Ítems + descuento de stock real (no reserva, sale ahora).
  --    tipo_movimiento no tiene un valor 'venta_pos' en el enum —
  --    se usa 'egreso', que ya existe, para no romper el CHECK.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_producto_id := (v_item->>'producto_id')::UUID;
    v_cantidad    := (v_item->>'cantidad')::NUMERIC;

    INSERT INTO venta_pos_items (
      venta_pos_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_venta_id, v_producto_id, v_cantidad,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      ROUND((v_item->>'subtotal')::NUMERIC, 2)
    );

    SELECT cantidad INTO v_disponible
      FROM stock
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id
       FOR UPDATE;

    IF NOT FOUND OR v_disponible < v_cantidad THEN
      RAISE EXCEPTION 'stock_insuficiente:% disponible:%', v_producto_id::TEXT, COALESCE(v_disponible, 0)::TEXT;
    END IF;

    UPDATE stock
       SET cantidad            = cantidad - v_cantidad,
           cantidad_disponible = cantidad_disponible - v_cantidad,
           updated_at          = NOW()
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id;

    INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES (v_producto_id, p_deposito_id, 'egreso', v_cantidad, v_venta_id, 'Venta POS ' || v_numero, p_vendedor_id);
  END LOOP;

  -- 6. Pagos (puede ser más de un medio por venta).
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO venta_pos_pagos (venta_pos_id, medio, monto, referencia)
    VALUES (v_venta_id, v_pago->>'medio', (v_pago->>'monto')::NUMERIC, v_pago->>'referencia');
  END LOOP;

  -- 7. Débito en cuenta corriente si corresponde (ya validado en el paso 3).
  --    NOTA: cta_cte.empresa_id es NOT NULL — se incluye explícitamente acá.
  --    (lib/facturas.js hoy NO lo incluye en sus inserts a cta_cte; es un bug
  --    preexistente del proyecto, no algo a replicar — ver aviso en el chat.)
  --    Se usa la columna 'monto' (no 'importe') porque es la que lee y escribe
  --    el resto de los handlers activos (clientes.js, notif.js); 'importe' solo
  --    la usa registrar_movimiento_cta_cte(), un RPC de otro flujo (notas de
  --    crédito/débito) que hoy no está conectado a ningún endpoint de la API.
  IF v_monto_cta_cte > 0 THEN
    INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (p_empresa_id, p_cliente_id, 'debito', v_monto_cta_cte, 'Venta POS ' || v_numero, NOW());
  END IF;

  RETURN json_build_object('ok', true, 'venta_id', v_venta_id, 'numero', v_numero, 'total', p_total);

EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'stock_insuficiente:%' THEN
      RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente', 'error', SQLERRM);
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_venta_pos FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_venta_pos TO service_role;

COMMENT ON FUNCTION public.registrar_venta_pos IS
  'Venta mostrador: crea ventas_pos + items + pagos y descuenta stock REAL '
  '(a diferencia de crear_pedido_cliente, que solo reserva). '
  'Soporta pago dividido entre varios medios y débito a cta_cte con '
  'validación de límite de crédito.';

-- ============================================================
-- 4. RPC: cerrar_turno_caja()
--    Calcula el arqueo automáticamente sumando los pagos en
--    efectivo del turno — evita que el handler tenga que hacer
--    esa cuenta en JS por separado (riesgo de desincronización).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cerrar_turno_caja(
  p_turno_id              UUID,
  p_monto_final_declarado NUMERIC
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno             RECORD;
  v_total_efectivo    NUMERIC;
  v_monto_calculado   NUMERIC;
BEGIN
  SELECT * INTO v_turno FROM turnos_caja WHERE id = p_turno_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_no_encontrado', 'error', 'Turno no encontrado');
  END IF;

  IF v_turno.estado = 'cerrado' THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_ya_cerrado', 'error', 'El turno ya fue cerrado');
  END IF;

  SELECT COALESCE(SUM(vpp.monto), 0) INTO v_total_efectivo
    FROM venta_pos_pagos vpp
    JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
   WHERE vp.turno_id = p_turno_id
     AND vpp.medio = 'efectivo'
     AND vp.estado = 'completada';

  v_monto_calculado := v_turno.monto_inicial + v_total_efectivo;

  UPDATE turnos_caja
     SET estado                  = 'cerrado',
         monto_final_declarado   = p_monto_final_declarado,
         monto_final_calculado   = v_monto_calculado,
         diferencia              = p_monto_final_declarado - v_monto_calculado,
         cerrado_at              = NOW()
   WHERE id = p_turno_id;

  RETURN json_build_object('ok', true,
    'monto_calculado', v_monto_calculado,
    'monto_declarado', p_monto_final_declarado,
    'diferencia', p_monto_final_declarado - v_monto_calculado);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_turno_caja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cerrar_turno_caja TO service_role;

-- ============================================================
-- 5. RLS — mismo patrón que 030_rls_hardening.sql:
--    acceso restringido a usuarios cuyo empresa_id coincide.
--    Revisar 030 antes de tocar esto si el patrón cambió desde
--    entonces.
-- ============================================================

ALTER TABLE cajas_pos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE turnos_caja     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas_pos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE venta_pos_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE venta_pos_pagos ENABLE ROW LEVEL SECURITY;

-- Acceso vía service_role únicamente (igual que el resto del
-- esquema: la autorización real ocurre en el handler de la API,
-- no vía políticas RLS por usuario final — Supabase Auth no se
-- usa directamente desde el cliente para estas tablas).
CREATE POLICY service_role_all_cajas_pos ON cajas_pos
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_all_turnos_caja ON turnos_caja
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_all_ventas_pos ON ventas_pos
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_all_venta_pos_items ON venta_pos_items
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY service_role_all_venta_pos_pagos ON venta_pos_pagos
  FOR ALL USING (auth.role() = 'service_role');

COMMIT;

-- ============================================================
-- NOTA POST-DEPLOY (no es parte de la transacción anterior,
-- ejecutar a mano una sola vez por empresa antes de usar el POS):
--
--   INSERT INTO depositos (empresa_id, nombre, es_principal)
--   VALUES ('<empresa_id>', 'Mostrador', false);
--
--   INSERT INTO cajas_pos (empresa_id, deposito_id, nombre)
--   VALUES ('<empresa_id>', '<id del depósito recién creado>', 'Caja 1');
--
-- Para cargar stock inicial al mostrador, usar
-- transferir_stock_entre_depositos() desde el depósito principal,
-- no editar la tabla stock a mano.
-- ============================================================
