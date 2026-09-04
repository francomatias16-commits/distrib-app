-- 594_tareas_automatizacion_cliente_id.sql
-- Fase 3 de PLAN_CLIENTES_EN_FUGA.md: la pantalla de "Clientes en fuga"
-- necesita saber, por cada cliente que devuelve fn_clientes_en_fuga, si ya
-- se disparó una acción (tarea de cobro/llamada creada por el listener
-- cliente_en_riesgo_fuga vs. WhatsApp automático ya enviado). Para las
-- tareas, tareas_automatizacion (433) no tenía forma de volver a un
-- cliente puntual (solo empresa_id + roles/usuario_id genéricos) — se
-- agrega cliente_id nullable e informativo. No rompe nada existente:
-- las tareas creadas por otras reglas de automatización (crear_tarea con
-- payload sin cliente_id) simplemente quedan con cliente_id NULL, igual
-- que hasta ahora.
--
-- Aplicada directo en producción (jgiquzjwoedmzwqgzubr) vía Supabase MCP
-- en esta sesión; este archivo la deja versionada en el repo.

ALTER TABLE public.tareas_automatizacion
  ADD COLUMN IF NOT EXISTS cliente_id uuid REFERENCES public.clientes(id) ON DELETE SET NULL;

-- Índice para el join de la pantalla (empresa_id + evento_disparador +
-- cliente_id in (...)), mismo criterio que otros índices de la tabla.
CREATE INDEX IF NOT EXISTS idx_tareas_automatizacion_cliente
  ON public.tareas_automatizacion (cliente_id)
  WHERE cliente_id IS NOT NULL;

COMMENT ON COLUMN public.tareas_automatizacion.cliente_id IS
  'Cliente puntual al que refiere la tarea, cuando aplica (ej: listener cliente_en_riesgo_fuga). NULL para tareas sin un cliente asociado.';
