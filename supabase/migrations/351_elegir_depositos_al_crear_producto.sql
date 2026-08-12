-- ─────────────────────────────────────────────────────────────────────────
-- 351: en vez de replicar automáticamente el producto nuevo en TODOS los
-- depósitos de la empresa (346), ahora se elige explícitamente en cuáles
-- depósitos va a existir desde el alta. Con 10 sucursales, antes un
-- producto nuevo aparecía 10 veces (una fila en 0 por depósito) aunque
-- solo se vendiera en 1 o 2.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Se saca el trigger que fanoutea a TODOS los depósitos en cada alta.
DROP TRIGGER IF EXISTS trg_productos_crear_stock_inicial ON public.productos;

COMMENT ON FUNCTION public.fn_productos_crear_stock_inicial IS
  'DEPRECADA (fix v351): ya no está enganchada a ningún trigger. Reemplazada '
  'por fn_crear_producto(), que crea el producto y sus filas de stock SOLO '
  'en los depósitos elegidos explícitamente al alta, en vez de fanoutear '
  'automáticamente a todos los depósitos de la empresa.';

-- 2) Nueva función que hace alta de producto + stock inicial en los
--    depósitos elegidos, en una sola transacción. SECURITY DEFINER por el
--    mismo motivo que 346: productos_modify permite también a 'depositero'
--    crear productos, pero stock_write solo admite service_role/es_admin()
--    en INSERT directo.
CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre        text,
  p_deposito_ids  uuid[],
  p_codigo        text    DEFAULT NULL,
  p_categoria_id  uuid    DEFAULT NULL,
  p_precio_base   numeric DEFAULT 0,
  p_costo         numeric DEFAULT 0,
  p_stock_minimo  numeric DEFAULT 0,
  p_activo        boolean DEFAULT true
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
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
    RAISE EXCEPTION 'El nombre del producto es obligatorio.';
  END IF;

  -- Solo se aceptan depósitos que realmente pertenecen a la empresa del
  -- usuario (evita que alguien mande un uuid de otra empresa).
  SELECT array_agg(d.id) INTO v_ids_validos
  FROM public.depositos d
  WHERE d.empresa_id = v_empresa_id
    AND d.id = ANY(p_deposito_ids);

  IF v_ids_validos IS NULL OR array_length(v_ids_validos, 1) IS NULL THEN
    RAISE EXCEPTION 'Debe seleccionar al menos un depósito válido para el producto nuevo.';
  END IF;

  INSERT INTO public.productos (
    empresa_id, codigo, nombre, categoria_id,
    precio_base, costo, stock_minimo, activo
  ) VALUES (
    v_empresa_id, NULLIF(trim(p_codigo), ''), p_nombre, p_categoria_id,
    p_precio_base, p_costo, p_stock_minimo, p_activo
  )
  RETURNING id INTO v_producto_id;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio, cantidad_disponible)
  SELECT v_producto_id, d, 0, 0, COALESCE(p_costo, 0), 0
  FROM unnest(v_ids_validos) AS d
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN v_producto_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean) IS
  'Alta de producto (fix v351): crea el producto y una fila de stock en 0 '
  'SOLO en los depositos pasados en p_deposito_ids (validados contra la '
  'empresa del usuario), en vez de fanoutear a todos los depositos como '
  'hacia el trigger de la migracion 346. Reemplaza el INSERT directo a '
  'productos que hacia guardarProducto() en frontend/admin/js/productos.js '
  'para el caso de alta (el UPDATE de edicion sigue igual, no toca stock).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '351_elegir_depositos_al_crear_producto.sql', '351', 'claude-session',
  'Cambio de UX pedido por el usuario: antes, crear un producto disparaba un trigger que generaba una fila de stock en 0 en TODOS los depositos de la empresa (fix v346), lo que con muchas sucursales mostraba el mismo producto duplicado N veces sin necesidad. Se saca ese trigger y se agrega fn_crear_producto(), que crea el producto + stock inicial SOLO en los depositos elegidos explicitamente al momento del alta.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
