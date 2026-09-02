-- 541_fix_calcular_score_cliente_componente_deuda_cons_04.sql
--
-- Etapa 6 (consistencia e2e) — CONS-04, sesión 2026-08-24.
--
-- calcular_score_cliente() recalculaba la deuda actual con su propio
-- SUM(CASE) sobre cta_cte (fijado por 523/524, ver esos archivos) en vez
-- de reusar calcular_deuda_cliente()/clientes.saldo_deuda (fuente
-- canónica, ver 540). Ese CASE propio solo reconocía tipo='factura' como
-- deuda (+monto); todo lo demás caía en el ELSE -monto, incluyendo
-- 'cargo' y 'nota_debito' -que SÍ son deuda según sync_saldo_deuda_cliente
-- desde la migración 452- lo que los restaba de la deuda del cliente en
-- vez de sumarlos.
--
-- Sin impacto en datos existentes: producción hoy solo tiene tipo IN
-- ('factura','cobro','nota_credito') en cta_cte, y para esos tres el
-- signo daba correcto (por eso 523/524 no lo detectaron). Pero apenas se
-- registre un 'cargo' o una 'nota_debito' (ya soportados por el trigger
-- desde 452), el componente Deuda (0-20 pts) de calcular_score_cliente
-- subestimaría la deuda real del cliente y sobreestimaría su score/
-- categoría de riesgo.
--
-- Fix: reemplaza el SUM(CASE) propio (heredado de 523/524) por una
-- llamada a calcular_deuda_cliente(p_cliente_id), sin cambiar el resto de
-- la función (componentes Pagos/Frecuencia/Devoluciones, umbrales de
-- categoría, alertas) respecto a la versión vigente desde 524.

CREATE OR REPLACE FUNCTION public.calcular_score_cliente(p_cliente_id uuid, p_empresa_id uuid, p_motivo text DEFAULT 'recalculo'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  -- CONS-04 (Etapa 6, migración 541): antes recalculaba la deuda con su
  -- propio SUM(CASE WHEN tipo='factura' THEN monto ELSE -monto END)
  -- (fijado por 523/524), que trataba 'cargo'/'nota_debito' como crédito
  -- en vez de deuda. Ahora delega en calcular_deuda_cliente() (540), la
  -- misma fuente canónica que usa el semáforo de cobranza (066) y que lee
  -- clientes.saldo_deuda (mantenido por sync_saldo_deuda_cliente, con el
  -- CASE completo por tipo).
  v_deuda_act := calcular_deuda_cliente(p_cliente_id);
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
$function$;

COMMENT ON FUNCTION public.calcular_score_cliente(uuid, uuid, text) IS
  'CONS-04 (Etapa 6, migración 541): el componente Deuda dejó de recalcular '
  'su propio SUM(CASE) sobre cta_cte (el que había fijado la migración real '
  '523/524 del repo, correcto para tipo IN (factura,cobro,nota_credito) '
  'pero no contemplaba cargo/nota_debito) y ahora delega en '
  'calcular_deuda_cliente() (migración 540), la misma fuente que usa el '
  'semáforo de cobranza. Resto de la función (Pagos/Frecuencia/'
  'Devoluciones) sin cambios respecto a la migración 524 del repo.';
