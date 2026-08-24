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
-- 015_audit_log.sql
-- Tabla de auditoría para registrar acciones críticas del sistema
-- Cubre: cambios de precio, movimientos de stock, pagos, modificaciones de pedidos

-- ─────────────────────────────────────────────
-- TABLA PRINCIPAL
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID        NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id    UUID        REFERENCES usuarios(id) ON DELETE SET NULL,
  tabla         TEXT        NOT NULL,          -- nombre de la tabla afectada
  accion        TEXT        NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
  registro_id   TEXT,                          -- id del registro afectado (TEXT para flexibilidad)
  datos_antes   JSONB,                         -- snapshot anterior (UPDATE/DELETE)
  datos_despues JSONB,                         -- snapshot nuevo (INSERT/UPDATE)
  ip            TEXT,                          -- IP del cliente (opcional, desde app)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_audit_log_empresa    ON audit_log (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_usuario    ON audit_log (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tabla      ON audit_log (tabla, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_registro   ON audit_log (tabla, registro_id);

-- ─────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Solo dueno y admin pueden leer el log de su empresa
CREATE POLICY "audit_log_select" ON audit_log
  FOR SELECT
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- Solo el sistema (service_role) puede insertar; los usuarios nunca escriben directo
-- Las inserciones se hacen desde triggers o desde funciones con SECURITY DEFINER
CREATE POLICY "audit_log_insert_service" ON audit_log
  FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());

-- Nadie puede modificar ni borrar registros de auditoría
-- (append-only: no UPDATE, no DELETE policies)

-- ─────────────────────────────────────────────
-- FUNCIÓN HELPER PARA REGISTRAR DESDE LA APP
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION registrar_auditoria(
  p_tabla         TEXT,
  p_accion        TEXT,
  p_registro_id   TEXT,
  p_datos_antes   JSONB DEFAULT NULL,
  p_datos_despues JSONB DEFAULT NULL,
  p_ip            TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (
    empresa_id,
    usuario_id,
    tabla,
    accion,
    registro_id,
    datos_antes,
    datos_despues,
    ip
  ) VALUES (
    get_empresa_id(),
    auth.uid(),
    p_tabla,
    p_accion,
    p_registro_id,
    p_datos_antes,
    p_datos_despues,
    p_ip
  );
END;
$$;

-- ─────────────────────────────────────────────
-- TRIGGER AUTOMÁTICO: precios de productos
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _audit_productos_precio()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.precio_base IS DISTINCT FROM NEW.precio_base THEN
    PERFORM registrar_auditoria(
      'productos',
      'UPDATE',
      NEW.id::TEXT,
      jsonb_build_object('precio_base', OLD.precio_base),
      jsonb_build_object('precio_base', NEW.precio_base)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_productos_precio ON productos;
CREATE TRIGGER trg_audit_productos_precio
  AFTER UPDATE ON productos
  FOR EACH ROW
  EXECUTE FUNCTION _audit_productos_precio();

-- ─────────────────────────────────────────────
-- TRIGGER AUTOMÁTICO: movimientos de stock
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _audit_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM registrar_auditoria(
      'movimientos_stock',
      'INSERT',
      NEW.id::TEXT,
      NULL,
      to_jsonb(NEW)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM registrar_auditoria(
      'movimientos_stock',
      'UPDATE',
      NEW.id::TEXT,
      to_jsonb(OLD),
      to_jsonb(NEW)
    );
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM registrar_auditoria(
      'movimientos_stock',
      'DELETE',
      OLD.id::TEXT,
      to_jsonb(OLD),
      NULL
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_stock ON movimientos_stock;
CREATE TRIGGER trg_audit_stock
  AFTER INSERT OR UPDATE OR DELETE ON movimientos_stock
  FOR EACH ROW
  EXECUTE FUNCTION _audit_stock();

-- ─────────────────────────────────────────────
-- COMENTARIOS
-- ─────────────────────────────────────────────
COMMENT ON TABLE audit_log IS
  'Log inmutable de auditoría. Append-only: sin UPDATE ni DELETE policies. '
  'Triggers automáticos en productos (precio) y movimientos_stock. '
  'Para otras tablas, llamar a registrar_auditoria() desde la API.';
-- 017_req01_02_03.sql
-- REQ-01: proveedores + órdenes de compra + recepción (stock + costo promedio) + KPI compras
-- REQ-02: remito_nro correlativo en pedidos
-- REQ-03: notas de crédito con ítems, asociadas a facturas, registradas en cta_cte

-- ════════════════════════════════════════════════════════════════════
-- REQ-01: PROVEEDORES
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS proveedores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  razon_social     TEXT NOT NULL,
  nombre_fantasia  TEXT,
  cuit             TEXT,
  condicion_iva    TEXT DEFAULT 'responsable_inscripto',
  contacto         TEXT,
  telefono         TEXT,
  email            TEXT,
  dias_pago        INT  DEFAULT 0,
  domicilio        TEXT,
  localidad        TEXT,
  notas            TEXT,
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proveedores_empresa ON proveedores(empresa_id, activo);

ALTER TABLE proveedores ENABLE ROW LEVEL SECURITY;

CREATE POLICY proveedores_select ON proveedores
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno','admin','vendedor','depositero','contador')
  );

CREATE POLICY proveedores_modify ON proveedores
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno','admin')
  );

-- ════════════════════════════════════════════════════════════════════
-- REQ-01: ÓRDENES DE COMPRA
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ordenes_compra (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  proveedor_id    UUID NOT NULL REFERENCES proveedores(id),
  numero          TEXT NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'borrador'
                    CHECK (estado IN ('borrador','enviada','confirmada','recibida_parcial','recibida','cancelada')),
  fecha_pedido    DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_esperada  DATE,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas           TEXT,
  created_by      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oc_empresa    ON ordenes_compra(empresa_id, estado, fecha_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_oc_proveedor  ON ordenes_compra(proveedor_id);

CREATE TABLE IF NOT EXISTS ordenes_compra_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_compra_id     UUID NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  producto_id         UUID REFERENCES productos(id) ON DELETE SET NULL,
  descripcion         TEXT,            -- fallback si no hay producto_id
  cantidad            NUMERIC(12,3) NOT NULL,
  precio_costo        NUMERIC(12,2) NOT NULL DEFAULT 0,
  iva_pct             NUMERIC(5,2)  NOT NULL DEFAULT 21,
  subtotal            NUMERIC(14,2) NOT NULL DEFAULT 0,
  cantidad_recibida   NUMERIC(12,3) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oci_orden ON ordenes_compra_items(orden_compra_id);

ALTER TABLE ordenes_compra       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes_compra_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY oc_select ON ordenes_compra
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno','admin','vendedor','depositero','contador')
  );

CREATE POLICY oc_modify ON ordenes_compra
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno','admin','depositero')
  );

CREATE POLICY oci_select ON ordenes_compra_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM ordenes_compra oc
      WHERE oc.id = orden_compra_id
        AND oc.empresa_id = get_empresa_id()
        AND get_rol_usuario() IN ('dueno','admin','vendedor','depositero','contador')
    )
  );

CREATE POLICY oci_modify ON ordenes_compra_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM ordenes_compra oc
      WHERE oc.id = orden_compra_id
        AND oc.empresa_id = get_empresa_id()
        AND get_rol_usuario() IN ('dueno','admin','depositero')
    )
  );

-- ── Contadores para número de OC ─────────────────────────────────────────
-- Reutiliza la tabla contadores_empresa existente con tipo = 'OC'

