-- ═══════════════════════════════════════════════════════════════════
-- 132_rls_rpc_hardening.sql
-- Guard cross-tenant en RPCs SECURITY DEFINER que recibían p_empresa_id
-- sin verificar que pertenece al usuario autenticado.
-- Agrega assert_empresa_access() como helper reutilizable.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.assert_empresa_access(p_empresa_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN; END IF;
  IF p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'Acceso denegado: empresa no autorizada'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMENT ON FUNCTION public.assert_empresa_access IS
  'Guard cross-tenant. Lanza excepción si el usuario no pertenece a p_empresa_id. No-op para service_role.';

CREATE OR REPLACE FUNCTION public.registrar_cobro(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_monto       NUMERIC,
  p_medio       TEXT,
  p_referencia  TEXT DEFAULT NULL,
  p_notas       TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cobro_id UUID;
  v_nro      TEXT;
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  SELECT 'COB-' || LPAD(COALESCE(MAX(CAST(regexp_replace(nro_comprobante,'[^0-9]','','g') AS INT)),0)::TEXT,'6','0')
  INTO   v_nro
  FROM   cobros
  WHERE  empresa_id = p_empresa_id;

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio, referencia, notas)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas)
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte (empresa_id, cliente_id, tipo, importe, nro_comprobante, descripcion)
  VALUES (p_empresa_id, p_cliente_id, 'credito', p_monto, v_nro,
          'Cobro registrado — ' || p_medio);

  RETURN json_build_object('ok', true, 'cobro_id', v_cobro_id);
END $$;

CREATE OR REPLACE FUNCTION public.registrar_movimiento_cta_cte(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_tipo        TEXT,
  p_importe     NUMERIC,
  p_descripcion TEXT DEFAULT NULL,
  p_fecha       TIMESTAMPTZ DEFAULT now()
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cta_id UUID;
  v_nro    TEXT;
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  SELECT 'MOV-' || LPAD(COALESCE(MAX(CAST(regexp_replace(nro_comprobante,'[^0-9]','','g') AS INT)),0)::TEXT,'6','0')
  INTO   v_nro
  FROM   cta_cte
  WHERE  empresa_id = p_empresa_id;

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, importe, nro_comprobante, descripcion, fecha)
  VALUES
    (p_empresa_id, p_cliente_id, p_tipo, p_importe, v_nro,
     COALESCE(p_descripcion, 'Nota de ' || replace(p_tipo, '_', ' ')), p_fecha)
  RETURNING id INTO v_cta_id;

  RETURN json_build_object('ok', true, 'cta_id', v_cta_id);
END $$;

