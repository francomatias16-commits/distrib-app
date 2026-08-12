-- ─────────────────────────────────────────────────────────────────────────
-- 353: subida de foto de producto desde el modal de alta/edición.
--
-- La columna productos.foto_url ya existe desde el schema original y el
-- bucket de Storage 'productos-fotos' (público, policies de insert/update/
-- delete para 'authenticated') ya estaba configurado en producción, pero
-- sin aplicarse vía migración versionada. El frontend la mostraba en
-- catálogo/carrito/compras pero el modal de alta/edición de Productos no
-- tenía forma de cargarla. Esta migración:
--   1) Deja registrada la migración de storage que ya estaba aplicada
--      directo en producción (bucket + policies), para que quede en el
--      historial versionado igual que pasó con otras migraciones "fantasma".
--   2) Agrega foto_url al SELECT de fn_productos_lista (para que el modal
--      de edición pueda precargar la imagen actual).
--   3) Agrega p_foto_url a fn_crear_producto (para que el alta pueda
--      guardar la foto subida antes de crear el producto).
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Bucket + policies (ya aplicado en producción; se deja documentado acá
--    para que quede en el historial de migraciones). Idempotente.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('productos-fotos', 'productos-fotos', true, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'productos_fotos_auth_insert'
  ) THEN
    CREATE POLICY productos_fotos_auth_insert ON storage.objects
      FOR INSERT TO public
      WITH CHECK (bucket_id = 'productos-fotos' AND auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'productos_fotos_auth_update'
  ) THEN
    CREATE POLICY productos_fotos_auth_update ON storage.objects
      FOR UPDATE TO public
      USING (bucket_id = 'productos-fotos' AND auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'productos_fotos_auth_delete'
  ) THEN
    CREATE POLICY productos_fotos_auth_delete ON storage.objects
      FOR DELETE TO public
      USING (bucket_id = 'productos-fotos' AND auth.role() = 'authenticated');
  END IF;
END $$;