-- ── RPC: crear_orden_compra ───────────────────────────────────────────────
-- Llamada desde service-role: recibe p_empresa_id explícito.
CREATE OR REPLACE FUNCTION crear_orden_compra(
  p_empresa_id    UUID,
  p_proveedor_id  UUID,
  p_fecha_esperada DATE DEFAULT NULL,
  p_notas         TEXT DEFAULT NULL,
  p_created_by    UUID DEFAULT NULL,
  p_items         JSONB DEFAULT '[]'  -- [{producto_id, cantidad, precio_costo, iva_pct}]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_numero  TEXT;
  v_oc_id   UUID;
  v_item    JSONB;
  v_sub     NUMERIC := 0;
  v_iva     NUMERIC := 0;
  v_it_sub  NUMERIC;
BEGIN
  -- Número correlativo
  v_numero := siguiente_numero_comprobante(p_empresa_id, 'OC');

  -- Calcular totales
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_it_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_costo')::NUMERIC;
    v_sub    := v_sub + v_it_sub;
    v_iva    := v_iva + v_it_sub * COALESCE((v_item->>'iva_pct')::NUMERIC, 21) / 100;
  END LOOP;

  INSERT INTO ordenes_compra
    (empresa_id, proveedor_id, numero, estado, fecha_esperada, notas,
     subtotal, iva_total, total, created_by)
  VALUES
    (p_empresa_id, p_proveedor_id, v_numero, 'borrador', p_fecha_esperada,
     p_notas, v_sub, v_iva, v_sub + v_iva, p_created_by)
  RETURNING id INTO v_oc_id;

  -- Insertar ítems
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_it_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_costo')::NUMERIC;
    INSERT INTO ordenes_compra_items
      (orden_compra_id, producto_id, descripcion, cantidad, precio_costo, iva_pct, subtotal)
    VALUES (
      v_oc_id,
      NULLIF(v_item->>'producto_id','')::UUID,
      v_item->>'descripcion',
      (v_item->>'cantidad')::NUMERIC,
      (v_item->>'precio_costo')::NUMERIC,
      COALESCE((v_item->>'iva_pct')::NUMERIC, 21),
      v_it_sub
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_oc_id, 'numero', v_numero);
END;
$$;

-- ── RPC: recepcionar_orden_compra ─────────────────────────────────────────
-- Registra cantidades recibidas, actualiza stock (costo promedio ponderado)
-- y actualiza estado de la OC. Recibe p_empresa_id explícito (llamado desde service-role).
CREATE OR REPLACE FUNCTION recepcionar_orden_compra(
  p_empresa_id    UUID,
  p_orden_id      UUID,
  p_items         JSONB,   -- [{producto_id, cantidad_recibida, precio_costo}]
  p_usuario_id    UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item          JSONB;
  v_prod_id       UUID;
  v_cant_recib    NUMERIC;
  v_costo         NUMERIC;
  v_deposito_id   UUID;
  v_stock_actual  NUMERIC;
  v_costo_actual  NUMERIC;
  v_nuevo_costo   NUMERIC;
  v_total_cant    NUMERIC;
  v_procesados    INT := 0;
  v_pendiente     NUMERIC;
  v_total_recibida NUMERIC;
  v_total_cant_oc  NUMERIC;
BEGIN
  -- Validar que la OC pertenece a la empresa
  IF NOT EXISTS (
    SELECT 1 FROM ordenes_compra WHERE id = p_orden_id AND empresa_id = p_empresa_id
  ) THEN
    RAISE EXCEPTION 'Orden de compra no encontrada';
  END IF;

  -- Depósito principal de la empresa (primer depósito activo)
  SELECT d.id INTO v_deposito_id
    FROM depositos d
   WHERE d.empresa_id = p_empresa_id AND d.activo = TRUE
   ORDER BY d.created_at
   LIMIT 1;

  IF v_deposito_id IS NULL THEN
    RAISE EXCEPTION 'La empresa no tiene depósitos configurados';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_prod_id    := (v_item->>'producto_id')::UUID;
    v_cant_recib := (v_item->>'cantidad_recibida')::NUMERIC;
    v_costo      := (v_item->>'precio_costo')::NUMERIC;

    IF v_cant_recib <= 0 THEN CONTINUE; END IF;

    -- Obtener stock actual y costo promedio
    SELECT cantidad, costo_promedio INTO v_stock_actual, v_costo_actual
      FROM stock
     WHERE producto_id = v_prod_id AND deposito_id = v_deposito_id
       FOR UPDATE;

    IF NOT FOUND THEN
      -- Crear registro de stock si no existe
      INSERT INTO stock (producto_id, deposito_id, cantidad, costo_promedio, empresa_id)
      VALUES (v_prod_id, v_deposito_id, 0, 0, p_empresa_id)
      ON CONFLICT (producto_id, deposito_id) DO NOTHING;

      v_stock_actual := 0;
      v_costo_actual := 0;
    END IF;

    -- Costo promedio ponderado
    v_total_cant := v_stock_actual + v_cant_recib;
    IF v_total_cant > 0 THEN
      v_nuevo_costo := (v_stock_actual * v_costo_actual + v_cant_recib * v_costo) / v_total_cant;
    ELSE
      v_nuevo_costo := v_costo;
    END IF;

    -- Actualizar stock
    UPDATE stock
       SET cantidad       = v_stock_actual + v_cant_recib,
           costo_promedio = v_nuevo_costo,
           updated_at     = now()
     WHERE producto_id = v_prod_id AND deposito_id = v_deposito_id;

    -- Actualizar costo en productos también
    UPDATE productos
       SET costo = v_nuevo_costo
     WHERE id = v_prod_id;

    -- Movimiento de stock
    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, costo_unitario, referencia, usuario_id, created_at)
    VALUES
      (v_prod_id, v_deposito_id, 'entrada_compra', v_cant_recib, v_costo,
       'OC:' || p_orden_id, p_usuario_id, now());

    -- Actualizar cantidad_recibida en el ítem de la OC
    UPDATE ordenes_compra_items
       SET cantidad_recibida = cantidad_recibida + v_cant_recib,
           precio_costo      = v_costo
     WHERE orden_compra_id = p_orden_id AND producto_id = v_prod_id;

    v_procesados := v_procesados + 1;
  END LOOP;

  -- Actualizar estado de la OC
  SELECT
    SUM(cantidad)         INTO v_total_cant_oc
  FROM ordenes_compra_items WHERE orden_compra_id = p_orden_id;

  SELECT
    SUM(cantidad_recibida) INTO v_total_recibida
  FROM ordenes_compra_items WHERE orden_compra_id = p_orden_id;

  UPDATE ordenes_compra
     SET estado     = CASE
                        WHEN v_total_recibida >= v_total_cant_oc THEN 'recibida'
                        WHEN v_total_recibida > 0               THEN 'recibida_parcial'
                        ELSE estado
                      END,
         updated_at = now()
   WHERE id = p_orden_id;

  RETURN jsonb_build_object('items_procesados', v_procesados);
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- REQ-02: REMITO_NRO EN PEDIDOS
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS remito_nro INT;

CREATE INDEX IF NOT EXISTS idx_pedidos_remito_nro ON pedidos(empresa_id, remito_nro) WHERE remito_nro IS NOT NULL;

-- ── RPC: reservar_remito_nro ──────────────────────────────────────────────
-- Asigna un número correlativo de remito a un pedido de forma atómica.
-- Recibe p_empresa_id explícito (service-role no tiene auth.uid() resuelto).
CREATE OR REPLACE FUNCTION reservar_remito_nro(
  p_empresa_id UUID,
  p_pedido_id  UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existente INT;
  v_nuevo     INT;
BEGIN
  -- Si ya tiene número, devolverlo
  SELECT remito_nro INTO v_existente
    FROM pedidos WHERE id = p_pedido_id AND empresa_id = p_empresa_id;

  IF v_existente IS NOT NULL THEN
    RETURN v_existente;
  END IF;

  -- Bloqueo pesimista: obtener y reservar el siguiente número
  INSERT INTO contadores_empresa (empresa_id, tipo, ultimo_numero, prefijo)
  VALUES (p_empresa_id, 'REMITO', 0, '')
  ON CONFLICT (empresa_id, tipo) DO NOTHING;

  UPDATE contadores_empresa
     SET ultimo_numero = ultimo_numero + 1
   WHERE empresa_id = p_empresa_id AND tipo = 'REMITO'
  RETURNING ultimo_numero INTO v_nuevo;

  UPDATE pedidos SET remito_nro = v_nuevo
   WHERE id = p_pedido_id AND empresa_id = p_empresa_id;

  RETURN v_nuevo;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- REQ-03: NOTAS DE CRÉDITO
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notas_credito (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id      UUID NOT NULL REFERENCES clientes(id),
  factura_id      UUID REFERENCES facturas(id) ON DELETE SET NULL,
  tipo            TEXT NOT NULL DEFAULT 'B' CHECK (tipo IN ('A','B','C','M')),
  numero          TEXT,                    -- asignado por AFIP al emitir
  cae             TEXT,
  cae_vto         DATE,
  pdf_url         TEXT,
  motivo          TEXT NOT NULL,
  neto            NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva             NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  estado          TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','emitida','aplicada','anulada','error_afip')),
  notas_error     TEXT,
  fecha_emision   TIMESTAMPTZ DEFAULT now(),
  created_by      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nc_empresa ON notas_credito(empresa_id, estado, fecha_emision DESC);
CREATE INDEX IF NOT EXISTS idx_nc_cliente ON notas_credito(cliente_id);
CREATE INDEX IF NOT EXISTS idx_nc_factura ON notas_credito(factura_id) WHERE factura_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notas_credito_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_credito_id UUID NOT NULL REFERENCES notas_credito(id) ON DELETE CASCADE,
  descripcion     TEXT NOT NULL,
  cantidad        NUMERIC(12,3) NOT NULL DEFAULT 1,
  precio_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_nci_nc ON notas_credito_items(nota_credito_id);

ALTER TABLE notas_credito       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notas_credito_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY nc_select ON notas_credito
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno','admin','vendedor','contador')
  );

CREATE POLICY nc_modify ON notas_credito
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno','admin')
  );

CREATE POLICY nci_select ON notas_credito_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM notas_credito nc
      WHERE nc.id = nota_credito_id
        AND nc.empresa_id = get_empresa_id()
        AND get_rol_usuario() IN ('dueno','admin','vendedor','contador')
    )
  );

CREATE POLICY nci_modify ON notas_credito_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM notas_credito nc
      WHERE nc.id = nota_credito_id
        AND nc.empresa_id = get_empresa_id()
        AND get_rol_usuario() IN ('dueno','admin')
    )
  );

