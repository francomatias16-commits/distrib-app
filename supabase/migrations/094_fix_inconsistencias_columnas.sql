-- ═══════════════════════════════════════════════════════════════════════════
-- 094_fix_inconsistencias_columnas.sql
-- Corrige las inconsistencias de columnas duplicadas detectadas en auditoría.
--
-- IMPORTANTE: este script fue corregido para manejar las políticas RLS
-- que dependen de orden_compra_id (2BP01 al intentar DROP COLUMN directo).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ordenes_compra_items — eliminar columna huérfana 'orden_compra_id'
-- ─────────────────────────────────────────────────────────────────────────

-- Paso 1a: migrar datos de orden_compra_id → orden_id donde corresponda
-- (filas creadas por el bug en stock-auto.js: orden_id NULL, orden_compra_id con valor)
UPDATE public.ordenes_compra_items
SET orden_id = orden_compra_id
WHERE orden_id IS NULL
  AND orden_compra_id IS NOT NULL;

-- Paso 1b: eliminar las políticas RLS que dependen de la columna a borrar.
-- Sin este paso, DROP COLUMN falla con ERROR 2BP01
-- ("cannot drop column because other objects depend on it").
DROP POLICY IF EXISTS oci_select ON public.ordenes_compra_items;
DROP POLICY IF EXISTS oci_modify ON public.ordenes_compra_items;

-- Paso 1c: ahora sí se puede eliminar la columna huérfana
ALTER TABLE public.ordenes_compra_items
  DROP COLUMN IF EXISTS orden_compra_id;

-- Paso 1d: recrear las políticas usando orden_id (columna con FK real)
CREATE POLICY oci_select ON public.ordenes_compra_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.ordenes_compra oc
      WHERE oc.id = ordenes_compra_items.orden_id
        AND oc.empresa_id = public.get_empresa_id()
        AND public.get_rol_usuario() = ANY (ARRAY[
          'dueno'::public.rol_usuario,
          'admin'::public.rol_usuario,
          'vendedor'::public.rol_usuario,
          'depositero'::public.rol_usuario,
          'contador'::public.rol_usuario
        ])
    )
  );

CREATE POLICY oci_modify ON public.ordenes_compra_items
  USING (
    EXISTS (
      SELECT 1 FROM public.ordenes_compra oc
      WHERE oc.id = ordenes_compra_items.orden_id
        AND oc.empresa_id = public.get_empresa_id()
        AND public.get_rol_usuario() = ANY (ARRAY[
          'dueno'::public.rol_usuario,
          'admin'::public.rol_usuario,
          'depositero'::public.rol_usuario
        ])
    )
  );

COMMENT ON COLUMN public.ordenes_compra_items.orden_id IS
  'FK a ordenes_compra.id. Columna canónica (tiene FK real). '
  'La columna orden_compra_id fue eliminada en 094. '
  'Las políticas RLS oci_select y oci_modify fueron recreadas apuntando a esta columna.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. cheques — agregar DEFAULT en 'fecha_vto' para evitar NOT NULL
-- ─────────────────────────────────────────────────────────────────────────

-- Sincronizar filas donde fecha_vto sea NULL (por seguridad)
UPDATE public.cheques
SET fecha_vto = vencimiento
WHERE fecha_vto IS NULL AND vencimiento IS NOT NULL;

-- DEFAULT defensivo: si algún cliente inserta sin fecha_vto, no falla
ALTER TABLE public.cheques
  ALTER COLUMN fecha_vto SET DEFAULT CURRENT_DATE;

COMMENT ON COLUMN public.cheques.fecha_vto IS
  'Columna original (NOT NULL, con índice). Sincronizada con "vencimiento". '
  'cheques.js asigna ambas al guardar.';

COMMENT ON COLUMN public.cheques.vencimiento IS
  'Alias legible de fecha_vto agregado en migración posterior. '
  'cheques.js la usa para lectura y escritura.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. facturas — trigger para sincronizar 'vencimiento' y 'fecha_vencimiento'
-- ─────────────────────────────────────────────────────────────────────────

-- Rellenar gaps existentes cruzados
UPDATE public.facturas
SET fecha_vencimiento = vencimiento
WHERE fecha_vencimiento IS NULL AND vencimiento IS NOT NULL;

UPDATE public.facturas
SET vencimiento = fecha_vencimiento
WHERE vencimiento IS NULL AND fecha_vencimiento IS NOT NULL;

-- Trigger de sincronización permanente
CREATE OR REPLACE FUNCTION public.fn_facturas_sync_vencimiento()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vencimiento IS DISTINCT FROM OLD.vencimiento
     AND (NEW.fecha_vencimiento IS NOT DISTINCT FROM OLD.fecha_vencimiento) THEN
    NEW.fecha_vencimiento := NEW.vencimiento;
  END IF;
  IF NEW.fecha_vencimiento IS DISTINCT FROM OLD.fecha_vencimiento
     AND (NEW.vencimiento IS NOT DISTINCT FROM OLD.vencimiento) THEN
    NEW.vencimiento := NEW.fecha_vencimiento;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_facturas_sync_vencimiento ON public.facturas;
CREATE TRIGGER trg_facturas_sync_vencimiento
  BEFORE INSERT OR UPDATE ON public.facturas
  FOR EACH ROW EXECUTE FUNCTION public.fn_facturas_sync_vencimiento();

COMMENT ON COLUMN public.facturas.vencimiento IS
  'Fecha de vencimiento — sincronizada automáticamente con fecha_vencimiento vía trigger 094.';
COMMENT ON COLUMN public.facturas.fecha_vencimiento IS
  'Alias de vencimiento para módulo cc-proveedores — sincronizado vía trigger 094.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. presupuesto_items — unificar 'descuento' y 'descuento_pct'
-- ─────────────────────────────────────────────────────────────────────────

-- Sincronizar datos antes de eliminar
UPDATE public.presupuesto_items
SET descuento_pct = descuento
WHERE (descuento_pct IS NULL OR descuento_pct = 0)
  AND descuento IS NOT NULL AND descuento > 0;

-- Eliminar columna redundante
ALTER TABLE public.presupuesto_items
  DROP COLUMN IF EXISTS descuento;

COMMENT ON COLUMN public.presupuesto_items.descuento_pct IS
  'Porcentaje de descuento (0-100). Columna canónica. '
  'La columna "descuento" fue eliminada en 094 por ser alias redundante. '
  'presupuestos.js mapea descuento→descuento_pct al guardar.';

-- ─────────────────────────────────────────────────────────────────────────
-- Registro en schema_migrations_registry
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '094_fix_inconsistencias_columnas.sql', '094', 'manual',
  'Fix columnas: orden_compra_id huerfana (RLS recreadas), cheques.fecha_vto DEFAULT, facturas vencimiento trigger, presupuesto_items.descuento')
ON CONFLICT (carpeta, archivo) DO NOTHING;
