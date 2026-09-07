-- 599_backfill_whatsapp_conversaciones_procesando_desde_v1055.sql
--
-- BACKFILL, no cambia nada en producción: esta columna ya existe en
-- Supabase (jgiquzjwoedmzwqgzubr) desde el fix de v1055 (Etapa 7
-- transversal, Bloque 4 — lock de conversación de WhatsApp), pero nunca
-- se guardó como migración en el repo. El comentario de
-- `lib/repos/whatsapp-bot.js` y `lib/handlers/notif.js` cita "migración
-- 577", y ese número corresponde en realidad a otro archivo
-- (577_webhooks_recibidos.sql, tabla `webhooks_recibidos` de Mercado
-- Pago/WhatsApp), sin relación con `whatsapp_conversaciones`. Mismo
-- patrón exacto que el backfill 598 (rpc_confirmar_ruta), detectado en
-- la misma revisión de Etapa 7. Este archivo solo documenta en el repo
-- lo que ya corre en producción, verificado hoy contra
-- `information_schema.columns` en vivo — sin él, una restauración de la
-- base solo con migraciones perdería esta columna, y con ella el lock de
-- conversación quedaría completamente deshabilitado (best-effort: sigue
-- sin bloquear el mensaje, ver `adquirirLockConversacion`).
--
-- Qué resuelve: `obtenerBorrador`/`guardarBorrador` (whatsapp-pedido-
-- tools.js) hacían un read-modify-write plano sobre `pedido_borrador`.
-- Dos mensajes del mismo cliente entregados en invocaciones del webhook
-- solapadas corrían dos `procesarMensajeTexto` en paralelo sin ninguna
-- sincronización, con riesgo de que la segunda en terminar pisara el
-- borrador que había armado la primera. `procesando_desde` es el claim
-- atómico que usa `adquirirLockConversacion`/`liberarLockConversacion`
-- (lib/repos/whatsapp-bot.js) para serializar el procesamiento por
-- conversación: el UPDATE ... WHERE es atómico por sí mismo pese al
-- connection pooling de PostgREST, y el lock huérfano (crash/timeout)
-- expira solo a los 2 minutos (LOCK_CONVERSACION_TTL_MS).

ALTER TABLE public.whatsapp_conversaciones
  ADD COLUMN IF NOT EXISTS procesando_desde timestamptz;

COMMENT ON COLUMN public.whatsapp_conversaciones.procesando_desde IS
  'Claim atómico de lock de procesamiento por conversación (Etapa 7, Bloque 4, v1055) -- ver adquirirLockConversacion/liberarLockConversacion en lib/repos/whatsapp-bot.js. NULL = libre. Lock huérfano expira solo por TTL (2 min) del lado de la app, no hay expiración en SQL.';
