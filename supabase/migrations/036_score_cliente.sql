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
