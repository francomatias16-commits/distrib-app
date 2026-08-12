-- ============================================================================
-- 071_punto_pedido_predictivo.sql
--
-- Innovación #7 (Punto de Pedido Predictivo), según roadmap-innovaciones-distrib.md.
--
-- Roadmap original: "Base: analizar_stock_autonomo(), ciclos_compra, pedidos
-- confirmado sin despachar. Falta: restar demanda comprometida + sumar demanda
-- futura conocida (no solo velocidad de venta de los últimos 30 días)."
--
-- DIAGNÓSTICO de analizar_stock_autonomo() (035_stock_autonomo.sql), la versión
-- vigente hasta ahora:
--   1. "necesita_reponer" comparaba disponible <= stock_minimo, IGNORANDO
--      lead_time_dias por completo. Eso no es un "punto de pedido" real: un
--      producto con poca venta pero lead time largo (proveedor lejano) podía
--      no disparar alerta y quedarse sin stock mientras llega la repo.
--   2. "disponible" se leía de stock.cantidad - stock.cantidad_reservada.
--      cantidad_reservada SÍ se mantiene bien hoy (crear_pedido_cliente llama
--      incrementar_stock_reservado, y el despacho llama liberar_stock_reservado
--      — ver pedidos.js línea ~215), pero depender de un contador mutable es
--      menos robusto que calcular la demanda comprometida directo desde
--      pedidos/pedido_items: por eso esta versión la recalcula explícitamente
--      en vez de confiar únicamente en la columna.
--   3. Sin agregación por depósito: si un producto tenía stock en más de un
--      depósito, el LEFT JOIN devolvía una fila por depósito (producto
--      duplicado en el resultado). Se corrige sumando por producto.
--   4. "cantidad_sugerida" apuntaba a un stock_objetivo fijo (o vel_dia×30),
--      sin contemplar que ya hay pedidos confirmados esperando despacho NI que
--      hay clientes de ciclos_compra a punto de volver a pedir.
--
-- CAMBIOS en esta versión (mismo nombre/firma — DROP+CREATE porque cambia la
-- forma de RETURNS TABLE; stock-auto.js y frontend/admin/js/stock.js acceden
-- a las columnas por nombre, no por posición, así que agregar columnas nuevas
-- al final no rompe nada de lo existente):
--
--   a) demanda_comprometida  — NUEVA. Suma de pedido_items.cantidad de pedidos
--      en estado 'confirmado' o 'preparando' (confirmados, sin despachar
--      todavía) para ese producto. Se resta del stock físico para obtener el
--      disponible real, calculado directo desde pedidos (no desde
--      cantidad_reservada).
--
--   b) demanda_futura_conocida — NUEVA. Suma de ciclos_compra.cantidad_promedio
--      de clientes con compra recurrente activa cuyo próximo_pedido cae dentro
--      de la ventana de lead_time del producto (es decir: van a volver a pedir
--      ANTES de que llegue la próxima reposición, aunque todavía no exista el
--      pedido en la tabla pedidos).
--
--   c) Punto de pedido real: se repone cuando el stock disponible no alcanza
--      para cubrir (venta proyectada durante el lead time + demanda futura
--      conocida en ese lead time) más el colchón de seguridad
--      (stock_minimo, que pasa de ser "el" umbral a ser el colchón extra sobre
--      la demanda proyectada).
--
--   d) cantidad_sugerida ahora cubre: el objetivo de stock (stock_objetivo, o
--      30 días de venta si no está configurado) MÁS la demanda proyectada
--      durante el lead time (incluida la demanda futura conocida), MENOS lo
--      disponible. Antes solo apuntaba al objetivo fijo.
--
-- Compatibilidad: stock-auto.js (REQ-4, motor #4 de automatizacion.js) sigue
-- funcionando sin cambios — usa necesita_reponer/cantidad_sugerida/proveedor_id
-- igual que antes, ahora con mejor cálculo. El modal de proyección en
-- frontend/admin/js/stock.js también sigue funcionando (stock_actual,
-- velocidad_dia, dias_restantes, lead_time se mantienen con el mismo
-- significado); se agregan 2 KPIs nuevos opcionales para mostrar las dos
-- columnas nuevas.
-- ============================================================================

DROP FUNCTION IF EXISTS public.analizar_stock_autonomo(uuid);

CREATE FUNCTION public.analizar_stock_autonomo(p_empresa_id UUID)
RETURNS TABLE (
  producto_id            UUID,
  nombre                 TEXT,
  stock_actual           NUMERIC,
  velocidad_dia          NUMERIC,
  dias_restantes         NUMERIC,
  lead_time              INT,
  necesita_reponer       BOOLEAN,
  cantidad_sugerida      NUMERIC,
  proveedor_id           UUID,
  demanda_comprometida   NUMERIC,
  demanda_futura_conocida NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH ventas_30d AS (
    SELECT pi2.producto_id,
           SUM(pi2.cantidad) / 30.0 AS vel_dia
    FROM pedido_items pi2
    JOIN pedidos ped ON ped.id = pi2.pedido_id
    WHERE ped.empresa_id = p_empresa_id
      AND ped.estado IN ('entregado', 'despachado', 'confirmado')
      AND ped.fecha_pedido >= now() - INTERVAL '30 days'
    GROUP BY pi2.producto_id
  ),
  stock_fisico AS (
    -- Suma por producto a través de todos los depósitos de la empresa.
    -- (antes: sin agregar, podía duplicar filas si había >1 depósito)
    SELECT s.producto_id, SUM(s.cantidad) AS cantidad_total
    FROM stock s
    JOIN depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
    GROUP BY s.producto_id
  ),
  demanda_comprometida AS (
    -- Pedidos confirmados/en preparación, sin despachar: demanda ya
    -- comprometida que todavía no salió del depósito. Calculado directo
    -- desde pedidos/pedido_items (no desde stock.cantidad_reservada) para
    -- no depender de un contador mutable.
    SELECT pi3.producto_id, SUM(pi3.cantidad) AS cantidad
    FROM pedido_items pi3
    JOIN pedidos p3 ON p3.id = pi3.pedido_id
    WHERE p3.empresa_id = p_empresa_id
      AND p3.estado IN ('confirmado', 'preparando')
    GROUP BY pi3.producto_id
  )
  SELECT
    p.id,
    p.nombre,
    -- Disponible real = físico - comprometido (puede no coincidir con
    -- cantidad - cantidad_reservada si esa columna llegó a desincronizarse).
    GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0)),
    COALESCE(v.vel_dia, 0),
    CASE WHEN COALESCE(v.vel_dia, 0) > 0
      THEN GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0)) / v.vel_dia
      ELSE 999
    END,
    COALESCE(p.lead_time_dias, 7),
    -- Punto de pedido real: ¿el disponible alcanza para cubrir lo que se va a
    -- vender/comprometer durante el lead time (vel_dia × lead_time + demanda
    -- futura conocida de ciclos_compra) más el colchón de stock_minimo?
    (
      GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0))
      <=
      (
        COALESCE(v.vel_dia, 0) * COALESCE(p.lead_time_dias, 7)
        + COALESCE((
            SELECT SUM(cc.cantidad_promedio)
            FROM ciclos_compra cc
            WHERE cc.empresa_id  = p_empresa_id
              AND cc.producto_id = p.id
              AND cc.activo
              AND cc.proximo_pedido IS NOT NULL
              AND cc.proximo_pedido <= CURRENT_DATE + COALESCE(p.lead_time_dias, 7)
          ), 0)
        + COALESCE(p.stock_minimo, 0)
      )
    ),
    -- Cantidad sugerida: objetivo de stock + demanda proyectada durante el
    -- lead time (venta + demanda futura conocida) - disponible.
    GREATEST(0,
      COALESCE(NULLIF(p.stock_objetivo, 0), COALESCE(v.vel_dia, 0) * 30)
      + COALESCE(v.vel_dia, 0) * COALESCE(p.lead_time_dias, 7)
      + COALESCE((
          SELECT SUM(cc.cantidad_promedio)
          FROM ciclos_compra cc
          WHERE cc.empresa_id  = p_empresa_id
            AND cc.producto_id = p.id
            AND cc.activo
            AND cc.proximo_pedido IS NOT NULL
            AND cc.proximo_pedido <= CURRENT_DATE + COALESCE(p.lead_time_dias, 7)
        ), 0)
      - GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0))
    ),
    p.proveedor_id_default,
    COALESCE(dc.cantidad, 0),
    COALESCE((
      SELECT SUM(cc.cantidad_promedio)
      FROM ciclos_compra cc
      WHERE cc.empresa_id  = p_empresa_id
        AND cc.producto_id = p.id
        AND cc.activo
        AND cc.proximo_pedido IS NOT NULL
        AND cc.proximo_pedido <= CURRENT_DATE + COALESCE(p.lead_time_dias, 7)
    ), 0)
  FROM productos p
  LEFT JOIN stock_fisico        sf ON sf.producto_id = p.id
  LEFT JOIN ventas_30d          v  ON v.producto_id  = p.id
  LEFT JOIN demanda_comprometida dc ON dc.producto_id = p.id
  WHERE p.empresa_id = p_empresa_id AND p.activo = true
  ORDER BY 4 ASC; -- dias_restantes
