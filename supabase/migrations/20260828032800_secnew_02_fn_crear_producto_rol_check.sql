-- =============================================================
-- 20260828032800_secnew_02_fn_crear_producto_rol_check.sql
-- SECNEW-02 (2026-08-28) — reconstruida en el repo, ya estaba
-- aplicada en la base real (audit_security_definer_grants la
-- detectó como riesgo: mutación SECURITY DEFINER sin verificación
-- de rol, mismo patrón que fn_guardar_combo/fn_combo_set_activo).
--
-- Faltaba el chequeo de rol que sí tienen las funciones hermanas.
-- Sin esto, cualquier usuario autenticado de la empresa (vendedor,
-- chofer, cliente) podía crear productos, no solo dueño/admin/
-- depositero.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre        text,
  p_deposito_ids  uuid[],
  p_codigo        text DEFAULT NULL::text,
  p_categoria_id  uuid DEFAULT NULL::uuid,
  p_precio_base   numeric DEFAULT 0,
  p_costo         numeric DEFAULT 0,
  p_stock_minimo  numeric DEFAULT 0,
  p_activo        boolean DEFAULT true,
  p_foto_url      text DEFAULT NULL::text,
  p_destacado     boolean DEFAULT false
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
  -- SECNEW-02 (2026-08-28): faltaba el chequeo de rol que sí tienen las
  -- funciones hermanas (fn_guardar_combo, fn_combo_set_activo). Sin esto,
  -- cualquier usuario autenticado de la empresa (vendedor, chofer, cliente)
  -- podia crear productos, no solo dueno/admin/depositero.
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
    precio_base, costo, stock_minimo, activo, foto_url, destacado
  ) VALUES (
    v_empresa_id, NULLIF(trim(p_codigo), ''), p_nombre, p_categoria_id,
    p_precio_base, p_costo, p_stock_minimo, p_activo, NULLIF(trim(p_foto_url), ''),
    COALESCE(p_destacado, false)
  )
  RETURNING id INTO v_producto_id;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
  SELECT v_producto_id, d, 0, 0, COALESCE(p_costo, 0)
  FROM unnest(v_ids_validos) AS d
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN v_producto_id;
END;
$function$;

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260828032800_secnew_02_fn_crear_producto_rol_check.sql',
  'secnew_02',
  'claude_assistant',
  'SECNEW-02: agrega el chequeo de rol (dueno/admin/depositero) que faltaba en fn_crear_producto, detectado por audit_security_definer_grants (muta_datos=true, parece_verificar_rol=false). Reconstruida en el repo el 2026-08-28 tras detectar que estaba aplicada en la base real pero no trackeada como archivo ni en este registro.'
)
ON CONFLICT DO NOTHING;
