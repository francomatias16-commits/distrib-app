-- ═══════════════════════════════════════════════════════════════════════════
-- 524_fix_componente_pagos_score_cliente_cobro_facturas_aplicadas.sql
--
-- Componente "Pagos" de calcular_score_cliente() (40% del peso del score):
-- media de días entre el vencimiento de una factura y su cobro. El join
-- original pasaba por cta_cte.factura_id, pero las filas tipo='cobro' de
-- cta_cte NUNCA completan esa columna (0 de 140 en la empresa de prueba)
-- — el join no encontraba nada y el componente caía siempre al default
-- (20/40).
--
-- registrar_cobro_completo() evolucionó (migración de RPCs financieras del
-- 2026-08-18) y desde entonces trackea el vínculo cobro↔factura en una
-- tabla dedicada: cobro_facturas_aplicadas (cobro_id, factura_id,
-- monto_aplicado). Ese es el dato real a usar, no cta_cte.factura_id (que
-- quedó de un diseño anterior y nunca se usó).
--
-- OJO: cobro_facturas_aplicadas recién empezó a poblarse con esa migración,
-- así que los cobros ya existentes de antes (140 en la empresa de prueba)
-- no tienen fila ahí — el componente Pagos va a seguir devolviendo el
-- default hasta que haya cobros nuevos vinculados a factura por esa vía.
-- Sigue siendo la corrección correcta: es el mismo mecanismo por el que
-- ya se desbloquea automáticamente a un cliente (registrar_cobro_completo
-- también migró de leer cta_cte con el criterio roto 'debito' a leer
-- clientes.saldo_deuda directamente).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.calcular_score_cliente(
  p_cliente_id uuid,
  p_empresa_id uuid,
  p_motivo      text DEFAULT 'recalculo'
) RETURNS numeric
  LANGUAGE plpgsql SECURITY DEFINER
AS $$
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
  v_mensaje    TEXT;
