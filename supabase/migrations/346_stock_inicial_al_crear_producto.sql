-- =============================================================================
-- 346_stock_inicial_al_crear_producto.sql
--
-- BUG REPORTADO: al crear un producto desde el modal de la pantalla
-- "Productos" (frontend/admin/js/productos.js → guardarProducto(), INSERT
-- directo a public.productos), no se crea ninguna fila en public.stock para
-- ese producto. Como stock.js y reportes-stock.js listan productos partiendo
-- SIEMPRE de la tabla `stock` con `productos!inner(...)` (inner join), un
-- producto sin fila de stock queda completamente invisible en esas pantallas
-- — no aparece "en cero", directamente no aparece — aunque sí existe y se ve
-- bien en la pantalla de Productos (que lista desde `productos`, no desde
-- `stock`).
--
-- Hasta ahora, la fila de stock solo se creaba de forma perezosa la primera
-- vez que corría ajustar_stock() / registrar_conteo_stock() /
-- recepcionar_orden_compra() / transferir_stock() para ese producto+depósito
-- — nunca al alta del producto.
--
-- FIX:
--   1) Trigger AFTER INSERT ON productos que crea una fila de stock en 0
--      (cantidad, cantidad_reservada, costo_promedio, cantidad_disponible)
--      para cada depósito de la empresa del producto nuevo.
--   2) Backfill: crea las filas faltantes para productos ya existentes que
--      quedaron "huérfanos" de stock (incluye el producto recién cargado
--      que reportó el usuario).
--
-- SECURITY DEFINER porque la policy stock_write solo permite
-- service_role/es_admin() en INSERT directo, pero productos_modify permite
-- también a 'depositero' crear productos — sin DEFINER, un depositero
-- podría crear el producto pero el trigger fallaría al intentar insertar en
-- stock.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_productos_crear_stock_inicial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio, cantidad_disponible)
  SELECT NEW.id, d.id, 0, 0, COALESCE(NEW.costo, 0), 0
  FROM public.depositos d
  WHERE d.empresa_id = NEW.empresa_id
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_productos_crear_stock_inicial IS
  'Crea automáticamente una fila de stock en 0 por cada depósito de la '
  'empresa cuando se da de alta un producto nuevo. Antes la fila de stock '
  'solo se creaba de forma perezosa al primer movimiento (ajustar_stock, '
  'recepcionar_orden_compra, etc.), lo que hacía que un producto recién '
  'creado no apareciera en las pantallas de Stock / Reportes de stock '
  '(que parten de la tabla stock con productos!inner).';

DROP TRIGGER IF EXISTS trg_productos_crear_stock_inicial ON public.productos;
CREATE TRIGGER trg_productos_crear_stock_inicial
  AFTER INSERT ON public.productos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_productos_crear_stock_inicial();

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill: productos ya existentes sin fila de stock en alguno de los
-- depósitos de su empresa (cubre el producto que reportó el usuario y
-- cualquier otro caso previo con el mismo problema).
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio, cantidad_disponible)
SELECT p.id, d.id, 0, 0, COALESCE(p.costo, 0), 0
FROM public.productos p
JOIN public.depositos d ON d.empresa_id = p.empresa_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock s
  WHERE s.producto_id = p.id AND s.deposito_id = d.id
)
ON CONFLICT (producto_id, deposito_id) DO NOTHING;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '346_stock_inicial_al_crear_producto.sql', '346', 'claude-session',
  'Fix: crear producto no generaba fila de stock (invisible en pantallas de Stock/Reportes, que parten de stock con productos!inner). Trigger AFTER INSERT ON productos + backfill de productos huérfanos.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
