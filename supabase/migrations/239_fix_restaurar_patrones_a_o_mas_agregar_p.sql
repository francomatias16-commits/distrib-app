-- ============================================================================
-- 239_fix_restaurar_patrones_a_o_mas_agregar_p.sql
--
-- FIX DE INCIDENTE: la migración 238 reemplazó detectar_anomalias_auditoria
-- con un CREATE OR REPLACE que sólo incluía los patrones (a)-(c) + (p),
-- perdiendo los patrones (d)-(o) que ya estaban en producción (agregados
-- en la migración 233 y corregidos por 234/235). Esta migración restaura
-- la función completa (16 patrones: a-p) tal como quedó vigente en
-- producción, incorporando también los fixes 234 y 235:
--
--   234_fix_make_interval_horas_nc_veloz:
--     patrón (h) — make_interval(hours => numeric) no existe;
--     se reemplaza por (v_horas_nc_post_factura * interval '1 hour').
--
--   235_fix_timestamptz_cast_puntos_manual:
--     patrón (l) — cast explícito a timestamptz en MIN/MAX(mp.created_at)
--     para que coincida con el tipo de retorno de la función.
--
-- Nota: el patrón (c) también difiere levemente del texto original de
-- 233 (join a depositos + filtro por tipo IN (...) y referencia NOT ILIKE
-- 'OC:%') porque esa era la versión vigente en producción al momento del
-- incidente, no la del archivo 233 tal cual quedó en el repo.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.detectar_anomalias_auditoria(
  p_empresa_id     uuid,
  p_dias_lookback  integer DEFAULT 7
)
RETURNS TABLE (
  tipo_anomalia     text,
  severidad         text,
  usuario_id        uuid,
  usuario_nombre    text,
  entidad_tipo      text,
  entidad_id        uuid,
  entidad_nombre    text,
  cantidad_eventos  integer,
  monto_estimado    numeric,
  detalle           jsonb,
  primer_evento     timestamptz,
  ultimo_evento     timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_desde                      timestamptz := now() - make_interval(days => p_dias_lookback);
  v_desde_prev                 timestamptz := now() - make_interval(days => p_dias_lookback * 2);
  v_umbral_descuento_vendedor  CONSTANT integer := 3;
  v_umbral_descuento_cliente   CONSTANT integer := 3;
  v_umbral_ajustes             CONSTANT integer := 3;
  v_umbral_anulaciones         CONSTANT integer := 3;
  v_descuento_maximo_pct       CONSTANT numeric  := 30;
  v_umbral_precio_bajo         CONSTANT integer := 3;
  v_precio_bajo_ratio          CONSTANT numeric  := 0.85;
  v_horas_nc_post_factura      CONSTANT numeric  := 24;
  v_umbral_nc_veloz            CONSTANT integer := 2;
  v_umbral_cobro_sin_cta       CONSTANT integer := 3;
  v_umbral_puntos_manual       CONSTANT integer := 3;
  v_minutos_entrega_veloz      CONSTANT numeric  := 2;
  v_umbral_entrega_veloz       CONSTANT integer := 2;
  v_umbral_stock_madrugada     CONSTANT integer := 3;
  v_umbral_volumen_min         CONSTANT integer := 8;
  v_ratio_volumen_anomalo      CONSTANT numeric  := 3;
  v_umbral_horas_turno_abierto CONSTANT numeric  := 12;
BEGIN

  -- (a) Vendedor con descuentos frecuentes (cualquier cliente) ───────────────
  RETURN QUERY
  SELECT
    'descuento_repetido_vendedor'::text,
    CASE WHEN COUNT(DISTINCT p.id) >= v_umbral_descuento_vendedor * 2 THEN 'alta' ELSE 'media' END,
    p.vendedor_id,
    u.nombre,
    'vendedor'::text,
    p.vendedor_id,
    u.nombre,
    COUNT(DISTINCT p.id)::integer,
    SUM(pi.cantidad * pi.precio_unitario * pi.descuento_pct / 100.0),
    jsonb_build_object('pedidos', jsonb_agg(DISTINCT jsonb_build_object(
      'pedido_id', p.id, 'numero_pedido', p.numero_pedido,
      'cliente_id', p.cliente_id, 'descuento_pct', pi.descuento_pct,
      'fecha', p.created_at
    ))),
    MIN(p.created_at),
    MAX(p.created_at)
  FROM public.pedido_items pi
  JOIN public.pedidos p ON p.id = pi.pedido_id
  JOIN public.usuarios u ON u.id = p.vendedor_id
  WHERE p.empresa_id = p_empresa_id
    AND p.vendedor_id IS NOT NULL
    AND p.estado NOT IN ('borrador', 'cancelado', 'sugerido')
    AND p.created_at >= v_desde
    AND pi.descuento_pct > 0
  GROUP BY p.vendedor_id, u.nombre
  HAVING COUNT(DISTINCT p.id) >= v_umbral_descuento_vendedor;

  -- (b) Mismo vendedor + mismo cliente, descuento repetido ────────────────────
  RETURN QUERY
  SELECT
    'descuento_repetido_vendedor_cliente'::text,
    CASE WHEN COUNT(DISTINCT p.id) >= v_umbral_descuento_cliente * 2 THEN 'alta' ELSE 'media' END,
    p.vendedor_id,
    u.nombre,
    'cliente'::text,
    p.cliente_id,
    c.razon_social,
    COUNT(DISTINCT p.id)::integer,
    SUM(pi.cantidad * pi.precio_unitario * pi.descuento_pct / 100.0),
    jsonb_build_object('pedidos', jsonb_agg(DISTINCT jsonb_build_object(
      'pedido_id', p.id, 'numero_pedido', p.numero_pedido,
      'descuento_pct', pi.descuento_pct, 'fecha', p.created_at
    ))),
    MIN(p.created_at),
    MAX(p.created_at)
  FROM public.pedido_items pi
  JOIN public.pedidos p  ON p.id = pi.pedido_id
  JOIN public.usuarios u ON u.id = p.vendedor_id
  JOIN public.clientes c ON c.id = p.cliente_id
  WHERE p.empresa_id = p_empresa_id
    AND p.vendedor_id IS NOT NULL
    AND p.estado NOT IN ('borrador', 'cancelado', 'sugerido')
    AND p.created_at >= v_desde
    AND pi.descuento_pct > 0
  GROUP BY p.vendedor_id, u.nombre, p.cliente_id, c.razon_social
  HAVING COUNT(DISTINCT p.id) >= v_umbral_descuento_cliente;

  -- (c) Ajustes de stock sin orden de compra de respaldo ──────────────────────
  RETURN QUERY
  SELECT
    'ajuste_stock_sin_respaldo'::text,
    CASE WHEN COUNT(*) >= v_umbral_ajustes * 2 THEN 'alta' ELSE 'media' END,
    ms.usuario_id,
    u2.nombre,
    'usuario'::text,
    ms.usuario_id,
    u2.nombre,
    COUNT(*)::integer,
    SUM(COALESCE(ms.costo_unitario, 0) * ms.cantidad),
    jsonb_build_object('movimientos', jsonb_agg(jsonb_build_object(
      'id', ms.id, 'producto_id', ms.producto_id, 'tipo', ms.tipo,
      'cantidad', ms.cantidad, 'notas', ms.notas, 'fecha', ms.created_at
    ))),
    MIN(ms.created_at),
    MAX(ms.created_at)
  FROM public.movimientos_stock ms
  JOIN public.depositos d       ON d.id = ms.deposito_id
  LEFT JOIN public.usuarios u2  ON u2.id = ms.usuario_id
  WHERE d.empresa_id = p_empresa_id
    AND ms.tipo IN ('ajuste', 'ingreso', 'egreso')
    AND (ms.referencia IS NULL OR ms.referencia NOT ILIKE 'OC:%')
    AND ms.created_at >= v_desde
  GROUP BY ms.usuario_id, u2.nombre
  HAVING COUNT(*) >= v_umbral_ajustes;

  -- (d) Movimientos de stock modificados o eliminados (vía audit_log) ─────────
  RETURN QUERY
  SELECT
    'movimiento_stock_alterado'::text,
    'alta'::text,
    al.usuario_id,
    u3.nombre,
    'movimiento_stock'::text,
    NULL::uuid,
    NULL::text,
    COUNT(*)::integer,
    NULL::numeric,
    jsonb_build_object('eventos', jsonb_agg(jsonb_build_object(
      'registro_id', al.registro_id, 'accion', al.accion,
      'fecha', al.created_at, 'antes', al.datos_antes, 'despues', al.datos_despues
    ))),
    MIN(al.created_at),
    MAX(al.created_at)
  FROM public.audit_log al
  LEFT JOIN public.usuarios u3 ON u3.id = al.usuario_id
  WHERE al.empresa_id = p_empresa_id
    AND al.tabla = 'movimientos_stock'
    AND al.accion IN ('UPDATE', 'DELETE')
    AND al.created_at >= v_desde
  GROUP BY al.usuario_id, u3.nombre;

  -- (e) Vendedor con pedidos cancelados repetidos ─────────────────────────────
  RETURN QUERY
  SELECT
    'pedido_anulado_repetido'::text,
    CASE WHEN COUNT(*) >= v_umbral_anulaciones * 2 THEN 'alta' ELSE 'media' END,
    p.vendedor_id,
    u.nombre,
    'vendedor'::text,
    p.vendedor_id,
    u.nombre,
    COUNT(*)::integer,
    SUM(p.total),
    jsonb_build_object('pedidos', jsonb_agg(jsonb_build_object(
      'pedido_id', p.id, 'numero_pedido', p.numero_pedido,
      'cliente_id', p.cliente_id, 'total', p.total, 'fecha', p.created_at
    ))),
    MIN(p.created_at),
    MAX(p.created_at)
  FROM public.pedidos p
  JOIN public.usuarios u ON u.id = p.vendedor_id
  WHERE p.empresa_id = p_empresa_id
    AND p.vendedor_id IS NOT NULL
    AND p.estado = 'cancelado'
    AND p.created_at >= v_desde
  GROUP BY p.vendedor_id, u.nombre
  HAVING COUNT(*) >= v_umbral_anulaciones;

  -- (f) Ítem con descuento que excede el máximo razonable (evento único) ──────
  RETURN QUERY
  SELECT
    'descuento_excede_maximo'::text,
    'alta'::text,
    p.vendedor_id,
    u.nombre,
    'cliente'::text,
    p.cliente_id,
    c.razon_social,
    COUNT(*)::integer,
    SUM(pi.cantidad * pi.precio_unitario * pi.descuento_pct / 100.0),
    jsonb_build_object('pedidos', jsonb_agg(jsonb_build_object(
      'pedido_id', p.id, 'numero_pedido', p.numero_pedido,
      'descuento_pct', pi.descuento_pct, 'fecha', p.created_at
    ))),
    MIN(p.created_at),
    MAX(p.created_at)
  FROM public.pedido_items pi
  JOIN public.pedidos p  ON p.id = pi.pedido_id
  JOIN public.usuarios u ON u.id = p.vendedor_id
  JOIN public.clientes c ON c.id = p.cliente_id
  WHERE p.empresa_id = p_empresa_id
    AND p.vendedor_id IS NOT NULL
    AND p.estado NOT IN ('borrador', 'cancelado', 'sugerido')
    AND p.created_at >= v_desde
    AND pi.descuento_pct >= v_descuento_maximo_pct
  GROUP BY p.vendedor_id, u.nombre, p.cliente_id, c.razon_social;

  -- (g) Vendedor cargando precio manual por debajo del precio de lista ────────
  RETURN QUERY
  SELECT
    'precio_manual_bajo_lista'::text,
    CASE WHEN COUNT(*) >= v_umbral_precio_bajo * 2 THEN 'alta' ELSE 'media' END,
    p.vendedor_id,
    u.nombre,
    'vendedor'::text,
    p.vendedor_id,
    u.nombre,
    COUNT(*)::integer,
    SUM((pr.precio_base - pi.precio_unitario) * pi.cantidad),
    jsonb_build_object('items', jsonb_agg(jsonb_build_object(
      'pedido_id', p.id, 'numero_pedido', p.numero_pedido,
      'producto_id', pr.id, 'producto_nombre', pr.nombre,
      'precio_lista', pr.precio_base, 'precio_cargado', pi.precio_unitario,
      'fecha', p.created_at
    ))),
    MIN(p.created_at),
    MAX(p.created_at)
  FROM public.pedido_items pi
  JOIN public.pedidos p    ON p.id = pi.pedido_id
  JOIN public.usuarios u   ON u.id = p.vendedor_id
  JOIN public.productos pr ON pr.id = pi.producto_id
  WHERE p.empresa_id = p_empresa_id
    AND p.vendedor_id IS NOT NULL
    AND p.estado NOT IN ('borrador', 'cancelado', 'sugerido')
    AND p.created_at >= v_desde
    AND pr.precio_base > 0
    AND pi.precio_unitario < pr.precio_base * v_precio_bajo_ratio
  GROUP BY p.vendedor_id, u.nombre
  HAVING COUNT(*) >= v_umbral_precio_bajo;

  -- (h) Nota de crédito emitida muy poco después de la factura original ───────
  -- Fix 234: make_interval(hours => numeric) no existe.
  RETURN QUERY
  SELECT
    'nota_credito_veloz_post_factura'::text,
    CASE WHEN COUNT(*) >= v_umbral_nc_veloz * 2 THEN 'alta' ELSE 'media' END,
    nc.created_by,
    u.nombre,
    'cliente'::text,
    nc.cliente_id,
    c.razon_social,
    COUNT(*)::integer,
    SUM(nc.total),
    jsonb_build_object('notas_credito', jsonb_agg(jsonb_build_object(
      'nota_credito_id', nc.id, 'factura_id', nc.factura_id,
      'motivo', nc.motivo, 'total', nc.total,
      'horas_desde_factura', ROUND(EXTRACT(EPOCH FROM (nc.created_at - f.fecha_emision)) / 3600.0, 1),
      'fecha', nc.created_at
    ))),
    MIN(nc.created_at),
    MAX(nc.created_at)
  FROM public.notas_credito nc
  JOIN public.facturas f  ON f.id = nc.factura_id
  JOIN public.clientes c  ON c.id = nc.cliente_id
  LEFT JOIN public.usuarios u ON u.id = nc.created_by
  WHERE nc.empresa_id = p_empresa_id
    AND nc.factura_id IS NOT NULL
    AND nc.created_at >= v_desde
    AND nc.created_at <= f.fecha_emision + (v_horas_nc_post_factura * interval '1 hour')
  GROUP BY nc.created_by, u.nombre, nc.cliente_id, c.razon_social
  HAVING COUNT(*) >= v_umbral_nc_veloz;

  -- (i) Cheque marcado como rechazado pero con un cobro vinculado ─────────────
  RETURN QUERY
  SELECT
    'cheque_rechazado_con_cobro_vinculado'::text,
    'alta'::text,
    NULL::uuid,
    NULL::text,
    'cliente'::text,
    ch.cliente_id,
    c.razon_social,
    COUNT(*)::integer,
    SUM(ch.monto),
    jsonb_build_object('cheques', jsonb_agg(jsonb_build_object(
      'cheque_id', ch.id, 'banco', ch.banco, 'numero', ch.numero,
      'monto', ch.monto, 'cobro_id', ch.cobro_id, 'fecha', ch.created_at
    ))),
    MIN(ch.created_at),
    MAX(ch.created_at)
  FROM public.cheques ch
  JOIN public.clientes c ON c.id = ch.cliente_id
  WHERE ch.empresa_id = p_empresa_id
    AND ch.estado = 'rechazado'
    AND ch.cobro_id IS NOT NULL
    AND ch.created_at >= v_desde
  GROUP BY ch.cliente_id, c.razon_social;

  -- (j) Cobro registrado sin movimiento de cuenta corriente que lo respalde ───
  RETURN QUERY
  SELECT
    'cobro_sin_respaldo_cta_cte'::text,
    CASE WHEN COUNT(*) >= v_umbral_cobro_sin_cta * 2 THEN 'alta' ELSE 'media' END,
    co.usuario_id,
    u.nombre,
    'usuario'::text,
    co.usuario_id,
    u.nombre,
    COUNT(*)::integer,
    SUM(co.monto),
    jsonb_build_object('cobros', jsonb_agg(jsonb_build_object(
      'cobro_id', co.id, 'cliente_id', co.cliente_id, 'monto', co.monto,
      'medio', co.medio, 'fecha', co.fecha
    ))),
    MIN(co.fecha),
    MAX(co.fecha)
  FROM public.cobros co
  LEFT JOIN public.usuarios u ON u.id = co.usuario_id
  WHERE co.empresa_id = p_empresa_id
    AND co.fecha >= v_desde
    AND NOT EXISTS (
      SELECT 1 FROM public.cta_cte cc WHERE cc.cobro_id = co.id
    )
  GROUP BY co.usuario_id, u.nombre
  HAVING COUNT(*) >= v_umbral_cobro_sin_cta;

  -- (k) Pedido cargado a un cliente después de haber sido bloqueado ───────────
  RETURN QUERY
  SELECT
    'cliente_bloqueado_con_pedido_posterior'::text,
    'alta'::text,
    p.vendedor_id,
    u.nombre,
    'cliente'::text,
    p.cliente_id,
    c.razon_social,
    COUNT(*)::integer,
    SUM(p.total),
    jsonb_build_object('pedidos', jsonb_agg(jsonb_build_object(
      'pedido_id', p.id, 'numero_pedido', p.numero_pedido,
      'total', p.total, 'motivo_bloqueo', bc.motivo,
      'bloqueado_desde', bc.updated_at, 'fecha_pedido', p.created_at
    ))),
    MIN(p.created_at),
    MAX(p.created_at)
  FROM public.pedidos p
  JOIN public.bloqueos_cliente bc ON bc.cliente_id = p.cliente_id AND bc.empresa_id = p.empresa_id
  JOIN public.clientes c          ON c.id = p.cliente_id
  LEFT JOIN public.usuarios u     ON u.id = p.vendedor_id
  WHERE p.empresa_id = p_empresa_id
    AND bc.activo = true
    AND p.estado NOT IN ('borrador', 'cancelado')
    AND p.created_at >= v_desde
    AND p.created_at > bc.updated_at
  GROUP BY p.vendedor_id, u.nombre, p.cliente_id, c.razon_social;

  -- (l) Puntos de fidelización sumados manualmente sin pedido asociado ────────
  -- Fix 235: cast explícito a timestamptz en MIN/MAX.
  RETURN QUERY
  SELECT
    'ajuste_puntos_manual_sin_pedido'::text,
    CASE WHEN COUNT(*) >= v_umbral_puntos_manual * 2 THEN 'alta' ELSE 'media' END,
    NULL::uuid,
    NULL::text,
    'cliente'::text,
    mp.cliente_id,
    c.razon_social,
    COUNT(*)::integer,
    SUM(mp.cantidad),
    jsonb_build_object('movimientos', jsonb_agg(jsonb_build_object(
      'movimiento_id', mp.id, 'cantidad', mp.cantidad, 'motivo', mp.motivo,
      'fecha', mp.created_at
    ))),
    MIN(mp.created_at)::timestamptz,
    MAX(mp.created_at)::timestamptz
  FROM public.movimientos_puntos mp
  JOIN public.clientes c ON c.id = mp.cliente_id
  WHERE mp.empresa_id = p_empresa_id
    AND mp.tipo = 'ganancia'
    AND mp.referencia_id IS NULL
    AND mp.created_at >= v_desde
  GROUP BY mp.cliente_id, c.razon_social
  HAVING COUNT(*) >= v_umbral_puntos_manual;

  -- (m) Entregas de una misma ruta confirmadas con diferencia de tiempo mínima
  RETURN QUERY
  SELECT
    'entrega_secuencia_veloz'::text,
    'media'::text,
    r.chofer_id,
    u.nombre,
    'ruta'::text,
    r.id,
    ('Ruta del ' || to_char(r.fecha, 'DD/MM/YYYY'))::text,
    COUNT(*)::integer,
    NULL::numeric,
    jsonb_build_object('pares_veloces', jsonb_agg(jsonb_build_object(
      'entrega_id', sub.id, 'orden', sub.orden,
      'minutos_desde_anterior', sub.minutos_gap, 'fecha', sub.fecha_confirmacion
    ))),
    MIN(sub.fecha_confirmacion),
    MAX(sub.fecha_confirmacion)
  FROM (
    SELECT
      e.id, e.ruta_id, e.orden, e.fecha_confirmacion,
      EXTRACT(EPOCH FROM (e.fecha_confirmacion - LAG(e.fecha_confirmacion) OVER (
        PARTITION BY e.ruta_id ORDER BY e.orden
      ))) / 60.0 AS minutos_gap
    FROM public.entregas e
    JOIN public.rutas ru ON ru.id = e.ruta_id
    WHERE ru.empresa_id = p_empresa_id
      AND e.estado = 'entregado'
      AND e.fecha_confirmacion >= v_desde
  ) sub
  JOIN public.rutas r     ON r.id = sub.ruta_id
  LEFT JOIN public.usuarios u ON u.id = r.chofer_id
  WHERE sub.minutos_gap IS NOT NULL
    AND sub.minutos_gap >= 0
    AND sub.minutos_gap < v_minutos_entrega_veloz
  GROUP BY r.id, r.chofer_id, u.nombre, r.fecha
  HAVING COUNT(*) >= v_umbral_entrega_veloz;

  -- (n) Movimientos de stock cargados de madrugada (fuera de horario habitual)
  RETURN QUERY
  SELECT
    'actividad_stock_fuera_horario'::text,
    CASE WHEN COUNT(*) >= v_umbral_stock_madrugada * 2 THEN 'alta' ELSE 'media' END,
    ms.usuario_id,
    u.nombre,
    'usuario'::text,
    ms.usuario_id,
    u.nombre,
    COUNT(*)::integer,
    NULL::numeric,
    jsonb_build_object('movimientos', jsonb_agg(jsonb_build_object(
      'id', ms.id, 'producto_id', ms.producto_id, 'tipo', ms.tipo,
      'cantidad', ms.cantidad, 'hora', to_char(ms.created_at, 'HH24:MI'),
      'fecha', ms.created_at
    ))),
    MIN(ms.created_at),
    MAX(ms.created_at)
  FROM public.movimientos_stock ms
  JOIN public.depositos d     ON d.id = ms.deposito_id
  LEFT JOIN public.usuarios u ON u.id = ms.usuario_id
  WHERE d.empresa_id = p_empresa_id
    AND ms.usuario_id IS NOT NULL
    AND ms.created_at >= v_desde
    AND EXTRACT(HOUR FROM ms.created_at) BETWEEN 0 AND 5
  GROUP BY ms.usuario_id, u.nombre
  HAVING COUNT(*) >= v_umbral_stock_madrugada;

  -- (o) Volumen de pedidos de un vendedor muy por encima de su propio promedio
  RETURN QUERY
  WITH actual AS (
    SELECT vendedor_id, COUNT(*) AS n, MIN(created_at) AS desde, MAX(created_at) AS hasta
    FROM public.pedidos
    WHERE empresa_id = p_empresa_id
      AND vendedor_id IS NOT NULL
      AND estado NOT IN ('borrador', 'sugerido')
      AND created_at >= v_desde
    GROUP BY vendedor_id
  ),
  previo AS (
    SELECT vendedor_id, COUNT(*) AS n
    FROM public.pedidos
    WHERE empresa_id = p_empresa_id
      AND vendedor_id IS NOT NULL
      AND estado NOT IN ('borrador', 'sugerido')
      AND created_at >= v_desde_prev
      AND created_at < v_desde
    GROUP BY vendedor_id
  )
  SELECT
    'volumen_pedidos_anomalo_vendedor'::text,
    'media'::text,
    a.vendedor_id,
    u.nombre,
    'vendedor'::text,
    a.vendedor_id,
    u.nombre,
    a.n::integer,
    NULL::numeric,
    jsonb_build_object(
      'pedidos_ventana_actual', a.n,
      'pedidos_ventana_previa', COALESCE(p2.n, 0),
      'dias_lookback', p_dias_lookback
    ),
    a.desde,
    a.hasta
  FROM actual a
  JOIN public.usuarios u ON u.id = a.vendedor_id
  LEFT JOIN previo p2 ON p2.vendedor_id = a.vendedor_id
  WHERE a.n >= v_umbral_volumen_min
    AND a.n >= COALESCE(p2.n, 0) * v_ratio_volumen_anomalo
    AND COALESCE(p2.n, 0) > 0;

  -- (p) Turno de caja abierto hace más de v_umbral_horas_turno_abierto horas ──
  -- Patrón de ESTADO ACTUAL, no de ventana histórica: no se filtra por
  -- p_dias_lookback / v_desde, sino contra "ahora". Por eso puede volver a
  -- notificar cada noche mientras el turno siga sin cerrarse — es
  -- intencional, no un bug de idempotencia (ver 238).
  -- NOTA: el make_interval(hours => ...) de este bloque tenía el mismo
  -- bug numeric/integer que (h); corregido en la migración 240.
  RETURN QUERY
  SELECT
    'turno_caja_abierto_prolongado'::text,
    CASE WHEN EXTRACT(EPOCH FROM (now() - tc.abierto_at)) / 3600.0 >= 24 THEN 'alta' ELSE 'media' END,
    tc.usuario_id,
    u3.nombre,
    'caja'::text,
    tc.caja_id,
    cp.nombre,
    ROUND(EXTRACT(EPOCH FROM (now() - tc.abierto_at)) / 3600.0)::integer,
    tc.monto_inicial,
    jsonb_build_object(
      'turno_id', tc.id,
      'caja_nombre', cp.nombre,
      'usuario_nombre', u3.nombre,
      'abierto_at', tc.abierto_at,
      'horas_abiertas', ROUND(EXTRACT(EPOCH FROM (now() - tc.abierto_at)) / 3600.0, 1)
    ),
    tc.abierto_at,
    tc.abierto_at
  FROM public.turnos_caja tc
  JOIN public.cajas_pos cp    ON cp.id = tc.caja_id
  LEFT JOIN public.usuarios u3 ON u3.id = tc.usuario_id
  WHERE cp.empresa_id = p_empresa_id
    AND tc.estado = 'abierto'
    AND tc.abierto_at <= now() - make_interval(hours => v_umbral_horas_turno_abierto);

END;
$$;

COMMENT ON FUNCTION public.detectar_anomalias_auditoria IS
  'Innovación #6 del roadmap (233, fixes 234/235, 238 patrón p — incidente '
  'restaurado en 239). Devuelve una fila por patrón sospechoso agrupado '
  'por usuario/entidad. Los patrones (a)-(o) son de comportamiento en los '
  'últimos p_dias_lookback días; (p) turno_caja_abierto_prolongado evalúa '
  'el estado ACTUAL de cajas abiertas sin cerrar, sin importar la '
  'ventana. SECURITY DEFINER: sólo service_role.';

REVOKE ALL ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) TO service_role;