BEGIN
  -- Componente Pagos (0-40 pts): velocidad de pago respecto al vencimiento
  -- FIX 524: antes hacía join vía cta_cte.factura_id, que las filas tipo=
  -- 'cobro' de cta_cte nunca completan. El dato real de qué cobro pagó
  -- qué factura vive en cobro_facturas_aplicadas desde que
  -- registrar_cobro_completo() empezó a registrarlo ahí.
  SELECT AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0) INTO v_dias_prom
  FROM cobro_facturas_aplicadas cfa
  JOIN cobros co   ON co.id = cfa.cobro_id
  JOIN facturas f  ON f.id  = cfa.factura_id
  WHERE co.cliente_id = p_cliente_id
    AND co.empresa_id = p_empresa_id
    AND co.fecha >= now() - INTERVAL '90 days'
    AND f.fecha_vencimiento IS NOT NULL;

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
  -- FIX 523: cta_cte.tipo real es 'factura'/'cobro'/'nota_credito', nunca
  -- 'debito'/'credito' — antes esto hacía que TODO cayera al ELSE (-monto)
  -- y el componente diera siempre 20/20 sin importar la deuda real.
  SELECT COALESCE(SUM(CASE WHEN tipo = 'factura' THEN monto ELSE -monto END), 0) INTO v_deuda_act
  FROM cta_cte
  WHERE cliente_id = p_cliente_id
    AND empresa_id = p_empresa_id
    AND COALESCE(anulado, false) = false;
  SELECT COALESCE(limite_credito, 0) INTO v_lim_cred FROM clientes WHERE id = p_cliente_id;

  v_deuda := CASE
    WHEN v_lim_cred = 0                          THEN 10
    WHEN v_deuda_act <= 0                        THEN 20
    WHEN (v_deuda_act / v_lim_cred) <= 0.3      THEN 18
    WHEN (v_deuda_act / v_lim_cred) <= 0.6      THEN 12
    WHEN (v_deuda_act / v_lim_cred) <= 0.9      THEN 6
    ELSE 0 END;

  -- Componente Devoluciones (0-15 pts)
  SELECT CASE WHEN COALESCE(SUM(pi2.cantidad), 0) > 0
    THEN COALESCE(
      (SELECT SUM(di.cantidad)
         FROM devoluciones d
         JOIN devolucion_items di ON di.devolucion_id = d.id
        WHERE d.cliente_id = p_cliente_id
          AND d.empresa_id = p_empresa_id
          AND d.estado <> 'rechazada'
          AND d.created_at >= now() - INTERVAL '90 days'
      ) / SUM(pi2.cantidad), 0) * 100
    ELSE 0 END INTO v_pct_devol
  FROM pedidos p
  JOIN pedido_items pi2 ON pi2.pedido_id = p.id
  WHERE p.cliente_id = p_cliente_id AND p.empresa_id = p_empresa_id
    AND p.fecha_pedido >= now() - INTERVAL '90 days';

  v_devol := CASE
    WHEN v_pct_devol = 0   THEN 15
    WHEN v_pct_devol < 5   THEN 12
    WHEN v_pct_devol < 10  THEN 8
    WHEN v_pct_devol < 20  THEN 4
    ELSE 0 END;

  v_total := v_pagos + v_frecuencia + v_deuda + v_devol;

  SELECT * INTO v_reglas FROM reglas_score
  WHERE empresa_id = p_empresa_id LIMIT 1;

  IF v_reglas IS NULL THEN
    v_categoria := CASE
      WHEN v_total >= 80 THEN 'premium'
      WHEN v_total >= 60 THEN 'bueno'
      WHEN v_total >= 40 THEN 'normal'
      WHEN v_total >= 20 THEN 'riesgo'
      ELSE 'bloqueado' END;
  ELSE
    v_categoria := CASE
      WHEN v_total >= v_reglas.umbral_premium   THEN 'premium'
      WHEN v_total >= v_reglas.umbral_bueno     THEN 'bueno'
      WHEN v_total >= v_reglas.umbral_normal    THEN 'normal'
      WHEN v_total >= v_reglas.umbral_riesgo    THEN 'riesgo'
      ELSE 'bloqueado' END;
  END IF;

  SELECT score INTO v_anterior FROM scores_cliente
  WHERE cliente_id = p_cliente_id AND empresa_id = p_empresa_id
  ORDER BY created_at DESC LIMIT 1;

  INSERT INTO scores_cliente (
    cliente_id, empresa_id, score, score_pagos, score_frecuencia,
    score_deuda, score_devolucion, motivo_cambio
  ) VALUES (
    p_cliente_id, p_empresa_id, v_total, v_pagos, v_frecuencia,
    v_deuda, v_devol, p_motivo
  );

  UPDATE clientes
  SET score_categoria   = v_categoria,
      score_actual      = v_total,
      score_actualizado = now()
  WHERE id = p_cliente_id AND empresa_id = p_empresa_id;

  IF (v_categoria IN ('riesgo', 'bloqueado')
      OR (v_anterior IS NOT NULL AND (v_anterior - v_total) >= 15))
     AND NOT EXISTS (
       SELECT 1 FROM alertas_score
       WHERE cliente_id = p_cliente_id
         AND empresa_id = p_empresa_id
         AND resuelta = false
     )
  THEN
    v_mensaje := CASE
      WHEN v_categoria IN ('riesgo', 'bloqueado') THEN
        'Cliente en estado ' || v_categoria || ' (score ' || v_total::INT || '/100).'
      ELSE
        'El cliente degradó su score ' || v_anterior::INT || ' → ' || v_total::INT ||
        ' puntos. Revisar situación crediticia.'
    END;

    INSERT INTO alertas_score (cliente_id, empresa_id, score_anterior, score_nuevo, mensaje)
    VALUES (p_cliente_id, p_empresa_id, v_anterior, v_total, v_mensaje);
  END IF;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.calcular_score_cliente(uuid, uuid, text) IS
'FIX 524: el componente Pagos usaba un join vía cta_cte.factura_id que
las filas tipo=''cobro'' nunca completan. Ahora usa cobro_facturas_aplicadas
(cobro_id, factura_id), la tabla que registrar_cobro_completo() realmente
llena desde la migración de RPCs financieras del 2026-08-18. Sigue el
FIX 523 (componente Deuda, tipo=''factura'' en vez de ''debito''). Ambos
componentes pendientes de que haya cobros nuevos vinculados a factura para
mostrar variación real — los históricos previos a esa migración no tienen
fila en cobro_facturas_aplicadas.';
