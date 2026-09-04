-- 593_tareas_automatizacion_usuario_id.sql
-- Fase 2.2 de PLAN_CLIENTES_EN_FUGA.md: agrega
-- tareas_automatizacion.usuario_id (nullable) para poder dirigir una
-- tarea a una persona puntual -- el vendedor_id_default del cliente en
-- fuga -- en vez de solo por roles. No afecta tareas existentes ni la
-- acción crear_tarea genérica de reglas de usuario (queda NULL salvo
-- que el listener cliente_en_riesgo_fuga la complete, ver
-- lib/repos/clientes-fuga.js:crearTareaFuga).
--
-- Reconstruida contra la definición real en producción (ver nota de
-- 592: aplicada en la sesión anterior pero nunca había quedado como
-- archivo versionado en el repo).

ALTER TABLE public.tareas_automatizacion
  ADD COLUMN IF NOT EXISTS usuario_id uuid NULL REFERENCES public.usuarios(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tareas_automatizacion.usuario_id IS
  'Persona puntual a la que se dirige la tarea (ej. vendedor_id_default del cliente), además/en vez de roles. NULL = solo visible por rol, comportamiento previo a esta migración.';
