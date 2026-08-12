-- 424_asistente_ordenes_compra.sql
-- Tool del asistente: listar_ordenes_compra
-- Cierra brecha funcional: ordenes_compra (y ordenes_compra_items) se usa
-- en varios handlers del sistema (automatizacion.js, stock-auto.js,
-- proveedores.js, portal_proveedor.js, notif.js) pero el asistente no
-- tenía ninguna tool para consultarla.
--
-- Scope de seguridad: ordenes_compra tiene empresa_id propio (a
-- diferencia de movimientos_stock), no hace falta resolver vía join.
-- Cap de 20 filas mostradas; total_ordenes es el conteo real.
-- Estados válidos (constraint ordenes_compra_estado_check): borrador,
-- pendiente_aprobacion, enviada, confirmada, recibida_parcial, recibida,
-- cancelada.

CREATE OR REPLACE FUNCTION public.listar_ordenes_compra(
  p_empresa_id UUID,
  p_proveedor  TEXT DEFAULT NULL,
  p_estado     TEXT DEFAULT NULL,
  p_dias       INT  DEFAULT 30
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      oc.id, oc.numero, oc.estado, oc.total, oc.subtotal, oc.iva_total,
      oc.notas, oc.auto_generada, oc.fecha_pedido, oc.fecha_esperada,
      oc.fecha_recepcion, oc.created_at,
      COALESCE(p.nombre_fantasia, p.razon_social) AS proveedor_nombre,
      (SELECT COUNT(*) FROM public.ordenes_compra_items i WHERE i.orden_id = oc.id) AS cantidad_items
    FROM public.ordenes_compra oc
    JOIN public.proveedores p ON p.id = oc.proveedor_id
    WHERE oc.empresa_id = p_empresa_id
      AND oc.created_at >= CURRENT_DATE - GREATEST(p_dias, 0)
      AND (p_proveedor IS NULL OR COALESCE(p.nombre_fantasia, p.razon_social) ILIKE '%' || p_proveedor || '%')
      AND (p_estado IS NULL OR oc.estado = p_estado)
  ), top AS (
    SELECT * FROM filas ORDER BY created_at DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_ordenes', (SELECT COUNT(*) FROM filas),
    'ordenes_mostradas', (SELECT COUNT(*) FROM top),
    'ordenes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'numero', numero,
        'proveedor', proveedor_nombre,
        'estado', estado,
        'total', total,
        'subtotal', subtotal,
        'iva_total', iva_total,
        'cantidad_items', cantidad_items,
        'auto_generada', auto_generada,
        'notas', notas,
        'fecha_pedido', fecha_pedido,
        'fecha_esperada', fecha_esperada,
        'fecha_recepcion', fecha_recepcion,
        'fecha', created_at
      ) ORDER BY created_at DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.listar_ordenes_compra(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_ordenes_compra(UUID, TEXT, TEXT, INT) TO service_role;

-- Fix de grants por default privileges (mismo problema que motivó 423b):
-- este proyecto auto-otorga EXECUTE a anon/authenticated en funciones
-- nuevas de public. Se revoca explícito en la misma migración esta vez.
REVOKE EXECUTE ON FUNCTION public.listar_ordenes_compra(UUID, TEXT, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.listar_ordenes_compra(UUID, TEXT, TEXT, INT) FROM authenticated;

COMMENT ON FUNCTION public.listar_ordenes_compra IS
  'Tool del asistente: historial de órdenes de compra a proveedores en los últimos N días, opcionalmente filtrado por proveedor y/o estado (máx. 20 filas mostradas, total_ordenes es el real). Grants explícitos a anon/authenticated revocados en la misma migración por default privileges del proyecto.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '424_asistente_ordenes_compra.sql', '424', 'claude-session',
        'Cierra brecha funcional detectada: ordenes_compra/ordenes_compra_items se usa en varios handlers (automatizacion, stock-auto, proveedores, portal_proveedor, notif) pero el asistente no tenía tool para consultarla. Agrega RPC listar_ordenes_compra (scopeada por empresa_id directo, cap 20 filas) y su entrada correspondiente en lib/asistente-tools.js. Incluye revoke explícito de anon/authenticated desde el inicio (lección de 423b).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
