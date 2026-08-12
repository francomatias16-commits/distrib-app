-- ═══════════════════════════════════════════════════════════════════════════
-- 049_fix_missing_tables_rpcs.sql
-- Asegura que todas las tablas y RPCs referenciadas en el código (v49)
-- existen en la base de datos. Idempotente — usa IF NOT EXISTS / IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. notif_log (ya en 005_notif_log.sql — re-create idempotente) ────────
CREATE TABLE IF NOT EXISTS notif_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id   UUID REFERENCES clientes(id) ON DELETE SET NULL,
  pedido_id    UUID REFERENCES pedidos(id)  ON DELETE SET NULL,
  tipo         TEXT NOT NULL,
  canal        TEXT NOT NULL,
  telefono     TEXT,
  email        TEXT,
  message_id   TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_log_empresa   ON notif_log(empresa_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_cliente   ON notif_log(cliente_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_tipo      ON notif_log(empresa_id, tipo, created_at DESC);
ALTER TABLE notif_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_log_empresa ON notif_log;
CREATE POLICY notif_log_empresa ON notif_log
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ─── 2. bloqueos_cliente (referenciada en pagos.js y cierre.js) ────────────
CREATE TABLE IF NOT EXISTS bloqueos_cliente (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  motivo      TEXT,
  activo      BOOLEAN DEFAULT true,
  usuario_id  UUID REFERENCES usuarios(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bloqueos_cliente ON bloqueos_cliente(cliente_id, activo);
ALTER TABLE bloqueos_cliente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bloqueos_empresa ON bloqueos_cliente;
CREATE POLICY bloqueos_empresa ON bloqueos_cliente
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ─── 3. ciclos_compra (piloto automático — 032_piloto_automatico.sql) ──────
CREATE TABLE IF NOT EXISTS ciclos_compra (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id        UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  producto_id       UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  cantidad_promedio NUMERIC(12,3) NOT NULL DEFAULT 0,
  intervalo_dias    INT NOT NULL DEFAULT 0,
  ultima_compra     DATE,
  proximo_pedido    DATE,
  confianza         NUMERIC(4,2) DEFAULT 0,
  activo            BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(cliente_id, producto_id)
);
CREATE INDEX IF NOT EXISTS idx_ciclos_empresa ON ciclos_compra(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ciclos_proximo ON ciclos_compra(proximo_pedido) WHERE activo = true;
CREATE INDEX IF NOT EXISTS idx_ciclos_cliente ON ciclos_compra(cliente_id);
ALTER TABLE ciclos_compra ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ciclos_empresa ON ciclos_compra;
CREATE POLICY ciclos_empresa ON ciclos_compra
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- Columnas en pedidos para piloto automático
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS generado_automatico  BOOLEAN DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confianza_sugerencia NUMERIC(4,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ciclo_referencia_id  UUID REFERENCES ciclos_compra(id);

-- ─── 4. scores_cliente + alertas_score + reglas_score (036_score_cliente) ──
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

-- Columnas en clientes para score
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
ALTER TABLE reglas_score ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reglas_empresa ON reglas_score;
CREATE POLICY reglas_empresa ON reglas_score
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ─── 5. calcular_score_cliente RPC (simplificada para evitar dependencias) ─
CREATE OR REPLACE FUNCTION calcular_score_cliente(
  p_cliente_id UUID, p_empresa_id UUID, p_motivo TEXT DEFAULT 'recalculo'
)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_score    NUMERIC := 50;
  v_anterior NUMERIC;
BEGIN
  -- Score base: media ponderada de componentes disponibles
  -- Pagos (40 pts)
  SELECT COALESCE(
    LEAST(40, 40 - (
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0), 0)
      FROM cobros co
      JOIN facturas f ON f.pedido_id = (
        SELECT pedido_id FROM cta_cte WHERE cobro_id = co.id LIMIT 1
      )
      WHERE co.cliente_id = p_cliente_id AND co.fecha >= now() - INTERVAL '90 days'
    ) * 1.5
  ), 20) INTO v_score;

  -- Frecuencia pedidos (25 pts)
  v_score := COALESCE(v_score, 0) + LEAST(25,
    (SELECT COUNT(*) FROM pedidos
     WHERE cliente_id = p_cliente_id AND empresa_id = p_empresa_id
       AND estado IN ('entregado','despachado','confirmado')
       AND fecha_pedido >= now() - INTERVAL '90 days') * 3
  );

  -- Normalizar 0-100
  v_score := GREATEST(0, LEAST(100, v_score));

  -- Guardar historial
  SELECT score INTO v_anterior FROM scores_cliente
  WHERE cliente_id = p_cliente_id ORDER BY created_at DESC LIMIT 1;

  INSERT INTO scores_cliente(cliente_id, empresa_id, score, motivo_cambio)
  VALUES (p_cliente_id, p_empresa_id, v_score, p_motivo);

  -- Actualizar cliente
  UPDATE clientes SET
    score_actual      = v_score,
    score_categoria   = CASE
      WHEN v_score >= 80 THEN 'premium'
      WHEN v_score >= 65 THEN 'bueno'
      WHEN v_score >= 45 THEN 'normal'
      WHEN v_score >= 30 THEN 'riesgo'
      ELSE 'bloqueado'
    END,
    score_actualizado = now()
  WHERE id = p_cliente_id;

  -- Generar alerta si cayó más de 10 puntos
  IF v_anterior IS NOT NULL AND (v_anterior - v_score) > 10 THEN
    INSERT INTO alertas_score(cliente_id, empresa_id, score_anterior, score_nuevo, mensaje)
    VALUES (p_cliente_id, p_empresa_id, v_anterior, v_score,
            format('Score bajó de %.0f a %.0f (%s)', v_anterior, v_score, p_motivo));
  END IF;

  RETURN v_score;
END;
$$;

-- ─── 6. generar_pedidos_sugeridos RPC (piloto automático) ──────────────────
CREATE OR REPLACE FUNCTION generar_pedidos_sugeridos(p_empresa_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ciclo    RECORD;
  v_count    INT := 0;
  v_pedido   UUID;
BEGIN
  -- Recalcular ciclos primero
  PERFORM calcular_ciclos_cliente(p_empresa_id);

  -- Generar pedidos sugeridos para ciclos que vencen en próximos 3 días
  FOR v_ciclo IN
    SELECT cc.*, c.vendedor_id
    FROM ciclos_compra cc
    JOIN clientes c ON c.id = cc.cliente_id
    WHERE cc.empresa_id = p_empresa_id
      AND cc.activo = true
      AND cc.proximo_pedido <= CURRENT_DATE + INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM pedidos p
        WHERE p.cliente_id = cc.cliente_id
          AND p.estado = 'sugerido'
          AND p.ciclo_referencia_id = cc.id
      )
  LOOP
    -- Crear pedido sugerido
    INSERT INTO pedidos (
      empresa_id, cliente_id, vendedor_id, estado,
      generado_automatico, confianza_sugerencia, ciclo_referencia_id,
      fecha_pedido, total
    ) VALUES (
      p_empresa_id, v_ciclo.cliente_id, v_ciclo.vendedor_id, 'sugerido',
      true, v_ciclo.confianza, v_ciclo.id,
      now(), 0
    ) RETURNING id INTO v_pedido;

    -- Agregar item sugerido
    INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario)
    SELECT v_pedido, v_ciclo.producto_id, v_ciclo.cantidad_promedio,
           COALESCE(lp_detalle.precio, pr.precio_base, 0)
    FROM productos pr
    LEFT JOIN listas_precios_detalle lp_detalle
      ON lp_detalle.producto_id = pr.id
      AND lp_detalle.lista_id = (
        SELECT id FROM listas_precios
        WHERE empresa_id = p_empresa_id AND es_default = true LIMIT 1
      )
    WHERE pr.id = v_ciclo.producto_id;

    -- Actualizar total del pedido
    UPDATE pedidos SET total = (
      SELECT COALESCE(SUM(cantidad * precio_unitario), 0) FROM pedido_items WHERE pedido_id = v_pedido
    ) WHERE id = v_pedido;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Función auxiliar para calcular_ciclos_cliente (si no existe de 032)
CREATE OR REPLACE FUNCTION calcular_ciclos_cliente(p_empresa_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_rec RECORD;
BEGIN
  FOR v_rec IN
    SELECT
      pi.cliente_id,
      pi.producto_id,
      COUNT(*)                                           AS total_pedidos,
      AVG(pi.cantidad)                                   AS cantidad_promedio,
      COALESCE(AVG(EXTRACT(EPOCH FROM (pi.fecha_actual - pi.fecha_anterior)) / 86400), 30)::INT AS intervalo_dias,
      MAX(pi.fecha_pedido)                               AS ultima_compra,
      LEAST(0.95, (COUNT(*) - 2)::NUMERIC / 10 + 0.3)   AS confianza
    FROM (
      SELECT p.cliente_id, pi2.producto_id, pi2.cantidad, p.fecha_pedido,
             p.fecha_pedido AS fecha_actual,
             LAG(p.fecha_pedido) OVER (
               PARTITION BY p.cliente_id, pi2.producto_id ORDER BY p.fecha_pedido
             ) AS fecha_anterior
      FROM pedidos p
      JOIN pedido_items pi2 ON pi2.pedido_id = p.id
      WHERE p.empresa_id = p_empresa_id
        AND p.estado IN ('entregado', 'confirmado', 'despachado')
        AND p.fecha_pedido >= now() - INTERVAL '6 months'
    ) pi
    WHERE pi.fecha_anterior IS NOT NULL
    GROUP BY pi.cliente_id, pi.producto_id
    HAVING COUNT(*) >= 3
       AND AVG(EXTRACT(EPOCH FROM (pi.fecha_actual - pi.fecha_anterior)) / 86400) > 0
  LOOP
    INSERT INTO ciclos_compra (
      empresa_id, cliente_id, producto_id,
      cantidad_promedio, intervalo_dias,
      ultima_compra, proximo_pedido, confianza, activo
    ) VALUES (
      p_empresa_id, v_rec.cliente_id, v_rec.producto_id,
      v_rec.cantidad_promedio, v_rec.intervalo_dias,
      v_rec.ultima_compra,
      v_rec.ultima_compra + v_rec.intervalo_dias,
      v_rec.confianza, true
    )
    ON CONFLICT (cliente_id, producto_id) DO UPDATE SET
      cantidad_promedio = EXCLUDED.cantidad_promedio,
      intervalo_dias    = EXCLUDED.intervalo_dias,
      ultima_compra     = EXCLUDED.ultima_compra,
      proximo_pedido    = EXCLUDED.proximo_pedido,
      confianza         = EXCLUDED.confianza,
      updated_at        = now();
  END LOOP;
END;
$$;

-- ─── 7. analizar_stock_autonomo (035_stock_autonomo.sql) ───────────────────
ALTER TABLE productos ADD COLUMN IF NOT EXISTS lead_time_dias       INT DEFAULT 7;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_minimo         NUMERIC(12,3) DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_objetivo       NUMERIC(12,3) DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS proveedor_id_default UUID REFERENCES proveedores(id);

CREATE TABLE IF NOT EXISTS alertas_stock (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id     UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  dias_restantes  NUMERIC(6,1),
  orden_compra_id UUID REFERENCES ordenes_compra(id),
  resuelta        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(producto_id, tipo, resuelta)
);
ALTER TABLE alertas_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alertas_empresa ON alertas_stock;
CREATE POLICY alertas_empresa ON alertas_stock
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE OR REPLACE FUNCTION analizar_stock_autonomo(p_empresa_id UUID)
RETURNS TABLE (
  producto_id       UUID,
  nombre            TEXT,
  stock_actual      NUMERIC,
  velocidad_dia     NUMERIC,
  dias_restantes    NUMERIC,
  lead_time         INT,
  necesita_reponer  BOOLEAN,
  cantidad_sugerida NUMERIC,
  proveedor_id      UUID
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH ventas_30d AS (
    SELECT pi2.producto_id,
           SUM(pi2.cantidad) / 30.0 AS vel_dia
    FROM pedido_items pi2
    JOIN pedidos ped ON ped.id = pi2.pedido_id
    WHERE ped.empresa_id = p_empresa_id
      AND ped.estado IN ('entregado','despachado','confirmado')
      AND ped.fecha_pedido >= now() - INTERVAL '30 days'
    GROUP BY pi2.producto_id
  ),
  stock_actual AS (
    SELECT s.producto_id,
           SUM(s.cantidad - COALESCE(s.cantidad_reservada, 0)) AS disponible
    FROM stock s
    JOIN depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
    GROUP BY s.producto_id
  )
  SELECT
    p.id,
    p.nombre,
    COALESCE(sa.disponible, 0),
    COALESCE(v.vel_dia, 0),
    CASE WHEN COALESCE(v.vel_dia, 0) > 0
      THEN COALESCE(sa.disponible, 0) / v.vel_dia
      ELSE 999
    END,
    COALESCE(p.lead_time_dias, 7),
    (COALESCE(sa.disponible, 0) <= COALESCE(p.stock_minimo, 0)),
    GREATEST(0,
      COALESCE(p.stock_objetivo,
        COALESCE(v.vel_dia, 0) * 30, 0)
      - COALESCE(sa.disponible, 0)
    ),
    p.proveedor_id_default
  FROM productos p
  LEFT JOIN ventas_30d v  ON v.producto_id = p.id
  LEFT JOIN stock_actual sa ON sa.producto_id = p.id
  WHERE p.empresa_id = p_empresa_id
    AND p.activo = true;
END;
$$;

-- ─── 8. Columnas faltantes en tablas existentes ────────────────────────────
-- ordenes_compra puede no tener auto_generada
ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS auto_generada            BOOLEAN DEFAULT false;
ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS velocidad_venta_snapshot JSONB;

-- pedidos: estado 'sugerido' en ENUM si existe
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_pedido') THEN
    ALTER TYPE estado_pedido ADD VALUE IF NOT EXISTS 'sugerido';
  END IF;
END;
$$;
