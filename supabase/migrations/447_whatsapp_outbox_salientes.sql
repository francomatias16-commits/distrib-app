-- 447_whatsapp_outbox_salientes.sql
-- Etapa 5 offline (plan PLAN_OFFLINE_COMPLETO.md), punto 3: outbox para los
-- mensajes salientes del bot de WhatsApp. No hace falta una tabla ni una
-- columna nueva — se reusa whatsapp_mensajes.metadata (jsonb, ya existía
-- desde la migración 247) para guardar estado_envio/intentos/ultimo_error.
-- Ver lib/repos/whatsapp-bot.js (obtenerSalientesPendientes/
-- marcarSalienteEnviado/marcarSalienteFallido) y el cron
-- _svc=whatsapp-salientes-reprocesar-cron en lib/handlers/notif.js.
--
-- Este índice parcial es lo único que agrega esta migración: sin él, el
-- barrido del cron (WHERE direccion='out' AND metadata->>'estado_envio'
-- = 'pendiente') haría un seq scan completo de whatsapp_mensajes a medida
-- que la tabla crezca.
CREATE INDEX IF NOT EXISTS idx_whatsapp_mensajes_salientes_pendientes
  ON public.whatsapp_mensajes ((metadata ->> 'estado_envio'))
  WHERE direccion = 'out';