END;
$$;

COMMENT ON FUNCTION public.analizar_stock_autonomo IS
  'Innovación #7 del roadmap (versión 2, 071). Punto de pedido predictivo: '
  'compara el stock disponible real (físico - demanda comprometida en '
  'pedidos confirmados/en preparación sin despachar) contra la demanda '
  'proyectada durante el lead_time del producto, que incluye tanto la '
  'velocidad de venta de los últimos 30 días COMO la demanda futura '
  'conocida de ciclos_compra (clientes recurrentes a punto de volver a '
  'pedir). Reemplaza la versión anterior (035_stock_autonomo.sql) que solo '
  'comparaba contra stock_minimo sin considerar lead_time ni demanda futura. '
  'Usada por stock-auto.js (REQ-4, motor #4 de automatizacion.js) — mismas '
  'columnas que antes + demanda_comprometida y demanda_futura_conocida al '
  'final, no rompe consumidores existentes.';

-- Igual criterio de seguridad multi-tenant que 070_auditoria_anomalias.sql:
-- esta función es SECURITY DEFINER y bypassa RLS. El handler (stock-auto.js)
-- ya filtra por el empresa_id del token verificado, así que NO se otorga
-- EXECUTE a `authenticated` — si se hiciera, cualquier usuario logueado
-- podría llamar a /rest/v1/rpc/analizar_stock_autonomo directo (vía
-- PostgREST) con el empresa_id de OTRA empresa y leer su stock/proveedores.
-- (La función original en 035 quedó con el EXECUTE en PUBLIC por default de
-- Postgres — no se la tocó hasta ahora porque no era el objeto de esa
-- migración, pero ya que se está reescribiendo esta función para #7,
-- corresponde cerrarla del mismo modo que 070.)
REVOKE ALL ON FUNCTION public.analizar_stock_autonomo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analizar_stock_autonomo(uuid) TO service_role;

-- ── Índice de soporte para el filtro de demanda futura por proximo_pedido ──
CREATE INDEX IF NOT EXISTS idx_ciclos_compra_producto_proximo
  ON public.ciclos_compra (producto_id, proximo_pedido)
  WHERE activo = true;

-- ── Índice de soporte para demanda comprometida (pedidos sin despachar) ────
CREATE INDEX IF NOT EXISTS idx_pedido_items_producto
  ON public.pedido_items (producto_id, pedido_id);
