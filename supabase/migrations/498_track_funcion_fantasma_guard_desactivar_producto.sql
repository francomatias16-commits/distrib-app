-- 498_track_funcion_fantasma_guard_desactivar_producto.sql
--
-- Etapa 0 (Higiene de base) — cierre. audit-funciones-fantasma.js no pudo
-- correrse localmente (falta @supabase/supabase-js en el entorno de
-- ejecución), así que se corrió el equivalente a mano: se llamó a
-- audit_funciones_vivas() (migración 249) contra la base real y se cruzó
-- el resultado (266 funciones vivas) contra los CREATE (OR REPLACE)
-- FUNCTION de supabase/migrations/*.sql.
--
-- Resultado: 1 sola función fantasma remanente después de la 492 (que ya
-- había trackeado 34) — fn_guard_desactivar_producto_con_stock. Es el
-- trigger BEFORE UPDATE en productos que impide desactivar un producto si
-- todavía tiene stock distinto de cero. El CREATE TRIGGER que la dispara
-- (trg_guard_desactivar_producto_con_stock, sobre public.productos)
-- tampoco existe en ningún archivo de migración — se trackea acá también.
--
-- Esta migración NO cambia ningún comportamiento — CREATE OR REPLACE con
-- la definición EXACTA que hoy vive en producción (capturada con
-- pg_get_functiondef / pg_get_triggerdef). Es puramente de trazabilidad.
-- Con esto, 266/266 funciones vivas quedan con al menos un CREATE FUNCTION
-- en el repo: un `supabase db reset` ya reconstruye el estado real completo.

CREATE OR REPLACE FUNCTION public.fn_guard_desactivar_producto_con_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stock numeric;
BEGIN
  IF OLD.activo = true AND NEW.activo = false THEN
    SELECT COALESCE(SUM(cantidad), 0) INTO v_stock
    FROM public.stock
    WHERE producto_id = NEW.id;

    IF v_stock <> 0 THEN
      RAISE EXCEPTION 'No se puede desactivar "%": todavía tiene % unidades en stock. Ajustá el stock a cero antes de desactivar el producto.', NEW.nombre, v_stock
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_desactivar_producto_con_stock ON public.productos;

CREATE TRIGGER trg_guard_desactivar_producto_con_stock
  BEFORE UPDATE ON public.productos
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_desactivar_producto_con_stock();
