-- ============================================================================
-- 246_etapa2_rentabilidad_producto_vendedor.sql
--
-- Etapa 2 (Comercial y precios) — Plan por etapas. Ítem 2/3:
-- "Panel de rentabilidad por producto y por vendedor (hoy solo existe por
-- zona)". La rentabilidad por zona (069_rentabilidad_zona_ruta.sql) sólo
-- cubre entregas de reparto con ruta asociada. Acá se cubren DOS fuentes de
-- venta, no una: pedidos entregados (reparto/mostrador con seguimiento de
-- pedido) Y ventas de mostrador del POS (072_pos.sql), que no pasan por
-- `entregas`/`rutas` y por lo tanto quedaban totalmente afuera del reporte
-- de zona.
--
-- Contenido:
--   1. v_rentabilidad_producto: margen por producto, agregado por día.
--   2. v_rentabilidad_vendedor: margen por vendedor, agregado por día.
--
-- Ambas vistas exponen una fila por (dimensión, fecha, origen) — se agregan
-- más en el handler/frontend según el rango de fechas pedido, mismo patrón
-- que v_rentabilidad_zona_ruta (una fila por ruta/fecha).
--
-- LIMITACIÓN CONOCIDA (documentada, no resuelta acá — mismo caso que 069):
-- el margen depende de productos.costo estar cargado correctamente. Un
-- producto con costo = 0 sin ser realmente gratis va a mostrar margen
-- inflado. No se puede detectar desde SQL.
--
-- SEGURIDAD: igual que v_rentabilidad_zona_ruta / v_cc_proveedor /
-- v_cobranza_priorizada — estas vistas NO llevan security_invoker ni RLS
-- propio. Se consumen exclusivamente desde el handler backend
-- (api/rutas-live, accion=rentabilidad-producto|rentabilidad-vendedor) con
-- SERVICE_ROLE_KEY, filtrando por empresa_id ahí. Nunca exponer directo por
-- PostgREST al browser.
-- ============================================================================

-- ── 1. Rentabilidad por producto ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_rentabilidad_producto AS
WITH lineas AS (
  -- Pedidos entregados: SOLO lo efectivamente entregado (cantidad_entregada),
  -- no lo pedido. Si cantidad_entregada es NULL (pedidos viejos que no la
  -- usan), cae a cantidad pedida como mejor aproximación disponible — mismo
  -- criterio que 069.
  SELECT
    p.empresa_id,
    pi.producto_id,
    COALESCE(p.fecha_entrega, p.fecha_pedido::date)                        AS fecha,
    COALESCE(pi.cantidad_entregada, pi.cantidad)                           AS cantidad,
    COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario      AS facturado,
    COALESCE(pi.cantidad_entregada, pi.cantidad)
      * (pi.precio_unitario - COALESCE(pr.costo, 0))                      AS margen,
    'pedido'::text AS origen
  FROM public.pedidos p
  JOIN public.pedido_items pi ON pi.pedido_id = p.id
  JOIN public.productos pr    ON pr.id = pi.producto_id
  WHERE p.estado = 'entregado'

  UNION ALL

  -- Ventas de mostrador (POS): venta_pos_items no tiene cantidad_entregada
  -- (no aplica — es venta inmediata, no hay etapa de reparto), se usa
  -- cantidad directo. Sólo ventas completadas (no anuladas).
  SELECT
    vp.empresa_id,
    vpi.producto_id,
    vp.created_at::date                                              AS fecha,
    vpi.cantidad,
    vpi.cantidad * vpi.precio_unitario                                AS facturado,
    vpi.cantidad * (vpi.precio_unitario - COALESCE(pr.costo, 0))     AS margen,
    'pos'::text AS origen
  FROM public.ventas_pos vp
  JOIN public.venta_pos_items vpi ON vpi.venta_pos_id = vp.id
  JOIN public.productos pr        ON pr.id = vpi.producto_id
  WHERE vp.estado = 'completada'
)
SELECT
  l.empresa_id,
  l.producto_id,
  pr.nombre                                            AS producto_nombre,
  pr.codigo                                             AS producto_codigo,
  pr.categoria_id,
  cat.nombre                                            AS categoria_nombre,
  l.fecha,
  l.origen,
  SUM(l.cantidad)                                       AS cantidad_vendida,
  SUM(l.facturado)                                      AS facturado_total,
  SUM(l.margen)                                         AS margen_total,
  CASE WHEN SUM(l.facturado) > 0
       THEN ROUND(SUM(l.margen) / SUM(l.facturado) * 100, 2)
       ELSE NULL
  END                                                    AS margen_pct
