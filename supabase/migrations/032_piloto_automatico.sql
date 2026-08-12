-- ═══════════════════════════════════════════════════════════════════════════
-- REQ-1: Motor de Decisión Autónomo de Pedidos ("Piloto Automático")
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- Tabla de ciclos de compra por cliente/producto
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

-- Agregar estado 'sugerido' al tipo de estado de pedidos
-- (ejecutar solo si el tipo existe como ENUM)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_pedido') THEN
    ALTER TYPE estado_pedido ADD VALUE IF NOT EXISTS 'sugerido';
  END IF;
END;
$$;

-- Columnas en tabla pedidos para soporte de piloto automático
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS generado_automatico  BOOLEAN DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confianza_sugerencia NUMERIC(4,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ciclo_referencia_id  UUID REFERENCES ciclos_compra(id);

-- ─── Función: calcular ciclos de compra por empresa ────────────────────────
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
      AVG(EXTRACT(EPOCH FROM (pi.fecha_actual - pi.fecha_anterior)) / 86400)::INT AS intervalo_dias,
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
      ultima_compra, proximo_pedido, confianza
    )
    VALUES (
      p_empresa_id, v_rec.cliente_id, v_rec.producto_id,
      v_rec.cantidad_promedio, v_rec.intervalo_dias,
      v_rec.ultima_compra::DATE,
      (v_rec.ultima_compra + v_rec.intervalo_dias * INTERVAL '1 day')::DATE,
      v_rec.confianza
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

-- ─── Función: generar pedidos sugeridos ────────────────────────────────────
CREATE OR REPLACE FUNCTION generar_pedidos_sugeridos(p_empresa_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_rec       RECORD;
  v_pedido_id UUID;
  v_contador  INT := 0;
  v_existe    BOOLEAN;
BEGIN
  PERFORM calcular_ciclos_cliente(p_empresa_id);

  FOR v_rec IN
    SELECT cc.id AS ciclo_id, cc.cliente_id, cc.producto_id,
           cc.cantidad_promedio, cc.confianza, pr.precio AS precio_unitario
    FROM ciclos_compra cc
    JOIN clientes c ON c.id = cc.cliente_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        (SELECT pi2.precio FROM precios_items pi2
         JOIN listas_precios lp ON lp.id = pi2.lista_precio_id
         WHERE pi2.producto_id = cc.producto_id AND lp.id = c.lista_precio_id LIMIT 1),
        (SELECT precio_venta FROM productos WHERE id = cc.producto_id)
      ) AS precio
    ) pr ON true
    WHERE cc.empresa_id = p_empresa_id
      AND cc.activo = true
      AND cc.confianza >= 0.4
      AND cc.proximo_pedido BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '2 days'
  LOOP
    -- Verificar si ya existe sugerido reciente para este cliente/producto
    SELECT EXISTS(
      SELECT 1 FROM pedidos p JOIN pedido_items pi2 ON pi2.pedido_id = p.id
      WHERE p.cliente_id = v_rec.cliente_id AND p.empresa_id = p_empresa_id
        AND p.estado = 'sugerido' AND pi2.producto_id = v_rec.producto_id
        AND p.created_at >= now() - INTERVAL '3 days'
    ) INTO v_existe;
    IF v_existe THEN CONTINUE; END IF;

    -- Verificar stock disponible
    IF NOT EXISTS (
      SELECT 1 FROM stock s WHERE s.producto_id = v_rec.producto_id
        AND (s.cantidad - s.cantidad_reservada) >= v_rec.cantidad_promedio
    ) THEN CONTINUE; END IF;

    INSERT INTO pedidos (empresa_id, cliente_id, estado, generado_automatico,
      confianza_sugerencia, ciclo_referencia_id, subtotal, total)
    VALUES (p_empresa_id, v_rec.cliente_id, 'sugerido', true, v_rec.confianza, v_rec.ciclo_id,
      v_rec.cantidad_promedio * v_rec.precio_unitario,
      v_rec.cantidad_promedio * v_rec.precio_unitario)
    RETURNING id INTO v_pedido_id;

    INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario, subtotal)
    VALUES (v_pedido_id, v_rec.producto_id, v_rec.cantidad_promedio, v_rec.precio_unitario,
      v_rec.cantidad_promedio * v_rec.precio_unitario);

    v_contador := v_contador + 1;
  END LOOP;
  RETURN v_contador;
END;
$$;
