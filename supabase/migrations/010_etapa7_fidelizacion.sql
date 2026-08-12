-- db/010_etapa7_fidelizacion.sql
-- Etapa 7: Expansión y Fidelización
-- Tablas para puntos, pagos online, sugerencias y notificaciones push

-- ── 1. TABLA: Programa de Fidelización (Puntos) ────────────────────────────
CREATE TABLE IF NOT EXISTS programas_fidelizacion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre VARCHAR(100) NOT NULL DEFAULT 'Programa de Puntos',
  puntos_por_peso DECIMAL(5,2) DEFAULT 1.0,  -- 1 punto por cada $1 gastado
  puntos_minimos_canje INT DEFAULT 100,       -- Mínimo de puntos para canjear
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id)
);

-- ── 2. TABLA: Saldo de Puntos por Cliente ──────────────────────────────────
CREATE TABLE IF NOT EXISTS saldo_puntos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  puntos_disponibles DECIMAL(10,2) DEFAULT 0,
  puntos_canjeados DECIMAL(10,2) DEFAULT 0,
  puntos_totales DECIMAL(10,2) DEFAULT 0,
  ultimo_movimiento TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(cliente_id)
);

-- ── 3. TABLA: Movimientos de Puntos (Historial) ────────────────────────────
CREATE TABLE IF NOT EXISTS movimientos_puntos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL,  -- 'ganancia', 'canje', 'ajuste'
  cantidad DECIMAL(10,2) NOT NULL,
  motivo TEXT,
  referencia_id UUID,  -- Puede ser pedido_id o factura_id
  created_at TIMESTAMP DEFAULT NOW()
);

-- ── 4. TABLA: Catálogo de Recompensas ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS recompensas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre VARCHAR(150) NOT NULL,
  descripcion TEXT,
  puntos_requeridos INT NOT NULL,
  tipo VARCHAR(30) NOT NULL,  -- 'descuento_fijo', 'descuento_porcentaje', 'producto_gratis', 'envio_gratis'
  valor DECIMAL(10,2),  -- Monto del descuento o valor del producto
  cantidad_disponible INT,  -- NULL = ilimitado
  cantidad_canjeada INT DEFAULT 0,
  activa BOOLEAN DEFAULT TRUE,
  fecha_inicio DATE,
  fecha_fin DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ── 5. TABLA: Canjes Realizados ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canjes_recompensas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  recompensa_id UUID NOT NULL REFERENCES recompensas(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  puntos_gastados INT NOT NULL,
  estado VARCHAR(20) DEFAULT 'pendiente',  -- 'pendiente', 'aplicado', 'expirado'
  aplicado_en_pedido_id UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  aplicado_at TIMESTAMP
);

-- ── 6. TABLA: Integración Mercado Pago ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS integraciones_pago (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  proveedor VARCHAR(50) NOT NULL DEFAULT 'mercado_pago',  -- 'mercado_pago', 'stripe', etc.
  access_token TEXT NOT NULL,  -- Encriptado en producción
  public_key TEXT,
  webhook_secret TEXT,  -- Para validar webhooks
  activa BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, proveedor)
);

