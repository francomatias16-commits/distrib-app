-- ════════════════════════════════════════════════════════════════════
-- 20260828050000_547_stock_objetivo_ui_y_alertas_unificadas.sql
--
-- Diagnóstico (2026-08-28): "mínimo/máximo de stock" tenía tres problemas.
--
--   1. stock_objetivo (el "máximo"/techo del motor de reposición
--      autónoma, migración 035) no tenía ningún campo en el modal de
--      producto ni en fn_crear_producto — solo se podía tocar por SQL
--      directo. Quedaba en 0 para prácticamente todos los productos, lo
--      que hacía caer la fórmula al fallback velocidad_diaria × 30
--      (ver migración 460).
--   2. Umbral inconsistente: trigger_push_stock_critico (push) comparaba
--      cantidad >= stock_minimo a secas, mientras que los reportes/KPIs
--      (fn_reportes_stock_kpis, fn_reportes_stock_criticos_lista, desde
--      la migración 441/542) aplican GREATEST(stock_minimo, 5). Un
--      producto con stock_minimo sin cargar (0) podía figurar como
--      "crítico" en Reportes sin haber disparado nunca un push.
--   3. El piso de 5 es un valor fijo hardcodeado, no una sugerencia según
--      rotación real — queda documentado como mejora futura, fuera de
--      alcance de este fix.
--
-- Este fix resuelve 1 y 2:
--   a) fn_crear_producto acepta p_stock_objetivo (reutiliza la columna
--      existente, sin migración de esquema).
--   b) trigger_push_stock_critico ahora usa el mismo criterio
--      GREATEST(stock_minimo, 5) que ya usan los reportes, para que push
--      y dashboard alerten en el mismo punto.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) fn_crear_producto: suma p_stock_objetivo ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre          text,
  p_deposito_ids    uuid[],
  p_codigo          text DEFAULT NULL::text,
  p_categoria_id    uuid DEFAULT NULL::uuid,
  p_precio_base     numeric DEFAULT 0,
  p_costo           numeric DEFAULT 0,
  p_stock_minimo    numeric DEFAULT 0,
  p_activo          boolean DEFAULT true,
  p_foto_url        text DEFAULT NULL::text,
  p_destacado       boolean DEFAULT false,
  p_stock_objetivo  numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id  uuid := public.get_empresa_id();
  v_producto_id uuid;
  v_ids_validos uuid[];
BEGIN
  -- SECNEW-02 (2026-08-28): chequeo de rol (dueno/admin/depositero), se
  -- mantiene igual que en la versión anterior de esta función.
  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno', 'admin', 'depositero') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
    RAISE EXCEPTION 'El nombre del producto es obligatorio.';
  END IF;

  SELECT array_agg(d.id) INTO v_ids_validos
  FROM public.depositos d
  WHERE d.empresa_id = v_empresa_id
    AND d.id = ANY(p_deposito_ids);

  IF v_ids_validos IS NULL OR array_length(v_ids_validos, 1) IS NULL THEN
    RAISE EXCEPTION 'Debe seleccionar al menos un depósito válido para el producto nuevo.';
  END IF;

  INSERT INTO public.productos (
    empresa_id, codigo, nombre, categoria_id,
    precio_base, costo, stock_minimo, activo, foto_url, destacado,
    stock_objetivo
  ) VALUES (
    v_empresa_id, NULLIF(trim(p_codigo), ''), p_nombre, p_categoria_id,
    p_precio_base, p_costo, p_stock_minimo, p_activo, NULLIF(trim(p_foto_url), ''),
    COALESCE(p_destacado, false),
    COALESCE(p_stock_objetivo, 0)
  )
  RETURNING id INTO v_producto_id;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
  SELECT v_producto_id, d, 0, 0, COALESCE(p_costo, 0)
  FROM unnest(v_ids_validos) AS d
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN v_producto_id;
END;
$function$;

-- ── (b) trigger_push_stock_critico: mismo umbral que los reportes ─────
CREATE OR REPLACE FUNCTION public.trigger_push_stock_critico()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_secret   text;
  v_payload  jsonb;
  v_minimo   numeric;
  v_umbral   numeric;
  v_empresa  uuid;
BEGIN
  IF NEW.cantidad IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.cantidad IS NOT NULL AND OLD.cantidad <= NEW.cantidad THEN
    RETURN NEW;
  END IF;

  SELECT p.stock_minimo, p.empresa_id
  INTO v_minimo, v_empresa
  FROM public.productos p
  WHERE p.id = NEW.producto_id;

  IF v_empresa IS NULL THEN
    RETURN NEW;
  END IF;

  -- 547: mismo criterio que fn_reportes_stock_kpis / fn_reportes_stock_criticos_lista
  -- (GREATEST(stock_minimo, 5)) — antes acá se comparaba stock_minimo a
  -- secas, así que con stock_minimo=0 (default) el push nunca disparaba
  -- aunque el producto ya figurara como "crítico" en Reportes.
  v_umbral := GREATEST(COALESCE(v_minimo, 0), 5);

  IF NEW.cantidad >= v_umbral THEN
    RETURN NEW;
  END IF;
  IF OLD.cantidad IS NOT NULL AND OLD.cantidad < v_umbral THEN
    RETURN NEW;
  END IF;

  v_secret := public.get_push_secret();
  v_payload := jsonb_build_object(
    'empresa_id', v_empresa,
    'tipo',       'stock_critico',
    'titulo',     'Stock crítico',
    'cuerpo',     'Un producto bajó del stock mínimo',
    'datos',      jsonb_build_object(
      'producto_id',  NEW.producto_id,
      'cantidad',     NEW.cantidad,
      'stock_minimo', v_minimo,
      'umbral',       v_umbral
    )
  );

  BEGIN
    PERFORM net.http_post(
      url     := 'https://distrib-app-nine.vercel.app/api/notif/push-interno',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-push-secret', v_secret
      ),
      body    := v_payload
    );
  EXCEPTION WHEN OTHERS THEN
    -- Un error de red/push nunca debe abortar la transacción de stock
    NULL;
  END;

  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260828050000_547_stock_objetivo_ui_y_alertas_unificadas.sql',
  '547',
  'claude_assistant',
  '547: agrega p_stock_objetivo a fn_crear_producto (reusa columna existente de la 035) y unifica el umbral de trigger_push_stock_critico con GREATEST(stock_minimo, 5), el mismo criterio que ya usan fn_reportes_stock_kpis/fn_reportes_stock_criticos_lista desde la 441/542. Antes push y reportes usaban dos criterios distintos para "crítico".'
)
ON CONFLICT DO NOTHING;
