-- ============================================================================
-- 067_priorizacion_cobranza.sql
--
-- Innovación #9 (Priorización Inteligente de Cobranza), según
-- roadmap-innovaciones-distrib.md.
--
-- Contenido:
--   1. Vista v_cobranza_priorizada: una fila por factura pendiente/parcial
--      vencida o por vencer, con un score_cobrabilidad (0-100) que combina:
--        - Velocidad histórica de pago del cliente (mismo criterio que el
--          componente "Pagos" de calcular_score_cliente, sobre cobros/facturas
--          de los últimos 90 días) — 40%
--        - % de cheques rechazados sobre el total de cheques del cliente
--          (señal directa de incumplimiento) — 25%
--        - Ratio deuda actual / límite de crédito, vía calcular_deuda_cliente()
--          (066) — 20%
--        - score_categoria actual del cliente (premium/bueno/normal/riesgo/
--          bloqueado), ya calculado por calcular_score_cliente() — 15%
--      Más antigüedad y monto de la deuda como columnas de ordenamiento
--      complementarias (no entran al score, son criterio operativo aparte).
--   2. Índice de soporte sobre cheques(cliente_id, estado) para el cálculo
--      de % de rechazo sin escanear toda la tabla por empresa.
--
-- IMPORTANTE — seguridad multi-tenant:
-- Esta vista NO tiene security_invoker (mismo patrón que v_cc_proveedor en
-- 064: ninguna vista del proyecto lo usa). Eso significa que NO hereda RLS
-- de las tablas base. Igual que v_cc_proveedor, debe consumirse SOLO desde
-- un handler backend con SUPABASE_SERVICE_ROLE_KEY que filtre manualmente
-- por empresa_id del perfil autenticado — nunca exponerla directo por
-- PostgREST al browser con el JWT del usuario (filtrar por ?empresa_id=eq.
-- en una query client-side NO alcanza: cualquiera podría pedir otra
-- empresa_id y la vista se la daría igual).
-- ============================================================================

-- ── Índice de soporte ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cheques_cliente_estado
  ON public.cheques USING btree (cliente_id, estado);