FROM lineas l
JOIN public.productos pr        ON pr.id = l.producto_id
LEFT JOIN public.categorias cat ON cat.id = pr.categoria_id
GROUP BY l.empresa_id, l.producto_id, pr.nombre, pr.codigo, pr.categoria_id, cat.nombre, l.fecha, l.origen
ORDER BY l.fecha DESC;

COMMENT ON VIEW public.v_rentabilidad_producto IS
  'Etapa 2 del plan por etapas (Comercial y precios): margen por producto, '
  'una fila por (producto, fecha, origen) — origen = pedido (reparto/mostrador '
  'con seguimiento) o pos (venta de mostrador). Usa cantidad_entregada cuando '
  'existe para pedidos. Margen depende de productos.costo estar cargado '
  '(si es 0 sin serlo realmente, el margen queda inflado — no detectable '
  'desde SQL). Mismo patrón de seguridad que v_rentabilidad_zona_ruta: SIN '
  'security_invoker, consumir solo desde el handler backend con '
  'SERVICE_ROLE_KEY filtrando por empresa_id.';

-- ── 2. Rentabilidad por vendedor ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_rentabilidad_vendedor AS
WITH lineas AS (
  SELECT
    p.empresa_id,
    p.vendedor_id,
    p.id                                                              AS doc_id,
    COALESCE(p.fecha_entrega, p.fecha_pedido::date)                   AS fecha,
    COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario AS facturado,
    COALESCE(pi.cantidad_entregada, pi.cantidad)
      * (pi.precio_unitario - COALESCE(pr.costo, 0))                 AS margen,
    'pedido'::text AS origen
  FROM public.pedidos p
  JOIN public.pedido_items pi ON pi.pedido_id = p.id
  JOIN public.productos pr    ON pr.id = pi.producto_id
  WHERE p.estado = 'entregado'

  UNION ALL

  SELECT
    vp.empresa_id,
    vp.vendedor_id,
    vp.id                                                          AS doc_id,
    vp.created_at::date                                            AS fecha,
    vpi.cantidad * vpi.precio_unitario                             AS facturado,
    vpi.cantidad * (vpi.precio_unitario - COALESCE(pr.costo, 0))  AS margen,
    'pos'::text AS origen
  FROM public.ventas_pos vp
  JOIN public.venta_pos_items vpi ON vpi.venta_pos_id = vp.id
  JOIN public.productos pr        ON pr.id = vpi.producto_id
  WHERE vp.estado = 'completada'
)
SELECT
  l.empresa_id,
  l.vendedor_id,
  u.nombre                                              AS vendedor_nombre,
  l.fecha,
  l.origen,
  COUNT(DISTINCT l.doc_id)                              AS documentos,
  SUM(l.facturado)                                      AS facturado_total,
  SUM(l.margen)                                         AS margen_total,
  CASE WHEN SUM(l.facturado) > 0
       THEN ROUND(SUM(l.margen) / SUM(l.facturado) * 100, 2)
       ELSE NULL
  END                                                    AS margen_pct
FROM lineas l
LEFT JOIN public.usuarios u ON u.id = l.vendedor_id
GROUP BY l.empresa_id, l.vendedor_id, u.nombre, l.fecha, l.origen
ORDER BY l.fecha DESC;

COMMENT ON VIEW public.v_rentabilidad_vendedor IS
  'Etapa 2 del plan por etapas (Comercial y precios): margen por vendedor, '
  'una fila por (vendedor, fecha, origen) — origen = pedido o pos. '
  'vendedor_id puede ser NULL (pedido/venta sin vendedor asignado) — se '
  'agrupa igual, el frontend lo debe mostrar como "Sin vendedor asignado". '
  'Mismo patrón de seguridad que v_rentabilidad_zona_ruta: SIN '
  'security_invoker, consumir solo desde el handler backend con '
  'SERVICE_ROLE_KEY filtrando por empresa_id.';

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '246_etapa2_rentabilidad_producto_vendedor.sql',
  '246',
  'claude_assistant',
  'Etapa 2 del plan por etapas (Comercial y precios), ítem 2/3: vistas v_rentabilidad_producto y v_rentabilidad_vendedor, combinando pedidos entregados + ventas de mostrador POS (esta última fuente no estaba cubierta por el reporte de rentabilidad por zona/ruta, que solo mira entregas con ruta asociada). Expuestas vía /api/rutas-live?accion=rentabilidad-producto|rentabilidad-vendedor.'
)
ON CONFLICT DO NOTHING;
