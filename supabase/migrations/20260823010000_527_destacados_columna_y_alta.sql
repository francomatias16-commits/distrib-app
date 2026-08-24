-- ============================================================
-- 20260823010000_527_destacados_columna_y_alta.sql
-- "Destacados" real: hasta ahora era solo el nombre puesto al orden
-- por defecto/relevancia del catálogo — no existía ningún campo en
-- productos ni sección curada. Se agrega la columna y se extiende
-- fn_crear_producto() para poder marcarlo desde el alta.
-- ============================================================

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS destacado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.productos.destacado IS
  'v527: marca manual (toggle en admin) para la sección fija de Destacados del catálogo del portal cliente, y para anteponer el producto en el orden general (cliente_productos_disponibles, migración 529).';

-- Índice parcial: las consultas del catálogo (cliente_productos_disponibles,
-- p_solo_destacados=true) y del admin filtran/ordenan casi siempre por
-- empresa + destacado=true, que es el subconjunto chico de la tabla.
CREATE INDEX IF NOT EXISTS idx_productos_destacado
  ON public.productos(empresa_id)
  WHERE destacado = true;

-- ── fn_crear_producto(): firma vigente (441) + p_destacado ──────
-- CREATE OR REPLACE no permite agregar un parámetro nuevo en medio de
-- la firma con el mismo nombre de función y distinta cantidad de
-- parámetros posicionales por delante — acá el nuevo parámetro va al
-- final con default, así que technically CREATE OR REPLACE alcanzaría,
-- pero se deja el DROP explícito de la firma vieja (9 args) para no
-- dejar dos overloads si en algún punto se llamó con nombres exactos.
DROP FUNCTION IF EXISTS public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text);

CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre        text,
  p_deposito_ids  uuid[],
  p_codigo        text    DEFAULT NULL::text,
  p_categoria_id  uuid    DEFAULT NULL::uuid,
  p_precio_base   numeric DEFAULT 0,
  p_costo         numeric DEFAULT 0,
  p_stock_minimo  numeric DEFAULT 0,
  p_activo        boolean DEFAULT true,
  p_foto_url      text    DEFAULT NULL::text,
  p_destacado     boolean DEFAULT false   -- v527
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

COMMENT ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text, boolean) IS
  'v527: suma p_destacado (default false) para poder marcar el producto como destacado ya desde el alta. Resto de la lógica igual a la versión 441 (elección de depósitos + stock inicial en 0).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823010000_527_destacados_columna_y_alta.sql',
  '527',
  'claude_assistant',
  'Agrega productos.destacado (boolean, default false) + índice parcial por empresa, y extiende fn_crear_producto (base: 441) con p_destacado.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
