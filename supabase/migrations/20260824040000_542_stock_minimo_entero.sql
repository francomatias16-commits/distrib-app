-- ============================================================
-- 20260824040000_542_stock_minimo_entero.sql
--
-- Hallazgo #6 de AUDITORIA_BUGS_v954.md: el input de stock mínimo del
-- admin (`frontend/admin/productos.html`, `input#fp-stock_minimo`) tiene
-- `step="1"` (sugiere entero) pero `productos.js` parseaba con
-- parseFloat, y la columna real en DB era numeric(12,3). No era un bug
-- funcional, pero era un cabo suelto de intención frente al criterio de
-- "cantidades solo enteras" ya aplicado en v690 (migraciones 449/450)
-- para el resto de las columnas de cantidad del sistema.
--
-- Se decide cerrar la inconsistencia con el mismo criterio que v690:
-- stock_minimo pasa a integer, no solo el input. Se verificó que no hay
-- forma de cargar un valor fraccionario desde ningún flujo actual (el
-- único formulario que lo escribe ya usa step="1"), así que la
-- conversión de tipo no trunca datos reales existentes.
--
-- Alcance:
--   1. productos.stock_minimo: numeric(12,3) -> integer.
--   2. fn_crear_producto: p_stock_minimo numeric -> integer (firma
--      vigente desde 527_destacados_columna_y_alta.sql).
--   3. fn_productos_lista: columna de salida stock_minimo numeric ->
--      integer (firma vigente desde 20260823020000_528_fn_productos_
--      lista_destacado.sql).
--   4. fn_reportes_stock_criticos_lista: columna de salida stock_minimo
--      numeric -> integer (firma vigente desde 441_fix_reportes_stock_
--      criticos_activo_y_lista_real.sql).
--
-- Fuera de alcance (revisado, no requiere cambios):
--   - obtener_kpis_dashboard_v2 (076), obtener_dashboard_ejecutivo_resumen
--     (243), fn_reportes_stock_kpis (441) y analizar_stock_autonomo (460)
--     usan stock_minimo solo dentro de expresiones sin declarar su tipo
--     como columna de salida (RETURNS JSONB o solo como parte de un
--     cálculo numeric) — el cast de asignación de integer a numeric es
--     implícito, siguen funcionando sin tocarlos.
--   - trigger_push_stock_critico (112) usa una variable local
--     `v_minimo numeric` para leer stock_minimo — asignación implícita
--     de integer a numeric, no requiere cambio.
--   - lib/asistente-tools.js sigue usando Number(args.stock_minimo) sin
--     forzar entero, igual criterio que se dejó para `cantidad` en ese
--     mismo archivo cuando se aplicó v690 (no se tocó en esa migración).
-- ============================================================

BEGIN;

-- 1. Columna en productos ------------------------------------------------

ALTER TABLE public.productos
  ALTER COLUMN stock_minimo TYPE integer USING round(stock_minimo)::integer,
  ALTER COLUMN stock_minimo SET DEFAULT 0;

COMMENT ON COLUMN public.productos.stock_minimo IS
  'Stock mínimo antes de considerar el producto en quiebre/crítico. Entero desde 2026-08-24 (migración 542), mismo criterio "solo enteros" aplicado a cantidades en v690 (migraciones 449/450).';

-- 2. fn_crear_producto: p_stock_minimo numeric -> integer -----------------
-- Firma vigente (527) + solo el tipo de este parámetro.

DROP FUNCTION IF EXISTS public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text, boolean);

CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre        text,
  p_deposito_ids  uuid[],
  p_codigo        text    DEFAULT NULL::text,
  p_categoria_id  uuid    DEFAULT NULL::uuid,
  p_precio_base   numeric DEFAULT 0,
  p_costo         numeric DEFAULT 0,
  p_stock_minimo  integer DEFAULT 0,
  p_activo        boolean DEFAULT true,
  p_foto_url      text    DEFAULT NULL::text,
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

COMMENT ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, integer, boolean, text, boolean) IS
  'v542: p_stock_minimo pasa de numeric a integer (columna productos.stock_minimo ahora integer, migración 542). Resto de la lógica idéntico a la versión 527 (destacado + elección de depósitos + stock inicial en 0).';

-- 3. fn_productos_lista: columna de salida stock_minimo numeric -> integer
-- Firma vigente (528, que sumó `destacado` sobre la base de 474) sin
-- cambios de parámetros, solo el tipo de la columna de salida.

