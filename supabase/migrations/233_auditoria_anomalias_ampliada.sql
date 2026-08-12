-- ============================================================================
-- 233_auditoria_anomalias_ampliada.sql
--
-- Amplía la Innovación #6 (Auditoría Predictiva, 070_auditoria_anomalias.sql)
-- con 11 patrones sospechosos nuevos, a pedido del cliente para que la
-- sección "Patrones sospechosos" (/admin/anomalias) refleje TODO lo que el
-- sistema puede realmente detectar hoy con los datos que ya tiene.
--
-- Los 4 patrones originales (a-d) NO se tocan. Se agregan (e)-(o):
--
--   e) pedido_anulado_repetido            — vendedor con muchos pedidos
--      cancelados en la ventana (pedidos.estado = 'cancelado').
--   f) descuento_excede_maximo            — un ítem con descuento_pct muy
--      por encima del máximo razonable (>=30%), sin importar frecuencia
--      (a diferencia de (a), acá UN solo evento ya es la señal).
--   g) precio_manual_bajo_lista           — vendedor cargando precio_unitario
--      por debajo del precio de lista (productos.precio_base) repetidas veces.
--   h) nota_credito_veloz_post_factura    — nota de crédito emitida muy poco
--      después de la factura original (notas_credito + facturas).
--   i) cheque_rechazado_con_cobro_vinculado — inconsistencia de datos: un
--      cheque marcado 'rechazado' que sigue vinculado a un cobro (cobro_id).
--   j) cobro_sin_respaldo_cta_cte         — cobro registrado sin el
--      movimiento correspondiente en cta_cte (posible cobro no asentado).
--   k) cliente_bloqueado_con_pedido_posterior — pedido cargado a un cliente
--      DESPUÉS de que se lo bloqueara por deuda/riesgo.
--   l) ajuste_puntos_manual_sin_pedido    — puntos de fidelización sumados
--      manualmente (tipo='ganancia', referencia_id NULL) sin pedido asociado.
--   m) entrega_secuencia_veloz            — entregas de una misma ruta
--      confirmadas con muy poca diferencia de tiempo entre sí (posible
--      marcado en bloque sin visitar realmente al cliente).
--   n) actividad_stock_fuera_horario      — movimientos de stock cargados de
--      madrugada (00:00–05:59), fuera del horario operativo habitual.
--   o) volumen_pedidos_anomalo_vendedor   — un vendedor cuya cantidad de
--      pedidos en la ventana es varias veces su propio promedio reciente
--      (proxy de actividad automatizada o cuenta comprometida, ya que el
--      sistema no tiene tabla de sesiones/login para medirlo directamente).
--
-- NOTA IMPORTANTE — lo que NO se incluye y por qué (para no prometer algo
-- que el sistema no puede sostener con evidencia real):
--   · Accesos por IP/ubicación o sesiones simultáneas: no existe tabla de
--     sesiones/login. Requeriría agregar un registro de accesos.
--   · Geolocalización de la entrega vs. domicilio del cliente: `entregas`
--     no guarda lat/lng propia al momento de la confirmación, sólo existe
--     `rutas.chofer_lat/lng` como posición ACTUAL (no un snapshot histórico
--     por entrega), así que comparar contra clientes.lat/lng dar
--     igual da falsos positivos/negativos.
--   · Canje de puntos a cuentas relacionadas: `canjes_recompensas` no tiene
--     un campo de destinatario distinto del cliente dueño de la cuenta.
--   · Auto-escalación de permisos: la tabla `usuarios` no tiene trigger de
--     auditoría (015_audit_log.sql sólo cubre productos.precio_base y
--     movimientos_stock).
-- Estos 4 quedan documentados como roadmap futuro, no simulados con datos
-- falsos.
--
-- Misma convención de seguridad que 070 (SECURITY DEFINER, revocado de
-- PUBLIC, sólo service_role vía handler que ya valida dueño/admin).
-- ============================================================================

-- ── Índices de soporte para las nuevas consultas ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pedidos_vendedor_estado_creado
  ON public.pedidos (empresa_id, vendedor_id, estado, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notas_credito_factura
  ON public.notas_credito (factura_id) WHERE factura_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cheques_estado_cobro
  ON public.cheques (empresa_id, estado) WHERE cobro_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_movimientos_puntos_cliente_tipo
  ON public.movimientos_puntos (empresa_id, cliente_id, tipo, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entregas_ruta_confirmacion
  ON public.entregas (ruta_id, fecha_confirmacion) WHERE fecha_confirmacion IS NOT NULL;

-- ── RPC ampliada (CREATE OR REPLACE: misma firma, se agregan RETURN QUERY) ──
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
  v_precio_bajo_ratio          CONSTANT numeric  := 0.85; -- 15% o más por debajo del precio de lista
  v_horas_nc_post_factura      CONSTANT numeric  := 24;
  v_umbral_nc_veloz            CONSTANT integer := 2;
  v_umbral_cobro_sin_cta       CONSTANT integer := 3;
  v_umbral_puntos_manual       CONSTANT integer := 3;
  v_minutos_entrega_veloz      CONSTANT numeric  := 2;
  v_umbral_entrega_veloz       CONSTANT integer := 2;
  v_umbral_stock_madrugada     CONSTANT integer := 3;
  v_umbral_volumen_min         CONSTANT integer := 8;
  v_ratio_volumen_anomalo      CONSTANT numeric  := 3;
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
    AND nc.created_at <= f.fecha_emision + make_interval(hours => v_horas_nc_post_factura)
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
    MIN(mp.created_at),
    MAX(mp.created_at)
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
    AND COALESCE(p2.n, 0) > 0; -- exige historial previo real, para no marcar vendedores nuevos

END;
$$;

COMMENT ON FUNCTION public.detectar_anomalias_auditoria IS
  'Innovación #6 del roadmap, ampliada (233). Devuelve una fila por patrón '
  'sospechoso agrupado por usuario/entidad en los últimos p_dias_lookback '
  'días: descuentos repetidos y fuera de rango, precio manual bajo lista, '
  'pedidos cancelados repetidos, ajustes/movimientos de stock sin respaldo '
  'o fuera de horario, notas de crédito veloces, cheques rechazados con '
  'cobro vinculado, cobros sin respaldo contable, pedidos a clientes '
  'bloqueados, ajustes manuales de puntos, entregas confirmadas en '
  'secuencia sospechosamente veloz y picos de volumen por vendedor. '
  'SECURITY DEFINER: sólo service_role.';

-- Se re-declara por las dudas (CREATE OR REPLACE no toca privilegios, pero
-- si algún entorno nunca corrió 070/142 en este orden, esto lo deja bien).
REVOKE ALL ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) TO service_role;