-- ── 7. TABLA: Transacciones de Pago Online ─────────────────────────────────
CREATE TABLE IF NOT EXISTS transacciones_pago (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  pedido_id UUID REFERENCES pedidos(id) ON DELETE SET NULL,
  factura_id UUID REFERENCES facturas(id) ON DELETE SET NULL,
  monto DECIMAL(12,2) NOT NULL,
  moneda VARCHAR(3) DEFAULT 'ARS',
  proveedor VARCHAR(50) NOT NULL DEFAULT 'mercado_pago',
  referencia_externa VARCHAR(100),  -- ID de Mercado Pago, Stripe, etc.
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',  -- 'pendiente', 'completado', 'fallido', 'cancelado'
  metodo_pago VARCHAR(50),  -- 'tarjeta_credito', 'transferencia', 'billetera'
  respuesta_json JSONB,  -- Respuesta completa del proveedor
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ── 8. TABLA: Sugerencias de Pedido (IA Simple) ─────────────────────────────
CREATE TABLE IF NOT EXISTS sugerencias_pedido (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  cantidad_sugerida INT NOT NULL,
  razon VARCHAR(100),  -- 'compra_frecuente', 'bajo_stock', 'oferta_activa', 'similar_a_compra'
  score_relevancia DECIMAL(3,2),  -- 0.0 a 1.0
  visualizada BOOLEAN DEFAULT FALSE,
  convertida_en_pedido BOOLEAN DEFAULT FALSE,
  pedido_id UUID REFERENCES pedidos(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expira_at TIMESTAMP DEFAULT (NOW() + INTERVAL '30 days')
);

-- ── 9. TABLA: Dispositivos para Notificaciones Push ────────────────────────
CREATE TABLE IF NOT EXISTS dispositivos_push (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  token_push VARCHAR(500) NOT NULL,  -- Token de Firebase Cloud Messaging
  tipo_dispositivo VARCHAR(20),  -- 'web', 'ios', 'android'
  activo BOOLEAN DEFAULT TRUE,
  ultimo_acceso TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ── 10. TABLA: Historial de Notificaciones Push ────────────────────────────
CREATE TABLE IF NOT EXISTS notificaciones_push (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL,
  titulo VARCHAR(150) NOT NULL,
  cuerpo TEXT NOT NULL,
  tipo VARCHAR(50),  -- 'oferta', 'alerta_deuda', 'pedido_entregado', 'puntos_ganados'
  datos_json JSONB,  -- Datos adicionales (link, recompensa_id, etc.)
  enviada BOOLEAN DEFAULT FALSE,
  leida BOOLEAN DEFAULT FALSE,
  enviada_at TIMESTAMP,
  leida_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ── ÍNDICES ────────────────────────────────────────────────────────────────
CREATE INDEX idx_saldo_puntos_cliente ON saldo_puntos(cliente_id);
CREATE INDEX idx_saldo_puntos_empresa ON saldo_puntos(empresa_id);
CREATE INDEX idx_movimientos_puntos_cliente ON movimientos_puntos(cliente_id);
CREATE INDEX idx_movimientos_puntos_empresa ON movimientos_puntos(empresa_id);
CREATE INDEX idx_recompensas_empresa ON recompensas(empresa_id);
CREATE INDEX idx_canjes_cliente ON canjes_recompensas(cliente_id);
CREATE INDEX idx_canjes_estado ON canjes_recompensas(estado);
CREATE INDEX idx_transacciones_pago_cliente ON transacciones_pago(cliente_id);
CREATE INDEX idx_transacciones_pago_estado ON transacciones_pago(estado);
CREATE INDEX idx_sugerencias_cliente ON sugerencias_pedido(cliente_id);
CREATE INDEX idx_sugerencias_expira ON sugerencias_pedido(expira_at);
CREATE INDEX idx_dispositivos_push_usuario ON dispositivos_push(usuario_id);
CREATE INDEX idx_notificaciones_push_usuario ON notificaciones_push(usuario_id);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────────────

-- RLS para saldo_puntos
ALTER TABLE saldo_puntos ENABLE ROW LEVEL SECURITY;
CREATE POLICY saldo_puntos_select ON saldo_puntos FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY saldo_puntos_insert ON saldo_puntos FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());
CREATE POLICY saldo_puntos_update ON saldo_puntos FOR UPDATE
  USING (empresa_id = get_empresa_id());

-- RLS para movimientos_puntos
ALTER TABLE movimientos_puntos ENABLE ROW LEVEL SECURITY;
CREATE POLICY movimientos_puntos_select ON movimientos_puntos FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY movimientos_puntos_insert ON movimientos_puntos FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());

-- RLS para recompensas
ALTER TABLE recompensas ENABLE ROW LEVEL SECURITY;
CREATE POLICY recompensas_select ON recompensas FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY recompensas_insert ON recompensas FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());
CREATE POLICY recompensas_update ON recompensas FOR UPDATE
  USING (empresa_id = get_empresa_id());

-- RLS para canjes_recompensas
ALTER TABLE canjes_recompensas ENABLE ROW LEVEL SECURITY;
CREATE POLICY canjes_select ON canjes_recompensas FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY canjes_insert ON canjes_recompensas FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());

