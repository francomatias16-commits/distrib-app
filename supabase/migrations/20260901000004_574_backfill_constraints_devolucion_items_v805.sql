-- Etapa 7 (Bloque 1, Devoluciones) — reconciliación de migraciones contra
-- Supabase real (mismo patrón que el gap de la migración 483, y que el
-- backfill 573 de esta misma sesión para fn_stock_lista_agrupada / v796).
--
-- v805 ("Auditoría completa del módulo de devoluciones, post-incidente
-- $9,86M") agrega, según su changelog, un constraint "en base (migración
-- v805_check_devolucion_items_cantidad_precio)" — un nombre de archivo que
-- nunca existió en el repo. Confirmado contra el proyecto real
-- (jgiquzjwoedmzwqgzubr, pg_constraint) que los dos CHECK SÍ están
-- aplicados en producción. Sin este backfill, un `supabase db reset`
-- reconstruiría `devolucion_items` sin esta última línea de defensa contra
-- cantidad <= 0 o precio_unitario negativo — justo la clase de bug que
-- causó el incidente que dispara v805 (4.555 u. de stock fantasma + NC de
-- $9.865.288,69 por una devolución sin las validaciones de cantidad/pedido
-- que esa misma versión agregó en `crearDevolucionCore`).
--
-- Guardado con IF NOT EXISTS explícito (vía pg_constraint) en vez de
-- ALTER TABLE ADD CONSTRAINT directo, porque en el proyecto real estas dos
-- restricciones YA existen — aplicar esto es un no-op ahí. Donde sí hace
-- falta (un `db reset` local, un ambiente nuevo) el DO block las crea.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devolucion_items_cantidad_positiva'
       AND conrelid = 'public.devolucion_items'::regclass
  ) THEN
    ALTER TABLE public.devolucion_items
      ADD CONSTRAINT devolucion_items_cantidad_positiva CHECK (cantidad > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devolucion_items_precio_no_negativo'
       AND conrelid = 'public.devolucion_items'::regclass
  ) THEN
    ALTER TABLE public.devolucion_items
      ADD CONSTRAINT devolucion_items_precio_no_negativo CHECK (precio_unitario >= 0);
  END IF;
END $$;
