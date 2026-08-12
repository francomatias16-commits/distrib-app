-- =============================================================
-- 204_asistente_conversaciones.sql
-- Fase 1 del asistente de ayuda: historial corto multi-turn.
--
-- NOTA DE NUMERACIÓN: preparada originalmente como
-- "201_asistente_conversaciones.sql"; renumerada a 204 porque 200,
-- 201 y 202 ya estaban tomados localmente por otro trabajo. Ver
-- 203_asistente_tools_lectura.sql para el detalle.
--
-- Dos tablas:
--   asistente_conversaciones: una fila por sesión de chat.
--   asistente_mensajes: los turnos (user/model) de cada sesión.
--
-- Solo se lee la ventana reciente desde el handler (ver
-- HISTORIAL_MAX_MENSAJES en lib/handlers/asistente.js), nunca todo
-- el historial completo — por costo de tokens, no por límite de la
-- tabla en sí.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.asistente_conversaciones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   UUID REFERENCES public.usuarios(id) ON DELETE CASCADE,
  empresa_id   UUID REFERENCES public.empresas(id) ON DELETE CASCADE,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.asistente_mensajes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  UUID NOT NULL REFERENCES public.asistente_conversaciones(id) ON DELETE CASCADE,
  rol              TEXT NOT NULL CHECK (rol IN ('user','model')),
  contenido        TEXT NOT NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asistente_mensajes_conv_fecha
  ON public.asistente_mensajes(conversacion_id, creado_en);

CREATE INDEX IF NOT EXISTS idx_asistente_conversaciones_usuario
  ON public.asistente_conversaciones(usuario_id, actualizado_en DESC);

ALTER TABLE public.asistente_conversaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistente_mensajes       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asistente_conversaciones_empresa ON public.asistente_conversaciones;
CREATE POLICY asistente_conversaciones_empresa ON public.asistente_conversaciones
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

DROP POLICY IF EXISTS asistente_mensajes_empresa ON public.asistente_mensajes;
CREATE POLICY asistente_mensajes_empresa ON public.asistente_mensajes
  FOR SELECT USING (
    conversacion_id IN (
      SELECT id FROM public.asistente_conversaciones
      WHERE empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    )
  );

REVOKE ALL ON public.asistente_conversaciones FROM anon, authenticated;
REVOKE ALL ON public.asistente_mensajes       FROM anon, authenticated;
GRANT SELECT ON public.asistente_conversaciones TO authenticated;
GRANT SELECT ON public.asistente_mensajes       TO authenticated;

COMMENT ON TABLE public.asistente_conversaciones IS
  'Sesiones de chat del asistente de ayuda, para historial multi-turn corto. Ver lib/handlers/asistente.js.';
COMMENT ON TABLE public.asistente_mensajes IS
  'Mensajes de una conversación del asistente de ayuda (rol user/model). Se lee solo la ventana reciente, no todo el historial.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '204_asistente_conversaciones.sql', '204', 'claude-session',
        'Fase 1 asistente: tablas asistente_conversaciones/asistente_mensajes para historial multi-turn corto (renumerada de 201 a 204 para no chocar con migraciones locales existentes).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