-- RLS para transacciones_pago
ALTER TABLE transacciones_pago ENABLE ROW LEVEL SECURITY;
CREATE POLICY transacciones_pago_select ON transacciones_pago FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY transacciones_pago_insert ON transacciones_pago FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());
CREATE POLICY transacciones_pago_update ON transacciones_pago FOR UPDATE
  USING (empresa_id = get_empresa_id());

-- RLS para sugerencias_pedido
ALTER TABLE sugerencias_pedido ENABLE ROW LEVEL SECURITY;
CREATE POLICY sugerencias_select ON sugerencias_pedido FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY sugerencias_insert ON sugerencias_pedido FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());

-- RLS para notificaciones_push
ALTER TABLE notificaciones_push ENABLE ROW LEVEL SECURITY;
CREATE POLICY notificaciones_push_select ON notificaciones_push FOR SELECT
  USING (empresa_id = get_empresa_id());
CREATE POLICY notificaciones_push_insert ON notificaciones_push FOR INSERT
  WITH CHECK (empresa_id = get_empresa_id());

-- ── FUNCIONES HELPER ───────────────────────────────────────────────────────

-- Función para calcular puntos ganados en una compra
CREATE OR REPLACE FUNCTION calcular_puntos_compra(
  p_cliente_id UUID,
  p_monto DECIMAL,
  p_empresa_id UUID
) RETURNS DECIMAL AS $$
DECLARE
  v_puntos_por_peso DECIMAL;
  v_puntos_ganados DECIMAL;
BEGIN
  SELECT puntos_por_peso INTO v_puntos_por_peso
  FROM programas_fidelizacion
  WHERE empresa_id = p_empresa_id AND activo = TRUE;
  
  v_puntos_ganados := p_monto * COALESCE(v_puntos_por_peso, 1.0);
  
  RETURN v_puntos_ganados;
END;
$$ LANGUAGE plpgsql;

