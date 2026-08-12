-- ── DT-02: Sistema de puntos — tablas y funciones ───────────────────────────
-- Archivo: db/020_dt02_puntos.sql
--
-- Diseño:
--   • puntos_saldo    — saldo actual por cliente (fila única, se actualiza con triggers)
--   • puntos_log      — historial inmutable de acreditaciones y canjes
--   • rpc canjear_puntos — transacción atómica: valida saldo, registra canje,
--                          actualiza saldo y emite evento para el pedido/descuento
--
-- Puntos se acreditan al confirmar un pedido (trigger externo en pedidos).
-- Puntos se canjean desde la UI (DT-02) o al cerrar un pedido.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tabla de saldo actual ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS puntos_saldo (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id   UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  saldo        INTEGER NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  total_ganado INTEGER NOT NULL DEFAULT 0,
  total_canjeado INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, cliente_id)
);

CREATE INDEX IF NOT EXISTS idx_puntos_saldo_empresa
  ON puntos_saldo(empresa_id, cliente_id);

-- ── 2. Log de movimientos de puntos ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS puntos_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL CHECK (tipo IN ('acreditacion','canje','ajuste','vencimiento')),
  puntos        INTEGER NOT NULL,          -- positivo = suma, negativo = resta
  saldo_post    INTEGER NOT NULL,          -- saldo tras el movimiento
  concepto      TEXT,                      -- descripción legible
  referencia_tipo TEXT,                    -- 'pedido' | 'factura' | 'manual'
  referencia_id   UUID,                    -- id del pedido/factura relacionado
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nombre TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_puntos_log_cliente
  ON puntos_log(empresa_id, cliente_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_puntos_log_referencia
  ON puntos_log(referencia_tipo, referencia_id);

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE puntos_saldo ENABLE ROW LEVEL SECURITY;
ALTER TABLE puntos_log   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "puntos_saldo_empresa" ON puntos_saldo
  FOR ALL USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE POLICY "puntos_log_empresa" ON puntos_log
  FOR ALL USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ── 4. Función RPC: acreditar_puntos ─────────────────────────────────────────
-- Llamada desde trigger de pedidos o manualmente desde el admin.
CREATE OR REPLACE FUNCTION acreditar_puntos(
  p_empresa_id   UUID,
  p_cliente_id   UUID,
  p_puntos       INTEGER,
  p_concepto     TEXT DEFAULT 'Compra',
  p_ref_tipo     TEXT DEFAULT NULL,
  p_ref_id       UUID DEFAULT NULL,
  p_usuario_id   UUID DEFAULT NULL,
  p_usuario_nombre TEXT DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_saldo INTEGER;
BEGIN
  IF p_puntos <= 0 THEN
    RAISE EXCEPTION 'Los puntos a acreditar deben ser positivos';
  END IF;

  -- Upsert saldo
  INSERT INTO puntos_saldo(empresa_id, cliente_id, saldo, total_ganado, updated_at)
    VALUES (p_empresa_id, p_cliente_id, p_puntos, p_puntos, now())
  ON CONFLICT (empresa_id, cliente_id) DO UPDATE SET
    saldo        = puntos_saldo.saldo + p_puntos,
    total_ganado = puntos_saldo.total_ganado + p_puntos,
    updated_at   = now()
  RETURNING saldo INTO v_saldo;

  -- Log
  INSERT INTO puntos_log(empresa_id, cliente_id, tipo, puntos, saldo_post, concepto,
    referencia_tipo, referencia_id, usuario_id, usuario_nombre)
  VALUES (p_empresa_id, p_cliente_id, 'acreditacion', p_puntos, v_saldo,
    p_concepto, p_ref_tipo, p_ref_id, p_usuario_id, p_usuario_nombre);

  RETURN json_build_object('ok', true, 'saldo', v_saldo, 'puntos_acreditados', p_puntos);
END;
$$;

-- ── 5. Función RPC: canjear_puntos ───────────────────────────────────────────
-- Transacción atómica con validación de saldo y bloqueo pesimista.
CREATE OR REPLACE FUNCTION canjear_puntos(
  p_empresa_id   UUID,
  p_cliente_id   UUID,
  p_puntos       INTEGER,
  p_concepto     TEXT DEFAULT 'Canje de puntos',
  p_ref_tipo     TEXT DEFAULT NULL,
  p_ref_id       UUID DEFAULT NULL,
  p_usuario_id   UUID DEFAULT NULL,
  p_usuario_nombre TEXT DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_saldo_actual INTEGER;
  v_saldo_post   INTEGER;
BEGIN
  IF p_puntos <= 0 THEN
    RAISE EXCEPTION 'Los puntos a canjear deben ser positivos';
  END IF;

  -- Bloqueo pesimista para evitar race condition con canjes simultáneos
  SELECT saldo INTO v_saldo_actual
    FROM puntos_saldo
   WHERE empresa_id = p_empresa_id AND cliente_id = p_cliente_id
     FOR UPDATE;

  IF v_saldo_actual IS NULL THEN
    RAISE EXCEPTION 'El cliente no tiene cuenta de puntos';
  END IF;

  IF v_saldo_actual < p_puntos THEN
    RAISE EXCEPTION 'Saldo insuficiente. Disponible: % puntos', v_saldo_actual;
  END IF;

  v_saldo_post := v_saldo_actual - p_puntos;

  UPDATE puntos_saldo SET
    saldo          = v_saldo_post,
    total_canjeado = total_canjeado + p_puntos,
    updated_at     = now()
  WHERE empresa_id = p_empresa_id AND cliente_id = p_cliente_id;

  INSERT INTO puntos_log(empresa_id, cliente_id, tipo, puntos, saldo_post, concepto,
    referencia_tipo, referencia_id, usuario_id, usuario_nombre)
  VALUES (p_empresa_id, p_cliente_id, 'canje', -p_puntos, v_saldo_post,
    p_concepto, p_ref_tipo, p_ref_id, p_usuario_id, p_usuario_nombre);

  RETURN json_build_object(
    'ok',              true,
    'puntos_canjeados', p_puntos,
    'saldo_anterior',   v_saldo_actual,
    'saldo_nuevo',      v_saldo_post
  );
END;
$$;

-- ── 6. Vista resumen para el admin ───────────────────────────────────────────
CREATE OR REPLACE VIEW v_puntos_clientes AS
SELECT
  ps.empresa_id,
  ps.cliente_id,
  COALESCE(c.razon_social, c.nombre_fantasia, 'Sin nombre') AS cliente_nombre,
  c.email AS cliente_email,
  ps.saldo,
  ps.total_ganado,
  ps.total_canjeado,
  ps.updated_at
FROM puntos_saldo ps
JOIN clientes c ON c.id = ps.cliente_id
ORDER BY ps.saldo DESC;

COMMENT ON TABLE puntos_saldo IS 'Saldo de puntos actual por cliente. Actualizado atómicamente por las funciones RPC.';
COMMENT ON TABLE puntos_log   IS 'Historial inmutable de movimientos de puntos (acreditaciones, canjes, ajustes).';
