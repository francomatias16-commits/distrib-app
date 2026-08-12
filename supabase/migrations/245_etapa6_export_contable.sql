-- ============================================================
-- MIGRACIÓN 245 — Etapa 6: Export contable (Tango/Bejerman/Contabilium)
-- distrib v245
--
-- Primera entrega de la Etapa 6 ("Integraciones externas"), frente
-- "Export contable". Alcance de ESTA migración: solo la base de datos
-- (config + auditoría + vistas normalizadas). El armado de los archivos
-- en cada formato específico vive en lib/export-contable/*.js (Node),
-- no en SQL — así el día que Tango cambie el layout no hay que tocar
-- la base.
--
-- Decisiones de diseño (ver CHANGELOG_v245_etapa6_export_contable_diseno.md
-- para el detalle completo):
--
--  1. Un solo par de vistas normalizadas (venta / compra), NO una vista
--     por proveedor contable. Cada formateador (Tango, Bejerman,
--     Contabilium, CSV genérico) lee de la misma vista y decide cómo
--     mapear cada campo a su layout. Si mañana aparece un 4to proveedor
--     contable, no hace falta tocar la base.
--
--  2. `plan_cuentas` es JSONB abierto a propósito: cada empresa tiene su
--     propio plan de cuentas y no hay forma de estandarizarlo sin atarse
--     a un solo proveedor. El handler valida que las claves mínimas estén
--     presentes antes de generar un export que arme asientos contables
--     (ventas/compras). Para cobranzas no hace falta plan de cuentas.
--
--  3. `codigo_contable` en clientes/proveedores es NULLABLE y no se usa
--     todavía en ningún lado más que acá: es el campo que permite
--     matchear un cliente de distrib con "el mismo" cliente ya cargado
--     en Tango/Bejerman (que tienen su propio código interno, no CUIT).
--     Si queda vacío, los formateadores caen a CUIT como fallback.
--
--  4. `export_contable_log` graba cada exportación (no bloquea re-exportar
--     el mismo rango — eso es una decisión operativa del contador, no
--     nuestra — pero permite mostrar en el panel "el 5/7 exportaste
--     ventas de junio a Tango, esto es lo que falta").
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Config de export contable por empresa
-- ============================================================
CREATE TABLE IF NOT EXISTS public.export_contable_config (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor          text NOT NULL DEFAULT 'generico_csv'
                       CHECK (proveedor IN ('tango', 'bejerman', 'contabilium', 'generico_csv')),
  -- Plan de cuentas propio de la empresa, mapeado a los conceptos que
  -- necesitamos para armar asientos. Ejemplo de contenido esperado:
  -- {
  --   "ventas_neto":          "4.1.01",
  --   "iva_debito_fiscal":    "2.1.03",
  --   "deudores_por_venta":   "1.1.02",
  --   "compras_neto":         "5.1.01",
  --   "iva_credito_fiscal":   "1.1.05",
  --   "proveedores":          "2.1.01"
  -- }
  -- No se valida la forma del código (cada plan de cuentas es distinto),
  -- solo que las claves necesarias existan antes de exportar ventas/compras.
  plan_cuentas       jsonb NOT NULL DEFAULT '{}'::jsonb,
  separador_decimal  text NOT NULL DEFAULT ',' CHECK (separador_decimal IN (',', '.')),
  formato_fecha      text NOT NULL DEFAULT 'DD/MM/YYYY' CHECK (formato_fecha IN ('DD/MM/YYYY', 'YYYY-MM-DD')),
  activo             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id)
);

ALTER TABLE public.export_contable_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_contable_config_select ON public.export_contable_config;
CREATE POLICY export_contable_config_select ON public.export_contable_config
  FOR SELECT USING (
    empresa_id = public.get_empresa_id()
    AND public.get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

DROP POLICY IF EXISTS export_contable_config_modify ON public.export_contable_config;
CREATE POLICY export_contable_config_modify ON public.export_contable_config
  FOR ALL USING (
    empresa_id = public.get_empresa_id()
    AND public.get_rol_usuario() IN ('dueno', 'admin')
  );

-- ============================================================
-- 2. Historial de exportaciones (auditoría, no bloqueo)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.export_contable_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  proveedor           text NOT NULL,
  tipo                text NOT NULL CHECK (tipo IN ('ventas', 'compras', 'cobranzas')),
  fecha_desde         date NOT NULL,
  fecha_hasta         date NOT NULL,
  cantidad_registros  integer NOT NULL DEFAULT 0,
  usuario_id          uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  archivo_nombre      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_export_contable_log_empresa
  ON public.export_contable_log (empresa_id, created_at DESC);

ALTER TABLE public.export_contable_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_contable_log_select ON public.export_contable_log;
CREATE POLICY export_contable_log_select ON public.export_contable_log
  FOR SELECT USING (
    empresa_id = public.get_empresa_id()
    AND public.get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

-- Sin policy de INSERT para `authenticated`: el registro del historial lo
-- hace el backend con service_role al terminar de generar el archivo
-- (mismo patrón que el resto de las tablas de auditoría del proyecto).

-- ============================================================
-- 3. Código contable de terceros (opcional)
-- ============================================================
ALTER TABLE public.clientes    ADD COLUMN IF NOT EXISTS codigo_contable text;
ALTER TABLE public.proveedores ADD COLUMN IF NOT EXISTS codigo_contable text;

COMMENT ON COLUMN public.clientes.codigo_contable IS
  'Código del cliente en el sistema contable externo (Tango/Bejerman), si difiere '
  'del CUIT. NULL = los formateadores usan CUIT como fallback.';
COMMENT ON COLUMN public.proveedores.codigo_contable IS
  'Ídem clientes.codigo_contable, para el padrón de proveedores.';

-- ============================================================
-- 4. Vista normalizada — comprobantes de VENTA
--    (facturas emitidas + notas de crédito emitidas)
--    NO aplica RLS de por sí (es una vista simple, hereda la RLS de las
--    tablas base cuando se consulta como usuario autenticado). El handler
--    de export usa service_role y filtra empresa_id explícitamente, igual
--    que el resto de los handlers de reportes del proyecto.
-- ============================================================
CREATE OR REPLACE VIEW public.v_comprobantes_contables_venta AS
SELECT
  f.empresa_id,
  'factura'::text            AS origen,
  f.tipo                      AS letra,
  f.numero,
  f.fecha_emision::date       AS fecha,
  f.cliente_id,
  c.razon_social,
  c.cuit,
  c.condicion_iva,
  c.codigo_contable,
  f.neto,
  f.iva,
  f.total,
  1                           AS signo   -- factura: suma al débito de ventas
FROM public.facturas f
JOIN public.clientes c ON c.id = f.cliente_id
WHERE f.estado = 'emitida'

UNION ALL

SELECT
  nc.empresa_id,
  'nota_credito'::text,
  nc.tipo,
  nc.numero,
  nc.fecha_emision::date,
  nc.cliente_id,
  c.razon_social,
  c.cuit,
  c.condicion_iva,
  c.codigo_contable,
  nc.neto,
  nc.iva,
  nc.total,
  -1                          -- nota de crédito: resta del débito de ventas
FROM public.notas_credito nc
JOIN public.clientes c ON c.id = nc.cliente_id
WHERE nc.estado = 'emitida';

COMMENT ON VIEW public.v_comprobantes_contables_venta IS
  'Comprobantes de venta ya emitidos (facturas + notas de crédito), '
  'normalizados para alimentar los formateadores de export contable. '
  'signo = 1 (factura) o -1 (nota de crédito) para que sumar total*signo '
  'dé directo el neto que corresponde imputar en el Libro IVA Ventas.';

-- ============================================================
-- 5. Vista normalizada — comprobantes de COMPRA
--    (facturas de proveedor cargadas vía cta-cte de proveedores)
-- ============================================================
CREATE OR REPLACE VIEW public.v_comprobantes_contables_compra AS
SELECT
  fp.empresa_id,
  'factura_proveedor'::text  AS origen,
  fp.tipo                     AS letra,
  fp.numero_factura           AS numero,
  fp.fecha_factura            AS fecha,
  fp.proveedor_id,
  p.razon_social,
  p.cuit,
  p.condicion_iva,
  p.codigo_contable,
  (fp.total - fp.iva_monto)   AS neto,
  fp.iva_monto                AS iva,
  fp.total,
  1                           AS signo
FROM public.facturas_proveedor fp
JOIN public.proveedores p ON p.id = fp.proveedor_id
WHERE fp.estado <> 'anulada';

COMMENT ON VIEW public.v_comprobantes_contables_compra IS
  'Facturas de proveedor cargadas (no anuladas), normalizadas para export '
  'contable de compras. Todavía no existe el concepto de nota de débito/ '
  'crédito de proveedor en el esquema — si se agrega, sumar acá con el '
  'mismo patrón de signo que la vista de venta.';

-- ============================================================
-- 6. RPC de lectura de config (mismo patrón que get_facturacion_config)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_export_contable_config()
RETURNS TABLE (
  configurado        boolean,
  proveedor          text,
  plan_cuentas       jsonb,
  separador_decimal  text,
  formato_fecha      text,
  activo             boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    true,
    ecc.proveedor,
    ecc.plan_cuentas,
    ecc.separador_decimal,
    ecc.formato_fecha,
    ecc.activo
  FROM public.export_contable_config ecc
  JOIN public.usuarios u ON u.empresa_id = ecc.empresa_id
  WHERE u.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_export_contable_config FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_export_contable_config TO authenticated;

COMMIT;
