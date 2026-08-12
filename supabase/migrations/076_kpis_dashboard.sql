-- ============================================================================
-- 076_kpis_dashboard.sql
--
-- Versiona en el repo la función obtener_kpis_dashboard(), que existía en
-- producción (Supabase SQL editor) pero nunca había quedado en ninguna
-- migración numerada — se detectó el hueco al armar la Etapa 5 del POS
-- (handleKPIs en lib/handlers/admin.js la llama, pero no había forma de
-- saber su definición real sin extraerla a mano).
--
-- ── Parte 1: CREATE OR REPLACE idéntico al que ya corre en producción ───
-- No cambia ningún comportamiento. Es exactamente lo que devolvió
--   select pg_get_functiondef(p.oid) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'obtener_kpis_dashboard';
-- corrido en el SQL editor de Supabase el 2026-06-21. Se versiona tal cual
-- para que de acá en más quede en el historial de migraciones — correrla
-- de nuevo es un no-op (incluye exactamente lo que ya hay deployado).
--
-- ── Parte 2: obtener_kpis_dashboard_v2() ─────────────────────────────────
-- Misma firma y misma forma de respuesta, pero 'ventas_actual' y
-- 'ventas_anterior' suman también ventas_pos (estado 'completada'), igual
-- criterio que ya se aplicó en handleVentasDiarias (075). NO se reemplaza
-- la función original — se deja una _v2 aparte a propósito, para que el
-- dashboard solo empiece a contar el canal mostrador cuando se decida
-- explícitamente cambiar el nombre llamado desde lib/handlers/admin.js
-- (supabase.rpc('obtener_kpis_dashboard', ...) → 'obtener_kpis_dashboard_v2').
-- Si se confirma el cambio, no hace falta nueva migración: alcanza con
-- ese cambio de una línea en el handler.
-- ============================================================================

-- ── Parte 1: función original, versionada tal cual está en producción ───
CREATE OR REPLACE FUNCTION public.obtener_kpis_dashboard(
  p_empresa_id     UUID,
  p_desde          TIMESTAMPTZ,
  p_hasta          TIMESTAMPTZ,
  p_desde_anterior TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'ventas_actual', COALESCE((
      SELECT SUM(total) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0),
    'ventas_anterior', COALESCE((
      SELECT SUM(total) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde_anterior AND created_at < p_desde
    ), 0),
    'pedidos_actual', (
      SELECT COUNT(*) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ),
    'pedidos_anterior', (
      SELECT COUNT(*) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde_anterior AND created_at < p_desde
    ),
    'clientes_activos', (
      SELECT COUNT(DISTINCT cliente_id) FROM pedidos
      WHERE empresa_id = p_empresa_id AND created_at >= p_desde AND created_at <= p_hasta
    ),
    'clientes_activos_anterior', (
      SELECT COUNT(DISTINCT cliente_id) FROM pedidos
      WHERE empresa_id = p_empresa_id AND created_at >= p_desde_anterior AND created_at < p_desde
    ),
    'stock_critico_count', (
      SELECT COUNT(*) FROM (
        SELECT s.producto_id,
               SUM(s.cantidad) - SUM(s.cantidad_reservada) AS disponible,
               MAX(p.stock_minimo) AS minimo
        FROM stock s
        JOIN productos p ON p.id = s.producto_id
        JOIN depositos d ON d.id = s.deposito_id
        WHERE d.empresa_id = p_empresa_id AND p.activo = true
        GROUP BY s.producto_id
        HAVING SUM(s.cantidad) - SUM(s.cantidad_reservada) <= GREATEST(MAX(p.stock_minimo), 5)
      ) crit
    )
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_kpis_dashboard FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_kpis_dashboard TO service_role;

-- ── Parte 2: variante que también cuenta el canal mostrador (POS) ───────
-- Idéntica a la de arriba, salvo 'ventas_actual'/'ventas_anterior', que
-- suman pedidos + ventas_pos (estado 'completada'). El resto de los KPIs
-- (pedidos_actual, clientes_activos, stock_critico_count) queda igual:
-- una venta de mostrador a "consumidor final" sin cliente_id no tiene
-- sentido contarla en clientes_activos, y no es un "pedido" en el sentido
-- del flujo reserva→reparto→entrega que mide pedidos_actual.
CREATE OR REPLACE FUNCTION public.obtener_kpis_dashboard_v2(
  p_empresa_id     UUID,
  p_desde          TIMESTAMPTZ,
  p_hasta          TIMESTAMPTZ,
  p_desde_anterior TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'ventas_actual', COALESCE((
      SELECT SUM(total) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0) + COALESCE((
      SELECT SUM(total) FROM ventas_pos
      WHERE empresa_id = p_empresa_id
        AND estado = 'completada'
        AND created_at >= p_desde AND created_at <= p_hasta
    ), 0),
    'ventas_anterior', COALESCE((
      SELECT SUM(total) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde_anterior AND created_at < p_desde
    ), 0) + COALESCE((
      SELECT SUM(total) FROM ventas_pos
      WHERE empresa_id = p_empresa_id
        AND estado = 'completada'
        AND created_at >= p_desde_anterior AND created_at < p_desde
    ), 0),
    'pedidos_actual', (
      SELECT COUNT(*) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde AND created_at <= p_hasta
    ),
    'pedidos_anterior', (
      SELECT COUNT(*) FROM pedidos
      WHERE empresa_id = p_empresa_id
        AND estado IN ('confirmado','preparando','despachado','entregado')
        AND created_at >= p_desde_anterior AND created_at < p_desde
    ),
    'clientes_activos', (
      SELECT COUNT(DISTINCT cliente_id) FROM pedidos
      WHERE empresa_id = p_empresa_id AND created_at >= p_desde AND created_at <= p_hasta
    ),
    'clientes_activos_anterior', (
      SELECT COUNT(DISTINCT cliente_id) FROM pedidos
      WHERE empresa_id = p_empresa_id AND created_at >= p_desde_anterior AND created_at < p_desde
    ),
    'stock_critico_count', (
      SELECT COUNT(*) FROM (
        SELECT s.producto_id,
               SUM(s.cantidad) - SUM(s.cantidad_reservada) AS disponible,
               MAX(p.stock_minimo) AS minimo
        FROM stock s
        JOIN productos p ON p.id = s.producto_id
        JOIN depositos d ON d.id = s.deposito_id
        WHERE d.empresa_id = p_empresa_id AND p.activo = true
        GROUP BY s.producto_id
        HAVING SUM(s.cantidad) - SUM(s.cantidad_reservada) <= GREATEST(MAX(p.stock_minimo), 5)
      ) crit
    )
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_kpis_dashboard_v2 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_kpis_dashboard_v2 TO service_role;
