-- 592_fn_clientes_en_fuga_telefono.sql
-- Fase 2 de PLAN_CLIENTES_EN_FUGA.md: agrega `telefono` al jsonb que
-- devuelve fn_clientes_en_fuga (creada en 590, corregida en 591) — el
-- cron de recuperación (handleFugaCron, lib/handlers/notif.js) lo
-- necesita para mandar WhatsApp sin una consulta extra por cliente.
--
-- Reconstruida contra la definición real en producción: esta migración
-- (junto con 590/591) ya estaba aplicada mediante el asistente de la
-- sesión anterior pero nunca había quedado como archivo versionado en
-- el repo. Ver notas de 590/591 (mismo problema, pendiente no
-- bloqueante) en schema_migrations_registry.

CREATE OR REPLACE FUNCTION public.fn_clientes_en_fuga(p_empresa_id uuid, p_limite integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH ciclos_vencidos AS (
    SELECT
      cc.cliente_id,
      cc.confianza,
      (CURRENT_DATE - cc.proximo_pedido)::int AS dias_atraso,
      pr.nombre AS producto_nombre
    FROM public.ciclos_compra cc
    JOIN public.productos pr ON pr.id = cc.producto_id
    WHERE cc.empresa_id = p_empresa_id
      AND cc.activo = true
      AND CURRENT_DATE > cc.proximo_pedido + GREATEST((cc.intervalo_dias * 0.5)::int, 1)
  ),
  fuga_por_cliente AS (
    SELECT
      cv.cliente_id,
      MAX(cv.dias_atraso) AS dias_atraso,
      MAX(cv.confianza) AS confianza_maxima,
      (ARRAY_AGG(cv.producto_nombre ORDER BY cv.confianza DESC, cv.dias_atraso DESC))[1] AS producto_principal
    FROM ciclos_vencidos cv
    GROUP BY cv.cliente_id
  ),
  valor_pedidos AS (
    SELECT cliente_id, SUM(total) AS total
    FROM public.pedidos
    WHERE empresa_id = p_empresa_id
      AND estado = 'entregado'
      AND fecha_pedido >= now() - interval '365 days'
    GROUP BY cliente_id
  ),
  valor_pos AS (
    SELECT cliente_id, SUM(total) AS total
    FROM public.ventas_pos
    WHERE empresa_id = p_empresa_id
      AND estado = 'completada'
      AND cliente_id IS NOT NULL
      AND created_at >= now() - interval '365 days'
    GROUP BY cliente_id
  ),
  valor_anual AS (
    SELECT
      COALESCE(vp.cliente_id, vpos.cliente_id) AS cliente_id,
      COALESCE(vp.total, 0) + COALESCE(vpos.total, 0) AS valor_anual_estimado
    FROM valor_pedidos vp
    FULL OUTER JOIN valor_pos vpos ON vpos.cliente_id = vp.cliente_id
  ),
  filas AS (
    SELECT
      c.id AS cliente_id,
      c.razon_social,
      c.telefono,
      c.vendedor_id_default,
      c.score_categoria,
      c.saldo_deuda,
      f.dias_atraso,
      f.confianza_maxima,
      f.producto_principal,
      COALESCE(va.valor_anual_estimado, 0) AS valor_anual_estimado
    FROM fuga_por_cliente f
    JOIN public.clientes c ON c.id = f.cliente_id
    LEFT JOIN valor_anual va ON va.cliente_id = c.id
    WHERE c.activo = true
  ),
  top AS (
    SELECT * FROM filas ORDER BY valor_anual_estimado DESC, dias_atraso DESC LIMIT GREATEST(p_limite, 0)
  )
  SELECT jsonb_build_object(
    'total_clientes_en_fuga', (SELECT COUNT(*) FROM filas),
    'clientes_mostrados', (SELECT COUNT(*) FROM top),
    'valor_anual_total_en_riesgo', (SELECT COALESCE(SUM(valor_anual_estimado), 0) FROM filas),
    'clientes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'cliente_id', cliente_id,
        'razon_social', razon_social,
        'telefono', telefono,
        'vendedor_id_default', vendedor_id_default,
        'dias_atraso', dias_atraso,
        'producto_principal', producto_principal,
        'confianza_maxima', confianza_maxima,
        'valor_anual_estimado', valor_anual_estimado,
        'score_categoria', score_categoria,
        'saldo_deuda', saldo_deuda,
        'motivo_probable', CASE
          WHEN score_categoria IN ('riesgo', 'bloqueado') THEN 'posible_freno_por_deuda'
          ELSE 'posible_fuga_a_competencia'
        END
      ) ORDER BY valor_anual_estimado DESC, dias_atraso DESC) FROM top
    ), '[]'::jsonb)
  );
$function$;
