-- 604_whatsapp_uso_conversacion_y_tools.sql
-- Capa 3 de PLAN_QA_ASISTENTE_WHATSAPP.md (equivalente a la migración 600
-- del asistente de ayuda del dashboard): la detección de fallas reales del
-- asistente de pedidos por WhatsApp necesita saber QUÉ tools se llamaron
-- en cada turno y con QUÉ proveedor respondió — ninguna de las dos cosas
-- se persiste hoy.
--
-- A diferencia del asistente de ayuda, WhatsApp no tiene una tabla
-- `asistente_uso` separada: cada turno ya tiene su fila propia en
-- `whatsapp_mensajes` (una por mensaje saliente del bot), con
-- `conversacion_id` NOT NULL desde que existe la tabla (migración 247) —
-- no hace falta agregar ninguna columna de vínculo, ya está. Por eso acá
-- alcanza con sumar las dos columnas directo a `whatsapp_mensajes`, sin
-- crear una tabla nueva.
--
-- `resultado.proveedor` y `resultado.tools` ya se calculan en cada turno
-- (responderConFallback() los devuelve, ver lib/handlers/notif.js,
-- procesarConAsistente()) — hoy se descartan en un console.log() sin
-- persistir. Este cambio solo agrega dónde guardarlo; el handler que lo
-- escribe se actualiza aparte (ver lib/handlers/notif.js,
-- procesarConAsistente() / responderYRegistrar()).
--
-- Solo tiene sentido en los mensajes SALIENTES del bot (direccion='out'):
-- un mensaje entrante del cliente no usó ningún proveedor/tool. Se dejan
-- NULL/'[]' en el resto de las filas (entrantes, y salientes históricos
-- anteriores a esta migración) a propósito — mismo criterio que
-- conversacion_id NULLABLE en la 600, no se reprocesan filas viejas.

ALTER TABLE public.whatsapp_mensajes
  ADD COLUMN IF NOT EXISTS tools_usadas jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS proveedor_usado text NULL;

COMMENT ON COLUMN public.whatsapp_mensajes.tools_usadas IS
  'Nombres de las tools que el modelo llamó para armar este mensaje saliente (array de strings, [] si no llamó ninguna o si es un mensaje entrante/del sistema) — mismo dato que ya devuelve responderConFallback() y antes se descartaba. Usado por scripts/detectar-fallas-asistente-whatsapp.js (Capa 3) para encontrar mensajes de cliente con intención de dominio que no dispararon ninguna tool.';

COMMENT ON COLUMN public.whatsapp_mensajes.proveedor_usado IS
  'Proveedor de IA (gemini/groq/openrouter) que generó este mensaje saliente del bot, NULL en mensajes entrantes/del sistema y en filas anteriores a esta migración. Usado para detectar caídas a Groq/OpenRouter (Gemini agotado) sin tener que traer todas las filas.';

-- Útil para el chequeo de "cayó a Groq/OpenRouter" sin traer todas las
-- filas: filtra directo por proveedor+fecha, mismo criterio que
-- idx_asistente_uso_proveedor_fecha en la 600.
CREATE INDEX IF NOT EXISTS idx_whatsapp_mensajes_proveedor_fecha
  ON public.whatsapp_mensajes(proveedor_usado, created_at DESC)
  WHERE proveedor_usado IS NOT NULL;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '604_whatsapp_uso_conversacion_y_tools.sql', '604', 'claude-session',
        'Capa 3 de PLAN_QA_ASISTENTE_WHATSAPP.md: agrega tools_usadas y proveedor_usado a whatsapp_mensajes (no hace falta conversacion_id, whatsapp_mensajes ya lo tiene NOT NULL desde la 247) para poder detectar mensajes de cliente sin tool llamada y caídas a Groq/OpenRouter. Ver scripts/detectar-fallas-asistente-whatsapp.js.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