-- ── RPC: crear_nota_credito ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crear_nota_credito(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_tipo        TEXT,
  p_motivo      TEXT,
  p_items       JSONB,    -- [{descripcion, cantidad, precio_unitario}]
  p_factura_id  UUID DEFAULT NULL,
  p_created_by  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_nc_id UUID;
  v_item  JSONB;
  v_neto  NUMERIC := 0;
  v_iva   NUMERIC := 0;
  v_sub   NUMERIC;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sub  := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_unitario')::NUMERIC;
    v_neto := v_neto + v_sub;
  END LOOP;

  -- IVA solo para tipo A y B (C es monotributista, sin IVA discriminado)
  IF p_tipo IN ('A','B') THEN
    v_iva := v_neto * 0.21;
  END IF;

  INSERT INTO notas_credito
    (empresa_id, cliente_id, factura_id, tipo, motivo, neto, iva, total,
     estado, created_by)
  VALUES
    (p_empresa_id, p_cliente_id, p_factura_id, p_tipo, p_motivo,
     v_neto, v_iva, v_neto + v_iva, 'pendiente', p_created_by)
  RETURNING id INTO v_nc_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_unitario')::NUMERIC;
    INSERT INTO notas_credito_items
      (nota_credito_id, descripcion, cantidad, precio_unitario, subtotal)
    VALUES (
      v_nc_id,
      v_item->>'descripcion',
      (v_item->>'cantidad')::NUMERIC,
      (v_item->>'precio_unitario')::NUMERIC,
      v_sub
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_nc_id);
END;
$$;

-- ── RPC: aplicar_nota_credito_cta_cte ────────────────────────────────────
-- Registra el crédito en la cuenta corriente del cliente.
-- Recibe p_empresa_id explícito (service-role).
CREATE OR REPLACE FUNCTION aplicar_nota_credito_cta_cte(
  p_empresa_id    UUID,
  p_nc_id         UUID,
  p_nc_numero     TEXT,
  p_cae           TEXT DEFAULT NULL,
  p_cae_vto       DATE DEFAULT NULL,
  p_pdf_url       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_nc notas_credito%ROWTYPE;
BEGIN
  SELECT * INTO v_nc FROM notas_credito
   WHERE id = p_nc_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nota de crédito no encontrada';
  END IF;

  -- Actualizar NC con datos AFIP
  UPDATE notas_credito
     SET numero      = p_nc_numero,
         cae         = p_cae,
         cae_vto     = p_cae_vto,
         pdf_url     = p_pdf_url,
         estado      = 'emitida',
         notas_error = NULL,
         updated_at  = now()
   WHERE id = p_nc_id;

  -- Acreditar en cta_cte
  INSERT INTO cta_cte
    (cliente_id, tipo, importe, factura_id, nro_comprobante, descripcion, fecha)
  VALUES (
    v_nc.cliente_id,
    'credito',
    v_nc.total,
    v_nc.factura_id,
    p_nc_numero,
    'NC-' || v_nc.tipo || ' ' || p_nc_numero || ' — ' || v_nc.motivo,
    now()
  );
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- TIPO DE MOVIMIENTO: entrada_compra (si no existe)
-- ════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  ALTER TYPE tipo_movimiento ADD VALUE IF NOT EXISTS 'entrada_compra';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- ── REQ-10: Tabla de log de emails enviados ─────────────────────────────────
-- Archivo: db/018_req10_email_log.sql
-- Registra cada email enviado para historial y auditoría.
-- La columna resend_id permite rastrear el estado en Resend si fuera necesario.

CREATE TABLE IF NOT EXISTS email_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id    UUID REFERENCES clientes(id) ON DELETE SET NULL,
  tipo          TEXT NOT NULL,          -- 'estado_cuenta' | 'confirmacion_pedido' | etc.
  destinatario  TEXT NOT NULL,
  asunto        TEXT,
  resend_id     TEXT,                   -- ID de Resend para tracking
  enviado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Índices útiles para consultas de historial
CREATE INDEX IF NOT EXISTS idx_email_log_empresa   ON email_log(empresa_id);
CREATE INDEX IF NOT EXISTS idx_email_log_cliente   ON email_log(cliente_id);
CREATE INDEX IF NOT EXISTS idx_email_log_tipo      ON email_log(tipo);
CREATE INDEX IF NOT EXISTS idx_email_log_created   ON email_log(created_at DESC);

-- RLS: solo usuarios de la misma empresa pueden ver sus logs
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_log_empresa" ON email_log
  FOR ALL USING (
    empresa_id = (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );

-- ── Comentarios descriptivos ────────────────────────────────────────────────
COMMENT ON TABLE email_log IS 'Log de todos los emails transaccionales enviados por la app.';
COMMENT ON COLUMN email_log.tipo IS 'Tipo de email: estado_cuenta, confirmacion_pedido, despacho, reset_password, etc.';
COMMENT ON COLUMN email_log.resend_id IS 'ID del mensaje en Resend API para tracking de entrega.';
-- =============================================================================
-- 048_fix_sync_code_v47.sql
-- Sincronización esquema ↔ código v47
--
-- Corrige todos los desajustes detectados entre el backup de la DB real y el
-- código de los handlers. Aplicar una sola vez en el proyecto Supabase.
-- =============================================================================

-- ── 1. notif_log — tabla faltante en backup ───────────────────────────────
-- Definida en 005_notif_log.sql pero no presente en el backup de producción.
-- Usada por notif.js, _push.js y pedidos.js para auditoría de mensajes WA/Push.
CREATE TABLE IF NOT EXISTS public.notif_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id   UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  pedido_id    UUID REFERENCES public.pedidos(id)  ON DELETE SET NULL,
  tipo         TEXT NOT NULL,
  canal        TEXT NOT NULL DEFAULT 'whatsapp',
  telefono     TEXT,
  email        TEXT,
  message_id   TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_cliente_tipo
    ON public.notif_log (cliente_id, tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_log_pedido
    ON public.notif_log (pedido_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_empresa
    ON public.notif_log (empresa_id, created_at DESC);

ALTER TABLE public.notif_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ver notif_log propia empresa" ON public.notif_log;
CREATE POLICY "ver notif_log propia empresa"
  ON public.notif_log FOR SELECT
  USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()
    )
  );

-- ── 2. categorias.activa — columna faltante ───────────────────────────────
-- Migration 041 la agrega como 'activa' (femenino). El código usa .eq('activa').
-- Idempotente: IF NOT EXISTS.
ALTER TABLE public.categorias
    ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_categorias_empresa_activa
    ON public.categorias (empresa_id, activa);

-- ── 3. lotes — estado CHECK y columnas ───────────────────────────────────
-- La tabla lotes en el backup usa: 'activo','agotado','vencido'.
-- El código insertaba 'vigente' (incorrecto) y filtraba 'dado_de_baja' (inexistente).
-- Ambos ya corregidos en el código. No se necesita cambio de esquema aquí.
-- Confirmar constraint existente:
-- CONSTRAINT lotes_estado_check CHECK (estado IN ('activo','agotado','vencido'))
-- Si hubiera filas con estado='vigente' del pasado, normalizar:
UPDATE public.lotes SET estado = 'activo' WHERE estado = 'vigente';
UPDATE public.lotes SET estado = 'agotado' WHERE estado = 'dado_de_baja';

-- ── 4. canjear_puntos — función faltante ─────────────────────────────────
-- Requerida por frontend/admin/js/puntos.js y frontend/cliente/js/puntos.js.
-- Descuenta puntos del saldo y registra el movimiento.
CREATE OR REPLACE FUNCTION public.canjear_puntos(
    p_empresa_id     UUID,
    p_cliente_id     UUID,
    p_puntos         INTEGER,
    p_concepto       TEXT    DEFAULT 'Canje manual',
    p_ref_tipo       TEXT    DEFAULT 'manual',
    p_usuario_id     UUID    DEFAULT NULL,
    p_usuario_nombre TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_saldo_actual INTEGER;
    v_saldo_nuevo  INTEGER;
BEGIN
    -- Leer saldo actual con bloqueo
    SELECT COALESCE(puntos_disponibles, 0)
      INTO v_saldo_actual
      FROM public.saldo_puntos
     WHERE cliente_id = p_cliente_id
       AND empresa_id = p_empresa_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El cliente no tiene saldo de puntos';
    END IF;

    IF v_saldo_actual < p_puntos THEN
        RAISE EXCEPTION 'Saldo insuficiente (disponible: %, requerido: %)', v_saldo_actual, p_puntos;
    END IF;

    v_saldo_nuevo := v_saldo_actual - p_puntos;

    -- Actualizar saldo
    UPDATE public.saldo_puntos
       SET puntos_disponibles = v_saldo_nuevo,
           puntos_canjeados   = COALESCE(puntos_canjeados, 0) + p_puntos,
           ultimo_movimiento  = now()
     WHERE cliente_id = p_cliente_id
       AND empresa_id = p_empresa_id;

    -- Registrar movimiento
    INSERT INTO public.movimientos_puntos
           (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
    VALUES (p_cliente_id, p_empresa_id, 'canje', p_puntos, p_concepto, NULL);

    RETURN json_build_object('ok', true, 'saldo_nuevo', v_saldo_nuevo);
END;
$$;

-- ── 5. acreditar_puntos — función faltante ────────────────────────────────
-- Requerida por frontend/admin/js/puntos.js para acreditación manual.
CREATE OR REPLACE FUNCTION public.acreditar_puntos(
    p_empresa_id     UUID,
    p_cliente_id     UUID,
    p_puntos         INTEGER,
    p_concepto       TEXT    DEFAULT 'Acreditación manual',
    p_ref_tipo       TEXT    DEFAULT 'manual',
    p_usuario_id     UUID    DEFAULT NULL,
    p_usuario_nombre TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_saldo_nuevo INTEGER;
BEGIN
    -- Upsert saldo
    INSERT INTO public.saldo_puntos
           (cliente_id, empresa_id, puntos_disponibles, puntos_totales, ultimo_movimiento)
    VALUES (p_cliente_id, p_empresa_id, p_puntos, p_puntos, now())
    ON CONFLICT (cliente_id, empresa_id) DO UPDATE
       SET puntos_disponibles = saldo_puntos.puntos_disponibles + p_puntos,
           puntos_totales     = saldo_puntos.puntos_totales + p_puntos,
           ultimo_movimiento  = now()
    RETURNING puntos_disponibles INTO v_saldo_nuevo;

    -- Registrar movimiento
    INSERT INTO public.movimientos_puntos
           (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
    VALUES (p_cliente_id, p_empresa_id, 'ganancia', p_puntos, p_concepto, NULL);

    RETURN json_build_object('ok', true, 'saldo', v_saldo_nuevo);
END;
$$;

-- ── 6. saldo_puntos — unique constraint (cliente_id, empresa_id) ──────────
-- El código hace upsert con onConflict: 'cliente_id,empresa_id'.
-- Asegurar que existe el constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.saldo_puntos'::regclass
           AND contype = 'u'
           AND conkey = ARRAY(
                SELECT attnum FROM pg_attribute
                 WHERE attrelid = 'public.saldo_puntos'::regclass
                   AND attname IN ('cliente_id','empresa_id')
                 ORDER BY attnum
               )
    ) THEN
        ALTER TABLE public.saldo_puntos
            ADD CONSTRAINT saldo_puntos_cliente_empresa_uq UNIQUE (cliente_id, empresa_id);
    END IF;
END $$;

-- ── 7. presupuesto_items — descuento_pct ─────────────────────────────────
-- La tabla tiene 'descuento_pct'. El código usaba 'descuento' (ya corregido).
-- Si la tabla tiene 'descuento' en vez de 'descuento_pct', crear alias:
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'presupuesto_items'
           AND column_name  = 'descuento'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'presupuesto_items'
           AND column_name  = 'descuento_pct'
    ) THEN
        ALTER TABLE public.presupuesto_items RENAME COLUMN descuento TO descuento_pct;
    END IF;
END $$;

-- ── Fin 048_fix_sync_code_v47.sql ────────────────────────────────────────
-- db/021_req05_presupuestos.sql
-- REQ-05: Módulo de presupuestos
-- Ejecutar en orden después de 020_dt02_puntos.sql

-- ── Tabla presupuestos ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presupuestos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id        UUID NOT NULL REFERENCES clientes(id),
  vendedor_id       UUID REFERENCES usuarios(id),
  numero            TEXT NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'borrador'
                    CHECK (estado IN ('borrador','enviado','aprobado','rechazado','expirado','convertido')),
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total             NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas             TEXT,
  fecha_vencimiento TIMESTAMPTZ,
  pedido_id         UUID REFERENCES pedidos(id),   -- rellenado al convertir
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Tabla presupuesto_items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presupuesto_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  presupuesto_id   UUID NOT NULL REFERENCES presupuestos(id) ON DELETE CASCADE,
  producto_id      UUID REFERENCES productos(id),
  descripcion      TEXT NOT NULL DEFAULT '',
  cantidad         NUMERIC(12,3) NOT NULL DEFAULT 1,
  precio_unitario  NUMERIC(14,2) NOT NULL DEFAULT 0,
  descuento        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0
);

-- ── Campo presupuesto_id en pedidos ──────────────────────────────────────
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS presupuesto_id UUID REFERENCES presupuestos(id);

-- ── Config: vigencia por defecto en empresas ─────────────────────────────
-- Se guarda en empresas.config JSONB como { "presupuestos_vigencia_dias": 2 }
-- No requiere migración de columna (config ya existe como JSONB)

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE presupuestos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE presupuesto_items ENABLE ROW LEVEL SECURITY;

-- Admin y vendedor: acceso total a su empresa
CREATE POLICY "presupuestos_empresa" ON presupuestos
  FOR ALL TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE POLICY "presupuesto_items_empresa" ON presupuesto_items
  FOR ALL TO authenticated
  USING (
    presupuesto_id IN (
      SELECT id FROM presupuestos
      WHERE empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    )
  );

-- ── Índices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_presupuestos_empresa  ON presupuestos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_presupuestos_cliente  ON presupuestos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_presupuestos_estado   ON presupuestos(estado);
CREATE INDEX IF NOT EXISTS idx_presupuestos_venc     ON presupuestos(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_pres_items_pres       ON presupuesto_items(presupuesto_id);

-- ── Trigger: marcar expirados ─────────────────────────────────────────────
-- Se llama desde el endpoint GET para marcar vencidos sin cron
CREATE OR REPLACE FUNCTION marcar_presupuestos_expirados(p_empresa_id UUID)
RETURNS void AS $$
  UPDATE presupuestos
  SET    estado = 'expirado', updated_at = now()
  WHERE  empresa_id        = p_empresa_id
    AND  estado            = 'enviado'
    AND  fecha_vencimiento < now();
$$ LANGUAGE sql;
-- db/022_req06_lotes.sql
-- REQ-06: Control de lotes y vencimientos
-- Ejecutar después de 021_req05_presupuestos.sql

-- ── Tabla lotes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id         UUID NOT NULL REFERENCES productos(id),
  deposito_id         UUID REFERENCES depositos(id),
  numero_lote         TEXT,
  cantidad            NUMERIC(12,3) NOT NULL DEFAULT 0,
  cantidad_reservada  NUMERIC(12,3) NOT NULL DEFAULT 0,
  fecha_vencimiento   DATE,
  fecha_fabricacion   DATE,
  costo_unitario      NUMERIC(14,2),
  estado              TEXT NOT NULL DEFAULT 'vigente'
                      CHECK (estado IN ('vigente','por_vencer','vencido','agotado','dado_de_baja')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE lotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lotes_empresa" ON lotes
  FOR ALL TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ── Índices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lotes_empresa    ON lotes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_lotes_producto   ON lotes(producto_id);
CREATE INDEX IF NOT EXISTS idx_lotes_deposito   ON lotes(deposito_id);
CREATE INDEX IF NOT EXISTS idx_lotes_venc       ON lotes(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_lotes_estado     ON lotes(estado);

-- ── Función: actualizar estado automáticamente ────────────────────────────
-- Llamada desde la API al listar para mantener estados sincronizados.
CREATE OR REPLACE FUNCTION actualizar_estado_lotes(p_empresa_id UUID)
RETURNS void AS $$
  -- Marcar vencidos
  UPDATE lotes
  SET    estado = 'vencido', updated_at = now()
  WHERE  empresa_id       = p_empresa_id
    AND  estado           = 'vigente'
    AND  fecha_vencimiento < CURRENT_DATE
    AND  cantidad         > 0;

  -- Marcar por_vencer (próximos 7 días)
  UPDATE lotes
  SET    estado = 'por_vencer', updated_at = now()
  WHERE  empresa_id       = p_empresa_id
    AND  estado           = 'vigente'
    AND  fecha_vencimiento BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
    AND  cantidad         > 0;

  -- Marcar agotados
  UPDATE lotes
  SET    estado = 'agotado', updated_at = now()
  WHERE  empresa_id = p_empresa_id
    AND  estado NOT IN ('agotado', 'dado_de_baja')
    AND  cantidad   = 0;
$$ LANGUAGE sql;
-- ============================================================
-- 027_refresh_tokens.sql
-- distrib-v38-optimized | Módulo 2: Seguridad JWT
--
-- Tabla para Refresh Token Rotation con detección de reuso.
-- Mantiene el prefijo de numeración existente (026_, 027_, ...)
-- ============================================================

BEGIN;

-- ── Tabla de refresh tokens ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id           BIGSERIAL    PRIMARY KEY,
    usuario_id   BIGINT       NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    token_hash   CHAR(64)     NOT NULL UNIQUE,  -- SHA-256 del token (nunca el crudo)
    expires_at   TIMESTAMPTZ  NOT NULL,
    revocado     BOOLEAN      NOT NULL DEFAULT FALSE,
    ip           TEXT,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice para lookup por hash (login/refresh críticos)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash
    ON public.refresh_tokens (token_hash)
    WHERE revocado = FALSE;

-- Índice para revocar todos los tokens de un usuario (logout global)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario
    ON public.refresh_tokens (usuario_id)
    WHERE revocado = FALSE;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;

-- Solo el service role puede leer/escribir (nunca expuesto al cliente)
CREATE POLICY "solo_service_role" ON public.refresh_tokens
    USING (auth.role() = 'service_role');

-- ── Limpieza automática: tokens expirados o revocados > 30 días ───────────────
CREATE OR REPLACE FUNCTION public.limpiar_refresh_tokens_expirados()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.refresh_tokens
    WHERE expires_at < NOW()
       OR (revocado = TRUE AND created_at < NOW() - INTERVAL '30 days');
END;
$$;

-- Programar limpieza diaria via pg_cron (si está habilitado en Supabase)
-- Descomentar si tenés pg_cron activado:
-- SELECT cron.schedule('limpiar-refresh-tokens', '0 3 * * *', 'SELECT public.limpiar_refresh_tokens_expirados()');

-- ── Comentarios ───────────────────────────────────────────────────────────────
COMMENT ON TABLE  public.refresh_tokens                IS 'Refresh tokens hasheados para rotación segura de sesiones';
COMMENT ON COLUMN public.refresh_tokens.token_hash     IS 'SHA-256 del JWT de refresh. Nunca almacenar el token crudo.';
COMMENT ON COLUMN public.refresh_tokens.revocado       IS 'TRUE si fue usado (rotado) o el usuario hizo logout.';

COMMIT;
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
-- ============================================================
-- 031_push_subscriptions.sql
-- distrib-v38-optimized | Módulo 4: Push Notifications
--
-- Tabla para suscripciones Web Push (VAPID).
-- Trigger que notifica al backend cuando se crea/actualiza un pedido.
-- ============================================================

BEGIN;

-- ── Tabla de suscripciones push ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id           BIGSERIAL    PRIMARY KEY,
    usuario_id   BIGINT       NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    endpoint     TEXT         NOT NULL,
    p256dh       TEXT         NOT NULL,   -- clave pública del cliente
    auth_key     TEXT         NOT NULL,   -- clave de autenticación del cliente
    user_agent   TEXT,
    portal       TEXT         NOT NULL DEFAULT 'cliente',  -- 'cliente' | 'chofer' | 'admin'
    activo       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (usuario_id, endpoint)
);

-- Índices para lookup eficiente
CREATE INDEX IF NOT EXISTS idx_push_subs_usuario
    ON public.push_subscriptions (usuario_id)
    WHERE activo = TRUE;

CREATE INDEX IF NOT EXISTS idx_push_subs_portal
    ON public.push_subscriptions (portal)
    WHERE activo = TRUE;

-- RLS
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_subs_own" ON public.push_subscriptions
    FOR ALL USING (
        auth.role() = 'service_role'
        OR usuario_id = public.auth_usuario_id()
    );


-- ── Tabla de log de notificaciones enviadas ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_log (
    id           BIGSERIAL    PRIMARY KEY,
    usuario_id   BIGINT       REFERENCES public.usuarios(id) ON DELETE SET NULL,
    tipo         TEXT         NOT NULL,   -- 'pedido_nuevo' | 'estado_cambio' | 'remito_sync' etc.
    titulo       TEXT         NOT NULL,
    cuerpo       TEXT,
    payload      JSONB,
    enviado      BOOLEAN      NOT NULL DEFAULT FALSE,
    error        TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_log_usuario
    ON public.push_log (usuario_id, created_at DESC);

ALTER TABLE public.push_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "push_log_admin" ON public.push_log
    FOR ALL USING (auth.role() = 'service_role' OR public.es_admin());


-- ── Función + Trigger: notificar API cuando cambia estado de pedido ───────────
-- Usa pg_notify para comunicación asíncrona DB→API sin polling

CREATE OR REPLACE FUNCTION public.trigger_notif_pedido_estado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Solo notificar si el estado realmente cambió
    IF OLD.estado IS DISTINCT FROM NEW.estado THEN
        PERFORM pg_notify(
            'pedido_estado_cambio',
            jsonb_build_object(
                'pedido_id',  NEW.id,
                'numero',     NEW.numero_pedido,
                'cliente_id', NEW.cliente_id,
                'chofer_id',  NEW.chofer_id,
                'estado_old', OLD.estado,
                'estado_new', NEW.estado,
                'ts',         EXTRACT(EPOCH FROM NOW())::BIGINT
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_pedido_estado ON public.pedidos;
CREATE TRIGGER trg_notif_pedido_estado
    AFTER UPDATE OF estado ON public.pedidos
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_notif_pedido_estado();


-- ── Función para obtener suscriptores por rol ─────────────────────────────────
-- Usada por la API /api/notif para resolver a quién enviar

CREATE OR REPLACE FUNCTION public.obtener_suscriptores_push(
    p_portal       TEXT    DEFAULT NULL,  -- NULL = todos los portales
    p_usuario_ids  BIGINT[] DEFAULT NULL  -- NULL = todos los activos
)
RETURNS TABLE (
    subscription_id BIGINT,
    usuario_id      BIGINT,
    endpoint        TEXT,
    p256dh          TEXT,
    auth_key        TEXT,
    portal          TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id, usuario_id, endpoint, p256dh, auth_key, portal
    FROM public.push_subscriptions
    WHERE activo = TRUE
      AND (p_portal IS NULL       OR portal     = p_portal)
      AND (p_usuario_ids IS NULL  OR usuario_id = ANY(p_usuario_ids));
$$;

REVOKE ALL ON FUNCTION public.obtener_suscriptores_push FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_suscriptores_push TO service_role;

COMMIT;
-- ═══════════════════════════════════════════════════════════════════════════
-- REQ-2: Cierre Financiero Encadenado Automático
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cola_financiera (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  referencia_id   UUID,
  estado          TEXT DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','procesando','completado','error','omitido')),
  intentos        INT DEFAULT 0,
  proximo_intento TIMESTAMPTZ DEFAULT now(),
  payload         JSONB DEFAULT '{}',
  error_msg       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cola_fin_pendiente ON cola_financiera(empresa_id, estado, proximo_intento)
  WHERE estado IN ('pendiente','error');

ALTER TABLE cola_financiera ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cola_fin_empresa ON cola_financiera;
CREATE POLICY cola_fin_empresa ON cola_financiera
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE TABLE IF NOT EXISTS bloqueos_cliente (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE UNIQUE,
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  motivo      TEXT NOT NULL,
  deuda_monto NUMERIC(12,2),
  activo      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bloqueos_cliente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bloqueos_empresa ON bloqueos_cliente;
CREATE POLICY bloqueos_empresa ON bloqueos_cliente
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bloqueado        BOOLEAN DEFAULT false;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bloqueado_motivo TEXT;

ALTER TABLE facturas ADD COLUMN IF NOT EXISTS pedido_id         UUID REFERENCES pedidos(id);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS notif_3d_enviada  BOOLEAN DEFAULT false;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS notif_7d_enviada  BOOLEAN DEFAULT false;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS notif_15d_enviada BOOLEAN DEFAULT false;

-- ─── Trigger: encadenar cierre financiero cuando se confirma una entrega ───
CREATE OR REPLACE FUNCTION fn_cierre_financiero_entrega()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pedido     RECORD;
  v_empresa_id UUID;
  v_dias_cred  INT;
BEGIN
  IF NEW.estado <> 'entregado' OR OLD.estado = 'entregado' THEN RETURN NEW; END IF;

  SELECT p.*, c.dias_credito, r.empresa_id INTO v_pedido
  FROM pedidos p
  JOIN rutas r ON r.id = NEW.ruta_id
  JOIN clientes c ON c.id = p.cliente_id
  WHERE p.id = NEW.pedido_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  v_empresa_id := v_pedido.empresa_id;
  v_dias_cred  := COALESCE(v_pedido.dias_credito, 0);

  -- Encolar facturación
  INSERT INTO cola_financiera (empresa_id, tipo, referencia_id, payload)
  VALUES (v_empresa_id, 'facturar', NEW.pedido_id,
    jsonb_build_object(
      'pedido_id',   NEW.pedido_id,
      'cliente_id',  v_pedido.cliente_id,
      'total',       v_pedido.total,
      'dias_credito', v_dias_cred,
      'vence_en',    (CURRENT_DATE + v_dias_cred)::TEXT
    ));

  -- Encolar notificación de vencimiento (si tiene crédito)
  IF v_dias_cred > 0 THEN
    INSERT INTO cola_financiera (empresa_id, tipo, referencia_id, proximo_intento, payload)
    VALUES (v_empresa_id, 'notif_vencimiento', v_pedido.cliente_id,
      now() + (v_dias_cred - 3) * INTERVAL '1 day',
      jsonb_build_object('dias_vencimiento', v_dias_cred));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_cierre_financiero ON entregas;
CREATE TRIGGER tg_cierre_financiero
  AFTER UPDATE ON entregas
  FOR EACH ROW
  EXECUTE FUNCTION fn_cierre_financiero_entrega();
-- ═══════════════════════════════════════════════════════════════════════════
-- REQ-5: Score de Salud del Cliente ("Semáforo Inteligente")
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scores_cliente (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id       UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  empresa_id       UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  score            NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  score_pagos      NUMERIC(5,2),
  score_frecuencia NUMERIC(5,2),
  score_deuda      NUMERIC(5,2),
  score_devolucion NUMERIC(5,2),
  motivo_cambio    TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_score_cliente ON scores_cliente(cliente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_empresa ON scores_cliente(empresa_id);

ALTER TABLE scores_cliente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS score_empresa ON scores_cliente;
CREATE POLICY score_empresa ON scores_cliente
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS score_actual      NUMERIC(5,2) DEFAULT 50;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS score_categoria   TEXT DEFAULT 'normal'
  CHECK (score_categoria IN ('premium','bueno','normal','riesgo','bloqueado'));
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS score_actualizado TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS alertas_score (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  empresa_id     UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  score_anterior NUMERIC(5,2),
  score_nuevo    NUMERIC(5,2),
  mensaje        TEXT,
  resuelta       BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE alertas_score ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alertas_score_empresa ON alertas_score;
CREATE POLICY alertas_score_empresa ON alertas_score
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE TABLE IF NOT EXISTS reglas_score (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE UNIQUE,
  umbral_premium       INT DEFAULT 80,
  umbral_bueno         INT DEFAULT 65,
  umbral_normal        INT DEFAULT 45,
  umbral_riesgo        INT DEFAULT 30,
  mult_credito_premium NUMERIC(4,2) DEFAULT 2.0,
  mult_credito_bueno   NUMERIC(4,2) DEFAULT 1.5,
  mult_credito_normal  NUMERIC(4,2) DEFAULT 1.0,
  mult_credito_riesgo  NUMERIC(4,2) DEFAULT 0.5,
  dias_cred_premium    INT DEFAULT 45,
  dias_cred_bueno      INT DEFAULT 30,
  dias_cred_normal     INT DEFAULT 15,
  dias_cred_riesgo     INT DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- ─── Función: calcular score de un cliente ─────────────────────────────────
CREATE OR REPLACE FUNCTION calcular_score_cliente(
  p_cliente_id UUID, p_empresa_id UUID, p_motivo TEXT DEFAULT 'recalculo'
)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pagos      NUMERIC := 0;
  v_frecuencia NUMERIC := 0;
  v_deuda      NUMERIC := 0;
  v_devol      NUMERIC := 0;
  v_total      NUMERIC := 0;
  v_anterior   NUMERIC;
  v_categoria  TEXT;
  v_reglas     RECORD;
  v_dias_prom  NUMERIC;
  v_deuda_act  NUMERIC;
  v_lim_cred   NUMERIC;
  v_pct_devol  NUMERIC;
  v_pedidos90  INT;
  v_nuevos_dias INT;
BEGIN
  -- Componente Pagos (0-40 pts): velocidad de pago respecto al vencimiento
  SELECT AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0) INTO v_dias_prom
  FROM cobros co
  JOIN facturas f ON f.pedido_id = (
    SELECT pedido_id FROM cta_cte WHERE cobro_id = co.id LIMIT 1
  )
  WHERE co.cliente_id = p_cliente_id AND co.fecha >= now() - INTERVAL '90 days';

  v_pagos := CASE
    WHEN v_dias_prom IS NULL  THEN 20
    WHEN v_dias_prom <= -5    THEN 40
    WHEN v_dias_prom <= 0     THEN 35
    WHEN v_dias_prom <= 7     THEN 25
    WHEN v_dias_prom <= 15    THEN 15
    WHEN v_dias_prom <= 30    THEN 5
    ELSE 0 END;

  -- Componente Frecuencia (0-25 pts): pedidos en últimos 90 días
  SELECT COUNT(*) INTO v_pedidos90 FROM pedidos
  WHERE cliente_id = p_cliente_id AND empresa_id = p_empresa_id
    AND estado IN ('entregado','despachado','confirmado')
    AND fecha_pedido >= now() - INTERVAL '90 days';
  v_frecuencia := LEAST(25, v_pedidos90 * 3);

  -- Componente Deuda (0-20 pts): ratio deuda/límite
  SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0) INTO v_deuda_act 
  FROM cta_cte
  WHERE cliente_id = p_cliente_id;
  SELECT COALESCE(limite_credito, 0) INTO v_lim_cred FROM clientes WHERE id = p_cliente_id;

  v_deuda := CASE
    WHEN v_lim_cred = 0                          THEN 10
    WHEN v_deuda_act <= 0                        THEN 20
    WHEN (v_deuda_act / v_lim_cred) <= 0.3      THEN 18
    WHEN (v_deuda_act / v_lim_cred) <= 0.6      THEN 12
    WHEN (v_deuda_act / v_lim_cred) <= 0.9      THEN 6
    ELSE 0 END;

  -- Componente Devoluciones (0-15 pts): tasa de devolución
  SELECT CASE WHEN SUM(pi2.cantidad) > 0
    THEN COALESCE(
      SUM(CASE WHEN e.estado = 'devolucion' THEN pi2.cantidad ELSE 0 END) /
      SUM(pi2.cantidad), 0) * 100
    ELSE 0 END INTO v_pct_devol
  FROM pedidos p
  JOIN pedido_items pi2 ON pi2.pedido_id = p.id
  LEFT JOIN entregas e ON e.pedido_id = p.id
  WHERE p.cliente_id = p_cliente_id AND p.empresa_id = p_empresa_id
    AND p.fecha_pedido >= now() - INTERVAL '90 days';

  v_devol := CASE
    WHEN v_pct_devol = 0   THEN 15
    WHEN v_pct_devol < 5   THEN 12
    WHEN v_pct_devol < 10  THEN 8
    WHEN v_pct_devol < 20  THEN 4
    ELSE 0 END;

  v_total := v_pagos + v_frecuencia + v_deuda + v_devol;

  -- Guardar en historial
  SELECT score INTO v_anterior FROM scores_cliente
  WHERE cliente_id = p_cliente_id ORDER BY created_at DESC LIMIT 1;

  INSERT INTO scores_cliente (
    cliente_id, empresa_id, score,
    score_pagos, score_frecuencia, score_deuda, score_devolucion, motivo_cambio
  ) VALUES (
    p_cliente_id, p_empresa_id, v_total,
    v_pagos, v_frecuencia, v_deuda, v_devol, p_motivo
  );

  -- Determinar categoría según reglas de la empresa
  SELECT * INTO v_reglas FROM reglas_score WHERE empresa_id = p_empresa_id;

  v_categoria := CASE
    WHEN v_total >= COALESCE(v_reglas.umbral_premium, 80) THEN 'premium'
    WHEN v_total >= COALESCE(v_reglas.umbral_bueno,   65) THEN 'bueno'
    WHEN v_total >= COALESCE(v_reglas.umbral_normal,  45) THEN 'normal'
    WHEN v_total >= COALESCE(v_reglas.umbral_riesgo,  30) THEN 'riesgo'
    ELSE 'bloqueado' END;

  v_nuevos_dias := COALESCE(CASE v_categoria
    WHEN 'premium'  THEN v_reglas.dias_cred_premium
    WHEN 'bueno'    THEN v_reglas.dias_cred_bueno
    WHEN 'normal'   THEN v_reglas.dias_cred_normal
    WHEN 'riesgo'   THEN v_reglas.dias_cred_riesgo
    ELSE 0 END, 0);

  -- Actualizar cliente con nuevo score, categoría y condiciones de crédito
  UPDATE clientes SET
    score_actual      = v_total,
    score_categoria   = v_categoria,
    score_actualizado = now(),
    dias_credito      = v_nuevos_dias,
    bloqueado         = (v_categoria = 'bloqueado'),
    bloqueado_motivo  = CASE
      WHEN v_categoria = 'bloqueado'
      THEN 'Score crediticio insuficiente (' || v_total::INT || '/100)'
      ELSE NULL END
  WHERE id = p_cliente_id;

  -- Generar alerta si el score bajó 15+ puntos
  IF v_anterior IS NOT NULL AND (v_anterior - v_total) >= 15 THEN
    INSERT INTO alertas_score (cliente_id, empresa_id, score_anterior, score_nuevo, mensaje)
    VALUES (p_cliente_id, p_empresa_id, v_anterior, v_total,
      'El cliente degradó su score ' || v_anterior::INT || ' → ' || v_total::INT ||
      ' puntos. Revisar situación crediticia.');
  END IF;

  RETURN v_total;
END;
$$;

-- ─── Trigger: recalcular score al registrar un cobro ──────────────────────
CREATE OR REPLACE FUNCTION tg_score_cobro()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM calcular_score_cliente(NEW.cliente_id, NEW.empresa_id, 'pago_registrado');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_score_after_cobro ON cobros;
CREATE TRIGGER tg_score_after_cobro
  AFTER INSERT ON cobros
  FOR EACH ROW EXECUTE FUNCTION tg_score_cobro();

-- ─── Trigger: recalcular score al confirmar entrega ───────────────────────
CREATE OR REPLACE FUNCTION tg_score_entrega()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cli UUID;
  v_emp UUID;
BEGIN
  IF NEW.estado = 'entregado' AND OLD.estado <> 'entregado' THEN
    SELECT p.cliente_id, r.empresa_id INTO v_cli, v_emp
    FROM pedidos p
    JOIN rutas r ON r.id = NEW.ruta_id
    WHERE p.id = NEW.pedido_id;
    IF FOUND THEN
      PERFORM calcular_score_cliente(v_cli, v_emp, 'entrega_confirmada');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_score_after_entrega ON entregas;
CREATE TRIGGER tg_score_after_entrega
  AFTER UPDATE ON entregas
  FOR EACH ROW EXECUTE FUNCTION tg_score_entrega();

-- Insertar reglas default (ajustar empresa_id según corresponda)
-- INSERT INTO reglas_score (empresa_id) SELECT id FROM empresas ON CONFLICT (empresa_id) DO NOTHING;
-- 037_notif_prefs_auto.sql
-- Preferencias de notificaciones push para los motores de automatización.
-- Una fila por empresa; cada columna booleana controla un tipo de evento.

CREATE TABLE IF NOT EXISTS notif_prefs_auto (
  empresa_id              UUID        PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,

  -- REQ-1: Piloto Automático
  piloto_sugerencia       BOOLEAN     NOT NULL DEFAULT TRUE,   -- Nuevas sugerencias de pedido generadas

  -- REQ-2: Cierre Financiero
  cierre_cliente_bloqueado BOOLEAN    NOT NULL DEFAULT TRUE,   -- Cliente bloqueado por deuda
  cierre_error_cola        BOOLEAN    NOT NULL DEFAULT TRUE,   -- Error en la cola financiera

  -- REQ-4: Stock Autónomo
  stock_quiebre           BOOLEAN     NOT NULL DEFAULT TRUE,   -- Quiebre de stock detectado
  stock_orden_auto        BOOLEAN     NOT NULL DEFAULT TRUE,   -- Orden de compra auto-generada esperando aprobación

  -- REQ-5: Score Cliente
  score_caida_critica     BOOLEAN     NOT NULL DEFAULT TRUE,   -- Cliente cae a "riesgo" o "bloqueado"

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION set_notif_prefs_auto_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_notif_prefs_auto_updated ON notif_prefs_auto;
CREATE TRIGGER trg_notif_prefs_auto_updated
  BEFORE UPDATE ON notif_prefs_auto
  FOR EACH ROW EXECUTE FUNCTION set_notif_prefs_auto_updated();

-- RLS
ALTER TABLE notif_prefs_auto ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin accede a sus prefs notif"
  ON notif_prefs_auto FOR ALL
  USING (
    empresa_id IN (
      SELECT empresa_id FROM usuarios
      WHERE auth_uid = auth.uid() AND rol IN ('dueno', 'admin')
    )
  );

-- Índice (PK ya cubre empresa_id; no se necesita extra)

COMMENT ON TABLE notif_prefs_auto IS
  'Preferencias de notificaciones push por motor de automatización, una fila por empresa.';
-- ═══════════════════════════════════════════════════════════════════════════
-- 051_automatizacion_setup.sql — Tablas para el panel de automatización
-- Idempotente: usa IF NOT EXISTS en todo.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. notif_prefs_auto — preferencias de alertas push por empresa
CREATE TABLE IF NOT EXISTS public.notif_prefs_auto (
  empresa_id              UUID PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  piloto_sugerencia       BOOLEAN DEFAULT true,
  cierre_cliente_bloqueado BOOLEAN DEFAULT true,
  cierre_error_cola       BOOLEAN DEFAULT true,
  stock_quiebre           BOOLEAN DEFAULT true,
  stock_orden_auto        BOOLEAN DEFAULT true,
  score_caida_critica     BOOLEAN DEFAULT true,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.notif_prefs_auto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif_prefs_auto_empresa" ON public.notif_prefs_auto;
CREATE POLICY "notif_prefs_auto_empresa" ON public.notif_prefs_auto
  FOR ALL USING (empresa_id = public.get_empresa_id());

-- 2. Insertar fila de prefs para empresas existentes que no la tengan
INSERT INTO public.notif_prefs_auto (empresa_id)
SELECT id FROM public.empresas
WHERE id NOT IN (SELECT empresa_id FROM public.notif_prefs_auto)
ON CONFLICT DO NOTHING;

-- 3. ciclos_compra: asegurar índice en proximo_pedido (para el piloto)
CREATE INDEX IF NOT EXISTS idx_ciclos_proximo_activo
  ON public.ciclos_compra (empresa_id, proximo_pedido)
  WHERE activo = true;

-- 4. clientes: asegurar columnas de score si no existen (migration 036)
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_actual        NUMERIC(5,2);
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_categoria     TEXT;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_actualizado   TIMESTAMPTZ;

-- 5. rutas: columnas GPS si no existen (migration 034)
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS chofer_lat         DOUBLE PRECISION;
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS chofer_lng         DOUBLE PRECISION;
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS chofer_actualizado TIMESTAMPTZ;

-- 6. Índices útiles para queries del panel
CREATE INDEX IF NOT EXISTS idx_facturas_empresa_estado
  ON public.facturas (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_cobros_empresa_fecha
  ON public.cobros (empresa_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_rutas_empresa_fecha
  ON public.rutas (empresa_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_lotes_empresa_vencimiento
  ON public.lotes (empresa_id, fecha_vencimiento)
  WHERE estado = 'activo';

-- 7. Verificación final
SELECT 'notif_prefs_auto' AS tabla, COUNT(*) AS filas FROM public.notif_prefs_auto
UNION ALL
SELECT 'ciclos_compra', COUNT(*) FROM public.ciclos_compra
UNION ALL
SELECT 'clientes_con_score', COUNT(*) FROM public.clientes WHERE score_actual IS NOT NULL;
-- ═══════════════════════════════════════════════════════════════════════════
-- 053_fix_sincronizacion_v54.sql
-- Sincronización DB con código v54 — ejecutar en Supabase SQL Editor
-- Orden: después de 052_saneamiento_final_v54.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. TABLA notif_prefs_auto (faltante en DB) ─────────────────────────────
-- Necesaria para que el Panel de Automatización pueda leer/escribir
-- preferencias de notificaciones push por motor.
CREATE TABLE IF NOT EXISTS public.notif_prefs_auto (
  empresa_id              UUID        PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  piloto_sugerencia       BOOLEAN     NOT NULL DEFAULT TRUE,
  cierre_cliente_bloqueado BOOLEAN    NOT NULL DEFAULT TRUE,
  cierre_error_cola        BOOLEAN    NOT NULL DEFAULT TRUE,
  stock_quiebre           BOOLEAN     NOT NULL DEFAULT TRUE,
  stock_orden_auto        BOOLEAN     NOT NULL DEFAULT TRUE,
  score_caida_critica     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS para notif_prefs_auto
ALTER TABLE public.notif_prefs_auto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_prefs_auto_empresa ON public.notif_prefs_auto;
CREATE POLICY notif_prefs_auto_empresa ON public.notif_prefs_auto
  FOR ALL
  USING (empresa_id = public.get_empresa_id());

-- ── 2. COLUMNAS p256dh y auth en dispositivos_push ─────────────────────────
-- El panel de automatización guarda suscripciones Web Push (VAPID).
-- La DB solo tenía token_push (FCM). Se agregan las columnas faltantes.
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS p256dh   TEXT;
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS auth     TEXT;

-- Índice único para evitar duplicar suscripciones por endpoint
DROP INDEX IF EXISTS public.idx_dispositivos_push_endpoint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispositivos_push_endpoint
  ON public.dispositivos_push(endpoint)
  WHERE endpoint IS NOT NULL;

-- ── 3. COLUMNA presupuesto_id en pedidos ───────────────────────────────────
-- Cuando se acepta un presupuesto se crea un pedido vinculado.
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS presupuesto_id UUID REFERENCES public.presupuestos(id);
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS notas_internas TEXT;

-- ── 4. UNIFICAR ESTADOS DE PRESUPUESTOS ────────────────────────────────────
-- El código v54 usa: aceptado | vencido (correcto según el CHECK constraint del backup).
-- Si quedaron filas con estados viejos (aprobado/expirado/convertido), migrarlas:
UPDATE public.presupuestos SET estado = 'aceptado' WHERE estado = 'aprobado';
UPDATE public.presupuestos SET estado = 'vencido'  WHERE estado = 'expirado';
UPDATE public.presupuestos SET estado = 'aceptado' WHERE estado = 'convertido';

-- ── 5. COLUMNA cliente_id en usuarios ──────────────────────────────────────
-- Permite que enviarPush() desde contexto cliente funcione.
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL;

-- ── 6. COLUMNAS adicionales en cta_cte ─────────────────────────────────────
ALTER TABLE public.cta_cte ADD COLUMN IF NOT EXISTS descripcion TEXT;

COMMIT;
-- =============================================================================
-- 038_fix_consistencia_v39.sql
-- Fix de consistencia detectado en el reporte estático v39
--
-- Cambios:
--   1. cta_cte.empresa_id  — columna faltante (CRÍTICO)
--   2. facturas.vencimiento — alias de fecha_vencimiento (ALTO)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. cta_cte — agregar empresa_id
--    El frontend filtra /rest/v1/cta_cte?empresa_id=eq.X pero la columna
--    no existía. Sin ella Supabase devuelve error o todos los registros.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE cta_cte
  ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

-- Backfill: derivar empresa_id desde el cliente dueño del movimiento
UPDATE cta_cte cc
SET    empresa_id = c.empresa_id
FROM   clientes c
WHERE  c.id = cc.cliente_id
  AND  cc.empresa_id IS NULL;

-- A partir de ahora la columna es obligatoria
ALTER TABLE cta_cte
  ALTER COLUMN empresa_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cta_cte_empresa ON cta_cte (empresa_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Actualizar las tres funciones que insertan en cta_cte para que siempre
-- incluyan empresa_id, derivándolo del cliente.
-- ─────────────────────────────────────────────────────────────────────────────

-- fn: registrar_cobro  (011_fase1_transacciones.sql)
CREATE OR REPLACE FUNCTION registrar_cobro(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_monto       NUMERIC,
  p_medio       TEXT,
  p_referencia  TEXT DEFAULT NULL,
  p_notas       TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cobro_id UUID;
  v_nro      TEXT;
BEGIN
  -- Número de comprobante secuencial por empresa
  SELECT 'COB-' || LPAD(COALESCE(MAX(CAST(regexp_replace(nro_comprobante,'[^0-9]','','g') AS INT)),0)::TEXT,'6','0')
  INTO   v_nro
  FROM   cobros
  WHERE  empresa_id = p_empresa_id;

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio_pago, referencia, notas)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas)
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, importe, cobro_id, nro_comprobante, descripcion, medio_pago)
  VALUES
    (p_empresa_id, p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
     'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  RETURN json_build_object('ok', true, 'cobro_id', v_cobro_id);
END;
$$;

-- fn: registrar_movimiento_cta_cte  (011_fase1_transacciones.sql)
CREATE OR REPLACE FUNCTION registrar_movimiento_cta_cte(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_tipo        TEXT,
  p_importe     NUMERIC,
  p_descripcion TEXT DEFAULT NULL,
  p_fecha       TIMESTAMPTZ DEFAULT now()
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cta_id UUID;
  v_nro    TEXT;
BEGIN
  SELECT 'MOV-' || LPAD(COALESCE(MAX(CAST(regexp_replace(nro_comprobante,'[^0-9]','','g') AS INT)),0)::TEXT,'6','0')
  INTO   v_nro
  FROM   cta_cte
  WHERE  empresa_id = p_empresa_id;

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, importe, nro_comprobante, descripcion, fecha)
  VALUES
    (p_empresa_id, p_cliente_id, p_tipo, p_importe, v_nro,
     COALESCE(p_descripcion, 'Nota de ' || replace(p_tipo, '_', ' ')), p_fecha)
  RETURNING id INTO v_cta_id;

  RETURN json_build_object('ok', true, 'cta_cte_id', v_cta_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: política de lectura para cta_cte usa empresa_id (ya existía por cliente_id).
-- Agregar política adicional filtrando por empresa.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS cta_cte_empresa_select ON cta_cte;
CREATE POLICY cta_cte_empresa_select ON cta_cte
  FOR SELECT
  USING (
    empresa_id = (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );


-- =============================================================================
-- 2. facturas.vencimiento — columna generada como alias de fecha_vencimiento
--
--    008_facturas_fix.sql ya agregó la columna `vencimiento DATE`.
--    033_cierre_financiero.sql agregó `fecha_vencimiento DATE`.
--    Ambas existen pero el código SQL interno usa fecha_vencimiento
--    y el frontend REST usa vencimiento.
--    Solución: mantener `vencimiento` como columna real (ya existe desde 008)
--    y sincronizarla con fecha_vencimiento vía trigger para que ambos nombres
--    sean equivalentes.
-- =============================================================================

-- Backfill: igualar vencimiento ← fecha_vencimiento donde vencimiento es NULL
UPDATE facturas
SET    vencimiento = fecha_vencimiento
WHERE  vencimiento IS NULL
  AND  fecha_vencimiento IS NOT NULL;

-- Trigger: cuando se escribe fecha_vencimiento, actualizar vencimiento también
CREATE OR REPLACE FUNCTION sync_factura_vencimiento()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Siempre mantener ambas columnas sincronizadas
  IF NEW.fecha_vencimiento IS DISTINCT FROM OLD.fecha_vencimiento THEN
    NEW.vencimiento := NEW.fecha_vencimiento;
  END IF;
  IF NEW.vencimiento IS DISTINCT FROM OLD.vencimiento THEN
    NEW.fecha_vencimiento := NEW.vencimiento;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_factura_vencimiento ON facturas;
CREATE TRIGGER trg_sync_factura_vencimiento
  BEFORE INSERT OR UPDATE ON facturas
  FOR EACH ROW EXECUTE FUNCTION sync_factura_vencimiento();

-- Índice para queries REST ?order=vencimiento.asc (ya existe en 028 para fecha_vencimiento)
CREATE INDEX IF NOT EXISTS idx_facturas_vencimiento ON facturas (vencimiento ASC)
  WHERE vencimiento IS NOT NULL;
-- ============================================================
-- 054_recepcion_mercaderia.sql
-- Etapa 8.2: OCR de remitos y facturas de proveedor
--
-- Crea:
--   1. recepciones_mercaderia  — registro de cada recepción con foto y datos OCR
--   2. conciliar_recepcion()   — RPC que cruza OCR vs. OC y devuelve discrepancias
--   3. recepcionar_orden_compra() — RPC transaccional que aplica stock (ya referenciada
--      en proveedores.js pero ausente de la DB)
-- ============================================================

-- ── 1. Tabla de recepciones ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recepciones_mercaderia (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES public.empresas(id)    ON DELETE CASCADE,
  orden_id        uuid             REFERENCES public.ordenes_compra(id) ON DELETE SET NULL,
  proveedor_id    uuid             REFERENCES public.proveedores(id)    ON DELETE SET NULL,
  usuario_id      uuid             REFERENCES public.usuarios(id)       ON DELETE SET NULL,
  foto_url        text,                        -- URL en Supabase Storage (opcional)
  datos_ocr       jsonb,                       -- salida cruda de Claude Vision
  items_conciliados jsonb,                     -- resultado de conciliar_recepcion()
  discrepancias   jsonb,                       -- items con diferencia > umbral
  estado          text NOT NULL DEFAULT 'borrador'
                    CHECK (estado IN ('borrador','confirmada','descartada')),
  notas           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmada_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_recepciones_empresa   ON public.recepciones_mercaderia (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recepciones_orden     ON public.recepciones_mercaderia (orden_id);

-- RLS: solo usuarios de la misma empresa
ALTER TABLE public.recepciones_mercaderia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recepciones_select ON public.recepciones_mercaderia;
CREATE POLICY recepciones_select ON public.recepciones_mercaderia
  FOR SELECT USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS recepciones_insert ON public.recepciones_mercaderia;
CREATE POLICY recepciones_insert ON public.recepciones_mercaderia
  FOR INSERT WITH CHECK (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios
      WHERE id = auth.uid() AND rol IN ('dueno','admin','depositero')
    )
  );

DROP POLICY IF EXISTS recepciones_update ON public.recepciones_mercaderia;
CREATE POLICY recepciones_update ON public.recepciones_mercaderia
  FOR UPDATE USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios
      WHERE id = auth.uid() AND rol IN ('dueno','admin','depositero')
    )
  );

-- ── 2. RPC: conciliar_recepcion ──────────────────────────────────────────────
-- Cruza los datos OCR del remito contra los items de la OC.
-- Devuelve un JSON con cada item: cantidad pedida, cantidad OCR, diferencia y si
-- supera el umbral de alerta (10% por defecto o configurable).
--
-- Parámetros:
--   p_orden_id   uuid     — OC a contrastar
--   p_datos_ocr  jsonb    — array [{codigo, nombre, cantidad, precio_unitario}]
--   p_umbral_pct numeric  — porcentaje de diferencia que dispara alerta (default 10)
--
-- Retorna: json con {items, discrepancias, resumen}

CREATE OR REPLACE FUNCTION public.conciliar_recepcion(
  p_orden_id   uuid,
  p_datos_ocr  jsonb,
  p_umbral_pct numeric DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_items       jsonb := '[]'::jsonb;
  v_disc        jsonb := '[]'::jsonb;
  v_oc_item     record;
  v_ocr_match   jsonb;
  v_cant_ocr    numeric;
  v_precio_ocr  numeric;
  v_diff_cant   numeric;
  v_diff_precio numeric;
  v_alerta      boolean;
BEGIN
  -- Iterar cada item de la OC
  FOR v_oc_item IN
    SELECT
      oci.id,
      oci.producto_id,
      oci.descripcion,
      oci.cantidad       AS cant_pedida,
      oci.precio_unitario AS precio_pedido,
      p.nombre           AS producto_nombre,
      p.codigo           AS producto_codigo
    FROM public.ordenes_compra_items oci
    LEFT JOIN public.productos p ON p.id = oci.producto_id
    WHERE oci.orden_id = p_orden_id
  LOOP
    -- Buscar match en los datos OCR por código o nombre (case-insensitive)
    SELECT elem INTO v_ocr_match
    FROM jsonb_array_elements(p_datos_ocr) AS elem
    WHERE
      (
        elem->>'codigo' IS NOT NULL AND
        LOWER(elem->>'codigo') = LOWER(v_oc_item.producto_codigo)
      )
      OR
      similarity(LOWER(elem->>'nombre'), LOWER(v_oc_item.producto_nombre)) > 0.5
    ORDER BY
      similarity(LOWER(elem->>'nombre'), LOWER(v_oc_item.producto_nombre)) DESC
    LIMIT 1;

    v_cant_ocr    := COALESCE((v_ocr_match->>'cantidad')::numeric,    NULL);
    v_precio_ocr  := COALESCE((v_ocr_match->>'precio_unitario')::numeric, NULL);

    -- Calcular diferencias porcentuales
    v_diff_cant := CASE
      WHEN v_cant_ocr IS NULL OR v_oc_item.cant_pedida = 0 THEN NULL
      ELSE ABS(v_cant_ocr - v_oc_item.cant_pedida) / v_oc_item.cant_pedida * 100
    END;

    v_diff_precio := CASE
      WHEN v_precio_ocr IS NULL OR v_oc_item.precio_pedido = 0 THEN NULL
      ELSE ABS(v_precio_ocr - v_oc_item.precio_pedido) / v_oc_item.precio_pedido * 100
    END;

    v_alerta := (
      v_cant_ocr IS NULL OR
      COALESCE(v_diff_cant,   0) > p_umbral_pct OR
      COALESCE(v_diff_precio, 0) > p_umbral_pct
    );

    -- Construir objeto del item
    v_items := v_items || jsonb_build_object(
      'oc_item_id',      v_oc_item.id,
      'producto_id',     v_oc_item.producto_id,
      'nombre',          v_oc_item.producto_nombre,
      'codigo',          v_oc_item.producto_codigo,
      'cant_pedida',     v_oc_item.cant_pedida,
      'precio_pedido',   v_oc_item.precio_pedido,
      'cant_ocr',        v_cant_ocr,
      'precio_ocr',      v_precio_ocr,
      'diff_cant_pct',   ROUND(COALESCE(v_diff_cant,   0)::numeric, 1),
      'diff_precio_pct', ROUND(COALESCE(v_diff_precio, 0)::numeric, 1),
      'alerta',          v_alerta,
      -- Valor sugerido a recepcionar: OCR si existe, sino pedido
      'cant_sugerida',   COALESCE(v_cant_ocr, v_oc_item.cant_pedida),
      'precio_sugerido', COALESCE(v_precio_ocr, v_oc_item.precio_pedido)
    );

    -- Acumular discrepancias
    IF v_alerta THEN
      v_disc := v_disc || jsonb_build_array(jsonb_build_object(
        'nombre',          v_oc_item.producto_nombre,
        'cant_pedida',     v_oc_item.cant_pedida,
        'cant_ocr',        v_cant_ocr,
        'precio_pedido',   v_oc_item.precio_pedido,
        'precio_ocr',      v_precio_ocr,
        'diff_cant_pct',   ROUND(COALESCE(v_diff_cant,   0)::numeric, 1),
        'diff_precio_pct', ROUND(COALESCE(v_diff_precio, 0)::numeric, 1)
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',           true,
    'items',        v_items,
    'discrepancias', v_disc,
    'resumen', jsonb_build_object(
      'total_items',       jsonb_array_length(v_items),
      'items_con_alerta',  jsonb_array_length(v_disc),
      'umbral_pct',        p_umbral_pct
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Habilitar pg_trgm para el similarity() si no está activo
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 3. RPC: recepcionar_orden_compra ─────────────────────────────────────────
-- Registra la recepción, actualiza stock y marca la OC como recibida.
-- Reutiliza la misma firma que ya espera proveedores.js.
--
-- items: [{producto_id, cantidad_recibida, precio_costo}]

CREATE OR REPLACE FUNCTION public.recepcionar_orden_compra(
  p_empresa_id  uuid,
  p_orden_id    uuid,
  p_items       jsonb,
  p_usuario_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item          jsonb;
  v_prod_id       uuid;
  v_cant          numeric;
  v_costo         numeric;
  v_items_proc    int := 0;
  v_total_recib   numeric := 0;
BEGIN
  -- Validar que la OC pertenece a la empresa
  IF NOT EXISTS (
    SELECT 1 FROM public.ordenes_compra
    WHERE id = p_orden_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Orden no encontrada');
  END IF;

  -- Procesar cada item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod_id := (v_item->>'producto_id')::uuid;
    v_cant    := COALESCE((v_item->>'cantidad_recibida')::numeric, 0);
    v_costo   := COALESCE((v_item->>'precio_costo')::numeric, 0);

    IF v_cant <= 0 THEN CONTINUE; END IF;

    -- Actualizar stock: incrementar stock_actual en todos los depósitos de la empresa
    -- Si el producto tiene stock por depósito, sumar al depósito principal
    UPDATE public.productos
    SET
      stock_actual = COALESCE(stock_actual, 0) + v_cant,
      costo        = CASE WHEN v_costo > 0 THEN v_costo ELSE costo END,
      updated_at   = now()
    WHERE id = v_prod_id AND empresa_id = p_empresa_id;

    -- Registrar movimiento de stock
    INSERT INTO public.movimientos_stock (
      empresa_id, producto_id, tipo, cantidad,
      referencia_tipo, referencia_id, usuario_id, notas, created_at
    ) VALUES (
      p_empresa_id, v_prod_id, 'ingreso', v_cant,
      'orden_compra', p_orden_id, p_usuario_id,
      'Recepción OC ' || p_orden_id::text, now()
    ) ON CONFLICT DO NOTHING;

    -- Actualizar cantidad recibida en ordenes_compra_items
    UPDATE public.ordenes_compra_items
    SET cantidad = v_cant
    WHERE orden_id = p_orden_id AND producto_id = v_prod_id;

    v_total_recib := v_total_recib + (v_cant * v_costo);
    v_items_proc  := v_items_proc + 1;
  END LOOP;

  -- Marcar OC como recibida
  UPDATE public.ordenes_compra
  SET
    estado          = 'recibida',
    fecha_recepcion = now(),
    total           = CASE WHEN v_total_recib > 0 THEN v_total_recib ELSE total END
  WHERE id = p_orden_id AND empresa_id = p_empresa_id;

  RETURN jsonb_build_object(
    'ok',              true,
    'items_procesados', v_items_proc,
    'total_recibido',  v_total_recib
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION public.conciliar_recepcion(uuid, jsonb, numeric)
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.recepcionar_orden_compra(uuid, uuid, jsonb, uuid)
  TO authenticated, service_role;
-- ============================================================
-- 055_storage_bucket_remitos.sql
-- Etapa 8.3: Bucket de Storage para fotos de remitos
-- ============================================================

-- Crear bucket 'remitos' (público para URLs directas sin firma)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'remitos',
  'remitos',
  true,
  10485760,  -- 10 MB máximo por archivo
  ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public            = EXCLUDED.public,
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Política: solo service_role sube (el backend autentica y sube)
DROP POLICY IF EXISTS remitos_insert_service ON storage.objects;
CREATE POLICY remitos_insert_service ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'remitos');

DROP POLICY IF EXISTS remitos_update_service ON storage.objects;
CREATE POLICY remitos_update_service ON storage.objects
  FOR UPDATE TO service_role
  USING (bucket_id = 'remitos');

-- Política: lectura pública (la URL ya es pública)
DROP POLICY IF EXISTS remitos_select_public ON storage.objects;
CREATE POLICY remitos_select_public ON storage.objects
  FOR SELECT USING (bucket_id = 'remitos');

-- Política: borrado solo para dueno/admin via service_role
DROP POLICY IF EXISTS remitos_delete_service ON storage.objects;
CREATE POLICY remitos_delete_service ON storage.objects
  FOR DELETE TO service_role
  USING (bucket_id = 'remitos');
-- ============================================================
-- 056_cc_proveedores.sql
-- Etapa 8.5: Cuentas corrientes con proveedores
--
-- Crea:
--   1. facturas_proveedor        — factura emitida por el proveedor
--   2. facturas_proveedor_items  — ítems de la factura
--   3. pagos_proveedor           — pagos realizados contra una factura
--   4. v_cc_proveedor            — vista resumen de saldo por proveedor
--   5. conciliar_oc_factura()    — RPC: cruza OC recibida vs factura proveedor
--   6. registrar_pago_proveedor()— RPC: registra pago y actualiza estado factura
-- ============================================================

-- ── 1. Facturas de proveedor ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.facturas_proveedor (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor_id      uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE RESTRICT,
  orden_id          uuid             REFERENCES public.ordenes_compra(id) ON DELETE SET NULL,
  numero_factura    text NOT NULL,          -- "A 0001-00012345"
  tipo              text NOT NULL DEFAULT 'A'
                      CHECK (tipo IN ('A','B','C','M','X')),
  fecha_factura     date NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento date,
  subtotal          numeric(14,2) NOT NULL DEFAULT 0,
  iva_pct           numeric(5,2)  NOT NULL DEFAULT 21,
  iva_monto         numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  total_pagado      numeric(14,2) NOT NULL DEFAULT 0,
  estado            text NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente','parcial','pagada','anulada')),
  conciliacion      jsonb,   -- resultado de conciliar_oc_factura()
  discrepancias     jsonb,   -- items con diferencia > umbral
  notas             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fp_empresa       ON public.facturas_proveedor (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fp_proveedor     ON public.facturas_proveedor (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_fp_orden         ON public.facturas_proveedor (orden_id);
CREATE INDEX IF NOT EXISTS idx_fp_estado        ON public.facturas_proveedor (estado);

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION public.fp_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_fp_updated_at ON public.facturas_proveedor;
CREATE TRIGGER trg_fp_updated_at
  BEFORE UPDATE ON public.facturas_proveedor
  FOR EACH ROW EXECUTE FUNCTION public.fp_touch_updated_at();

-- RLS
ALTER TABLE public.facturas_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fp_select ON public.facturas_proveedor;
CREATE POLICY fp_select ON public.facturas_proveedor FOR SELECT USING (
  empresa_id IN (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid())
);

DROP POLICY IF EXISTS fp_insert ON public.facturas_proveedor;
CREATE POLICY fp_insert ON public.facturas_proveedor FOR INSERT WITH CHECK (
  empresa_id IN (
    SELECT empresa_id FROM public.usuarios
    WHERE id = auth.uid() AND rol IN ('dueno','admin','contador','depositero')
  )
);

DROP POLICY IF EXISTS fp_update ON public.facturas_proveedor;
CREATE POLICY fp_update ON public.facturas_proveedor FOR UPDATE USING (
  empresa_id IN (
    SELECT empresa_id FROM public.usuarios
    WHERE id = auth.uid() AND rol IN ('dueno','admin','contador')
  )
);

-- ── 2. Ítems de la factura de proveedor ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.facturas_proveedor_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factura_id       uuid NOT NULL REFERENCES public.facturas_proveedor(id) ON DELETE CASCADE,
  producto_id      uuid             REFERENCES public.productos(id) ON DELETE SET NULL,
  descripcion      text NOT NULL,
  cantidad         numeric(14,3) NOT NULL DEFAULT 1,
  precio_unitario  numeric(14,2) NOT NULL DEFAULT 0,
  subtotal         numeric(14,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED
);

CREATE INDEX IF NOT EXISTS idx_fpi_factura ON public.facturas_proveedor_items (factura_id);

-- ── 3. Pagos a proveedores ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pagos_proveedor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor_id uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE RESTRICT,
  factura_id   uuid             REFERENCES public.facturas_proveedor(id) ON DELETE SET NULL,
  monto        numeric(14,2) NOT NULL CHECK (monto > 0),
  medio_pago   text NOT NULL DEFAULT 'transferencia'
                 CHECK (medio_pago IN ('efectivo','transferencia','cheque','otro')),
  fecha_pago   date NOT NULL DEFAULT CURRENT_DATE,
  referencia   text,   -- N° cheque, CBU destino, etc.
  notas        text,
  usuario_id   uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pp_empresa   ON public.pagos_proveedor (empresa_id, fecha_pago DESC);
CREATE INDEX IF NOT EXISTS idx_pp_proveedor ON public.pagos_proveedor (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_pp_factura   ON public.pagos_proveedor (factura_id);

ALTER TABLE public.pagos_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pp_select ON public.pagos_proveedor;
CREATE POLICY pp_select ON public.pagos_proveedor FOR SELECT USING (
  empresa_id IN (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid())
);

DROP POLICY IF EXISTS pp_insert ON public.pagos_proveedor;
CREATE POLICY pp_insert ON public.pagos_proveedor FOR INSERT WITH CHECK (
  empresa_id IN (
    SELECT empresa_id FROM public.usuarios
    WHERE id = auth.uid() AND rol IN ('dueno','admin','contador')
  )
);

-- ── 4. Vista: cuenta corriente por proveedor ─────────────────────────────────
-- Consolida: total OC recibidas, total facturado, total pagado, saldo
CREATE OR REPLACE VIEW public.v_cc_proveedor AS
SELECT
  p.empresa_id,
  p.id                              AS proveedor_id,
  p.razon_social,
  p.fantasia,
  p.email,
  p.telefono,
  -- OC recibidas
  COUNT(DISTINCT oc.id)             AS oc_recibidas,
  COALESCE(SUM(DISTINCT oc.total) FILTER (WHERE oc.estado = 'recibida'), 0) AS total_oc_recibidas,
  -- Facturas
  COUNT(DISTINCT fp.id)             AS facturas_count,
  COALESCE(SUM(fp.total), 0)        AS total_facturado,
  COALESCE(SUM(fp.total_pagado), 0) AS total_pagado,
  COALESCE(SUM(fp.total) - SUM(fp.total_pagado), 0) AS saldo_pendiente,
  -- Facturas vencidas
  COUNT(fp.id) FILTER (
    WHERE fp.estado IN ('pendiente','parcial')
    AND fp.fecha_vencimiento < CURRENT_DATE
  )                                 AS facturas_vencidas
FROM public.proveedores p
LEFT JOIN public.ordenes_compra     oc ON oc.proveedor_id = p.id
LEFT JOIN public.facturas_proveedor fp ON fp.proveedor_id = p.id AND fp.estado != 'anulada'
GROUP BY p.empresa_id, p.id, p.razon_social, p.fantasia, p.email, p.telefono;

GRANT SELECT ON public.v_cc_proveedor TO authenticated, service_role;

-- ── 5. RPC: conciliar_oc_factura ─────────────────────────────────────────────
-- Cruza los ítems de la OC recibida contra los ítems de la factura del proveedor.
-- Retorna discrepancias de cantidad y precio para que el usuario pueda aprobar o rechazar.
--
-- Parámetros:
--   p_orden_id   uuid     — OC ya recibida
--   p_factura_id uuid     — factura a comparar
--   p_umbral_pct numeric  — % de diferencia que dispara alerta (default 5)
--
-- Retorna jsonb: { ok, items, discrepancias, resumen }

CREATE OR REPLACE FUNCTION public.conciliar_oc_factura(
  p_orden_id   uuid,
  p_factura_id uuid,
  p_umbral_pct numeric DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_items    jsonb := '[]'::jsonb;
  v_disc     jsonb := '[]'::jsonb;
  v_oc_item  record;
  v_fac_item jsonb;
  v_cant_fac   numeric;
  v_precio_fac numeric;
  v_diff_cant  numeric;
  v_diff_prec  numeric;
  v_alerta     boolean;
BEGIN
  -- Iterar cada ítem de la OC
  FOR v_oc_item IN
    SELECT
      oci.id,
      oci.producto_id,
      oci.descripcion,
      oci.cantidad        AS cant_oc,
      oci.precio_unitario AS precio_oc,
      p.nombre            AS producto_nombre,
      p.codigo            AS producto_codigo
    FROM public.ordenes_compra_items oci
    LEFT JOIN public.productos p ON p.id = oci.producto_id
    WHERE oci.orden_id = p_orden_id
  LOOP
    -- Buscar ítem equivalente en la factura (por producto_id o similaridad de descripción)
    SELECT elem INTO v_fac_item
    FROM jsonb_array_elements(
      (SELECT jsonb_agg(
          jsonb_build_object(
            'producto_id',     fpi.producto_id,
            'descripcion',     fpi.descripcion,
            'cantidad',        fpi.cantidad,
            'precio_unitario', fpi.precio_unitario
          )
        )
        FROM public.facturas_proveedor_items fpi
        WHERE fpi.factura_id = p_factura_id
      )
    ) AS elem
    WHERE
      (v_oc_item.producto_id IS NOT NULL AND (elem->>'producto_id')::uuid = v_oc_item.producto_id)
      OR
      (similarity(LOWER(elem->>'descripcion'), LOWER(COALESCE(v_oc_item.producto_nombre, v_oc_item.descripcion))) > 0.4)
    ORDER BY
      CASE WHEN (elem->>'producto_id')::uuid = v_oc_item.producto_id THEN 0 ELSE 1 END,
      similarity(LOWER(elem->>'descripcion'), LOWER(COALESCE(v_oc_item.producto_nombre, v_oc_item.descripcion))) DESC
    LIMIT 1;

    v_cant_fac   := COALESCE((v_fac_item->>'cantidad')::numeric, NULL);
    v_precio_fac := COALESCE((v_fac_item->>'precio_unitario')::numeric, NULL);

    v_diff_cant := CASE
      WHEN v_cant_fac IS NULL OR v_oc_item.cant_oc = 0 THEN NULL
      ELSE ABS(v_cant_fac - v_oc_item.cant_oc) / v_oc_item.cant_oc * 100
    END;

    v_diff_prec := CASE
      WHEN v_precio_fac IS NULL OR v_oc_item.precio_oc = 0 THEN NULL
      ELSE ABS(v_precio_fac - v_oc_item.precio_oc) / v_oc_item.precio_oc * 100
    END;

    v_alerta := (
      v_cant_fac IS NULL OR
      COALESCE(v_diff_cant, 0) > p_umbral_pct OR
      COALESCE(v_diff_prec, 0) > p_umbral_pct
    );

    v_items := v_items || jsonb_build_object(
      'oc_item_id',      v_oc_item.id,
      'producto_id',     v_oc_item.producto_id,
      'nombre',          v_oc_item.producto_nombre,
      'descripcion',     v_oc_item.descripcion,
      -- OC
      'cant_oc',         v_oc_item.cant_oc,
      'precio_oc',       v_oc_item.precio_oc,
      'subtotal_oc',     ROUND(v_oc_item.cant_oc * v_oc_item.precio_oc, 2),
      -- Factura
      'cant_fac',        v_cant_fac,
      'precio_fac',      v_precio_fac,
      'subtotal_fac',    CASE WHEN v_cant_fac IS NOT NULL AND v_precio_fac IS NOT NULL
                           THEN ROUND(v_cant_fac * v_precio_fac, 2) ELSE NULL END,
      -- Diferencias
      'diff_cant_pct',   ROUND(COALESCE(v_diff_cant, 0)::numeric, 1),
      'diff_precio_pct', ROUND(COALESCE(v_diff_prec, 0)::numeric, 1),
      'alerta',          v_alerta,
      'match',           (v_fac_item IS NOT NULL)
    );

    IF v_alerta THEN
      v_disc := v_disc || jsonb_build_array(jsonb_build_object(
        'nombre',          v_oc_item.producto_nombre,
        'cant_oc',         v_oc_item.cant_oc,
        'cant_fac',        v_cant_fac,
        'precio_oc',       v_oc_item.precio_oc,
        'precio_fac',      v_precio_fac,
        'diff_cant_pct',   ROUND(COALESCE(v_diff_cant, 0)::numeric, 1),
        'diff_precio_pct', ROUND(COALESCE(v_diff_prec, 0)::numeric, 1),
        'tipo',            CASE
          WHEN v_cant_fac IS NULL      THEN 'no_encontrado'
          WHEN COALESCE(v_diff_cant,0) > p_umbral_pct THEN 'cantidad'
          WHEN COALESCE(v_diff_prec,0) > p_umbral_pct THEN 'precio'
          ELSE 'ambos'
        END
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',            true,
    'items',         v_items,
    'discrepancias', v_disc,
    'resumen', jsonb_build_object(
      'total_items',      jsonb_array_length(v_items),
      'items_ok',         jsonb_array_length(v_items) - jsonb_array_length(v_disc),
      'items_con_alerta', jsonb_array_length(v_disc),
      'umbral_pct',       p_umbral_pct
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Necesita pg_trgm para similarity()
CREATE EXTENSION IF NOT EXISTS pg_trgm;

GRANT EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, numeric)
  TO authenticated, service_role;

-- ── 6. RPC: registrar_pago_proveedor ─────────────────────────────────────────
-- Inserta el pago, acumula total_pagado en la factura y actualiza su estado.

CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_empresa_id   uuid,
  p_proveedor_id uuid,
  p_factura_id   uuid,
  p_monto        numeric,
  p_medio        text     DEFAULT 'transferencia',
  p_fecha        date     DEFAULT CURRENT_DATE,
  p_referencia   text     DEFAULT NULL,
  p_notas        text     DEFAULT NULL,
  p_usuario_id   uuid     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_factura      record;
  v_nuevo_pagado numeric;
  v_nuevo_estado text;
BEGIN
  -- Leer factura y validar empresa
  SELECT * INTO v_factura
  FROM public.facturas_proveedor
  WHERE id = p_factura_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  IF v_factura.estado = 'anulada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura está anulada');
  END IF;

  IF v_factura.estado = 'pagada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura ya está pagada');
  END IF;

  -- Insertar pago
  INSERT INTO public.pagos_proveedor (
    empresa_id, proveedor_id, factura_id,
    monto, medio_pago, fecha_pago, referencia, notas, usuario_id
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_factura_id,
    p_monto, p_medio, p_fecha, p_referencia, p_notas, p_usuario_id
  );

  -- Actualizar total_pagado y estado
  v_nuevo_pagado := LEAST(v_factura.total_pagado + p_monto, v_factura.total);

  v_nuevo_estado := CASE
    WHEN v_nuevo_pagado >= v_factura.total THEN 'pagada'
    WHEN v_nuevo_pagado > 0               THEN 'parcial'
    ELSE 'pendiente'
  END;

  UPDATE public.facturas_proveedor
  SET total_pagado = v_nuevo_pagado,
      estado       = v_nuevo_estado,
      updated_at   = now()
  WHERE id = p_factura_id;

  RETURN jsonb_build_object(
    'ok',           true,
    'total_pagado', v_nuevo_pagado,
    'saldo',        v_factura.total - v_nuevo_pagado,
    'estado',       v_nuevo_estado
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(uuid,uuid,uuid,numeric,text,date,text,text,uuid)
  TO authenticated, service_role;

-- ── Índice de búsqueda de texto en número de factura ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_fp_numero ON public.facturas_proveedor
  USING gin (to_tsvector('spanish', numero_factura));
-- =============================================================================
-- 058_ajustar_stock.sql
-- RPC faltante: ajuste manual de stock (transferencias entre depósitos y ajustes)
-- Usado en: frontend/admin/js/stock.js (3 llamadas en modal de movimiento)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id UUID,
  p_deposito_id UUID,
  p_delta       NUMERIC,
  p_motivo      TEXT DEFAULT 'ajuste_manual'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_empresa_id  UUID;
  v_stock_nuevo NUMERIC;
BEGIN
  -- Obtener empresa_id del depósito
  SELECT empresa_id INTO v_empresa_id
  FROM public.depositos
  WHERE id = p_deposito_id;

  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  -- Verificar autorización (debe ser admin o dueño de la empresa)
  IF NOT (
    get_rol_usuario() IN ('admin', 'dueno') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  -- Upsert en stock
  INSERT INTO public.stock (producto_id, deposito_id, empresa_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, v_empresa_id, GREATEST(0, p_delta))
  ON CONFLICT (producto_id, deposito_id)
  DO UPDATE SET
    cantidad   = GREATEST(0, public.stock.cantidad + p_delta),
    updated_at = NOW()
  RETURNING cantidad INTO v_stock_nuevo;

  -- Registrar en movimientos_stock
  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, motivo, usuario_id, created_at)
  VALUES (
    v_empresa_id,
    p_producto_id,
    p_deposito_id,
    CASE WHEN p_delta >= 0 THEN 'entrada' ELSE 'salida' END,
    ABS(p_delta),
    p_motivo,
    auth.uid(),
    NOW()
  );

  RETURN json_build_object(
    'ok',         true,
    'stock_nuevo', COALESCE(v_stock_nuevo, 0),
    'delta',       p_delta
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ajustar_stock(UUID, UUID, NUMERIC, TEXT) TO authenticated;

COMMENT ON FUNCTION public.ajustar_stock IS
  'Ajuste manual de stock en un depósito. Delta positivo = entrada, negativo = salida. Registra en movimientos_stock.';
-- =============================================================================
-- 059_compat_views.sql
-- Views de compatibilidad para nombres inconsistentes en el código v65
-- =============================================================================

-- ── 1. cuenta_corriente → cta_cte ────────────────────────────────────────────
-- Usado en: frontend/cliente/js/checkout.js línea 71
-- Tabla real en backup: cta_cte
-- La view hereda RLS automáticamente de la tabla base en Postgres

CREATE OR REPLACE VIEW public.cuenta_corriente AS
SELECT
  id,
  empresa_id,
  cliente_id,
  saldo,
  limite_credito,
  updated_at
FROM public.cta_cte;

GRANT SELECT ON public.cuenta_corriente TO authenticated;

COMMENT ON VIEW public.cuenta_corriente IS
  'Vista de compatibilidad: mapea cta_cte → cuenta_corriente (usado en checkout.js)';


-- ── 2. perfiles → usuarios ────────────────────────────────────────────────────
-- Usado en: lib/handlers/empresa.js (empresa_id, rol lookup por auth.uid())
-- Tabla real en backup: usuarios
-- Expone solo las columnas que empresa.js necesita

CREATE OR REPLACE VIEW public.perfiles AS
SELECT
  id,
  empresa_id,
  rol,
  email,
  nombre,
  activo,
  created_at
FROM public.usuarios;

GRANT SELECT ON public.perfiles TO authenticated;

COMMENT ON VIEW public.perfiles IS
  'Vista de compatibilidad: mapea usuarios → perfiles (usado en handlers/empresa.js)';

-- ============================================================
-- v194: Ficha de cliente — vendedor_id_default
-- Agrega el campo vendedor_id_default a la tabla clientes para
-- asignar un vendedor predeterminado por cliente.
-- Referencia: Punto 1 del resumen ejecutivo v193+
-- ============================================================
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS vendedor_id_default uuid
    REFERENCES public.usuarios(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.clientes.vendedor_id_default
  IS 'Vendedor predeterminado asignado a este cliente. Se usa en pedidos automáticos y piloto automático.';

-- Índice para búsquedas por vendedor
CREATE INDEX IF NOT EXISTS idx_clientes_vendedor_id_default
  ON public.clientes (vendedor_id_default)
  WHERE vendedor_id_default IS NOT NULL;


-- ============================================================
-- v194 (cont.): Ficha de producto — proveedor_id_default
-- stock_objetivo y lead_time_dias ya existían en la tabla.
-- Agrega proveedor_id_default para vincular el proveedor habitual
-- de cada producto. Referencia: Punto 2 del resumen ejecutivo.
-- ============================================================
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS proveedor_id_default uuid
    REFERENCES public.proveedores(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.productos.proveedor_id_default
  IS 'Proveedor predeterminado de este producto. Se sugiere al crear órdenes de compra.';

COMMENT ON COLUMN public.productos.stock_objetivo
  IS 'Cantidad objetivo de stock. Cuando el stock baja de este nivel, se puede sugerir una orden de compra.';

COMMENT ON COLUMN public.productos.lead_time_dias
  IS 'Días que tarda el proveedor en entregar desde que se emite la orden de compra.';

CREATE INDEX IF NOT EXISTS idx_productos_proveedor_id_default
  ON public.productos (proveedor_id_default)
  WHERE proveedor_id_default IS NOT NULL;

