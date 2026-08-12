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
