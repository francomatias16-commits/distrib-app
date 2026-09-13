-- 621_conciliar_stock_por_deposito_etapa4.sql
--
-- Cierra la limitación anotada en 620_conciliacion_saldos_stock_etapa4.sql:
-- "conciliar_stock_por_producto() concilia el TOTAL por producto, no por
-- depósito individual, porque tipo='transferencia' no tiene columna de
-- dirección".
--
-- Esa nota quedó desactualizada apenas 6 migraciones antes de escribirse:
-- 400_fix_signo_movimientos_transferencia.sql (anterior a esta, ya en
-- producción) hace tiempo que guarda la cantidad de las filas
-- tipo='transferencia' CON SIGNO (negativa en el depósito de origen,
-- positiva en el de destino) — no hace falta agregar una columna
-- `direccion` nueva (como sugería 620, "mismo patrón que
-- movimientos_stock_lotes.direccion"): el signo YA es esa dirección.
-- Verificado en vivo contra el dataset actual (par de filas -10/+10 con
-- mismo producto_id, deposito_id cruzados en referencia_id) antes de
-- escribir esta migración.
--
-- conciliar_stock_por_deposito(empresa_id): mismo criterio que
-- conciliar_stock_por_producto(), pero agrupando también por depósito, y
-- sumando tipo='transferencia' tal cual (ya viene signada) junto con
-- ingreso/entrada_compra/egreso/ajuste. Los pares (producto, depósito) a
-- evaluar salen de un UNION de `stock` y `movimientos_stock` — no de un
-- CROSS JOIN productos×depositos — para no generar filas de puro cero en
-- empresas con muchos productos y muchos depósitos.
--
-- SECURITY DEFINER, pensada para uso exclusivo de service_role — mismo
-- patrón y misma nota de seguridad que 620 (no se expone a `authenticated`
-- ni se agrega policy alguna; solo se le hace GRANT a service_role).

CREATE OR REPLACE FUNCTION public.conciliar_stock_por_deposito(p_empresa_id uuid)
 RETURNS TABLE(
   producto_id uuid,
   producto_nombre text,
   deposito_id uuid,
   deposito_nombre text,
   cantidad_mostrada numeric,
   cantidad_recalculada numeric,
   diferencia numeric
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pares AS (
    SELECT st.producto_id, st.deposito_id
    FROM public.stock st
    JOIN public.productos p ON p.id = st.producto_id AND p.empresa_id = p_empresa_id
    UNION
    SELECT ms.producto_id, ms.deposito_id
    FROM public.movimientos_stock ms
    WHERE ms.empresa_id = p_empresa_id
      AND ms.tipo IN ('ingreso', 'entrada_compra', 'egreso', 'ajuste', 'transferencia')
  ),
  mov AS (
    SELECT ms.producto_id, ms.deposito_id,
      SUM(CASE
            WHEN ms.tipo IN ('ingreso', 'entrada_compra')  THEN ms.cantidad
            WHEN ms.tipo = 'egreso'                        THEN -ms.cantidad
            -- 'ajuste' y 'transferencia' ya vienen guardados con signo
            -- (ver 399 y 400 respectivamente) — se suman tal cual.
            WHEN ms.tipo IN ('ajuste', 'transferencia')    THEN ms.cantidad
          END) AS total_recalculado
    FROM public.movimientos_stock ms
    WHERE ms.empresa_id = p_empresa_id
      AND ms.tipo IN ('ingreso', 'entrada_compra', 'egreso', 'ajuste', 'transferencia')
    GROUP BY ms.producto_id, ms.deposito_id
  )
  SELECT
    pr.producto_id,
    p.nombre,
    pr.deposito_id,
    d.nombre,
    COALESCE(s.cantidad, 0)                                     AS cantidad_mostrada,
    COALESCE(mo.total_recalculado, 0)                           AS cantidad_recalculada,
    COALESCE(s.cantidad, 0) - COALESCE(mo.total_recalculado, 0) AS diferencia
  FROM pares pr
  JOIN public.productos p  ON p.id = pr.producto_id
  JOIN public.depositos d  ON d.id = pr.deposito_id
  LEFT JOIN public.stock s ON s.producto_id = pr.producto_id AND s.deposito_id = pr.deposito_id
  LEFT JOIN mov mo          ON mo.producto_id = pr.producto_id AND mo.deposito_id = pr.deposito_id
  WHERE p.empresa_id = p_empresa_id
    AND d.empresa_id = p_empresa_id;
$function$;

-- Mismo criterio de seguridad que conciliar_stock_por_producto /
-- conciliar_cta_cte (migración 620): SECURITY DEFINER pero SIN grant a
-- `authenticated` — de uso exclusivo para scripts con SERVICE_ROLE_KEY
-- (scripts/conciliar-stock-por-deposito.js). No se le agrega policy ni se
-- expone vía PostgREST a usuarios finales.
REVOKE ALL ON FUNCTION public.conciliar_stock_por_deposito(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conciliar_stock_por_deposito(uuid) TO service_role;

COMMENT ON FUNCTION public.conciliar_stock_por_deposito IS
  'Etapa 4 (auditoría financiera), complemento de conciliar_stock_por_producto: '
  'recalcula stock.cantidad por (producto, depósito) desde movimientos_stock, '
  'incluyendo tipo=transferencia (ya viene con signo desde la v400: negativo '
  'en origen, positivo en destino). Uso exclusivo service_role.';
