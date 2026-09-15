-- 629_fn_actualizar_precios_masivo.sql
--
-- Hoy no hay forma de cambiar el precio de varios productos a la vez: hay
-- que abrir producto por producto y editar precio_base a mano. Esta RPC
-- agrega el caso "aplicar un ajuste a N productos de una", reutilizando en
-- el frontend la misma selección múltiple que ya existe para "Generar
-- etiquetas" (frontend/admin/js/productos/seleccion-etiquetas.js) — incluye
-- el atajo "seleccionar los N resultados" del filtro activo, así que esto
-- también cubre el caso "por categoría" (filtrás por categoría, seleccionás
-- todos los resultados, aplicás el ajuste).
--
-- Diseño: un solo UPDATE atómico vía CTE (no un loop de updates desde el
-- cliente) para que sea todo-o-nada y no se pueda dejar la mitad de los
-- productos con precio nuevo y la otra mitad con el viejo si se corta la
-- conexión a mitad de camino. SECURITY DEFINER + filtro por
-- get_empresa_id() en el WHERE (mismo patrón que fn_crear_producto): un
-- array de ids ajeno a la empresa del usuario simplemente no matchea nada,
-- no hace falta validar ownership id por id.

DROP FUNCTION IF EXISTS public.fn_actualizar_precios_masivo(uuid[], text, numeric, numeric, boolean);

CREATE OR REPLACE FUNCTION public.fn_actualizar_precios_masivo(
  p_producto_ids uuid[],
  p_tipo_ajuste  text,             -- 'porcentaje' | 'monto_fijo' | 'precio_fijo'
  p_valor        numeric,          -- % o $ (puede ser negativo, salvo precio_fijo); precio_fijo debe ser >= 0
  p_redondeo     numeric DEFAULT NULL,  -- redondear el resultado al múltiplo más cercano (10, 50, 100...); NULL = sin redondeo, solo 2 decimales
  p_preview      boolean DEFAULT false  -- true = solo calcular y devolver, sin tocar la tabla (para mostrar antes/después)
)
 RETURNS TABLE(id uuid, nombre text, precio_anterior numeric, precio_nuevo numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_cantidad   integer;
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  IF p_producto_ids IS NULL OR array_length(p_producto_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Seleccioná al menos un producto.';
  END IF;

  -- Mismo tope que MAX_IDS_ETIQUETAS en el frontend (nucleo-estado.js) —
  -- una tanda de "seleccionar todos los resultados" nunca supera eso, así
  -- que si llega más es un uso indebido de la RPC, no un caso real.
  v_cantidad := array_length(p_producto_ids, 1);
  IF v_cantidad > 500 THEN
    RAISE EXCEPTION 'No se pueden actualizar más de 500 productos por tanda (llegaron %). Achicá el filtro y repetí en tandas.', v_cantidad;
  END IF;

  IF p_tipo_ajuste NOT IN ('porcentaje', 'monto_fijo', 'precio_fijo') THEN
    RAISE EXCEPTION 'Tipo de ajuste inválido: %. Debe ser porcentaje, monto_fijo o precio_fijo.', p_tipo_ajuste;
  END IF;

  IF p_valor IS NULL THEN
    RAISE EXCEPTION 'Falta el valor del ajuste.';
  END IF;

  IF p_tipo_ajuste = 'precio_fijo' AND p_valor < 0 THEN
    RAISE EXCEPTION 'El precio fijo no puede ser negativo.';
  END IF;

  IF p_redondeo IS NOT NULL AND p_redondeo <= 0 THEN
    RAISE EXCEPTION 'El redondeo debe ser un número positivo.';
  END IF;

  IF p_preview THEN
    -- Solo calcula y devuelve — no toca la tabla. Usado por el modal para
    -- mostrar la lista de antes/después antes de que el usuario confirme.
    RETURN QUERY
    WITH calc AS (
      SELECT
        p.id,
        p.nombre,
        p.precio_base AS precio_anterior,
        GREATEST(0,
          CASE p_tipo_ajuste
            WHEN 'porcentaje' THEN p.precio_base * (1 + p_valor / 100.0)
            WHEN 'monto_fijo' THEN p.precio_base + p_valor
            WHEN 'precio_fijo' THEN p_valor
          END
        ) AS precio_calculado
      FROM public.productos p
      WHERE p.id = ANY(p_producto_ids)
        AND p.empresa_id = v_empresa_id
    )
    SELECT
      c.id,
      c.nombre,
      c.precio_anterior,
      CASE
        WHEN p_redondeo IS NOT NULL THEN ROUND(c.precio_calculado / p_redondeo) * p_redondeo
        ELSE ROUND(c.precio_calculado, 2)
      END AS precio_nuevo
    FROM calc c
    ORDER BY c.nombre;

    GET DIAGNOSTICS v_cantidad = ROW_COUNT;
    IF v_cantidad = 0 THEN
      RAISE EXCEPTION 'Ninguno de los productos seleccionados pertenece a tu empresa, o ya no existen.';
    END IF;
    RETURN;
  END IF;

  RETURN QUERY
  WITH calc AS (
    SELECT
      p.id,
      p.nombre,
      p.precio_base AS precio_anterior,
      GREATEST(0,
        CASE p_tipo_ajuste
          WHEN 'porcentaje' THEN p.precio_base * (1 + p_valor / 100.0)
          WHEN 'monto_fijo' THEN p.precio_base + p_valor
          WHEN 'precio_fijo' THEN p_valor
        END
      ) AS precio_calculado
    FROM public.productos p
    WHERE p.id = ANY(p_producto_ids)
      AND p.empresa_id = v_empresa_id
  ),
  calc2 AS (
    SELECT
      c.id,
      c.nombre,
      c.precio_anterior,
      CASE
        WHEN p_redondeo IS NOT NULL THEN ROUND(c.precio_calculado / p_redondeo) * p_redondeo
        ELSE ROUND(c.precio_calculado, 2)
      END AS precio_nuevo
    FROM calc c
  ),
  upd AS (
    UPDATE public.productos p
    SET precio_base = c2.precio_nuevo,
        updated_at  = now()
    FROM calc2 c2
    WHERE p.id = c2.id
    RETURNING p.id
  )
  SELECT c2.id, c2.nombre, c2.precio_anterior, c2.precio_nuevo
  FROM calc2 c2
  ORDER BY c2.nombre;

  GET DIAGNOSTICS v_cantidad = ROW_COUNT;
  IF v_cantidad = 0 THEN
    RAISE EXCEPTION 'Ninguno de los productos seleccionados pertenece a tu empresa, o ya no existen.';
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_actualizar_precios_masivo(uuid[], text, numeric, numeric, boolean)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_actualizar_precios_masivo(uuid[], text, numeric, numeric, boolean)
  TO authenticated, service_role;
