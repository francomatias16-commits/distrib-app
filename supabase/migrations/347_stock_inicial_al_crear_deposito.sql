-- =============================================================================
-- 347_stock_inicial_al_crear_deposito.sql
--
-- Caso simétrico al de la migración 346 (crear producto no generaba stock).
-- Acá es al revés: crear un DEPÓSITO nuevo tampoco generaba una fila de
-- stock=0 para cada producto ya existente de la empresa en ese depósito.
--
-- Camino real donde esto pasa hoy: el wizard de "Migración de datos"
-- (fn migración maestra, entidad 'depositos' — ver
-- 173_migracion_maestros_categoria_deposito_lista_zona.sql) hace
-- INSERT INTO depositos directo al importar un depósito nuevo durante el
-- onboarding de un tenant. No hay pantalla de alta manual de depósitos en
-- el admin todavía, pero el wizard sí es un camino alcanzable.
--
-- Sin este trigger, un depósito recién importado quedaría sin ningún
-- producto visible en Stock / Reportes de stock para ESE depósito
-- específico (mismo síntoma que el bug de productos: `stock.js` y
-- `reportes-stock.js` parten de la tabla `stock` con productos!inner).
--
-- El backfill de 346 ya cubrió el estado actual (todas las combinaciones
-- producto x depósito existentes al momento de esa migración). Este
-- trigger evita que el gap vuelva a aparecer con el próximo depósito nuevo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_deposito_crear_stock_inicial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio, cantidad_disponible)
  SELECT p.id, NEW.id, 0, 0, COALESCE(p.costo, 0), 0
  FROM public.productos p
  WHERE p.empresa_id = NEW.empresa_id
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_deposito_crear_stock_inicial IS
  'Crea automáticamente una fila de stock en 0 para cada producto existente '
  'de la empresa cuando se da de alta un depósito nuevo. Caso simétrico a '
  'fn_productos_crear_stock_inicial (346): sin esto, un depósito recién '
  'creado (p.ej. vía la migración maestra) queda sin productos visibles en '
  'Stock / Reportes de stock para ese depósito.';

DROP TRIGGER IF EXISTS trg_deposito_crear_stock_inicial ON public.depositos;
CREATE TRIGGER trg_deposito_crear_stock_inicial
  AFTER INSERT ON public.depositos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_deposito_crear_stock_inicial();

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '347_stock_inicial_al_crear_deposito.sql', '347', 'claude-session',
  'Caso simétrico a 346: trigger AFTER INSERT ON depositos que crea stock=0 para todos los productos existentes de la empresa en el depósito nuevo (alcanzable hoy vía el wizard de migración maestra, entidad depositos).')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