-- Función para registrar movimiento de puntos
CREATE OR REPLACE FUNCTION registrar_movimiento_puntos(
  p_cliente_id UUID,
  p_empresa_id UUID,
  p_tipo VARCHAR,
  p_cantidad DECIMAL,
  p_motivo TEXT DEFAULT NULL,
  p_referencia_id UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_movimiento_id UUID;
BEGIN
  INSERT INTO movimientos_puntos (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
  VALUES (p_cliente_id, p_empresa_id, p_tipo, p_cantidad, p_motivo, p_referencia_id)
  RETURNING id INTO v_movimiento_id;
  
  -- Actualizar saldo
  UPDATE saldo_puntos
  SET 
    puntos_disponibles = CASE 
      WHEN p_tipo = 'ganancia' THEN puntos_disponibles + p_cantidad
      WHEN p_tipo = 'canje' THEN puntos_disponibles - p_cantidad
      ELSE puntos_disponibles
    END,
    puntos_canjeados = CASE 
      WHEN p_tipo = 'canje' THEN puntos_canjeados + p_cantidad
      ELSE puntos_canjeados
    END,
    puntos_totales = puntos_totales + CASE 
      WHEN p_tipo = 'ganancia' THEN p_cantidad
      WHEN p_tipo = 'canje' THEN -p_cantidad
      ELSE 0
    END,
    ultimo_movimiento = NOW()
  WHERE cliente_id = p_cliente_id AND empresa_id = p_empresa_id;
  
  RETURN v_movimiento_id;
END;
$$ LANGUAGE plpgsql;

-- ── TRIGGERS ───────────────────────────────────────────────────────────────

-- Trigger: Al crear un nuevo cliente, crear su saldo de puntos
CREATE OR REPLACE FUNCTION trigger_crear_saldo_puntos()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO saldo_puntos (cliente_id, empresa_id, puntos_disponibles, puntos_canjeados, puntos_totales)
  VALUES (NEW.id, NEW.empresa_id, 0, 0, 0)
  ON CONFLICT (cliente_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_crear_saldo_puntos
AFTER INSERT ON clientes
FOR EACH ROW
EXECUTE FUNCTION trigger_crear_saldo_puntos();

-- Trigger: Forzar empresa_id en inserciones (seguridad)
CREATE OR REPLACE FUNCTION trigger_force_empresa_id_etapa7()
RETURNS TRIGGER AS $$
BEGIN
  NEW.empresa_id := get_empresa_id();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_force_empresa_saldo_puntos BEFORE INSERT ON saldo_puntos
FOR EACH ROW EXECUTE FUNCTION trigger_force_empresa_id_etapa7();

CREATE TRIGGER tg_force_empresa_movimientos_puntos BEFORE INSERT ON movimientos_puntos
FOR EACH ROW EXECUTE FUNCTION trigger_force_empresa_id_etapa7();

CREATE TRIGGER tg_force_empresa_transacciones_pago BEFORE INSERT ON transacciones_pago
FOR EACH ROW EXECUTE FUNCTION trigger_force_empresa_id_etapa7();

CREATE TRIGGER tg_force_empresa_sugerencias BEFORE INSERT ON sugerencias_pedido
FOR EACH ROW EXECUTE FUNCTION trigger_force_empresa_id_etapa7();

CREATE TRIGGER tg_force_empresa_notificaciones_push BEFORE INSERT ON notificaciones_push
FOR EACH ROW EXECUTE FUNCTION trigger_force_empresa_id_etapa7();


-- ════════════════════════════════════════════════════════════════════════════
-- RLS FALTANTE: programas_fidelizacion, integraciones_pago, dispositivos_push
-- (Corrección post-auditoría — estas tablas quedaron sin políticas de acceso)
-- ════════════════════════════════════════════════════════════════════════════

-- ── programas_fidelizacion ────────────────────────────────────────────────
ALTER TABLE programas_fidelizacion ENABLE ROW LEVEL SECURITY;

-- Usuarios internos ven el programa de su empresa
CREATE POLICY programas_fidelizacion_select ON programas_fidelizacion FOR SELECT
  USING (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

-- Solo dueño/admin pueden crear/modificar el programa
CREATE POLICY programas_fidelizacion_insert ON programas_fidelizacion FOR INSERT
  WITH CHECK (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

CREATE POLICY programas_fidelizacion_update ON programas_fidelizacion FOR UPDATE
  USING (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

-- ── integraciones_pago ────────────────────────────────────────────────────
ALTER TABLE integraciones_pago ENABLE ROW LEVEL SECURITY;

-- Solo usuarios internos de la empresa pueden ver sus integraciones
CREATE POLICY integraciones_pago_select ON integraciones_pago FOR SELECT
  USING (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

CREATE POLICY integraciones_pago_insert ON integraciones_pago FOR INSERT
  WITH CHECK (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

CREATE POLICY integraciones_pago_update ON integraciones_pago FOR UPDATE
  USING (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

-- ── dispositivos_push ─────────────────────────────────────────────────────
ALTER TABLE dispositivos_push ENABLE ROW LEVEL SECURITY;

-- Cada usuario solo puede ver/gestionar sus propios dispositivos
CREATE POLICY dispositivos_push_select ON dispositivos_push FOR SELECT
  USING (usuario_id = auth.uid());

CREATE POLICY dispositivos_push_insert ON dispositivos_push FOR INSERT
  WITH CHECK (usuario_id = auth.uid());

CREATE POLICY dispositivos_push_update ON dispositivos_push FOR UPDATE
  USING (usuario_id = auth.uid());

CREATE POLICY dispositivos_push_delete ON dispositivos_push FOR DELETE
  USING (usuario_id = auth.uid());
