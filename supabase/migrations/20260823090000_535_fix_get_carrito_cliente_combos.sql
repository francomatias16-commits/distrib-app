-- ============================================================
-- 20260823090000_535_fix_get_carrito_cliente_combos.sql
-- Bug real encontrado al integrar el frontend de combos: get_carrito_cliente
-- hace INNER JOIN con productos, así que cualquier renglón de combo en
-- carrito_items (producto_id NULL desde la migración 530) desaparece en
-- silencio del carrito que ve el cliente, aunque el registro siga existiendo
-- en la tabla — el checkout (crear_pedido_cliente) sí lo procesaría si
-- llegara, pero nunca llega porque catalogo.html/carrito.html usan esta RPC
-- para pintar el carrito.
--
-- Fix: LEFT JOIN a productos y a combos, resolviendo nombre/foto_url/stock
-- desde el que corresponda según cuál columna esté seteada (constraint
-- carrito_items_producto_o_combo garantiza que es una sola). El stock de un
-- combo se calcula como el mínimo de (stock disponible del componente /
-- cantidad que el combo necesita de ese componente), floor'd — mismo
-- criterio de disponibilidad que ya usa cliente_combos_disponibles (531),
-- así el carrito y el catálogo no pueden mostrar disponibilidad distinta
-- para el mismo combo.
--
-- Requiere DROP + CREATE (no CREATE OR REPLACE) porque cambia la lista de
-- columnas de RETURNS TABLE (agrega combo_id) — mismo motivo que forzó
-- DROP+CREATE en 532/crear_pedido_cliente.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_carrito_cliente(uuid);

CREATE FUNCTION public.get_carrito_cliente(p_cliente_id uuid)
RETURNS TABLE (
  id               uuid,
  producto_id      uuid,
  combo_id         uuid,
  cantidad         int,
  precio_snap      numeric,
  nombre           text,
  unidad           text,
  foto_url         text,
  stock_disponible int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cliente_id uuid;
  v_empresa_id uuid;
BEGIN
  SELECT u.cliente_id, u.empresa_id
    INTO v_cliente_id, v_empresa_id
  FROM usuarios u
  WHERE u.id = auth.uid()
    AND u.cliente_id = p_cliente_id;

  IF v_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Acceso denegado';
  END IF;

  RETURN QUERY
  WITH stock_por_producto AS (
    SELECT s.producto_id,
           GREATEST(0, COALESCE(SUM(s.cantidad - s.cantidad_reservada), 0))::int AS disponible
      FROM stock s
      JOIN depositos d ON d.id = s.deposito_id
     WHERE d.empresa_id = v_empresa_id
     GROUP BY s.producto_id
  ),
  stock_por_combo AS (
    SELECT cbi.combo_id,
           FLOOR(MIN(COALESCE(sp.disponible, 0)::numeric / cbi.cantidad))::int AS disponible
      FROM combo_items cbi
      LEFT JOIN stock_por_producto sp ON sp.producto_id = cbi.producto_id
     GROUP BY cbi.combo_id
  )
  SELECT
    ci.id,
    ci.producto_id,
    ci.combo_id,
    ci.cantidad::int,
    ci.precio_snap,
    COALESCE(p.nombre, cb.nombre)::text                    AS nombre,
    COALESCE(p.unidad, '')::text                            AS unidad,
    COALESCE(p.foto_url, cb.foto_url)::text                 AS foto_url,
    COALESCE(sp.disponible, sco.disponible, 0)::int          AS stock_disponible
  FROM carrito_items ci
  LEFT JOIN productos p            ON p.id = ci.producto_id
  LEFT JOIN combos cb              ON cb.id = ci.combo_id
  LEFT JOIN stock_por_producto sp  ON sp.producto_id = ci.producto_id
  LEFT JOIN stock_por_combo sco    ON sco.combo_id = ci.combo_id
  WHERE ci.cliente_id = p_cliente_id
  ORDER BY ci.created_at ASC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_carrito_cliente(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_carrito_cliente(uuid) TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823090000_535_fix_get_carrito_cliente_combos.sql',
  '535',
  'claude_assistant',
  'Fix: get_carrito_cliente usaba INNER JOIN a productos, lo que hacía desaparecer del carrito cualquier renglón de combo (producto_id NULL). Ahora LEFT JOIN a productos y combos, con stock de combo calculado como min(stock_componente/cantidad_requerida).'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