-- 2) fn_productos_lista: se agrega foto_url a la salida para que el modal
--    de edición pueda mostrar la imagen actual sin un segundo round-trip.
DROP FUNCTION IF EXISTS public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_productos_lista(
  p_busqueda    text    DEFAULT NULL,
  p_categoria_id uuid   DEFAULT NULL,
  p_estado      text    DEFAULT NULL,
  p_orden       text    DEFAULT 'nombre',
  p_asc         boolean DEFAULT true,
  p_limit       integer DEFAULT 50,
  p_offset      integer DEFAULT 0,
  p_mes         integer DEFAULT NULL,
  p_anio        integer DEFAULT NULL
)
RETURNS TABLE(
  id uuid, codigo text, nombre text, activo boolean, estado text,
  categoria_id uuid, categoria_nombre text, precio_base numeric, costo numeric,
  stock_minimo numeric, stock_disponible numeric, updated_at timestamp with time zone,
  created_at timestamp with time zone, foto_url text, total_count bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_orden_col  text;
  v_dir        text := CASE WHEN p_asc THEN 'ASC' ELSE 'DESC' END;
  v_sql        text;
BEGIN
  v_orden_col := CASE p_orden
    WHEN 'nombre'      THEN 'nombre'
    WHEN 'precio'      THEN 'precio_base'
    WHEN 'precio_base' THEN 'precio_base'
    WHEN 'costo'       THEN 'costo'
    WHEN 'stock'       THEN 'stock_disponible'
    WHEN 'fechaAct'    THEN 'updated_at'
    WHEN 'updated_at'  THEN 'updated_at'
    ELSE 'nombre'
  END;

  v_sql := format(
    $q$
    WITH stock_por_producto AS (
      SELECT s.producto_id,
             SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
      FROM public.stock s
      JOIN public.depositos d ON d.id = s.deposito_id
      WHERE d.empresa_id = $1
      GROUP BY s.producto_id
    ),
    base AS (
      SELECT
        p.id, p.codigo, p.nombre, p.activo,
        CASE
          WHEN NOT p.activo THEN 'borrador'
          WHEN COALESCE(sp.disponible, 0) <= 0 THEN 'sin_stock'
          ELSE 'activo'
        END AS estado,
        p.categoria_id, c.nombre AS categoria_nombre,
        p.precio_base, p.costo, p.stock_minimo,
        COALESCE(sp.disponible, 0) AS stock_disponible,
        p.updated_at, p.created_at, p.foto_url
      FROM public.productos p
      LEFT JOIN stock_por_producto sp ON sp.producto_id = p.id
      LEFT JOIN public.categorias c   ON c.id = p.categoria_id
      WHERE p.empresa_id = $1
        AND ($2::uuid IS NULL OR p.categoria_id = $2)
        AND (
          $3::text IS NULL OR $3 = '' OR
          (COALESCE(p.nombre, '') || ' ' || COALESCE(p.codigo, '')) ILIKE '%%' || $3 || '%%'
        )
        AND ($7::int IS NULL OR EXTRACT(MONTH FROM p.created_at) = $7)
        AND ($8::int IS NULL OR EXTRACT(YEAR  FROM p.created_at) = $8)
    )
    SELECT b.id, b.codigo, b.nombre, b.activo, b.estado,
           b.categoria_id, b.categoria_nombre,
           b.precio_base, b.costo, b.stock_minimo, b.stock_disponible,
           b.updated_at, b.created_at, b.foto_url,
           COUNT(*) OVER() AS total_count
    FROM base b
    WHERE ($4::text IS NULL OR $4 = '' OR b.estado = $4)
    ORDER BY b.%I %s NULLS LAST, b.id
    LIMIT $5 OFFSET $6
    $q$,
    v_orden_col, v_dir
  );

  RETURN QUERY EXECUTE v_sql
    USING v_empresa_id, p_categoria_id, p_busqueda, p_estado, p_limit, p_offset, p_mes, p_anio;
END;
$function$;

COMMENT ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer) IS
  'Fix v353: se agrega foto_url a la salida (ya existía la columna en productos, '
  'faltaba exponerla acá) para que el modal de edición de Productos pueda '
  'precargar la imagen actual sin un segundo round-trip.';

-- 3) fn_crear_producto: se agrega p_foto_url para poder guardar la foto ya
--    subida al bucket antes del alta del producto (se sube primero a
--    Storage, y la URL pública resultante se pasa acá).
DROP FUNCTION IF EXISTS public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean);

CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre        text,
  p_deposito_ids  uuid[],
  p_codigo        text    DEFAULT NULL,
  p_categoria_id  uuid    DEFAULT NULL,
  p_precio_base   numeric DEFAULT 0,
  p_costo         numeric DEFAULT 0,
  p_stock_minimo  numeric DEFAULT 0,
  p_activo        boolean DEFAULT true,
  p_foto_url      text    DEFAULT NULL
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
    precio_base, costo, stock_minimo, activo, foto_url
  ) VALUES (
    v_empresa_id, NULLIF(trim(p_codigo), ''), p_nombre, p_categoria_id,
    p_precio_base, p_costo, p_stock_minimo, p_activo, NULLIF(trim(p_foto_url), '')
  )
  RETURNING id INTO v_producto_id;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio, cantidad_disponible)
  SELECT v_producto_id, d, 0, 0, COALESCE(p_costo, 0), 0
  FROM unnest(v_ids_validos) AS d
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN v_producto_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text) IS
  'Fix v353: se agrega p_foto_url (opcional) para guardar, en la misma alta, '
  'la foto ya subida a Storage (bucket productos-fotos) desde el modal de '
  'Productos. El resto de la lógica es igual a la v351.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '353_foto_producto_upload.sql', '353', 'claude-session',
  'Se habilita la subida de foto de producto desde el modal de alta/edición. '
  'Se documenta en migración versionada el bucket productos-fotos y sus '
  'policies (ya estaban aplicados directo en producción). Se agrega foto_url '
  'a fn_productos_lista y p_foto_url a fn_crear_producto.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
