-- ============================================================
-- 054_recepcion_mercaderia.sql
-- Etapa 8.2: OCR de remitos y facturas de proveedor
--
-- Crea:
--   1. recepciones_mercaderia  — registro de cada recepción con foto y datos OCR
--   2. conciliar_recepcion()   — RPC que cruza OCR vs. OC y devuelve discrepancias
--   3. recepcionar_orden_compra() — RPC transaccional que aplica stock (ya referenciada
--      en proveedores.js pero ausente de la DB)
-- ============================================================

-- ── 1. Tabla de recepciones ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recepciones_mercaderia (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES public.empresas(id)    ON DELETE CASCADE,
  orden_id        uuid             REFERENCES public.ordenes_compra(id) ON DELETE SET NULL,
  proveedor_id    uuid             REFERENCES public.proveedores(id)    ON DELETE SET NULL,
  usuario_id      uuid             REFERENCES public.usuarios(id)       ON DELETE SET NULL,
  foto_url        text,                        -- URL en Supabase Storage (opcional)
  datos_ocr       jsonb,                       -- salida cruda de Claude Vision
  items_conciliados jsonb,                     -- resultado de conciliar_recepcion()
  discrepancias   jsonb,                       -- items con diferencia > umbral
  estado          text NOT NULL DEFAULT 'borrador'
                    CHECK (estado IN ('borrador','confirmada','descartada')),
  notas           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmada_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_recepciones_empresa   ON public.recepciones_mercaderia (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recepciones_orden     ON public.recepciones_mercaderia (orden_id);

-- RLS: solo usuarios de la misma empresa
ALTER TABLE public.recepciones_mercaderia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recepciones_select ON public.recepciones_mercaderia;
CREATE POLICY recepciones_select ON public.recepciones_mercaderia
  FOR SELECT USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS recepciones_insert ON public.recepciones_mercaderia;
CREATE POLICY recepciones_insert ON public.recepciones_mercaderia
  FOR INSERT WITH CHECK (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios
      WHERE id = auth.uid() AND rol IN ('dueno','admin','depositero')
    )
  );

DROP POLICY IF EXISTS recepciones_update ON public.recepciones_mercaderia;
CREATE POLICY recepciones_update ON public.recepciones_mercaderia
  FOR UPDATE USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios
      WHERE id = auth.uid() AND rol IN ('dueno','admin','depositero')
    )
  );

-- ── 2. RPC: conciliar_recepcion ──────────────────────────────────────────────
-- Cruza los datos OCR del remito contra los items de la OC.
-- Devuelve un JSON con cada item: cantidad pedida, cantidad OCR, diferencia y si
-- supera el umbral de alerta (10% por defecto o configurable).
--
-- Parámetros:
--   p_orden_id   uuid     — OC a contrastar
--   p_datos_ocr  jsonb    — array [{codigo, nombre, cantidad, precio_unitario}]
--   p_umbral_pct numeric  — porcentaje de diferencia que dispara alerta (default 10)
--
-- Retorna: json con {items, discrepancias, resumen}

