-- ============================================================
-- Migración 092: Fix bugs críticos detectados en auditoría v112
-- Fecha: 2026-06-24
--
-- BUGS CORREGIDOS:
--   1. calcular_score_cliente — componente Pagos nunca calculó: 
--      SELECT pedido_id FROM cta_cte (columna inexistente → siempre NULL → score_pagos=20)
--      FIX: JOIN correcto via factura_id
--
--   2. nav-data.js — entrada "Compras" ausente del workspace Depósito
--      (PENDIENTES #3 marcado ✅ pero no aplicado en código)
--      FIX: aplicado en JS (ver 092_nav-data-fix.js)
--
--   3. puntos.js / auditoria.js — malformed function definitions
--      "async function window.getHeaders()" → sintaxis inválida, crash en producción
--      FIX: aplicado en JS (ver archivos corregidos)
--
--   4. generar_pedido_sugerido_cliente — RPC llamada por ciclos.js pero nunca
--      definida en la base. Sin ella, "Enviar por WhatsApp" falla en fallback.
--      FIX: se crea la función con lógica real basada en ciclos_compra.
--
-- Ejecución: psql -d distrib < 092_fix_bugs_criticos.sql
-- ============================================================

BEGIN;

-- ============================================================
-- FIX 1: calcular_score_cliente — Componente Pagos
-- El bug: SELECT pedido_id FROM cta_cte → cta_cte no tiene columna pedido_id
-- El fix: JOIN facturas f ON f.id = (SELECT factura_id FROM cta_cte ...)
-- Confirmado: el mismo patrón correcto ya usa v_cobranza_priorizada (backup línea ~9241)
-- ============================================================

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
  v_nuevos_dias INT;
BEGIN
  -- Componente Pagos (0-40 pts): velocidad de pago respecto al vencimiento
  -- FIX 092: cta_cte NO tiene columna pedido_id. El join correcto es via factura_id.
  SELECT AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0) INTO v_dias_prom
  FROM cobros co
  JOIN facturas f ON f.id = (
    SELECT factura_id FROM cta_cte WHERE cobro_id = co.id LIMIT 1
  )
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

  -- Determinar categoría
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

  -- Obtener score anterior para calcular variación
  SELECT score INTO v_anterior FROM scores_cliente
  WHERE cliente_id = p_cliente_id AND empresa_id = p_empresa_id
  ORDER BY created_at DESC LIMIT 1;

  v_nuevos_dias := CASE
    WHEN v_anterior IS NULL THEN NULL
    ELSE ROUND((v_total - v_anterior)::numeric, 2)
  END;

  -- Insertar nuevo score
  INSERT INTO scores_cliente (
    cliente_id, empresa_id, score, score_pagos, score_frecuencia,
    score_deuda, score_devolucion, score_categoria, motivo
  ) VALUES (
    p_cliente_id, p_empresa_id, v_total, v_pagos, v_frecuencia,
    v_deuda, v_devol, v_categoria, p_motivo
  );

  -- Actualizar categoría en clientes
  UPDATE clientes
  SET score_categoria = v_categoria
  WHERE id = p_cliente_id AND empresa_id = p_empresa_id;

  -- Disparar alerta si categoría empeoró o es crítica
  IF v_categoria IN ('riesgo', 'bloqueado') THEN
    INSERT INTO alertas_score (cliente_id, empresa_id, score, categoria, motivo, resuelta)
    VALUES (p_cliente_id, p_empresa_id, v_total, v_categoria, p_motivo, false)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.calcular_score_cliente(uuid, uuid, text) IS
'FIX 092: Corregido bug crítico en componente Pagos (siempre retornaba 20/40 porque la subquery
hacía SELECT pedido_id FROM cta_cte, columna inexistente → siempre NULL → v_pagos=20).
La subquery correcta es: SELECT factura_id FROM cta_cte WHERE cobro_id = co.id.
Mismo patrón que usa v_cobranza_priorizada (que sí funcionaba correctamente).
Agregado filtro co.empresa_id = p_empresa_id y f.fecha_vencimiento IS NOT NULL para evitar
divisiones erróneas con fechas nulas.';


