-- ============================================================
-- 20260822190000_531_combos_rpcs.sql
-- RPCs de combos:
--   - fn_guardar_combo: alta/edición atómica de un combo + su composición
--     (combo_items), llamada directo desde el panel admin vía supabase-js
--     (mismo patrón que el resto de Productos: RLS + RPC, no pasa por
--     Node) — ver combos.js.
--   - fn_combo_set_activo: activar/desactivar, mismo criterio.
--   - cliente_combos_disponibles: catálogo público de combos para el
--     portal cliente/catalogo.html, espejo de cliente_productos_disponibles
--     (255/292) incluyendo el mismo gate SEC-008 (catalogo_publico_habilitado)
--     para no reabrir ese hallazgo con la superficie nueva de combos.
-- ============================================================

-- ── 1. fn_guardar_combo: upsert atómico de cabecera + composición ───────
CREATE OR REPLACE FUNCTION public.fn_guardar_combo(
  p_combo_id    UUID DEFAULT NULL,
  p_nombre      TEXT,
  p_descripcion TEXT DEFAULT NULL,
  p_precio      NUMERIC DEFAULT 0,
  p_foto_url    TEXT DEFAULT NULL,
  p_activo      BOOLEAN DEFAULT true,
  p_items       JSONB DEFAULT '[]'::jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id UUID;
  v_combo_id   UUID;
  v_item       JSONB;
BEGIN
  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno', 'admin', 'depositero') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  v_empresa_id := public.get_empresa_id();

  IF p_nombre IS NULL OR btrim(p_nombre) = '' THEN
    RETURN json_build_object('ok', false, 'error', 'El combo necesita un nombre');
  END IF;

  IF p_precio IS NULL OR p_precio < 0 THEN
    RETURN json_build_object('ok', false, 'error', 'Precio inválido');
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El combo necesita al menos un producto');
  END IF;

  -- Cada producto del combo tiene que pertenecer a la misma empresa.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) it
      LEFT JOIN public.productos p ON p.id = (it->>'producto_id')::uuid
     WHERE p.id IS NULL OR p.empresa_id <> v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Uno o más productos del combo no pertenecen a esta empresa');
  END IF;

  IF p_combo_id IS NOT NULL THEN
    -- Edición: el combo tiene que ser de esta empresa.
    UPDATE public.combos
       SET nombre      = p_nombre,
           descripcion = p_descripcion,
           precio      = p_precio,
           foto_url    = p_foto_url,
           activo      = p_activo
     WHERE id = p_combo_id
       AND empresa_id = v_empresa_id
    RETURNING id INTO v_combo_id;

    IF v_combo_id IS NULL THEN
      RETURN json_build_object('ok', false, 'error', 'Combo no encontrado');
    END IF;

    DELETE FROM public.combo_items WHERE combo_id = v_combo_id;
  ELSE
    INSERT INTO public.combos (empresa_id, nombre, descripcion, precio, foto_url, activo)
    VALUES (v_empresa_id, p_nombre, p_descripcion, p_precio, p_foto_url, p_activo)
    RETURNING id INTO v_combo_id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.combo_items (combo_id, producto_id, cantidad)
    VALUES (
      v_combo_id,
      (v_item->>'producto_id')::UUID,
      (v_item->>'cantidad')::NUMERIC
    )
    ON CONFLICT (combo_id, producto_id)
    DO UPDATE SET cantidad = combo_items.cantidad + EXCLUDED.cantidad;
  END LOOP;

  RETURN json_build_object('ok', true, 'combo_id', v_combo_id);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guardar_combo(uuid, text, text, numeric, text, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_guardar_combo(uuid, text, text, numeric, text, boolean, jsonb) TO authenticated, service_role;

-- ── 2. fn_combo_set_activo: activar/desactivar sin tocar composición ────
CREATE OR REPLACE FUNCTION public.fn_combo_set_activo(p_combo_id UUID, p_activo BOOLEAN)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno', 'admin', 'depositero') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  UPDATE public.combos
     SET activo = p_activo
   WHERE id = p_combo_id
     AND empresa_id = public.get_empresa_id()
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Combo no encontrado');
  END IF;

  RETURN json_build_object('ok', true, 'combo_id', v_id, 'activo', p_activo);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_combo_set_activo(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_combo_set_activo(uuid, boolean) TO authenticated, service_role;

-- ── 3. cliente_combos_disponibles: catálogo público, espejo de
-- cliente_productos_disponibles (255/292) con el mismo gate SEC-008. Un
-- combo se lista como "disponible" solo si TODOS sus componentes tienen
-- stock suficiente para al menos 1 unidad del combo (no se calcula "cuántos
-- combos entran" acá, solo disponibilidad booleana — el chequeo real de
-- cantidad ocurre en el checkout, igual que con productos sueltos).
CREATE OR REPLACE FUNCTION public.cliente_combos_disponibles(
  p_empresa_id UUID,
  p_limit      INTEGER DEFAULT 24,
  p_offset     INTEGER DEFAULT 0
)
RETURNS TABLE(
  id           UUID,
  nombre       TEXT,
  descripcion  TEXT,
  precio       NUMERIC,
  foto_url     TEXT,
  items        JSONB,
  total_count  BIGINT
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Mismo gate que cliente_productos_disponibles (SEC-008): sin sesión de
  -- esa empresa, solo se muestra si la empresa habilitó el catálogo
  -- público explícitamente. Vacío en vez de error, para no revelar si
  -- p_empresa_id existe.
  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM p_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = p_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH stock_por_producto AS (
    SELECT s.producto_id,
           SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
      FROM public.stock s
      JOIN public.depositos d ON d.id = s.deposito_id
     WHERE d.empresa_id = p_empresa_id
     GROUP BY s.producto_id
  ),
  combos_disponibles AS (
    SELECT c.id
      FROM public.combos c
      JOIN public.combo_items ci ON ci.combo_id = c.id
      LEFT JOIN stock_por_producto sp ON sp.producto_id = ci.producto_id
     WHERE c.empresa_id = p_empresa_id
       AND c.activo = true
     GROUP BY c.id
    HAVING bool_and(COALESCE(sp.disponible, 0) >= ci.cantidad)
  )
  SELECT
    c.id, c.nombre, c.descripcion, c.precio, c.foto_url,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'producto_id', ci.producto_id,
          'nombre',      p.nombre,
          'cantidad',    ci.cantidad
        )
      ) FILTER (WHERE ci.producto_id IS NOT NULL),
      '[]'::jsonb
    ) AS items,
    COUNT(*) OVER() AS total_count
  FROM public.combos c
  JOIN combos_disponibles cd ON cd.id = c.id
  LEFT JOIN public.combo_items ci ON ci.combo_id = c.id
  LEFT JOIN public.productos p ON p.id = ci.producto_id
  GROUP BY c.id, c.nombre, c.descripcion, c.precio, c.foto_url
  ORDER BY c.nombre
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.cliente_combos_disponibles(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cliente_combos_disponibles(uuid, integer, integer) TO anon, authenticated, service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260822190000_531_combos_rpcs.sql',
  '531',
  'claude_assistant',
  'Reconstrucción: fn_guardar_combo, fn_combo_set_activo (admin, directo desde supabase-js) y cliente_combos_disponibles (catálogo público, mismo gate SEC-008 que cliente_productos_disponibles).'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
