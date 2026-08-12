-- ============================================================================
-- 073_fix_score_y_escritura_portal_proveedor.sql
--
-- Cierra 4 de los 5 puntos pendientes detectados en la auditoría del roadmap
-- (el 5to es de nomenclatura: esta migración pasa a ser la "073").
--
--  1) Fix de una línea en calcular_score_cliente(): el subselect
--     "SELECT pedido_id FROM cta_cte WHERE cobro_id = co.id" está roto
--     porque cta_cte NO tiene columna pedido_id (solo factura_id, cobro_id).
--     Se reemplaza por el join directo cta_cte.factura_id -> facturas.id,
--     igual que ya se corrigió en dias_pago_cliente (ver nota en 067).
--
--  2) (resuelto en código, no en SQL) manejo de error en score.js:144 —
--     ver lib/handlers/score.js.
--
--  3) Soporte de datos para costo_km configurable: la columna ya existe
--     como empresas.config->>'costo_km' desde 069, no requiere migración.
--     Lo que faltaba era la superficie de escritura (ver rutas-live.js +
--     rentabilidad-zona.html/js).
--
--  4) Habilitar escritura en el portal de proveedor (Innovación #10):
--     - ordenes_compra: columna confirmada_por_proveedor + fecha_confirmacion_at,
--       para distinguir "fecha estimada por el comprador" de "fecha
--       confirmada por el proveedor" (fecha_esperada se sigue usando como
--       el valor vigente, ahora editable por el proveedor vía portal).
--     - facturas_proveedor: columna archivo_url (link al PDF/imagen subido
--       por el proveedor) y origen ('admin' | 'proveedor'), para que el
--       panel admin pueda distinguir y revisar lo autocargado.
--     - bucket de storage 'facturas-proveedor' (mismo patrón que 'remitos'
--       en 055): público para lectura directa, solo service_role escribe.
-- ============================================================================

-- ── 1. Fix calcular_score_cliente(): join directo factura_id -> facturas.id ─
CREATE OR REPLACE FUNCTION public.calcular_score_cliente(p_cliente_id uuid, p_empresa_id uuid, p_motivo text DEFAULT 'recalculo'::text) RETURNS numeric
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
  -- FIX (073): el subselect anterior pedía cta_cte.pedido_id, columna que
  -- no existe (cta_cte solo tiene factura_id). Ahora joinea directo por
  -- cta_cte.factura_id -> facturas.id, igual que dias_pago_cliente.
  SELECT AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0) INTO v_dias_prom
  FROM cobros co
  JOIN facturas f ON f.id = (
    SELECT factura_id FROM cta_cte WHERE cobro_id = co.id LIMIT 1
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
  -- FIX (064): antes leía de entregas.estado='devolucion' (nunca escrito,
  -- siempre daba 0% -> 15pts máximos sin importar el comportamiento real).
  -- Ahora lee de devoluciones/devolucion_items, excluyendo las rechazadas
  -- (devolución rechazada por admin no cuenta contra el cliente).
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

-- ── 2. ordenes_compra: confirmación de fecha de entrega por el proveedor ────
ALTER TABLE public.ordenes_compra
  ADD COLUMN IF NOT EXISTS confirmada_por_proveedor boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecha_confirmacion_at timestamptz;

COMMENT ON COLUMN public.ordenes_compra.confirmada_por_proveedor IS
  'Innovación #10: true cuando fecha_esperada fue confirmada/ajustada por el '
  'proveedor desde su portal (antes solo era una estimación del comprador '
  'al crear la OC).';

-- ── 3. facturas_proveedor: factura cargada por el proveedor desde el portal ─
ALTER TABLE public.facturas_proveedor
  ADD COLUMN IF NOT EXISTS archivo_url text,
  ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'admin';

ALTER TABLE public.facturas_proveedor
  DROP CONSTRAINT IF EXISTS facturas_proveedor_origen_check;
ALTER TABLE public.facturas_proveedor
  ADD CONSTRAINT facturas_proveedor_origen_check
  CHECK (origen = ANY (ARRAY['admin'::text, 'proveedor'::text]));

COMMENT ON COLUMN public.facturas_proveedor.archivo_url IS
  'Innovación #10: link público al PDF/imagen de la factura, cuando fue '
  'subida por el proveedor desde su portal (bucket facturas-proveedor).';
COMMENT ON COLUMN public.facturas_proveedor.origen IS
  'Innovación #10: "proveedor" si la cargó el proveedor desde el portal '
  '(queda en estado pendiente para revisión del admin); "admin" si la '
  'cargó el equipo de la distribuidora (comportamiento histórico).';

-- ── 4. Bucket de storage para los archivos de factura subidos por proveedor ─
-- Mismo patrón que 'remitos' (055): público para lectura directa por URL,
-- solo service_role inserta (el backend autentica por token y sube).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'facturas-proveedor',
  'facturas-proveedor',
  true,
  10485760,  -- 10 MB máximo por archivo
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public            = EXCLUDED.public,
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS facturas_proveedor_insert_service ON storage.objects;
CREATE POLICY facturas_proveedor_insert_service ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'facturas-proveedor');

DROP POLICY IF EXISTS facturas_proveedor_update_service ON storage.objects;
CREATE POLICY facturas_proveedor_update_service ON storage.objects
  FOR UPDATE TO service_role
  USING (bucket_id = 'facturas-proveedor');

DROP POLICY IF EXISTS facturas_proveedor_select_public ON storage.objects;
CREATE POLICY facturas_proveedor_select_public ON storage.objects
  FOR SELECT USING (bucket_id = 'facturas-proveedor');

DROP POLICY IF EXISTS facturas_proveedor_delete_service ON storage.objects;
CREATE POLICY facturas_proveedor_delete_service ON storage.objects
  FOR DELETE TO service_role
  USING (bucket_id = 'facturas-proveedor');
