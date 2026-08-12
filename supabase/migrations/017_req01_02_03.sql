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