-- ============================================================
-- FIX 4: generar_pedido_sugerido_cliente — RPC faltante
-- Llamada por ciclos.js línea 139 pero nunca existió en la DB.
-- Sin ella, el botón "Enviar pedido habitual por WhatsApp" siempre falla
-- si no hay un sugerido pre-generado por el cron nocturno.
-- ============================================================

CREATE OR REPLACE FUNCTION public.generar_pedido_sugerido_cliente(
  p_empresa_id uuid,
  p_cliente_id uuid
) RETURNS TABLE (pedido_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_pedido_id uuid;
  v_ciclo     RECORD;
  v_tiene     BOOLEAN := false;
BEGIN
  -- Verificar si ya existe un sugerido reciente (últimas 36h) para no duplicar
  SELECT p.id INTO v_pedido_id
  FROM pedidos p
  WHERE p.empresa_id  = p_empresa_id
    AND p.cliente_id  = p_cliente_id
    AND p.estado      = 'sugerido'
    AND p.generado_automatico = true
    AND p.fecha_pedido >= now() - INTERVAL '36 hours'
  ORDER BY p.fecha_pedido DESC
  LIMIT 1;

  IF v_pedido_id IS NOT NULL THEN
    RETURN QUERY SELECT v_pedido_id;
    RETURN;
  END IF;

  -- Crear pedido sugerido basado en ciclos_compra activos con vencimiento próximo
  FOR v_ciclo IN
    SELECT cc.producto_id, cc.cantidad_habitual,
           p.precio_lista AS precio_unitario
    FROM ciclos_compra cc
    LEFT JOIN productos p ON p.id = cc.producto_id AND p.empresa_id = p_empresa_id
    WHERE cc.empresa_id = p_empresa_id
      AND cc.cliente_id = p_cliente_id
      AND cc.activo = true
      AND cc.proximo_vencimiento <= now() + INTERVAL '3 days'
    ORDER BY cc.proximo_vencimiento ASC
  LOOP
    IF NOT v_tiene THEN
      -- Crear el pedido cabecera
      INSERT INTO pedidos (
        empresa_id, cliente_id, estado, generado_automatico,
        fecha_pedido, origen
      ) VALUES (
        p_empresa_id, p_cliente_id, 'sugerido', true,
        now(), 'piloto_automatico'
      )
      RETURNING id INTO v_pedido_id;
      v_tiene := true;
    END IF;

    -- Agregar ítem
    INSERT INTO pedido_items (
      pedido_id, producto_id, cantidad, precio_unitario, empresa_id
    ) VALUES (
      v_pedido_id, v_ciclo.producto_id,
      COALESCE(v_ciclo.cantidad_habitual, 1),
      COALESCE(v_ciclo.precio_unitario, 0),
      p_empresa_id
    );
  END LOOP;

  IF v_pedido_id IS NOT NULL THEN
    RETURN QUERY SELECT v_pedido_id;
  END IF;
  -- Si no hay ciclos activos, retorna vacío → ciclos.js lo maneja con 409
END;
$$;

COMMENT ON FUNCTION public.generar_pedido_sugerido_cliente(uuid, uuid) IS
'FIX 092: Creada RPC faltante. Era llamada por lib/handlers/ciclos.js línea ~139 pero
nunca existió en la DB → el botón "Enviar por WhatsApp" solo funcionaba si había
un sugerido pre-generado por el cron nocturno. Ahora genera el sugerido a demanda
basándose en ciclos_compra activos con proximo_vencimiento en los próximos 3 días.
Si no hay ciclos → retorna vacío → ciclos.js responde 409 con mensaje claro al usuario.';


COMMIT;

-- ============================================================
-- Validación post-migración (ejecutar manualmente para verificar)
-- ============================================================

-- 1. Verificar que la función fue reemplazada
-- SELECT proname, prosrc LIKE '%factura_id%' AS usa_factura_id
-- FROM pg_proc WHERE proname = 'calcular_score_cliente';
-- Resultado esperado: usa_factura_id = true

-- 2. Probar score con un cliente real
-- SELECT calcular_score_cliente(
--   (SELECT id FROM clientes LIMIT 1),
--   (SELECT empresa_id FROM clientes LIMIT 1)
-- );
-- Resultado esperado: un número entre 0 y 100

-- 3. Verificar que la RPC nueva existe
-- SELECT proname FROM pg_proc WHERE proname = 'generar_pedido_sugerido_cliente';
-- Resultado esperado: 1 fila
