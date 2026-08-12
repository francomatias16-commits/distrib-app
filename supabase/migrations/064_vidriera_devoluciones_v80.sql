-- ============================================================================
-- 064_vidriera_devoluciones_v80.sql
--
-- Innovaciones #1 (Vidriera de Liquidación) y #2 (Devoluciones + Score
-- automático de proveedor), según roadmap-innovaciones-distrib.md.
--
-- Contenido:
--   1. Fix bug productos.proveedor_id_default (faltaba la columna; el cron
--      diario de analizar_stock_autonomo() la referencia desde siempre).
--   2. Tabla notas_debito_proveedor (ajuste interno de cta-cte proveedor,
--      no es documento fiscal AFIP).
--   3. v_cc_proveedor actualizada para descontar notas de débito del saldo.
--   4. calcular_score_cliente() corregida: el componente de devoluciones
--      leía de entregas.estado = 'devolucion', columna que nunca se escribe.
--      Ahora lee de devoluciones/devolucion_items (las tablas reales).
--   5. CHECK constraints en devoluciones.motivo / estado (tablas vacías,
--      se puede agregar sin riesgo de romper datos existentes).
--   6. Storage bucket 'devoluciones' (mismo patrón que 'remitos').
-- ============================================================================

-- ── 1. Fix bug: stock-auto.js / analizar_stock_autonomo() referencian esta
--    columna desde siempre, pero nunca existió ──────────────────────────────
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS proveedor_id_default uuid
    REFERENCES public.proveedores(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.productos.proveedor_id_default IS
  'Proveedor por defecto del producto. Usado por analizar_stock_autonomo() '
  'para agrupar OCs automáticas, y por el flujo de devoluciones para saber '
  'a quién facturarle una nota de débito por producto defectuoso.';

-- ── 2. Tabla notas_debito_proveedor ─────────────────────────────────────────
-- Ajuste interno de cuenta corriente con el proveedor (no es nota de débito
-- fiscal AFIP — esa la emite el proveedor hacia nosotros, no al revés).
CREATE TABLE IF NOT EXISTS public.notas_debito_proveedor (
    id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    empresa_id      uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    proveedor_id    uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE CASCADE,
    factura_id      uuid REFERENCES public.facturas_proveedor(id) ON DELETE SET NULL,
    devolucion_id   uuid REFERENCES public.devoluciones(id) ON DELETE SET NULL,
    motivo          text NOT NULL,
    monto           numeric(14,2) NOT NULL DEFAULT 0,
    estado          text NOT NULL DEFAULT 'pendiente',
    notas           text,
    created_by      uuid,
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    updated_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notas_debito_proveedor_estado_check
      CHECK (estado = ANY (ARRAY['pendiente'::text, 'aplicada'::text, 'anulada'::text])),
    CONSTRAINT notas_debito_proveedor_monto_check CHECK (monto >= 0)
);

CREATE INDEX IF NOT EXISTS idx_notas_debito_prov_empresa
  ON public.notas_debito_proveedor (empresa_id);
CREATE INDEX IF NOT EXISTS idx_notas_debito_prov_proveedor
  ON public.notas_debito_proveedor (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_notas_debito_prov_devolucion
  ON public.notas_debito_proveedor (devolucion_id);

ALTER TABLE public.notas_debito_proveedor ENABLE ROW LEVEL SECURITY;

-- Mismo patrón que facturas_proveedor (fp_select / fp_insert / fp_update)
CREATE POLICY ndp_select ON public.notas_debito_proveedor FOR SELECT USING (
  (empresa_id IN (SELECT usuarios.empresa_id FROM public.usuarios
                    WHERE (usuarios.id = auth.uid())))
);

CREATE POLICY ndp_insert ON public.notas_debito_proveedor FOR INSERT WITH CHECK (
  (empresa_id IN (SELECT usuarios.empresa_id FROM public.usuarios
                    WHERE ((usuarios.id = auth.uid())
                       AND (usuarios.rol = ANY (ARRAY[
                            'dueno'::public.rol_usuario,
                            'admin'::public.rol_usuario,
                            'contador'::public.rol_usuario,
                            'depositero'::public.rol_usuario])))))
);

CREATE POLICY ndp_update ON public.notas_debito_proveedor FOR UPDATE USING (
  (empresa_id IN (SELECT usuarios.empresa_id FROM public.usuarios
                    WHERE ((usuarios.id = auth.uid())
                       AND (usuarios.rol = ANY (ARRAY[
                            'dueno'::public.rol_usuario,
                            'admin'::public.rol_usuario,
                            'contador'::public.rol_usuario])))))
);

-- ── 3. v_cc_proveedor: descontar notas de débito del saldo pendiente ───────
CREATE OR REPLACE VIEW public.v_cc_proveedor AS
 SELECT p.empresa_id,
    p.id AS proveedor_id,
    p.razon_social,
    p.nombre_fantasia,
    p.email,
    p.telefono,
    count(DISTINCT oc.id) AS oc_recibidas,
    COALESCE(sum(DISTINCT oc.total) FILTER (WHERE (oc.estado = 'recibida'::text)), (0)::numeric) AS total_oc_recibidas,
    count(DISTINCT fp.id) AS facturas_count,
    COALESCE(sum(fp.total), (0)::numeric) AS total_facturado,
    COALESCE(sum(fp.total_pagado), (0)::numeric) AS total_pagado,
    COALESCE((sum(fp.total) - sum(fp.total_pagado)), (0)::numeric)
      - COALESCE(sum(ndp.monto) FILTER (WHERE ndp.estado <> 'anulada'), (0)::numeric) AS saldo_pendiente,
    count(fp.id) FILTER (WHERE ((fp.estado = ANY (ARRAY['pendiente'::text, 'parcial'::text])) AND (fp.fecha_vencimiento < CURRENT_DATE))) AS facturas_vencidas,
    COALESCE(sum(ndp.monto) FILTER (WHERE ndp.estado <> 'anulada'), (0)::numeric) AS total_notas_debito
   FROM ((public.proveedores p
     LEFT JOIN public.ordenes_compra oc ON ((oc.proveedor_id = p.id)))
     LEFT JOIN public.facturas_proveedor fp ON (((fp.proveedor_id = p.id) AND (fp.estado <> 'anulada'::text))))
     LEFT JOIN public.notas_debito_proveedor ndp ON (ndp.proveedor_id = p.id)
  GROUP BY p.empresa_id, p.id, p.razon_social, p.nombre_fantasia, p.email, p.telefono;

-- ── 4. Fix calcular_score_cliente(): componente devoluciones leía de
--    entregas.estado = 'devolucion' (nunca escrito). Ahora lee de la tabla
--    devoluciones/devolucion_items real. Resto de la función intacto. ──────
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

-- ── 5. CHECK constraints en devoluciones (tablas vacías -> seguro agregarlas) ─
ALTER TABLE public.devoluciones
  ADD CONSTRAINT devoluciones_motivo_check
  CHECK (motivo = ANY (ARRAY[
    'producto_defectuoso'::text, 'error_pedido'::text,
    'cliente_arrepentido'::text, 'vencido'::text, 'otro'::text
  ]));

ALTER TABLE public.devoluciones
  ADD CONSTRAINT devoluciones_estado_check
  CHECK (estado = ANY (ARRAY['pendiente'::text, 'aprobada'::text, 'rechazada'::text]));

-- ── 6. Storage bucket para fotos de devolución (mismo patrón que 'remitos') ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('devoluciones', 'devoluciones', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "devoluciones_public_read" ON storage.objects;
CREATE POLICY "devoluciones_public_read" ON storage.objects FOR SELECT
  USING (bucket_id = 'devoluciones');

DROP POLICY IF EXISTS "devoluciones_service_write" ON storage.objects;
CREATE POLICY "devoluciones_service_write" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'devoluciones' AND auth.role() = 'service_role');

DROP POLICY IF EXISTS "devoluciones_service_update" ON storage.objects;
CREATE POLICY "devoluciones_service_update" ON storage.objects FOR UPDATE
  USING (bucket_id = 'devoluciones' AND auth.role() = 'service_role');

DROP POLICY IF EXISTS "devoluciones_service_delete" ON storage.objects;
CREATE POLICY "devoluciones_service_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'devoluciones' AND auth.role() = 'service_role');