-- ── Vista de priorización ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cobranza_priorizada AS
WITH dias_pago_cliente AS (
  -- Misma INTENCIÓN que el componente "Pagos" de calcular_score_cliente()
  -- (promedio de días entre cobro y vencimiento), pero con el JOIN
  -- corregido: esa función usa cta_cte.pedido_id, columna que NO EXISTE
  -- en cta_cte (ver nota al pie). Acá se usa cta_cte.factura_id, que sí
  -- existe y vincula directo cobro → factura sin pasar por pedidos.
  SELECT
    co.cliente_id,
    AVG(EXTRACT(EPOCH FROM (co.fecha - f.fecha_vencimiento)) / 86400.0) AS dias_prom
  FROM public.cobros co
  JOIN public.cta_cte cc ON cc.cobro_id = co.id
  JOIN public.facturas f ON f.id = cc.factura_id
  WHERE co.fecha >= now() - INTERVAL '90 days'
  GROUP BY co.cliente_id
),
cheques_cliente AS (
  SELECT
    cliente_id,
    COUNT(*) FILTER (WHERE estado = 'rechazado') AS rechazados,
    COUNT(*) AS total_cheques
  FROM public.cheques
  WHERE cliente_id IS NOT NULL
  GROUP BY cliente_id
),
componentes AS (
  SELECT
    f.id                AS factura_id,
    f.empresa_id,
    f.cliente_id,
    f.numero,
    f.total,
    f.total_cobrado,
    (f.total - COALESCE(f.total_cobrado, 0))           AS saldo_pendiente,
    f.fecha_vencimiento,
    GREATEST(0, (CURRENT_DATE - f.fecha_vencimiento))   AS dias_vencida,
    c.razon_social,
    c.nombre_fantasia,
    c.score_categoria,
    c.limite_credito,
    public.calcular_deuda_cliente(c.id)                 AS deuda_actual,

    -- Componente Pagos (0-40, igual escala que calcular_score_cliente,
    -- pero invertido a "puntos de cobrabilidad")
    CASE
      WHEN dp.dias_prom IS NULL  THEN 20  -- sin historial: neutral
      WHEN dp.dias_prom <= -5    THEN 40
      WHEN dp.dias_prom <= 0     THEN 35
      WHEN dp.dias_prom <= 7     THEN 25
      WHEN dp.dias_prom <= 15    THEN 15
      WHEN dp.dias_prom <= 30    THEN 5
      ELSE 0
    END AS pts_pagos,

    -- Componente Cheques rechazados (0-25): castiga fuerte si tiene
    -- historial de rechazo, neutral si nunca tuvo cheques.
    CASE
      WHEN COALESCE(ch.total_cheques, 0) = 0 THEN 18
      ELSE GREATEST(0, ROUND(25 - (25.0 * ch.rechazados / ch.total_cheques)))
    END AS pts_cheques,

    -- Componente Deuda/límite (0-20)
    CASE
      WHEN COALESCE(c.limite_credito, 0) = 0                              THEN 10
      WHEN public.calcular_deuda_cliente(c.id) <= 0                       THEN 20
      WHEN (public.calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.3 THEN 16
      WHEN (public.calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.6 THEN 10
      WHEN (public.calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.9 THEN 4
      ELSE 0
    END AS pts_deuda,

    -- Componente score_categoria (0-15)
    CASE c.score_categoria
      WHEN 'premium'   THEN 15
      WHEN 'bueno'      THEN 11
      WHEN 'normal'     THEN 7
      WHEN 'riesgo'     THEN 2
      WHEN 'bloqueado'  THEN 0
      ELSE 7  -- sin categoría asignada todavía: neutral
    END AS pts_categoria

  FROM public.facturas f
  JOIN public.clientes c ON c.id = f.cliente_id
  LEFT JOIN dias_pago_cliente dp ON dp.cliente_id = f.cliente_id
  LEFT JOIN cheques_cliente   ch ON ch.cliente_id = f.cliente_id
  -- Mismo criterio que ya usa cobranzas.js (REST directo): facturas con
  -- AFIP ya resuelto (emitida) o con cobro parcial. 'pendiente' es un
  -- estado transitorio pre-AFIP que esa pantalla nunca mostró, así que
  -- esta vista tampoco lo incluye, para no listar algo que el admin no
  -- puede cobrar todavía.
  WHERE f.estado IN ('emitida', 'parcial')
    AND (f.total - COALESCE(f.total_cobrado, 0)) > 0
)
SELECT
  factura_id,
  empresa_id,
  cliente_id,
  numero            AS numero_factura,
  COALESCE(nombre_fantasia, razon_social) AS cliente_nombre,
  total,
  total_cobrado,
  saldo_pendiente,
  fecha_vencimiento,
  dias_vencida,
  score_categoria,
  deuda_actual,
  (pts_pagos + pts_cheques + pts_deuda + pts_categoria) AS score_cobrabilidad,
  -- Etiqueta operativa lista para mostrar en UI sin lógica extra en JS
  CASE
    WHEN (pts_pagos + pts_cheques + pts_deuda + pts_categoria) < 30 THEN 'accion_urgente'
    WHEN (pts_pagos + pts_cheques + pts_deuda + pts_categoria) < 55 THEN 'seguimiento'
    ELSE 'cobro_probable'
  END AS prioridad
FROM componentes
ORDER BY score_cobrabilidad ASC, saldo_pendiente DESC, dias_vencida DESC;

COMMENT ON VIEW public.v_cobranza_priorizada IS
  'Innovación #9 del roadmap: una fila por factura pendiente/parcial, '
  'ordenada por score_cobrabilidad (0-100, ascendente = menos probable que '
  'se cobre sola, más urge accionar). Combina velocidad histórica de pago, '
  '% de cheques rechazados, ratio deuda/límite y score_categoria del '
  'cliente. No reemplaza facturas_vencidas por fecha; es un criterio '
  'adicional de orden para la pantalla de Cobranzas.';

-- ============================================================================
-- NOTA — bug heredado detectado de paso (NO corregido acá, fuera de alcance
-- de esta migración, dejarlo para una 069 dedicada):
--
-- calcular_score_cliente() (definida en 064_vidriera_devoluciones_v80.sql)
-- calcula v_dias_prom con:
--   JOIN facturas f ON f.pedido_id = (SELECT pedido_id FROM cta_cte WHERE cobro_id = co.id LIMIT 1)
-- pero cta_cte NO TIENE columna pedido_id (confirmado contra el backup.sql
-- real: solo tiene factura_id, cobro_id, cliente_id, etc.). Ese subselect
-- debería fallar en cada ejecución de calcular_score_cliente(), lo que
-- probablemente hace que el componente "Pagos" (0-40 pts, el de mayor peso
-- del score) nunca se calcule bien y caiga siempre al default de 20pts
-- neutral (rama v_dias_prom IS NULL), o que la función entera tire error
-- silencioso atrapado en otro lado. Vale la pena revisarlo: si se confirma,
-- el fix es UNA línea — cambiar el subselect a
--   JOIN facturas f ON f.id = (SELECT factura_id FROM cta_cte WHERE cobro_id = co.id LIMIT 1)
-- igual que se corrigió acá en dias_pago_cliente.
-- ============================================================================
