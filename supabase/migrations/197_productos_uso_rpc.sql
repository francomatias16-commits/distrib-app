-- ============================================================================
-- 197_productos_uso_rpc.sql
--
-- RPC de solo lectura para el botón "Eliminar definitivamente" agregado en
-- v210 (frontend/admin/productos.html + js/productos.js). El frontend llama
-- sb.rpc('productos_uso', { p_producto_id }) directo desde el cliente antes
-- de intentar el DELETE, para poder avisar de forma amigable qué lo bloquea
-- (FKs ON DELETE RESTRICT/NO ACTION) o qué se borra en cascada (ON DELETE
-- CASCADE), en vez de que el usuario se encuentre con un error 23503 crudo.
--
-- Tablas con FK a productos.id (verificado contra la base real, no contra
-- docs/schema-snapshots que estaba desactualizado):
--   RESTRICT/NO ACTION (bloqueantes): movimientos_stock, pedido_items,
--     presupuesto_items, venta_pos_items, ordenes_compra_items,
--     devoluciones_pos_items, devolucion_items, facturas_proveedor_items
--   CASCADE (se listan mas no bloquean): stock, lotes, carrito_items,
--     precios_clientes, precios_items, promociones, alertas_stock,
--     pos_favoritos, ofertas_liquidacion, sugerencias_pedido, ciclos_compra
--
-- Seguridad: SECURITY INVOKER (default) — corre con los permisos del
-- llamador, así que la RLS de cada tabla listada abajo hace el aislamiento
-- por tenant automáticamente. Nunca recibe ni usa empresa_id explícito;
-- si el producto no pertenece al tenant del usuario, RLS ya lo esconde en
-- el listado de productos, por lo que este RPC ni se llega a invocar para
-- ese id (incluso si se llamara, los counts darían todos 0 y no bloquea
-- ni informa cascada, así que no hay fuga de información cross-tenant).
-- Mismo criterio que el fix de 194 sobre v_productos_sin_proveedor_default.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.productos_uso(p_producto_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_bloqueantes JSONB;
  v_cascada     JSONB;
  v_total_bloqueantes INT;
  v_total_cascada     INT;
BEGIN
  SELECT jsonb_build_object(
    'movimientos_stock',        (SELECT count(*) FROM movimientos_stock        WHERE producto_id = p_producto_id),
    'pedido_items',             (SELECT count(*) FROM pedido_items             WHERE producto_id = p_producto_id),
    'presupuesto_items',        (SELECT count(*) FROM presupuesto_items        WHERE producto_id = p_producto_id),
    'venta_pos_items',          (SELECT count(*) FROM venta_pos_items          WHERE producto_id = p_producto_id),
    'ordenes_compra_items',     (SELECT count(*) FROM ordenes_compra_items     WHERE producto_id = p_producto_id),
    'devoluciones_pos_items',   (SELECT count(*) FROM devoluciones_pos_items   WHERE producto_id = p_producto_id),
    'devolucion_items',         (SELECT count(*) FROM devolucion_items         WHERE producto_id = p_producto_id),
    'facturas_proveedor_items', (SELECT count(*) FROM facturas_proveedor_items WHERE producto_id = p_producto_id)
  ) INTO v_bloqueantes;

  SELECT jsonb_build_object(
    'stock',               (SELECT count(*) FROM stock               WHERE producto_id = p_producto_id),
    'lotes',               (SELECT count(*) FROM lotes               WHERE producto_id = p_producto_id),
    'carrito_items',       (SELECT count(*) FROM carrito_items       WHERE producto_id = p_producto_id),
    'precios_clientes',    (SELECT count(*) FROM precios_clientes    WHERE producto_id = p_producto_id),
    'precios_items',       (SELECT count(*) FROM precios_items       WHERE producto_id = p_producto_id),
    'promociones',         (SELECT count(*) FROM promociones         WHERE producto_id = p_producto_id),
    'alertas_stock',       (SELECT count(*) FROM alertas_stock       WHERE producto_id = p_producto_id),
    'pos_favoritos',       (SELECT count(*) FROM pos_favoritos       WHERE producto_id = p_producto_id),
    'ofertas_liquidacion', (SELECT count(*) FROM ofertas_liquidacion WHERE producto_id = p_producto_id),
    'sugerencias_pedido',  (SELECT count(*) FROM sugerencias_pedido  WHERE producto_id = p_producto_id),
    'ciclos_compra',       (SELECT count(*) FROM ciclos_compra       WHERE producto_id = p_producto_id)
  ) INTO v_cascada;

  SELECT COALESCE(SUM(value::int), 0) INTO v_total_bloqueantes FROM jsonb_each_text(v_bloqueantes);
  SELECT COALESCE(SUM(value::int), 0) INTO v_total_cascada     FROM jsonb_each_text(v_cascada);

  RETURN jsonb_build_object(
    'puede_eliminar', v_total_bloqueantes = 0,
    'bloqueantes',    v_bloqueantes,
    'cascada',        v_cascada,
    'total_cascada',  v_total_cascada
  );
END;
$$;

REVOKE ALL ON FUNCTION public.productos_uso FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.productos_uso TO authenticated;

COMMENT ON FUNCTION public.productos_uso IS
  'Chequeo de uso de un producto antes de DELETE físico. Llamada directo desde frontend/admin/js/productos.js (sb.rpc) por el botón "Eliminar definitivamente" agregado en v210. SECURITY INVOKER: se apoya en la RLS de cada tabla para el aislamiento por tenant.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '197_productos_uso_rpc.sql', '197', 'claude-session',
        'RPC productos_uso(): chequea FKs bloqueantes (RESTRICT/NO ACTION) y en cascada antes de permitir borrado físico de un producto desde el admin. Requerido por v210 (botón "Eliminar definitivamente" en productos.html/js).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
