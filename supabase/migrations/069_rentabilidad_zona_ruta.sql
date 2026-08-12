-- ============================================================================
-- 069_rentabilidad_zona_ruta.sql
--
-- Innovación #5 (Mapa de Rentabilidad por Zona/Ruta), según
-- roadmap-innovaciones-distrib.md.
--
-- Contenido:
--   1. Columna empresas.config.costo_km: costo logístico configurable por
--      empresa ($/km), usado para estimar el costo de cada entrega. No
--      existe ningún dato de costo logístico en el schema (sin tabla de
--      flota, combustible, etc.), así que se modela como un único valor
--      editable por empresa dentro del jsonb que ya existe — sin migración
--      de columna nueva. Default conservador: $0 (no estima costo hasta que
--      el dueño lo cargue; mejor mostrar margen bruto sin costo restado que
--      inventar un número).
--   2. Vista v_rentabilidad_zona_ruta: una fila por (zona, ruta, fecha),
--      cruzando margen real ENTREGADO (no facturado: usa
--      pedido_items.cantidad_entregada, no cantidad pedida) contra el costo
--      logístico estimado de esa ruta (reportes_ruta.km_estimados × costo_km).
--
-- LIMITACIÓN CONOCIDA (documentada, no resuelta acá):
--   El margen depende de productos.costo estar cargado correctamente. Si un
--   producto tiene costo = 0 (default de la tabla) y no es realmente gratis,
--   esta vista va a mostrar margen inflado para esas líneas. No hay forma de
--   detectar eso desde SQL — es un problema de calidad de dato de carga de
--   catálogo, a validar manualmente antes de confiar en el reporte para
--   decisiones de zona.
-- ============================================================================

-- ── 1. Costo por km dentro de empresas.config (sin columna nueva) ──────────
-- Acceso desde JS: empresa.config?.costo_km ?? 0
-- Acceso desde SQL: (config->>'costo_km')::numeric
COMMENT ON COLUMN public.empresas.config IS
  'Config jsonb libre por empresa. Claves conocidas en uso: '
  'costo_km (numeric, $/km para estimar costo logístico — Innovación #5, '
  'default 0 si no está cargado, ver v_rentabilidad_zona_ruta).';

-- ── 2. Vista de rentabilidad por zona/ruta ──────────────────────────────────
CREATE OR REPLACE VIEW public.v_rentabilidad_zona_ruta AS
WITH margen_entrega AS (
  -- Margen real por entrega: SOLO lo efectivamente entregado
  -- (cantidad_entregada), no lo pedido. Si cantidad_entregada es NULL
  -- (entrega aún no confirmada / campo no usado en pedidos viejos), cae a
  -- cantidad pedida como mejor aproximación disponible.
  SELECT
    e.id            AS entrega_id,
    e.ruta_id,
    e.distancia_km,
    e.duracion_minutos,
    e.estado        AS estado_entrega,
    p.cliente_id,
    SUM(
      COALESCE(pi.cantidad_entregada, pi.cantidad)
      * (pi.precio_unitario - COALESCE(pr.costo, 0))
    ) AS margen_entrega,
    SUM(
      COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario
    ) AS facturado_entrega
  FROM public.entregas e
  JOIN public.pedidos p       ON p.id = e.pedido_id
  JOIN public.pedido_items pi ON pi.pedido_id = p.id
  JOIN public.productos pr    ON pr.id = pi.producto_id
  WHERE e.estado = 'entregado'
  GROUP BY e.id, e.ruta_id, e.distancia_km, e.duracion_minutos, e.estado, p.cliente_id
),
costo_km_empresa AS (
  -- Extraído aparte para no repetir el cast jsonb 4 veces ni arrastrar
  -- el config completo en el GROUP BY de la consulta final.
  SELECT id AS empresa_id, COALESCE((config->>'costo_km')::numeric, 0) AS costo_km
  FROM public.empresas
)
SELECT
  rt.empresa_id,
  z.id                                          AS zona_id,
  z.nombre                                      AS zona_nombre,
  rt.id                                         AS ruta_id,
  rt.fecha                                      AS ruta_fecha,
  rt.chofer_id,
  COUNT(DISTINCT me.entrega_id)                 AS entregas_completadas,
  SUM(me.margen_entrega)                        AS margen_total,
  SUM(me.facturado_entrega)                     AS facturado_total,
  SUM(me.distancia_km)                          AS km_recorridos,
  SUM(me.duracion_minutos)                      AS minutos_recorridos,
  ck.costo_km                                   AS costo_km_configurado,
  ROUND(SUM(me.distancia_km) * ck.costo_km, 2)  AS costo_logistico_estimado,
  ROUND(SUM(me.margen_entrega) - (SUM(me.distancia_km) * ck.costo_km), 2) AS margen_neto_estimado,
  -- Margen neto por km: la métrica que el roadmap pide para comparar zonas
  -- entre sí (una zona con mucho margen bruto pero muy dispersa puede rendir
  -- peor por km que una zona compacta con menos volumen).
  CASE
    WHEN SUM(me.distancia_km) > 0 THEN
      ROUND((SUM(me.margen_entrega) - (SUM(me.distancia_km) * ck.costo_km)) / SUM(me.distancia_km), 2)
    ELSE NULL
  END AS margen_neto_por_km
FROM margen_entrega me
JOIN public.rutas rt           ON rt.id = me.ruta_id
JOIN public.clientes c         ON c.id = me.cliente_id
LEFT JOIN public.zonas z       ON z.id = c.zona_id
JOIN costo_km_empresa ck       ON ck.empresa_id = rt.empresa_id
GROUP BY rt.empresa_id, z.id, z.nombre, rt.id, rt.fecha, rt.chofer_id, ck.costo_km
ORDER BY rt.fecha DESC, margen_neto_estimado DESC;

COMMENT ON VIEW public.v_rentabilidad_zona_ruta IS
  'Innovación #5 del roadmap: margen real ENTREGADO (no facturado — usa '
  'pedido_items.cantidad_entregada) por zona y ruta, cruzado contra costo '
  'logístico estimado (km recorridos × empresas.config.costo_km). '
  'margen_neto_por_km es la métrica recomendada para comparar zonas entre '
  'sí. Si costo_km no está configurado en empresas.config, '
  'costo_logistico_estimado da 0 y margen_neto_estimado == margen_total '
  '(solo margen bruto, sin penalizar por logística). '
  'Mismo patrón de seguridad que v_cc_proveedor / v_cobranza_priorizada: '
  'SIN security_invoker, consumir solo desde handler backend con '
  'SERVICE_ROLE_KEY filtrando por empresa_id — nunca exponer directo por '
  'PostgREST al browser.';