DROP FUNCTION IF EXISTS public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_productos_lista(
  p_busqueda      text    DEFAULT NULL,
  p_categoria_id  uuid    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_orden         text    DEFAULT 'nombre',
  p_asc           boolean DEFAULT true,
  p_limit         integer DEFAULT 50,
  p_offset        integer DEFAULT 0,
  p_mes           integer DEFAULT NULL,
  p_anio          integer DEFAULT NULL,
  p_foto_fuente   text    DEFAULT NULL,
  p_etiqueta_id   uuid    DEFAULT NULL
)
RETURNS TABLE(
  id uuid, codigo text, nombre text, activo boolean, estado text,
  categoria_id uuid, categoria_nombre text, precio_base numeric, costo numeric,
  stock_minimo integer, stock_disponible numeric, updated_at timestamp with time zone,
  created_at timestamp with time zone, foto_url text, foto_fuente text,
  destacado boolean, total_count bigint   -- v542: stock_minimo a integer
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
        p.updated_at, p.created_at, p.foto_url, p.foto_fuente,
        p.destacado
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
        AND (
          $10::uuid IS NULL OR EXISTS (
            SELECT 1 FROM public.entidad_etiquetas ee
            WHERE ee.entidad_tipo = 'productos'
              AND ee.entidad_id = p.id
              AND ee.etiqueta_id = $10
          )
        )
    )
    SELECT b.id, b.codigo, b.nombre, b.activo, b.estado,
           b.categoria_id, b.categoria_nombre,
           b.precio_base, b.costo, b.stock_minimo, b.stock_disponible,
           b.updated_at, b.created_at, b.foto_url, b.foto_fuente,
           b.destacado,
           COUNT(*) OVER() AS total_count
    FROM base b
    WHERE ($4::text IS NULL OR $4 = '' OR b.estado = $4)
      AND (
        $9::text IS NULL OR $9 = '' OR
        ($9 = 'sin_foto' AND b.foto_url IS NULL) OR
        ($9 = 'generica' AND b.foto_fuente = 'pexels') OR
        ($9 = 'real' AND b.foto_url IS NOT NULL
                     AND (b.foto_fuente IS NULL OR b.foto_fuente <> 'pexels'))
      )
    ORDER BY b.%I %s NULLS LAST, b.id
    LIMIT $5 OFFSET $6
    $q$,
    v_orden_col, v_dir
  );

  RETURN QUERY EXECUTE v_sql
    USING v_empresa_id, p_categoria_id, p_busqueda, p_estado, p_limit, p_offset, p_mes, p_anio, p_foto_fuente, p_etiqueta_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid) IS
  'v542: columna de salida stock_minimo pasa de numeric a integer (columna productos.stock_minimo ahora integer, migración 542). Resto de la firma y filtros igual a 528 (que sumó destacado sobre la base de 474: busqueda/categoria/estado/orden/mes/anio/foto_fuente/etiqueta). Usado por el admin de Productos.';

-- El DROP FUNCTION de más arriba borra junto con la función el REVOKE de
-- PUBLIC/anon que había fijado la migración 258 (fn_productos_lista es RPC
-- de admin, sin caso de uso legítimo para anon/authenticated sin JWT de
-- admin). Sin este bloque, la función recreada quedaría con el EXECUTE por
-- defecto de Postgres a PUBLIC, reabriendo ese acceso.
REVOKE EXECUTE ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid)
  TO authenticated, service_role;

-- 4. fn_reportes_stock_criticos_lista: columna de salida stock_minimo
-- numeric -> integer. Firma vigente desde 441.

DROP FUNCTION IF EXISTS public.fn_reportes_stock_criticos_lista(uuid, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_reportes_stock_criticos_lista(p_deposito_id uuid DEFAULT NULL::uuid, p_categoria_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(producto_id uuid, nombre text, cantidad_disponible numeric, stock_minimo integer, deficit numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT s.producto_id, p.nombre, p.stock_minimo,
           s.cantidad, s.cantidad_reservada
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    JOIN public.productos p ON p.id = s.producto_id
    WHERE d.empresa_id = v_empresa_id
      AND p.activo = true
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
  ),
  agg AS (
    SELECT
      producto_id,
      MAX(nombre) AS nombre,
      SUM(cantidad - COALESCE(cantidad_reservada, 0)) AS disponible,
      GREATEST(MAX(stock_minimo), 5) AS minimo
    FROM base
    GROUP BY producto_id
  )
  SELECT
    a.producto_id, a.nombre, a.disponible, a.minimo,
    GREATEST(a.minimo - a.disponible, 0) AS deficit,
    COUNT(*) OVER() AS total_count
  FROM agg a
  WHERE a.disponible <= a.minimo
  ORDER BY a.disponible ASC, a.nombre ASC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

COMMENT ON FUNCTION public.fn_reportes_stock_criticos_lista(uuid, uuid, integer, integer) IS
  'v542: columna de salida stock_minimo pasa de numeric a integer (columna productos.stock_minimo ahora integer, migración 542). Resto de la lógica idéntico a 441 (mismo criterio real -stock_minimo por producto, piso de 5- que fn_reportes_stock_kpis).';

REVOKE ALL ON FUNCTION public.fn_reportes_stock_criticos_lista(uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_reportes_stock_criticos_lista(uuid, uuid, integer, integer) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
