-- Migración 575 — Backfill puro de trazabilidad (Etapa 7, Bloque 4)
--
-- v1012 creó la vista v_whatsapp_conversaciones_historial directo contra
-- Supabase (el changelog la referencia como "supabase/migrations/ —
-- migración whatsapp_conversaciones_historial_view" pero ese archivo nunca
-- existió en el repo). Confirmado contra pg_views en el proyecto real
-- (jgiquzjwoedmzwqgzubr) que la definición de abajo es EXACTAMENTE la que
-- ya corre en producción.
--
-- No cambia comportamiento: es CREATE OR REPLACE VIEW con la definición
-- ya vigente, para que un `supabase db reset` reconstruya el estado real
-- en vez de dejar la vista sin existir.

CREATE OR REPLACE VIEW v_whatsapp_conversaciones_historial
WITH (security_invoker = true) AS
SELECT
    wc.id,
    wc.empresa_id,
    wc.cliente_id,
    COALESCE(c.nombre_fantasia, c.razon_social) AS cliente_nombre,
    wc.telefono,
    wc.estado,
    wc.pedido_borrador,
    wc.pedido_creado_id,
    wc.motivo_derivacion,
    wc.tomada_por,
    u.nombre AS tomada_por_nombre,
    wc.tomada_en,
    wc.ultima_interaccion,
    (SELECT count(*) FROM whatsapp_mensajes m WHERE m.conversacion_id = wc.id) AS cant_mensajes
FROM whatsapp_conversaciones wc
LEFT JOIN clientes c ON c.id = wc.cliente_id
LEFT JOIN usuarios u ON u.id = wc.tomada_por
WHERE wc.estado = 'cerrada';
