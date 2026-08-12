-- ============================================================================
-- 070_auditoria_anomalias.sql
--
-- Innovación #6 (Auditoría Predictiva de Anomalías Internas), según
-- roadmap-innovaciones-distrib.md.
--
-- Roadmap original decía "Base: audit_log, movimientos_stock" — en la
-- práctica se usan ambas, más pedidos/pedido_items (los descuentos NO tienen
-- trigger de auditoría hoy: 015_audit_log.sql sólo cubre productos.precio_base
-- y movimientos_stock, así que para "descuentos repetidos" se consulta
-- pedido_items directo, no audit_log).
--
-- Contenido:
--   1. RPC detectar_anomalias_auditoria(p_empresa_id, p_dias_lookback):
--      corre 4 detecciones sobre una ventana móvil de N días y devuelve una
--      fila por patrón sospechoso encontrado (agrupado por usuario/entidad,
--      no evento por evento, para no inundar de avisos):
--
--        a) descuento_repetido_vendedor — un vendedor aplicó descuento_pct>0
--           en >= UMBRAL_DESCUENTO_VENDEDOR pedidos distintos en la ventana.
--        b) descuento_repetido_vendedor_cliente — el mismo vendedor le dio
--           descuento al mismo cliente >= UMBRAL_DESCUENTO_CLIENTE veces
--           seguidas (señal de trato preferencial / posible retorno).
--        c) ajuste_stock_sin_respaldo — movimientos_stock tipo
--           ajuste/ingreso/egreso SIN referencia a una OC (la convención real
--           del sistema, ver 017_req01_02_03.sql, es referencia = 'OC:<id>'
--           para entradas legítimas por compra), repetidos por el mismo
--           usuario >= UMBRAL_AJUSTES veces.
--        d) movimiento_stock_alterado — usa audit_log (acá sí, es su único
--           propósito real hoy): UPDATE o DELETE sobre movimientos_stock.
--           Como audit_log es append-only e inmutable, un DELETE sobre el
--           movimiento original no borra el rastro acá. Cualquier evento
--           cuenta (sin umbral): modificar o borrar un movimiento de stock
--           ya registrado es en sí mismo el patrón sospechoso.
--
--   2. Columna notif_prefs_auto.auditoria_anomalia — para que el dueño pueda
--      apagar el aviso push de este motor desde el panel, igual que los
--      otros 5 (037_notif_prefs_auto.sql).
--
--   3. Índices de soporte para las consultas de (a)-(d).
--
-- IMPORTANTE — seguridad multi-tenant (mismo patrón que 067):
-- Esta función es SECURITY DEFINER y recibe p_empresa_id como parámetro, así
-- que bypassa RLS de las tablas base. A diferencia de otras funciones del
-- proyecto (que quedan con EXECUTE en PUBLIC por default de Postgres), acá
-- se REVOCA explícitamente y sólo se otorga a service_role: el handler
-- (lib/handlers/auditoria.js) ya valida que quien pide el análisis sea
-- dueño/admin de ESA empresa (o el cron) antes de llamarla. Si se le diera
-- EXECUTE a `authenticated`, cualquier usuario logueado podría pedir
-- p_empresa_id de OTRA empresa y leer sus anomalías igual.
-- ============================================================================

-- ── 1. Preferencia de notificación (igual patrón que los otros 5 motores) ───
ALTER TABLE public.notif_prefs_auto
  ADD COLUMN IF NOT EXISTS auditoria_anomalia BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.notif_prefs_auto.auditoria_anomalia IS
  'REQ-6 (Auditoría Predictiva): aviso push cuando se detecta un patrón '
  'sospechoso (descuentos repetidos, ajustes de stock sin OC, movimientos '
  'de stock alterados/borrados).';

-- ── 2. Índices de soporte ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido_descuento
  ON public.pedido_items (pedido_id)
  WHERE descuento_pct > 0;

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_deposito_creado
  ON public.movimientos_stock (deposito_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_movimientos_stock_usuario_creado
  ON public.movimientos_stock (usuario_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_tabla_accion
  ON public.audit_log (tabla, accion, created_at DESC);

-- ── 3. RPC principal ─────────────────────────────────────────────────────────
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
  v_umbral_descuento_vendedor  CONSTANT integer := 3;
  v_umbral_descuento_cliente   CONSTANT integer := 3;
  v_umbral_ajustes             CONSTANT integer := 3;
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

END;
$$;

COMMENT ON FUNCTION public.detectar_anomalias_auditoria IS
  'Innovación #6 del roadmap. Devuelve una fila por patrón sospechoso '
  'agrupado por usuario/entidad (no evento por evento) en los últimos '
  'p_dias_lookback días: descuentos repetidos (por vendedor y por par '
  'vendedor-cliente), ajustes de stock sin OC de respaldo, y movimientos de '
  'stock modificados/eliminados (vía audit_log). SECURITY DEFINER: sólo '
  'service_role, ver nota de seguridad al inicio del archivo.';

-- Revocar el EXECUTE en PUBLIC que Postgres otorga por default a funciones
-- nuevas, y dejarlo sólo para el backend (service_role).
REVOKE ALL ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) TO service_role;