CREATE OR REPLACE FUNCTION public.conciliar_recepcion(
  p_orden_id   uuid,
  p_datos_ocr  jsonb,
  p_umbral_pct numeric DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_items       jsonb := '[]'::jsonb;
  v_disc        jsonb := '[]'::jsonb;
  v_oc_item     record;
  v_ocr_match   jsonb;
  v_cant_ocr    numeric;
  v_precio_ocr  numeric;
  v_diff_cant   numeric;
  v_diff_precio numeric;
  v_alerta      boolean;
BEGIN
  -- Iterar cada item de la OC
  FOR v_oc_item IN
    SELECT
      oci.id,
      oci.producto_id,
      oci.descripcion,
      oci.cantidad       AS cant_pedida,
      oci.precio_unitario AS precio_pedido,
      p.nombre           AS producto_nombre,
      p.codigo           AS producto_codigo
    FROM public.ordenes_compra_items oci
    LEFT JOIN public.productos p ON p.id = oci.producto_id
    WHERE oci.orden_id = p_orden_id
  LOOP
    -- Buscar match en los datos OCR por código o nombre (case-insensitive)
    SELECT elem INTO v_ocr_match
    FROM jsonb_array_elements(p_datos_ocr) AS elem
    WHERE
      (
        elem->>'codigo' IS NOT NULL AND
        LOWER(elem->>'codigo') = LOWER(v_oc_item.producto_codigo)
      )
      OR
      similarity(LOWER(elem->>'nombre'), LOWER(v_oc_item.producto_nombre)) > 0.5
    ORDER BY
      similarity(LOWER(elem->>'nombre'), LOWER(v_oc_item.producto_nombre)) DESC
    LIMIT 1;

    v_cant_ocr    := COALESCE((v_ocr_match->>'cantidad')::numeric,    NULL);
    v_precio_ocr  := COALESCE((v_ocr_match->>'precio_unitario')::numeric, NULL);

    -- Calcular diferencias porcentuales
    v_diff_cant := CASE
      WHEN v_cant_ocr IS NULL OR v_oc_item.cant_pedida = 0 THEN NULL
      ELSE ABS(v_cant_ocr - v_oc_item.cant_pedida) / v_oc_item.cant_pedida * 100
    END;

    v_diff_precio := CASE
      WHEN v_precio_ocr IS NULL OR v_oc_item.precio_pedido = 0 THEN NULL
      ELSE ABS(v_precio_ocr - v_oc_item.precio_pedido) / v_oc_item.precio_pedido * 100
    END;

    v_alerta := (
      v_cant_ocr IS NULL OR
      COALESCE(v_diff_cant,   0) > p_umbral_pct OR
      COALESCE(v_diff_precio, 0) > p_umbral_pct
    );

    -- Construir objeto del item
    v_items := v_items || jsonb_build_object(
      'oc_item_id',      v_oc_item.id,
      'producto_id',     v_oc_item.producto_id,
      'nombre',          v_oc_item.producto_nombre,
      'codigo',          v_oc_item.producto_codigo,
      'cant_pedida',     v_oc_item.cant_pedida,
      'precio_pedido',   v_oc_item.precio_pedido,
      'cant_ocr',        v_cant_ocr,
      'precio_ocr',      v_precio_ocr,
      'diff_cant_pct',   ROUND(COALESCE(v_diff_cant,   0)::numeric, 1),
      'diff_precio_pct', ROUND(COALESCE(v_diff_precio, 0)::numeric, 1),
      'alerta',          v_alerta,
      -- Valor sugerido a recepcionar: OCR si existe, sino pedido
      'cant_sugerida',   COALESCE(v_cant_ocr, v_oc_item.cant_pedida),
      'precio_sugerido', COALESCE(v_precio_ocr, v_oc_item.precio_pedido)
    );

    -- Acumular discrepancias
    IF v_alerta THEN
      v_disc := v_disc || jsonb_build_array(jsonb_build_object(
        'nombre',          v_oc_item.producto_nombre,
        'cant_pedida',     v_oc_item.cant_pedida,
        'cant_ocr',        v_cant_ocr,
        'precio_pedido',   v_oc_item.precio_pedido,
        'precio_ocr',      v_precio_ocr,
        'diff_cant_pct',   ROUND(COALESCE(v_diff_cant,   0)::numeric, 1),
        'diff_precio_pct', ROUND(COALESCE(v_diff_precio, 0)::numeric, 1)
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',           true,
    'items',        v_items,
    'discrepancias', v_disc,
    'resumen', jsonb_build_object(
      'total_items',       jsonb_array_length(v_items),
      'items_con_alerta',  jsonb_array_length(v_disc),
      'umbral_pct',        p_umbral_pct
    )
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Habilitar pg_trgm para el similarity() si no está activo
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 3. RPC: recepcionar_orden_compra ─────────────────────────────────────────
-- Registra la recepción, actualiza stock y marca la OC como recibida.
-- Reutiliza la misma firma que ya espera proveedores.js.
--
-- items: [{producto_id, cantidad_recibida, precio_costo}]

CREATE OR REPLACE FUNCTION public.recepcionar_orden_compra(
  p_empresa_id  uuid,
  p_orden_id    uuid,
  p_items       jsonb,
  p_usuario_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item          jsonb;
  v_prod_id       uuid;
  v_cant          numeric;
  v_costo         numeric;
  v_items_proc    int := 0;
  v_total_recib   numeric := 0;
BEGIN
  -- Validar que la OC pertenece a la empresa
  IF NOT EXISTS (
    SELECT 1 FROM public.ordenes_compra
    WHERE id = p_orden_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Orden no encontrada');
  END IF;

  -- Procesar cada item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod_id := (v_item->>'producto_id')::uuid;
    v_cant    := COALESCE((v_item->>'cantidad_recibida')::numeric, 0);
    v_costo   := COALESCE((v_item->>'precio_costo')::numeric, 0);

    IF v_cant <= 0 THEN CONTINUE; END IF;

    -- Actualizar stock: incrementar stock_actual en todos los depósitos de la empresa
    -- Si el producto tiene stock por depósito, sumar al depósito principal
    UPDATE public.productos
    SET
      stock_actual = COALESCE(stock_actual, 0) + v_cant,
      costo        = CASE WHEN v_costo > 0 THEN v_costo ELSE costo END,
      updated_at   = now()
    WHERE id = v_prod_id AND empresa_id = p_empresa_id;

    -- Registrar movimiento de stock
    INSERT INTO public.movimientos_stock (
      empresa_id, producto_id, tipo, cantidad,
      referencia_tipo, referencia_id, usuario_id, notas, created_at
    ) VALUES (
      p_empresa_id, v_prod_id, 'ingreso', v_cant,
      'orden_compra', p_orden_id, p_usuario_id,
      'Recepción OC ' || p_orden_id::text, now()
    ) ON CONFLICT DO NOTHING;

    -- Actualizar cantidad recibida en ordenes_compra_items
    UPDATE public.ordenes_compra_items
    SET cantidad = v_cant
    WHERE orden_id = p_orden_id AND producto_id = v_prod_id;

    v_total_recib := v_total_recib + (v_cant * v_costo);
    v_items_proc  := v_items_proc + 1;
  END LOOP;

  -- Marcar OC como recibida
  UPDATE public.ordenes_compra
  SET
    estado          = 'recibida',
    fecha_recepcion = now(),
    total           = CASE WHEN v_total_recib > 0 THEN v_total_recib ELSE total END
  WHERE id = p_orden_id AND empresa_id = p_empresa_id;

  RETURN jsonb_build_object(
    'ok',              true,
    'items_procesados', v_items_proc,
    'total_recibido',  v_total_recib
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION public.conciliar_recepcion(uuid, jsonb, numeric)
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.recepcionar_orden_compra(uuid, uuid, jsonb, uuid)
  TO authenticated, service_role;
