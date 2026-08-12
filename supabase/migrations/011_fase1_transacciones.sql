-- ============================================================
-- DISTRIB-APP — Fase 1: Transacciones Atómicas + Numeración
-- 011_fase1_transacciones.sql
-- Ejecutar DESPUÉS de 010_etapa7_fidelizacion.sql
-- ============================================================

-- ============================================================
-- TABLA: contadores_empresa
-- Una fila por empresa × tipo de comprobante.
-- El campo ultimo_numero se incrementa de forma atómica con
-- SELECT ... FOR UPDATE para evitar duplicados bajo concurrencia.
-- ============================================================
CREATE TABLE IF NOT EXISTS contadores_empresa (
  empresa_id   UUID    REFERENCES empresas(id) ON DELETE CASCADE,
  tipo         TEXT    NOT NULL,   -- 'nota_credito','nota_debito','cobro','factura_b','factura_a','factura_c'
  ultimo_numero INT    NOT NULL DEFAULT 0,
  prefijo      TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (empresa_id, tipo)
);

-- RLS: solo internos de la empresa, solo dueno/admin pueden resetear
ALTER TABLE contadores_empresa ENABLE ROW LEVEL SECURITY;

CREATE POLICY contadores_select ON contadores_empresa
  FOR SELECT USING (empresa_id = get_empresa_id());

