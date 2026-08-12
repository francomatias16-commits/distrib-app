-- 024_fix_trigger_productos_precio.sql
-- BUGFIX CRÍTICO: el trigger _audit_productos_precio referenciaba OLD.precio / NEW.precio
-- pero la columna real en la tabla productos se llama precio_base.
-- En plpgsql esto no falla al crear el trigger sino al ejecutarlo (late binding),
-- causando que CUALQUIER UPDATE en productos crashee silenciosamente.
-- Esto hacía fallar toda importación de productos (825 errores, 0 nuevos).

CREATE OR REPLACE FUNCTION _audit_productos_precio()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.precio_base IS DISTINCT FROM NEW.precio_base THEN
    PERFORM registrar_auditoria(
      'productos',
      'UPDATE',
      NEW.id::TEXT,
      jsonb_build_object('precio_base', OLD.precio_base),
      jsonb_build_object('precio_base', NEW.precio_base)
    );
  END IF;
  RETURN NEW;
END;
$$;

-- El trigger ya existe, solo se reemplazó la función que invoca