CREATE OR REPLACE FUNCTION public.crear_orden_compra(
  p_empresa_id     UUID,
  p_proveedor_id   UUID,
  p_fecha_esperada DATE,
  p_notas          TEXT,
  p_created_by     UUID,
  p_items          JSONB
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_numero TEXT;
  v_oc_id  UUID;
  v_item   JSONB;
  v_sub    NUMERIC := 0;
  v_iva    NUMERIC := 0;
  v_it_sub NUMERIC;
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  v_numero := siguiente_numero_comprobante(p_empresa_id, 'OC');

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_it_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_costo')::NUMERIC;
    v_sub    := v_sub + v_it_sub;
    v_iva    := v_iva + v_it_sub * COALESCE((v_item->>'iva_pct')::NUMERIC, 21) / 100;
  END LOOP;

  INSERT INTO ordenes_compra (
    empresa_id, proveedor_id, fecha_esperada, notas, created_by,
    numero, subtotal, iva_total, total
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_fecha_esperada, p_notas, p_created_by,
    v_numero, v_sub, v_iva, v_sub + v_iva
  ) RETURNING id INTO v_oc_id;

  INSERT INTO ordenes_compra_items (orden_id, producto_id, cantidad, precio_costo, iva_pct)
  SELECT v_oc_id,
         (v_item->>'producto_id')::UUID,
         (v_item->>'cantidad')::NUMERIC,
         (v_item->>'precio_costo')::NUMERIC,
         COALESCE((v_item->>'iva_pct')::NUMERIC, 21)
  FROM jsonb_array_elements(p_items) AS v_item;

  RETURN jsonb_build_object('ok', true, 'orden_id', v_oc_id, 'numero', v_numero);
END $$;

CREATE OR REPLACE FUNCTION public.obtener_kpis_dashboard(
  p_empresa_id     UUID,
  p_desde          TIMESTAMPTZ,
  p_hasta          TIMESTAMPTZ,
  p_desde_anterior TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  RETURN jsonb_build_object(
    'ventas_actual', COALESCE((
      SELECT SUM(total) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0),
    'ventas_anterior', COALESCE((
      SELECT SUM(total) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde_anterior AND created_at < p_desde
    ), 0),
    'pedidos_actual', COALESCE((
      SELECT COUNT(*) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0),
    'clientes_activos', COALESCE((
      SELECT COUNT(DISTINCT cliente_id) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0),
    'cobros_actual', COALESCE((
      SELECT SUM(monto) FROM cobros
      WHERE empresa_id = p_empresa_id
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0)
  );
END $$;

CREATE OR REPLACE FUNCTION public.generar_pedidos_sugeridos(p_empresa_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ciclo  RECORD;
  v_count  INT := 0;
  v_pedido UUID;
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  PERFORM calcular_ciclos_cliente(p_empresa_id);

  FOR v_ciclo IN
    SELECT cc.*, c.vendedor_id
    FROM ciclos_compra cc
    JOIN clientes c ON c.id = cc.cliente_id
    WHERE cc.empresa_id = p_empresa_id
      AND cc.activo = true
      AND cc.proximo_pedido <= CURRENT_DATE + INTERVAL '3 days'
  LOOP
    SELECT id INTO v_pedido
    FROM pedidos
    WHERE empresa_id = p_empresa_id
      AND cliente_id = v_ciclo.cliente_id
      AND estado = 'sugerido'
      AND generado_automatico = true
      AND fecha_pedido >= now() - INTERVAL '36 hours'
    LIMIT 1;

    IF NOT FOUND THEN
      PERFORM public.generar_pedido_sugerido_cliente(p_empresa_id, v_ciclo.cliente_id);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.registrar_notif_sugerencia(
  p_empresa_id UUID,
  p_cliente_id UUID,
  p_pedido_id  UUID,
  p_telefono   TEXT,
  p_message_id TEXT,
  p_payload    JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  INSERT INTO notif_log (
    empresa_id, cliente_id, pedido_id,
    tipo, canal, telefono, message_id, payload
  ) VALUES (
    p_empresa_id, p_cliente_id, p_pedido_id,
    'piloto_sugerencia', 'whatsapp',
    p_telefono, p_message_id, p_payload
  );
END $$;

-- importar_productos_lote: guard inyectado dinámicamente en producción
-- (el cuerpo completo original se preserva; solo se agrega el PERFORM al inicio)
DO $$
DECLARE
  v_src  TEXT;
  v_args TEXT;
  v_ret  TEXT;
BEGIN
  SELECT prosrc,
         pg_get_function_arguments(oid),
         pg_get_function_result(oid)
  INTO v_src, v_args, v_ret
  FROM pg_proc
  WHERE proname = 'importar_productos_lote'
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

  IF v_src IS NULL OR v_src LIKE '%assert_empresa_access%' THEN RETURN; END IF;

  v_src := regexp_replace(
    v_src,
    '(BEGIN\s*\n)',
    E'\\1  PERFORM public.assert_empresa_access(p_empresa_id);\n',
    'i'
  );

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.importar_productos_lote(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER AS $fn$%s$fn$',
    v_args, v_ret, v_src
  );
END $$;
