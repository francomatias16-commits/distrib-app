-- ============================================================
-- 165_validacion_cantidad_entera_unidad.sql
-- Corrige cantidades con decimales en productos unidad='unidad'
-- (stock, movimientos_stock, lotes, ordenes_compra_items) y agrega
-- triggers que bloquean decimales a futuro para ese tipo de producto.
-- Los productos con unidad='kg' conservan sus decimales.
--
-- NOTA: aplicado en producción vía MCP el 2026-06-30. Este archivo
-- lo deja versionado en el repo para que quede en el historial y
-- se pueda re-aplicar en otros entornos (dev/staging).
-- ============================================================

-- ------------------------------------------------------------
-- PASO 1: limpieza de datos existentes
-- ------------------------------------------------------------
BEGIN;

UPDATE stock s
SET cantidad = round(s.cantidad),
    cantidad_reservada = round(s.cantidad_reservada)
FROM productos p
WHERE p.id = s.producto_id AND p.unidad = 'unidad'
  AND (s.cantidad <> floor(s.cantidad) OR s.cantidad_reservada <> floor(s.cantidad_reservada));

UPDATE movimientos_stock ms
SET cantidad = round(ms.cantidad)
FROM productos p
WHERE p.id = ms.producto_id AND p.unidad = 'unidad'
  AND ms.cantidad <> floor(ms.cantidad);

UPDATE lotes l
SET cantidad = round(l.cantidad),
    cantidad_reservada = round(l.cantidad_reservada),
    cantidad_disponible = round(l.cantidad) - round(l.cantidad_reservada)
FROM productos p
WHERE p.id = l.producto_id AND p.unidad = 'unidad'
  AND (l.cantidad <> floor(l.cantidad) OR l.cantidad_reservada <> floor(l.cantidad_reservada));

UPDATE ordenes_compra_items oi
SET cantidad = round(oi.cantidad),
    cantidad_recibida = round(oi.cantidad_recibida)
FROM productos p
WHERE p.id = oi.producto_id AND p.unidad = 'unidad'
  AND (oi.cantidad <> floor(oi.cantidad) OR oi.cantidad_recibida <> floor(oi.cantidad_recibida));

COMMIT;

-- ------------------------------------------------------------
-- PASO 2: helper de validacion
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_cantidad_entera(p_producto_id uuid, p_cantidad numeric, p_campo text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_unidad text;
BEGIN
  IF p_cantidad IS NULL THEN
    RETURN;
  END IF;
  SELECT unidad INTO v_unidad FROM productos WHERE id = p_producto_id;
  IF v_unidad = 'unidad' AND p_cantidad <> floor(p_cantidad) THEN
    RAISE EXCEPTION 'El campo % debe ser un numero entero para productos con unidad=unidad (producto_id=%, valor=%)', p_campo, p_producto_id, p_cantidad;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- PASO 3: triggers por tabla
-- ------------------------------------------------------------

-- stock
CREATE OR REPLACE FUNCTION trg_fn_stock_cantidad_entera()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad, 'cantidad');
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad_reservada, 'cantidad_reservada');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_cantidad_entera ON stock;
CREATE TRIGGER trg_stock_cantidad_entera
BEFORE INSERT OR UPDATE ON stock
FOR EACH ROW EXECUTE FUNCTION trg_fn_stock_cantidad_entera();

-- movimientos_stock
CREATE OR REPLACE FUNCTION trg_fn_movstock_cantidad_entera()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad, 'cantidad');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_movstock_cantidad_entera ON movimientos_stock;
CREATE TRIGGER trg_movstock_cantidad_entera
BEFORE INSERT OR UPDATE ON movimientos_stock
FOR EACH ROW EXECUTE FUNCTION trg_fn_movstock_cantidad_entera();

-- lotes
CREATE OR REPLACE FUNCTION trg_fn_lotes_cantidad_entera()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad, 'cantidad');
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad_reservada, 'cantidad_reservada');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lotes_cantidad_entera ON lotes;
CREATE TRIGGER trg_lotes_cantidad_entera
BEFORE INSERT OR UPDATE ON lotes
FOR EACH ROW EXECUTE FUNCTION trg_fn_lotes_cantidad_entera();

-- ordenes_compra_items
CREATE OR REPLACE FUNCTION trg_fn_ocitems_cantidad_entera()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad, 'cantidad');
  PERFORM fn_check_cantidad_entera(NEW.producto_id, NEW.cantidad_recibida, 'cantidad_recibida');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ocitems_cantidad_entera ON ordenes_compra_items;
CREATE TRIGGER trg_ocitems_cantidad_entera
BEFORE INSERT OR UPDATE ON ordenes_compra_items
FOR EACH ROW EXECUTE FUNCTION trg_fn_ocitems_cantidad_entera();
