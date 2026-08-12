-- ============================================================
-- 056_cc_proveedores.sql
-- Etapa 8.5: Cuentas corrientes con proveedores
--
-- Crea:
--   1. facturas_proveedor        — factura emitida por el proveedor
--   2. facturas_proveedor_items  — ítems de la factura
--   3. pagos_proveedor           — pagos realizados contra una factura
--   4. v_cc_proveedor            — vista resumen de saldo por proveedor
--   5. conciliar_oc_factura()    — RPC: cruza OC recibida vs factura proveedor
--   6. registrar_pago_proveedor()— RPC: registra pago y actualiza estado factura
-- ============================================================

-- ── 1. Facturas de proveedor ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.facturas_proveedor (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor_id      uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE RESTRICT,
  orden_id          uuid             REFERENCES public.ordenes_compra(id) ON DELETE SET NULL,
  numero_factura    text NOT NULL,          -- "A 0001-00012345"
  tipo              text NOT NULL DEFAULT 'A'
                      CHECK (tipo IN ('A','B','C','M','X')),
  fecha_factura     date NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento date,
  subtotal          numeric(14,2) NOT NULL DEFAULT 0,
  iva_pct           numeric(5,2)  NOT NULL DEFAULT 21,
  iva_monto         numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  total_pagado      numeric(14,2) NOT NULL DEFAULT 0,
  estado            text NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente','parcial','pagada','anulada')),
  conciliacion      jsonb,   -- resultado de conciliar_oc_factura()
  discrepancias     jsonb,   -- items con diferencia > umbral
  notas             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fp_empresa       ON public.facturas_proveedor (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fp_proveedor     ON public.facturas_proveedor (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_fp_orden         ON public.facturas_proveedor (orden_id);
CREATE INDEX IF NOT EXISTS idx_fp_estado        ON public.facturas_proveedor (estado);

-- Trigger: updated_at
CREATE OR REPLACE FUNCTION public.fp_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_fp_updated_at ON public.facturas_proveedor;
CREATE TRIGGER trg_fp_updated_at
  BEFORE UPDATE ON public.facturas_proveedor
  FOR EACH ROW EXECUTE FUNCTION public.fp_touch_updated_at();

-- RLS
ALTER TABLE public.facturas_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fp_select ON public.facturas_proveedor;
CREATE POLICY fp_select ON public.facturas_proveedor FOR SELECT USING (
  empresa_id IN (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid())
);

DROP POLICY IF EXISTS fp_insert ON public.facturas_proveedor;
CREATE POLICY fp_insert ON public.facturas_proveedor FOR INSERT WITH CHECK (
  empresa_id IN (
    SELECT empresa_id FROM public.usuarios
    WHERE id = auth.uid() AND rol IN ('dueno','admin','contador','depositero')
  )
);

DROP POLICY IF EXISTS fp_update ON public.facturas_proveedor;
CREATE POLICY fp_update ON public.facturas_proveedor FOR UPDATE USING (
  empresa_id IN (
    SELECT empresa_id FROM public.usuarios
    WHERE id = auth.uid() AND rol IN ('dueno','admin','contador')
  )
);

-- ── 2. Ítems de la factura de proveedor ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.facturas_proveedor_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factura_id       uuid NOT NULL REFERENCES public.facturas_proveedor(id) ON DELETE CASCADE,
  producto_id      uuid             REFERENCES public.productos(id) ON DELETE SET NULL,
  descripcion      text NOT NULL,
  cantidad         numeric(14,3) NOT NULL DEFAULT 1,
  precio_unitario  numeric(14,2) NOT NULL DEFAULT 0,
  subtotal         numeric(14,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED
);

CREATE INDEX IF NOT EXISTS idx_fpi_factura ON public.facturas_proveedor_items (factura_id);

-- ── 3. Pagos a proveedores ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pagos_proveedor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor_id uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE RESTRICT,
  factura_id   uuid             REFERENCES public.facturas_proveedor(id) ON DELETE SET NULL,
  monto        numeric(14,2) NOT NULL CHECK (monto > 0),
  medio_pago   text NOT NULL DEFAULT 'transferencia'
                 CHECK (medio_pago IN ('efectivo','transferencia','cheque','otro')),
  fecha_pago   date NOT NULL DEFAULT CURRENT_DATE,
  referencia   text,   -- N° cheque, CBU destino, etc.
  notas        text,
  usuario_id   uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pp_empresa   ON public.pagos_proveedor (empresa_id, fecha_pago DESC);
CREATE INDEX IF NOT EXISTS idx_pp_proveedor ON public.pagos_proveedor (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_pp_factura   ON public.pagos_proveedor (factura_id);

ALTER TABLE public.pagos_proveedor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pp_select ON public.pagos_proveedor;
CREATE POLICY pp_select ON public.pagos_proveedor FOR SELECT USING (
  empresa_id IN (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid())
);

DROP POLICY IF EXISTS pp_insert ON public.pagos_proveedor;
CREATE POLICY pp_insert ON public.pagos_proveedor FOR INSERT WITH CHECK (
  empresa_id IN (
    SELECT empresa_id FROM public.usuarios
    WHERE id = auth.uid() AND rol IN ('dueno','admin','contador')
  )
);

-- ── 4. Vista: cuenta corriente por proveedor ─────────────────────────────────
-- Consolida: total OC recibidas, total facturado, total pagado, saldo
CREATE OR REPLACE VIEW public.v_cc_proveedor AS
SELECT
  p.empresa_id,
  p.id                              AS proveedor_id,
  p.razon_social,
  p.fantasia,
  p.email,
  p.telefono,
  -- OC recibidas
  COUNT(DISTINCT oc.id)             AS oc_recibidas,
  COALESCE(SUM(DISTINCT oc.total) FILTER (WHERE oc.estado = 'recibida'), 0) AS total_oc_recibidas,
  -- Facturas
  COUNT(DISTINCT fp.id)             AS facturas_count,
  COALESCE(SUM(fp.total), 0)        AS total_facturado,
  COALESCE(SUM(fp.total_pagado), 0) AS total_pagado,
  COALESCE(SUM(fp.total) - SUM(fp.total_pagado), 0) AS saldo_pendiente,
  -- Facturas vencidas
  COUNT(fp.id) FILTER (
    WHERE fp.estado IN ('pendiente','parcial')
    AND fp.fecha_vencimiento < CURRENT_DATE
  )                                 AS facturas_vencidas
FROM public.proveedores p
LEFT JOIN public.ordenes_compra     oc ON oc.proveedor_id = p.id
LEFT JOIN public.facturas_proveedor fp ON fp.proveedor_id = p.id AND fp.estado != 'anulada'
GROUP BY p.empresa_id, p.id, p.razon_social, p.fantasia, p.email, p.telefono;

GRANT SELECT ON public.v_cc_proveedor TO authenticated, service_role;

-- ── 5. RPC: conciliar_oc_factura ─────────────────────────────────────────────
-- Cruza los ítems de la OC recibida contra los ítems de la factura del proveedor.
-- Retorna discrepancias de cantidad y precio para que el usuario pueda aprobar o rechazar.
--
-- Parámetros:
--   p_orden_id   uuid     — OC ya recibida
--   p_factura_id uuid     — factura a comparar
--   p_umbral_pct numeric  — % de diferencia que dispara alerta (default 5)
--
-- Retorna jsonb: { ok, items, discrepancias, resumen }

CREATE OR REPLACE FUNCTION public.conciliar_oc_factura(
  p_orden_id   uuid,
  p_factura_id uuid,
  p_umbral_pct numeric DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_items    jsonb := '[]'::jsonb;
  v_disc     jsonb := '[]'::jsonb;
  v_oc_item  record;
  v_fac_item jsonb;
  v_cant_fac   numeric;
  v_precio_fac numeric;
  v_diff_cant  numeric;
  v_diff_prec  numeric;
  v_alerta     boolean;
BEGIN
  -- Iterar cada ítem de la OC
  FOR v_oc_item IN
    SELECT
      oci.id,
      oci.producto_id,
      oci.descripcion,
      oci.cantidad        AS cant_oc,
      oci.precio_unitario AS precio_oc,
      p.nombre            AS producto_nombre,
      p.codigo            AS producto_codigo
    FROM public.ordenes_compra_items oci
    LEFT JOIN public.productos p ON p.id = oci.producto_id
    WHERE oci.orden_id = p_orden_id
  LOOP
    -- Buscar ítem equivalente en la factura (por producto_id o similaridad de descripción)
    SELECT elem INTO v_fac_item
    FROM jsonb_array_elements(
      (SELECT jsonb_agg(
          jsonb_build_object(
            'producto_id',     fpi.producto_id,
            'descripcion',     fpi.descripcion,
            'cantidad',        fpi.cantidad,
            'precio_unitario', fpi.precio_unitario
          )
        )
        FROM public.facturas_proveedor_items fpi
        WHERE fpi.factura_id = p_factura_id
      )
    ) AS elem
    WHERE
      (v_oc_item.producto_id IS NOT NULL AND (elem->>'producto_id')::uuid = v_oc_item.producto_id)
      OR
      (similarity(LOWER(elem->>'descripcion'), LOWER(COALESCE(v_oc_item.producto_nombre, v_oc_item.descripcion))) > 0.4)
    ORDER BY
      CASE WHEN (elem->>'producto_id')::uuid = v_oc_item.producto_id THEN 0 ELSE 1 END,
      similarity(LOWER(elem->>'descripcion'), LOWER(COALESCE(v_oc_item.producto_nombre, v_oc_item.descripcion))) DESC
    LIMIT 1;

    v_cant_fac   := COALESCE((v_fac_item->>'cantidad')::numeric, NULL);
    v_precio_fac := COALESCE((v_fac_item->>'precio_unitario')::numeric, NULL);

    v_diff_cant := CASE
      WHEN v_cant_fac IS NULL OR v_oc_item.cant_oc = 0 THEN NULL
      ELSE ABS(v_cant_fac - v_oc_item.cant_oc) / v_oc_item.cant_oc * 100
    END;

    v_diff_prec := CASE
      WHEN v_precio_fac IS NULL OR v_oc_item.precio_oc = 0 THEN NULL
      ELSE ABS(v_precio_fac - v_oc_item.precio_oc) / v_oc_item.precio_oc * 100
    END;

    v_alerta := (
      v_cant_fac IS NULL OR
      COALESCE(v_diff_cant, 0) > p_umbral_pct OR
      COALESCE(v_diff_prec, 0) > p_umbral_pct
    );

    v_items := v_items || jsonb_build_object(
      'oc_item_id',      v_oc_item.id,
      'producto_id',     v_oc_item.producto_id,
      'nombre',          v_oc_item.producto_nombre,
      'descripcion',     v_oc_item.descripcion,
      -- OC
      'cant_oc',         v_oc_item.cant_oc,
      'precio_oc',       v_oc_item.precio_oc,
      'subtotal_oc',     ROUND(v_oc_item.cant_oc * v_oc_item.precio_oc, 2),
      -- Factura
      'cant_fac',        v_cant_fac,
      'precio_fac',      v_precio_fac,
      'subtotal_fac',    CASE WHEN v_cant_fac IS NOT NULL AND v_precio_fac IS NOT NULL
                           THEN ROUND(v_cant_fac * v_precio_fac, 2) ELSE NULL END,
      -- Diferencias
      'diff_cant_pct',   ROUND(COALESCE(v_diff_cant, 0)::numeric, 1),
      'diff_precio_pct', ROUND(COALESCE(v_diff_prec, 0)::numeric, 1),
      'alerta',          v_alerta,
      'match',           (v_fac_item IS NOT NULL)
    );

    IF v_alerta THEN
      v_disc := v_disc || jsonb_build_array(jsonb_build_object(
        'nombre',          v_oc_item.producto_nombre,
        'cant_oc',         v_oc_item.cant_oc,
        'cant_fac',        v_cant_fac,
        'precio_oc',       v_oc_item.precio_oc,
        'precio_fac',      v_precio_fac,
        'diff_cant_pct',   ROUND(COALESCE(v_diff_cant, 0)::numeric, 1),
        'diff_precio_pct', ROUND(COALESCE(v_diff_prec, 0)::numeric, 1),
        'tipo',            CASE
          WHEN v_cant_fac IS NULL      THEN 'no_encontrado'
          WHEN COALESCE(v_diff_cant,0) > p_umbral_pct THEN 'cantidad'
          WHEN COALESCE(v_diff_prec,0) > p_umbral_pct THEN 'precio'
          ELSE 'ambos'
        END
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',            true,
    'items',         v_items,
    'discrepancias', v_disc,
    'resumen', jsonb_build_object(
      'total_items',      jsonb_array_length(v_items),
      'items_ok',         jsonb_array_length(v_items) - jsonb_array_length(v_disc),
      'items_con_alerta', jsonb_array_length(v_disc),
      'umbral_pct',       p_umbral_pct
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Necesita pg_trgm para similarity()
CREATE EXTENSION IF NOT EXISTS pg_trgm;

GRANT EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, numeric)
  TO authenticated, service_role;

-- ── 6. RPC: registrar_pago_proveedor ─────────────────────────────────────────
-- Inserta el pago, acumula total_pagado en la factura y actualiza su estado.

CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_empresa_id   uuid,
  p_proveedor_id uuid,
  p_factura_id   uuid,
  p_monto        numeric,
  p_medio        text     DEFAULT 'transferencia',
  p_fecha        date     DEFAULT CURRENT_DATE,
  p_referencia   text     DEFAULT NULL,
  p_notas        text     DEFAULT NULL,
  p_usuario_id   uuid     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_factura      record;
  v_nuevo_pagado numeric;
  v_nuevo_estado text;
BEGIN
  -- Leer factura y validar empresa
  SELECT * INTO v_factura
  FROM public.facturas_proveedor
  WHERE id = p_factura_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  IF v_factura.estado = 'anulada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura está anulada');
  END IF;

  IF v_factura.estado = 'pagada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura ya está pagada');
  END IF;

  -- Insertar pago
  INSERT INTO public.pagos_proveedor (
    empresa_id, proveedor_id, factura_id,
    monto, medio_pago, fecha_pago, referencia, notas, usuario_id
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_factura_id,
    p_monto, p_medio, p_fecha, p_referencia, p_notas, p_usuario_id
  );

  -- Actualizar total_pagado y estado
  v_nuevo_pagado := LEAST(v_factura.total_pagado + p_monto, v_factura.total);

  v_nuevo_estado := CASE
    WHEN v_nuevo_pagado >= v_factura.total THEN 'pagada'
    WHEN v_nuevo_pagado > 0               THEN 'parcial'
    ELSE 'pendiente'
  END;

  UPDATE public.facturas_proveedor
  SET total_pagado = v_nuevo_pagado,
      estado       = v_nuevo_estado,
      updated_at   = now()
  WHERE id = p_factura_id;

  RETURN jsonb_build_object(
    'ok',           true,
    'total_pagado', v_nuevo_pagado,
    'saldo',        v_factura.total - v_nuevo_pagado,
    'estado',       v_nuevo_estado
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(uuid,uuid,uuid,numeric,text,date,text,text,uuid)
  TO authenticated, service_role;

-- ── Índice de búsqueda de texto en número de factura ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_fp_numero ON public.facturas_proveedor
  USING gin (to_tsvector('spanish', numero_factura));
