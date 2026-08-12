-- Bug encontrado al testear el punto 5: la migración 169 agregó soporte
-- para 'ordenes_compra'/'pagos_proveedores' en CAMPOS (backend JS) y en los
-- RPC de confirmar/deshacer, pero se olvidó de extender el CHECK constraint
-- de migracion_sesiones.entidad — el insert de la sesión fallaba antes de
-- llegar a mapear nada.
ALTER TABLE public.migracion_sesiones DROP CONSTRAINT migracion_sesiones_entidad_check;
ALTER TABLE public.migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY[
    'clientes'::text, 'productos'::text, 'pedidos'::text, 'cta_cte'::text,
    'precios_clientes'::text, 'proveedores'::text,
    'ordenes_compra'::text, 'pagos_proveedores'::text
  ]));
