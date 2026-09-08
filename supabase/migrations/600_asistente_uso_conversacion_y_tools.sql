-- 600_asistente_uso_conversacion_y_tools.sql
-- Capa 3 de PLAN_QA_ASISTENTE.md: la detección de fallas reales del
-- asistente (conversación sin tool llamada teniendo palabras de dominio,
-- conversación que degradó a Groq/OpenRouter, etc.) necesita saber QUÉ
-- tools se llamaron en cada turno y a QUÉ conversación pertenece cada fila
-- de asistente_uso — ninguna de las dos cosas se persiste hoy.
--
-- Hoy asistente_uso (195_asistente_ayuda.sql) guarda proveedor_usado,
-- articulos_encontrados, latencia_ms y pregunta, pero NO qué tools se
-- llamaron ni el conversacion_id — y asistente_mensajes
-- (204_asistente_conversaciones.sql) guarda el texto de cada turno pero
-- tampoco sabe qué tools se usaron para responderlo. Las dos tablas ni
-- siquiera están enlazadas entre sí hoy.
--
-- `toolsUsadas` YA se calcula en cada turno (responderConFallback() lo
-- devuelve, ver lib/handlers/asistente.js línea ~754) — hoy se descarta
-- sin persistir. Este cambio solo agrega dónde guardarlo; el handler que
-- lo escribe se actualiza aparte (ver lib/handlers/asistente.js,
-- registrarUso()).
--
-- conversacion_id es NULLABLE a propósito: no reprocesa filas históricas
-- de asistente_uso (quedan sin conversación asociada, se pueden seguir
-- usando para lo que ya se usaban: rate limiting y métricas de proveedor).

ALTER TABLE public.asistente_uso
  ADD COLUMN IF NOT EXISTS conversacion_id uuid NULL
    REFERENCES public.asistente_conversaciones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tools_usadas jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.asistente_uso.conversacion_id IS
  'Conversación a la que pertenece este turno (NULL en filas anteriores a esta migración). Permite cruzar asistente_uso con asistente_mensajes para auditoría de Capa 3, ver PLAN_QA_ASISTENTE.md.';

COMMENT ON COLUMN public.asistente_uso.tools_usadas IS
  'Nombres de las tools que el modelo llamó en este turno (array de strings, [] si no llamó ninguna) — mismo dato que ya devuelve responderConFallback() y antes se descartaba. Usado por scripts/detectar-fallas-asistente.js (Capa 3) para encontrar preguntas de dominio que no dispararon ninguna tool.';

CREATE INDEX IF NOT EXISTS idx_asistente_uso_conversacion
  ON public.asistente_uso(conversacion_id);

-- Útil para el chequeo de "cayó a Groq/OpenRouter" (Gemini agotado) sin
-- tener que traer todas las filas: filtra directo por proveedor+fecha.
CREATE INDEX IF NOT EXISTS idx_asistente_uso_proveedor_fecha
  ON public.asistente_uso(proveedor_usado, creado_en DESC);

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '600_asistente_uso_conversacion_y_tools.sql', '600', 'claude-session',
        'Capa 3 de PLAN_QA_ASISTENTE.md: agrega conversacion_id y tools_usadas a asistente_uso para poder cruzarla con asistente_mensajes y detectar conversaciones sin tool llamada, repreguntas rápidas, y caídas a Groq/OpenRouter. Ver scripts/detectar-fallas-asistente.js.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