CREATE POLICY contadores_modify ON contadores_empresa
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ============================================================
-- FUNCIÓN: siguiente_numero_comprobante
-- Devuelve el próximo número formateado para un tipo de documento
-- y empresa dados. Atómico: usa FOR UPDATE + UPDATE en la misma tx.
-- Si la empresa no tiene contador para ese tipo, lo crea en 1.
-- ============================================================
CREATE OR REPLACE FUNCTION siguiente_numero_comprobante(
  p_empresa_id UUID,
  p_tipo       TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_nuevo  INT;
  v_prefijo TEXT;
BEGIN
  -- INSERT ... ON CONFLICT garantiza que la fila exista
  INSERT INTO contadores_empresa (empresa_id, tipo, ultimo_numero, prefijo)
  VALUES (p_empresa_id, p_tipo, 0, '')
  ON CONFLICT (empresa_id, tipo) DO NOTHING;

  -- Bloqueo pesimista: nadie más puede incrementar hasta que terminemos
  SELECT ultimo_numero + 1, prefijo
    INTO v_nuevo, v_prefijo
    FROM contadores_empresa
   WHERE empresa_id = p_empresa_id AND tipo = p_tipo
   FOR UPDATE;

  UPDATE contadores_empresa
     SET ultimo_numero = v_nuevo
   WHERE empresa_id = p_empresa_id AND tipo = p_tipo;

  -- Formato: prefijo + número con ceros a la izquierda (8 dígitos)
  RETURN v_prefijo || LPAD(v_nuevo::TEXT, 8, '0');
END;
$$;

-- ============================================================
-- FUNCIÓN: incrementar_stock_reservado
-- Incrementa cantidad_reservada de forma atómica.
-- Usada tanto por confirmar_pedido como por la API Vercel.
-- Verifica que haya stock disponible antes de reservar.
-- ============================================================
CREATE OR REPLACE FUNCTION incrementar_stock_reservado(
  p_producto_id UUID,
  p_deposito_id UUID,
  p_cantidad    NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_disponible NUMERIC;
BEGIN
  SELECT (cantidad - cantidad_reservada)
    INTO v_disponible
    FROM stock
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_id
   FOR UPDATE;

  IF v_disponible IS NULL THEN
    RAISE EXCEPTION 'No existe registro de stock para este producto/depósito';
  END IF;

  IF p_cantidad > v_disponible THEN
    RAISE EXCEPTION 'Stock insuficiente: disponible=%, solicitado=%', v_disponible, p_cantidad;
  END IF;

  UPDATE stock
     SET cantidad_reservada = cantidad_reservada + p_cantidad
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_id;
END;
$$;

-- ============================================================
-- FUNCIÓN: liberar_stock_reservado
-- Decrementa cantidad_reservada (no puede quedar negativa).
-- Usada al cancelar pedidos.
-- ============================================================
CREATE OR REPLACE FUNCTION liberar_stock_reservado(
  p_producto_id UUID,
  p_deposito_id UUID,
  p_cantidad    NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE stock
     SET cantidad_reservada = GREATEST(0, cantidad_reservada - p_cantidad)
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_id;
END;
$$;

-- ============================================================
-- FUNCIÓN: confirmar_pedido
-- Transición borrador → confirmado (llamada desde el panel admin).
-- En una sola transacción:
--   1. Valida que el pedido esté en estado 'borrador'
--   2. Valida stock disponible para cada ítem
--   3. Reserva stock atómicamente
--   4. Registra movimientos_stock
--   5. Actualiza pedido.estado = 'confirmado'
-- Parámetros:
--   p_pedido_id: UUID del pedido
--   p_forzar:    si TRUE omite validación de límite de crédito
-- ============================================================
CREATE OR REPLACE FUNCTION confirmar_pedido(
  p_pedido_id UUID,
  p_forzar    BOOLEAN DEFAULT FALSE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido       RECORD;
  v_cliente      RECORD;
  v_item         RECORD;
  v_stock        RECORD;
  v_deposito_id  UUID;
  v_disponible   NUMERIC;
  v_saldo_cte    NUMERIC;
  v_usuario_id   UUID;
BEGIN
  -- Obtener usuario autenticado
  v_usuario_id := auth.uid();

  -- 1. Cargar y bloquear el pedido
  SELECT p.*, e.id AS eid
    INTO v_pedido
    FROM pedidos p
    JOIN empresas e ON e.id = p.empresa_id
   WHERE p.id = p_pedido_id
     AND p.empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado <> 'borrador' THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'El pedido no está en borrador (estado actual: ' || v_pedido.estado || ')'
    );
  END IF;

  -- 2. Cargar datos del cliente
  SELECT * INTO v_cliente FROM clientes WHERE id = v_pedido.cliente_id;

  -- 3. Validar límite de crédito (salteable con p_forzar)
  IF NOT p_forzar AND v_cliente.limite_credito > 0 THEN
    SELECT COALESCE(SUM(
      CASE WHEN tipo IN ('factura','nota_debito') THEN importe ELSE -importe END
    ), 0)
      INTO v_saldo_cte
      FROM cta_cte
     WHERE cliente_id = v_cliente.id;

    IF (v_saldo_cte + v_pedido.total) > v_cliente.limite_credito THEN
      RETURN json_build_object(
        'ok', false,
        'error', 'Límite de crédito superado. Saldo actual: $' || v_saldo_cte || ' / Límite: $' || v_cliente.limite_credito,
        'tipo', 'limite_credito'
      );
    END IF;
  END IF;

  -- 4. Validar y reservar stock ítem por ítem
  FOR v_item IN
    SELECT pi.producto_id, pi.cantidad
      FROM pedido_items pi
     WHERE pi.pedido_id = p_pedido_id
  LOOP
    -- Buscar depósito principal de la empresa
    SELECT s.deposito_id,
           (s.cantidad - s.cantidad_reservada) AS disponible
      INTO v_stock
      FROM stock s
      JOIN depositos d ON d.id = s.deposito_id
     WHERE s.producto_id = v_item.producto_id
       AND d.empresa_id  = v_pedido.empresa_id
       AND d.es_principal = TRUE
     LIMIT 1;

    -- Fallback: cualquier depósito de la empresa con stock
    IF NOT FOUND THEN
      SELECT s.deposito_id,
             (s.cantidad - s.cantidad_reservada) AS disponible
        INTO v_stock
        FROM stock s
        JOIN depositos d ON d.id = s.deposito_id
       WHERE s.producto_id = v_item.producto_id
         AND d.empresa_id  = v_pedido.empresa_id
       ORDER BY (s.cantidad - s.cantidad_reservada) DESC
       LIMIT 1;
    END IF;

    IF NOT FOUND OR v_stock.disponible < v_item.cantidad THEN
      RETURN json_build_object(
        'ok', false,
        'error', 'Stock insuficiente para producto ' || v_item.producto_id::TEXT ||
                 '. Disponible: ' || COALESCE(v_stock.disponible, 0),
        'producto_id', v_item.producto_id
      );
    END IF;

    -- Reservar stock (FOR UPDATE interno en la función)
    PERFORM incrementar_stock_reservado(
      v_item.producto_id,
      v_stock.deposito_id,
      v_item.cantidad
    );

    -- Registrar movimiento
    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_item.producto_id, v_stock.deposito_id, 'reserva', v_item.cantidad,
       p_pedido_id, 'Confirmación pedido admin', v_usuario_id);
  END LOOP;

  -- 5. Actualizar estado del pedido
  UPDATE pedidos
     SET estado = 'confirmado'
   WHERE id = p_pedido_id;

  RETURN json_build_object('ok', true, 'pedido_id', p_pedido_id);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- FUNCIÓN: cancelar_pedido
-- Transición (borrador|confirmado|preparando) → cancelado.
-- En una sola transacción:
--   1. Valida que el pedido sea cancelable
--   2. Libera reservas de stock si las había
--   3. Registra movimientos de liberación
--   4. Actualiza pedido.estado = 'cancelado'
--   5. Marca facturas asociadas como 'anulada' (si las hay)
-- ============================================================
CREATE OR REPLACE FUNCTION cancelar_pedido(p_pedido_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido  RECORD;
  v_item    RECORD;
  v_stock   RECORD;
  v_uid     UUID;
BEGIN
  v_uid := auth.uid();

  SELECT * INTO v_pedido
    FROM pedidos
   WHERE id = p_pedido_id
     AND empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado IN ('entregado', 'cancelado') THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'No se puede cancelar un pedido ' || v_pedido.estado
    );
  END IF;

  -- Liberar stock solo si ya estaba reservado
  IF v_pedido.estado IN ('confirmado', 'preparando') THEN
    FOR v_item IN
      SELECT pi.producto_id, pi.cantidad
        FROM pedido_items pi
       WHERE pi.pedido_id = p_pedido_id
    LOOP
      SELECT s.deposito_id INTO v_stock
        FROM stock s
        JOIN depositos d ON d.id = s.deposito_id
       WHERE s.producto_id = v_item.producto_id
         AND d.empresa_id  = v_pedido.empresa_id
       ORDER BY d.es_principal DESC
       LIMIT 1;

      IF FOUND THEN
        PERFORM liberar_stock_reservado(
          v_item.producto_id, v_stock.deposito_id, v_item.cantidad
        );

        INSERT INTO movimientos_stock
          (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
        VALUES
          (v_item.producto_id, v_stock.deposito_id, 'liberacion', v_item.cantidad,
           p_pedido_id, 'Cancelación pedido', v_uid);
      END IF;
    END LOOP;
  END IF;

  -- Cancelar el pedido
  UPDATE pedidos SET estado = 'cancelado' WHERE id = p_pedido_id;

  -- Anular facturas pendientes vinculadas
  UPDATE facturas
     SET estado = 'anulada'
   WHERE pedido_id = p_pedido_id
     AND estado IN ('pendiente', 'emitida');

  RETURN json_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- FUNCIÓN: marcar_preparado
-- Transición confirmado → preparando.
-- Solo actualiza estado; el stock ya está reservado.
-- ============================================================
CREATE OR REPLACE FUNCTION marcar_preparado(p_pedido_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido RECORD;
BEGIN
  SELECT * INTO v_pedido
    FROM pedidos
   WHERE id = p_pedido_id
     AND empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado <> 'confirmado' THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'El pedido debe estar confirmado para pasar a preparando (estado: ' || v_pedido.estado || ')'
    );
  END IF;

  UPDATE pedidos SET estado = 'preparando' WHERE id = p_pedido_id;

  RETURN json_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- FUNCIÓN: registrar_cobro_completo
-- Crea cobro + movimiento en cta_cte en una sola transacción.
-- Garantiza que ambas escrituras ocurran o ninguna.
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_cobro_completo(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_monto       NUMERIC,
  p_medio       TEXT,
  p_referencia  TEXT DEFAULT NULL,
  p_notas       TEXT DEFAULT NULL,
  p_usuario_id  UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cobro_id      UUID;
  v_nro           TEXT;
BEGIN
  -- Validaciones básicas
  IF p_monto <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  -- Verificar que el cliente pertenece a la empresa
  IF NOT EXISTS (
    SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  -- Generar número de recibo secuencial
  v_nro := siguiente_numero_comprobante(p_empresa_id, 'cobro');

  -- Insertar cobro
  INSERT INTO cobros (empresa_id, cliente_id, monto, medio, referencia, notas, usuario_id)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas,
          COALESCE(p_usuario_id, auth.uid()))
  RETURNING id INTO v_cobro_id;

  -- Insertar movimiento en cuenta corriente (crédito)
  INSERT INTO cta_cte
    (cliente_id, tipo, importe, cobro_id, nro_comprobante, descripcion, medio_pago)
  VALUES
    (p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
     'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  RETURN json_build_object(
    'ok',      true,
    'cobro_id', v_cobro_id,
    'nro',     v_nro
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- FUNCIÓN: emitir_nota_cta_cte
-- Crea una nota de crédito o débito con número secuencial.
-- Reemplaza la lógica de 'PROV-' + Date.now() del frontend.
-- ============================================================
CREATE OR REPLACE FUNCTION emitir_nota_cta_cte(
  p_empresa_id UUID,
  p_cliente_id UUID,
  p_tipo       TEXT,    -- 'nota_credito' | 'nota_debito'
  p_importe    NUMERIC,
  p_descripcion TEXT DEFAULT NULL,
  p_fecha      DATE DEFAULT CURRENT_DATE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_nro    TEXT;
  v_cta_id UUID;
BEGIN
  IF p_tipo NOT IN ('nota_credito', 'nota_debito') THEN
    RETURN json_build_object('ok', false, 'error', 'Tipo debe ser nota_credito o nota_debito');
  END IF;

  IF p_importe <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El importe debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado');
  END IF;

  -- Número secuencial por tipo
  v_nro := siguiente_numero_comprobante(p_empresa_id, p_tipo);

  INSERT INTO cta_cte
    (cliente_id, tipo, importe, nro_comprobante, descripcion, fecha)
  VALUES
    (p_cliente_id, p_tipo, p_importe, v_nro,
     COALESCE(p_descripcion, 'Nota de ' || replace(p_tipo, '_', ' ')), p_fecha)
  RETURNING id INTO v_cta_id;

  RETURN json_build_object(
    'ok',     true,
    'id',     v_cta_id,
    'nro',    v_nro
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- INICIALIZAR contadores para empresas existentes
-- (con prefijo vacío; el admin puede cambiar el prefijo
--  editando la tabla contadores_empresa directamente)
-- ============================================================
INSERT INTO contadores_empresa (empresa_id, tipo, ultimo_numero, prefijo)
SELECT id, tipo, 0, ''
FROM empresas
CROSS JOIN (VALUES
  ('nota_credito'), ('nota_debito'), ('cobro'),
  ('factura_a'), ('factura_b'), ('factura_c')
) AS tipos(tipo)
ON CONFLICT (empresa_id, tipo) DO NOTHING;

-- ============================================================
-- FIN DE 011_fase1_transacciones.sql
-- ============================================================
