-- ═══════════════════════════════════════════════════════════════════════════
-- #3 Reposición por WhatsApp en Un Toque ("Pedido Habitual")
-- Ejecutar en: Supabase → SQL Editor → New Query → pegar todo → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. RPC: obtener pedidos sugeridos listos para notificar ─────────────────
--    Filtra: cliente con teléfono, no bloqueado, pedido generado en últimas 36h,
--    no notificado hoy por piloto_sugerencia
CREATE OR REPLACE FUNCTION public.obtener_sugeridos_para_whatsapp(p_empresa_id uuid)
RETURNS TABLE (
  pedido_id        uuid,
  cliente_id       uuid,
  cliente_nombre   text,
  cliente_telefono text,
  total            numeric,
  confianza        numeric,
  items_json       jsonb
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.cliente_id,
    COALESCE(c.nombre_fantasia, c.razon_social),
    c.telefono,
    p.total,
    p.confianza_sugerencia,
    (
      SELECT jsonb_agg(jsonb_build_object(
        'nombre',   pr.nombre,
        'cantidad', pi2.cantidad,
        'precio',   pi2.precio_unitario
      ))
      FROM pedido_items pi2
      JOIN productos pr ON pr.id = pi2.producto_id
      WHERE pi2.pedido_id = p.id
    )
  FROM pedidos p
  JOIN clientes c ON c.id = p.cliente_id
  WHERE p.empresa_id            = p_empresa_id
    AND p.estado                = 'sugerido'
    AND p.generado_automatico   = true
    AND c.telefono IS NOT NULL
    AND c.telefono              <> ''
    AND c.bloqueado             = false
    AND p.fecha_pedido          >= now() - INTERVAL '36 hours'
    AND NOT EXISTS (
      SELECT 1 FROM notif_log nl
      WHERE nl.cliente_id = p.cliente_id
        AND nl.tipo       = 'piloto_sugerencia'
        AND nl.created_at >= CURRENT_DATE::timestamptz
    );
END;
$$;

-- ── 2. RPC: confirmar pedido sugerido desde el checkout del cliente ──────────
--    No requiere auth — valida empresa_id + cliente_id + estado = sugerido
CREATE OR REPLACE FUNCTION public.confirmar_pedido_sugerido(
  p_pedido_id  uuid,
  p_empresa_id uuid,
  p_cliente_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_numero text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pedidos
    WHERE id = p_pedido_id AND empresa_id = p_empresa_id
      AND cliente_id = p_cliente_id AND estado = 'sugerido'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado o ya procesado');
  END IF;

  UPDATE pedidos
  SET estado = 'pendiente', canal = 'whatsapp', updated_at = now()
  WHERE id = p_pedido_id
  RETURNING numero_pedido INTO v_numero;

  RETURN jsonb_build_object('ok', true, 'numero_pedido', v_numero);
END;
$$;

-- ── 3. Vista de monitoreo diario ─────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_piloto_whatsapp_hoy AS
SELECT
  nl.empresa_id,
  COUNT(*)                                           AS enviadas_hoy,
  COUNT(*) FILTER (WHERE p.estado = 'pendiente')    AS confirmadas,
  COUNT(*) FILTER (WHERE p.estado = 'sugerido')     AS pendientes,
  ROUND(
    COUNT(*) FILTER (WHERE p.estado = 'pendiente')::numeric
    / NULLIF(COUNT(*), 0) * 100, 1
  )                                                  AS pct_conversion
FROM notif_log nl
LEFT JOIN pedidos p ON p.id = nl.pedido_id
WHERE nl.tipo = 'piloto_sugerencia'
  AND nl.created_at >= CURRENT_DATE::timestamptz
GROUP BY nl.empresa_id;
