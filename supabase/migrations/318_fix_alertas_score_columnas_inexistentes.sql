-- ═══════════════════════════════════════════════════════════════════════════
-- 318_fix_alertas_score_columnas_inexistentes.sql
--
-- BUG CRÍTICO encontrado al diagnosticar "estados críticos no se ven en el
-- dashboard": la versión VIVA de calcular_score_cliente() (definida en
-- 092_fix_bugs_criticos.sql, la última CREATE OR REPLACE aplicada — 064 y
-- 073 quedaron pisadas) tiene DOS inserts a columnas que no existen:
--
--   1. INSERT INTO scores_cliente (..., score_categoria, motivo)
--      → scores_cliente NUNCA tuvo columna `score_categoria`, y la columna
--        de motivo se llama `motivo_cambio`, no `motivo`.
--   2. INSERT INTO alertas_score (cliente_id, empresa_id, score, categoria, motivo, resuelta)
--      → alertas_score tampoco tiene `score`, `categoria` ni `motivo`. Su
--        esquema real es: score_anterior, score_nuevo, mensaje.
--
-- Confirmado en vivo contra jgiquzjwoedmzwqgzubr: ejecutar
-- calcular_score_cliente() hoy tira "ERROR 42703: column score_categoria of
-- relation scores_cliente does not exist" — el PRIMER insert de los dos ya
-- revienta. Como ambos inserts están dentro de la misma función plpgsql sin
-- manejo de excepción, esto significa que calcular_score_cliente() viene
-- fallando en el 100% de sus llamadas desde que se aplicó 092 (2026-06-24),
-- para TODOS los clientes, no solo los críticos: ningún score se guardó,
-- ninguna clientes.score_categoria se actualizó, y por lo tanto ninguna
-- alerta de score ni ningún estado crítico pudo llegar a verse en ningún
-- lado — panel de automatización, widget de "Alertas de Nivel de Confianza"
-- ni dashboard. Esto también explica por qué ~1580 clientes quedaron
-- congelados en categorías legacy A/B/C/D: el cron de recálculo que
-- supuestamente los iba reprocesando estaba fallando silenciosamente en
-- cada corrida.
--
-- 064 y 073 (versiones previas, correctas) confirman el esquema real:
--   INSERT INTO scores_cliente (cliente_id, empresa_id, score,
--     score_pagos, score_frecuencia, score_deuda, score_devolucion, motivo_cambio)
--
-- FIX:
--   1. INSERT a scores_cliente corregido: se saca `score_categoria` (no
--      existe ahí — la categoría vive en clientes.score_categoria, que sí
--      se actualiza dos líneas después) y se renombra motivo → motivo_cambio.
--   2. INSERT a alertas_score corregido a las columnas reales
--      (score_anterior, score_nuevo, mensaje), recuperando el patrón que ya
--      usaban 064 y 073.
--   3. Se combina el criterio de 092 (categoría crítica ahora) CON el
--      criterio original de 073 (caída de 15+ puntos), para cubrir todos
--      los casos: un cliente que cae en riesgo/bloqueado genera alerta
--      aunque no haya caído 15 puntos de una vez (ej. arranca nuevo y su
--      primer cálculo ya da 'riesgo'), y uno que cae fuerte genera alerta
--      aunque no llegue a cruzar a riesgo/bloqueado todavía.
--   4. Guarda contra spam: no inserta una alerta nueva si ya existe una sin
--      resolver para ese cliente.
--   5. El resto de la función (componente Pagos con el join corregido,
--      Frecuencia, Deuda, Devoluciones, determinación de categoría) se deja
--      igual que 092 — ese cálculo era correcto, el bug estaba solo en los
--      dos INSERT finales.
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
  -- FIX 092 (preservado): cta_cte NO tiene columna pedido_id. El join
  -- correcto es via factura_id.
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

  -- Insertar nuevo score
  -- FIX 318: scores_cliente no tiene columna score_categoria (la categoría
  -- vive solo en clientes.score_categoria, actualizada abajo) y la columna
  -- de motivo se llama motivo_cambio, no motivo.
  INSERT INTO scores_cliente (
    cliente_id, empresa_id, score, score_pagos, score_frecuencia,
    score_deuda, score_devolucion, motivo_cambio
  ) VALUES (
    p_cliente_id, p_empresa_id, v_total, v_pagos, v_frecuencia,
    v_deuda, v_devol, p_motivo
  );

  -- Actualizar categoría en clientes
  -- FIX 318: 092 dejó de actualizar score_actual/score_actualizado (solo
  -- tocaba score_categoria). Nada más en el sistema escribe esas dos
  -- columnas, así que quedaban congeladas desde 2026-06-24 — rompiendo el
  -- número mostrado en clientes.js y en el promedio/"peores clientes" de
  -- automatizacion.js (Motor 5), que leen score_actual, no scores_cliente.
  -- OJO: no se tocan bloqueado/bloqueado_motivo/dias_credito a propósito:
  -- eso lo gestiona un subsistema aparte (cierre.js / pagos.js, deuda
  -- vencida), no calcular_score_cliente — mezclarlos de nuevo acá
  -- reintroduciría el doble-bloqueo que ya se había separado.
  UPDATE clientes
  SET score_categoria   = v_categoria,
      score_actual      = v_total,
      score_actualizado = now()
  WHERE id = p_cliente_id AND empresa_id = p_empresa_id;

  -- ── FIX 318: disparo de alerta a columnas REALES de alertas_score ────────
  -- Cubre los dos casos posibles: (a) la categoría es crítica ahora mismo,
  -- (b) el score cayó 15+ puntos aunque todavía no cruce a riesgo/bloqueado.
  -- Evita duplicar alertas sin resolver para el mismo cliente.
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
'FIX 318: corregido INSERT INTO alertas_score que usaba columnas inexistentes
(score, categoria, motivo — nunca existieron en la tabla) heredado de 092, lo
que abortaba toda la función (incluyendo el guardado del score y la
actualización de score_categoria) cada vez que un cliente caía en riesgo o
bloqueado. Ahora inserta en las columnas reales (score_anterior, score_nuevo,
mensaje) y combina el criterio de categoría crítica con el de caída de 15+
puntos, sin duplicar alertas sin resolver del mismo cliente.';

-- Verificación informativa: cuántos clientes están HOY en riesgo/bloqueado
-- y cuántas alertas sin resolver hay ya en la tabla (antes de este fix, la
-- segunda columna debería ser 0 o casi 0 para empresas con clientes en
-- riesgo, precisamente por el bug).
SELECT
  (SELECT count(*) FROM public.clientes WHERE score_categoria IN ('riesgo','bloqueado')) AS clientes_criticos_hoy,
  (SELECT count(*) FROM public.alertas_score WHERE resuelta = false) AS alertas_score_sin_resolver;
