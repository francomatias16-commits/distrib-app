-- ============================================================
-- MIGRACIÓN 271 — Etapa 6 (panel admin, Etapa 5 del plan): marcar
-- conversación de WhatsApp derivada a un humano como "tomada"
-- distrib v271
--
-- Contexto: la migración 247 dejó whatsapp_conversaciones.estado con un
-- CHECK acotado a ('activa', 'esperando_confirmacion', 'derivada_humano',
-- 'cerrada'). "Tomada" no es un estado de la conversación en sí (el bot
-- sigue sin intervenir igual, el pedido_borrador sigue vigente) — es una
-- marca de "qué vendedor humano se está haciendo cargo de esta derivación",
-- ortogonal al estado. Modelarlo como columnas nuevas evita:
--   a) tocar el CHECK y toda la lógica de ruteo del webhook que ya
--      distingue esos 4 estados (whatsappWebhookHandler en notif.js),
--   b) perder la info de "derivada_humano" cuando alguien la toma (si
--      fuera un 5to estado 'tomada', dejaríamos de saber que fue una
--      derivación en primer lugar).
--
-- Decisión de RLS: a propósito NO se agrega policy de UPDATE para
-- whatsapp_conversaciones. El panel admin lee el listado y los mensajes
-- directo vía Supabase client (RLS de SELECT, ya cubierta por la 247),
-- pero tomar/liberar pasa siempre por el endpoint
-- /api/notif/whatsapp-conversacion-accion (whatsappConversacionAccionHandler
-- en lib/handlers/notif.js), que usa service_role y valida a mano
-- ownership por empresa_id + rol. Esto evita que cualquier fila
-- "authenticated" pueda pisar tomada_por de otra empresa por un bug de
-- policy, y centraliza la regla de negocio (un vendedor no libera lo que
-- tomó otro vendedor; dueño/admin sí) en un solo lugar.
-- ============================================================

BEGIN;

ALTER TABLE public.whatsapp_conversaciones
  ADD COLUMN IF NOT EXISTS tomada_por uuid REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS tomada_en  timestamptz;

CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_tomada_por
  ON public.whatsapp_conversaciones(tomada_por)
  WHERE tomada_por IS NOT NULL;

-- Vista de monitoreo del panel admin: se agrega quién tomó la
-- conversación (nombre, no solo el uuid) y el borrador de pedido en
-- curso, que el plan pide mostrar en el detalle.
CREATE OR REPLACE VIEW public.v_whatsapp_conversaciones_activas AS
SELECT
  wc.id,
  wc.empresa_id,
  wc.cliente_id,
  COALESCE(c.nombre_fantasia, c.razon_social) AS cliente_nombre,
  wc.telefono,
  wc.estado,
  wc.pedido_borrador,
  wc.motivo_derivacion,
  wc.tomada_por,
  u.nombre AS tomada_por_nombre,
  wc.tomada_en,
  wc.ultima_interaccion,
  (SELECT count(*) FROM whatsapp_mensajes m WHERE m.conversacion_id = wc.id) AS cant_mensajes
FROM whatsapp_conversaciones wc
LEFT JOIN clientes c ON c.id = wc.cliente_id
LEFT JOIN usuarios u ON u.id = wc.tomada_por
WHERE wc.estado <> 'cerrada';

GRANT SELECT ON public.v_whatsapp_conversaciones_activas TO authenticated;

COMMENT ON COLUMN public.whatsapp_conversaciones.tomada_por IS
  'Vendedor/admin que se hizo cargo de una conversación derivada a humano. Ortogonal a estado — no se toca via RLS, solo via /api/notif/whatsapp-conversacion-accion (service_role).';
COMMENT ON COLUMN public.whatsapp_conversaciones.tomada_en IS
  'Timestamp de cuándo se tomó la conversación. NULL si está libre.';

COMMIT;
