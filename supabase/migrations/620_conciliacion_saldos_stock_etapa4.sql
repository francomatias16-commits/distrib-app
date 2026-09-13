-- 620_conciliacion_saldos_stock_etapa4.sql
--
-- Etapa 4 del plan de auditoría de integridad financiera
-- (docs/auditoria/plan-auditoria-fluxo.md): agrega dos RPCs de solo
-- lectura para conciliar saldos agregados contra sus movimientos
-- individuales.
--
-- conciliar_cta_cte(empresa_id): recalcula clientes.saldo_deuda desde
-- cta_cte (sumando factura/debito/cargo/nota_debito y restando
-- cobro/credito/nota_credito/pago, excluyendo filas anuladas) y lo
-- compara contra el saldo_deuda mostrado. En teoría SIEMPRE cierra en 0
-- porque trg_sync_saldo_deuda (migración 078) recalcula saldo_deuda
-- completo desde cta_cte en cada INSERT/UPDATE/DELETE. Una divergencia
-- acá indica que algo escribió saldo_deuda por fuera de ese trigger, o
-- que el trigger se rompió/deshabilitó.
--
-- conciliar_stock_por_producto(empresa_id): recalcula el stock TOTAL de
-- cada producto (sumado entre depósitos) desde movimientos_stock
-- (tipo IN ingreso/entrada_compra/egreso/ajuste) y lo compara contra la
-- suma real de stock.cantidad. LIMITACIÓN CONOCIDA: concilia el TOTAL
-- por producto, no por depósito individual — movimientos_stock
-- tipo='transferencia' no tiene columna de dirección, así que se excluye
-- del recálculo (correcto para el total, porque una transferencia
-- interna nunca cambia el total de la empresa, pero impide conciliar
-- por depósito). Queda como recomendación abierta para una futura
-- migración: agregar columna `direccion`, mismo patrón que
-- movimientos_stock_lotes.direccion.
--
-- Ambas son SECURITY DEFINER pensadas para uso exclusivo de
-- service_role (scripts/conciliar-cta-cte.js, scripts/conciliar-stock.js)
-- — ver nota de seguridad más abajo.
--
-- Ya aplicada en producción vía Supabase MCP el 2026-09-12 03:51 UTC
-- (registro id 213 en schema_migrations_registry). Este archivo es
-- backfill puro para dejar el repo consistente con lo que ya corre —
-- incluye el `GRANT` exactamente como quedó en producción, ver nota de
-- seguridad.

CREATE OR REPLACE FUNCTION public.conciliar_cta_cte(p_empresa_id uuid)
 RETURNS TABLE(cliente_id uuid, cliente_nombre text, saldo_mostrado numeric, saldo_recalculado numeric, diferencia numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.id,
    COALESCE(c.nombre_fantasia, c.razon_social),
    COALESCE(c.saldo_deuda, 0)          AS saldo_mostrado,
    COALESCE(m.saldo_recalculado, 0)    AS saldo_recalculado,
    COALESCE(c.saldo_deuda, 0) - COALESCE(m.saldo_recalculado, 0) AS diferencia
  FROM public.clientes c
  LEFT JOIN (
    SELECT cliente_id,
      SUM(CASE
            WHEN tipo IN ('factura', 'debito', 'cargo', 'nota_debito') THEN monto
            WHEN tipo IN ('cobro', 'credito', 'nota_credito', 'pago')  THEN -monto
          END) AS saldo_recalculado
    FROM public.cta_cte
    WHERE empresa_id = p_empresa_id AND NOT anulado
    GROUP BY cliente_id
  ) m ON m.cliente_id = c.id
  WHERE c.empresa_id = p_empresa_id;
$function$;

CREATE OR REPLACE FUNCTION public.conciliar_stock_por_producto(p_empresa_id uuid)
 RETURNS TABLE(producto_id uuid, producto_nombre text, cantidad_mostrada numeric, cantidad_recalculada numeric, diferencia numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    p.id,
    p.nombre,
    COALESCE(s.total_mostrado, 0)     AS cantidad_mostrada,
    COALESCE(m.total_recalculado, 0)  AS cantidad_recalculada,
    COALESCE(s.total_mostrado, 0) - COALESCE(m.total_recalculado, 0) AS diferencia
  FROM public.productos p
  LEFT JOIN (
    SELECT st.producto_id, SUM(st.cantidad) AS total_mostrado
    FROM public.stock st
    GROUP BY st.producto_id
  ) s ON s.producto_id = p.id
  LEFT JOIN (
    SELECT ms.producto_id,
      SUM(CASE
            WHEN ms.tipo IN ('ingreso', 'entrada_compra') THEN ms.cantidad
            WHEN ms.tipo = 'egreso'                       THEN -ms.cantidad
            WHEN ms.tipo = 'ajuste'                        THEN ms.cantidad
          END) AS total_recalculado
    FROM public.movimientos_stock ms
    WHERE ms.empresa_id = p_empresa_id
      AND ms.tipo IN ('ingreso', 'entrada_compra', 'egreso', 'ajuste')
    GROUP BY ms.producto_id
  ) m ON m.producto_id = p.id
  WHERE p.empresa_id = p_empresa_id;
$function$;

-- NOTA DE SEGURIDAD (hallazgo al reconstruir este backfill, no corregido
-- acá): en producción ambas funciones están otorgadas también a `anon` y
-- `authenticated`, no solo a `service_role` como documenta su propia nota
-- en schema_migrations_registry y los scripts que las consumen. Al ser
-- SECURITY DEFINER y recibir `p_empresa_id` como parámetro sin validarlo
-- contra la empresa del caller (patrón que este mismo repo ya identificó
-- y corrigió antes en otras RPCs, ver migraciones
-- "revoke_execute_rpc_sin_tenant_check*"), cualquier usuario autenticado
-- — y potencialmente anónimo — podría hoy pasar el empresa_id de otra
-- empresa y leer su conciliación de saldo_deuda/stock. Se deja
-- documentado para resolver en una migración de hardening dedicada
-- (revocar EXECUTE de anon/authenticated, dejar solo service_role), no
-- se aplica automáticamente acá para no tocar grants de producción sin
-- confirmación explícita.
