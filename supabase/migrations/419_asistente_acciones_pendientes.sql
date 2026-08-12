-- =============================================================
-- 419_asistente_acciones_pendientes.sql
-- Infraestructura de confirmación explícita para tools de ESCRITURA
-- del asistente de ayuda (distinto de las tools de solo lectura ya
-- existentes desde 203_asistente_tools_lectura.sql).
--
-- Ninguna tool de escritura corría antes de esto sin pasar por un
-- click humano de Confirmar/Cancelar: cuando una tool se marca con
-- `requiereConfirmacion: true` (ver lib/asistente-tools.js),
-- ejecutarTool() nunca llama a su execute() en el mismo turno en que
-- Gemini la "decide" — en cambio guarda acá la propuesta (con un
-- resumen en texto plano para mostrarle al usuario) y devuelve el id.
-- El execute() real solo corre desde resolverAccionPendiente(),
-- después de que el usuario clickea Confirmar en el chat-widget.
--
-- NOTA: esta migración ya fue APLICADA directo en producción
-- (jgiquzjwoedmzwqgzubr) vía Supabase:apply_migration con este mismo
-- contenido. Se agrega acá para que el historial de migraciones del
-- repo quede consistente con lo que ya corre en producción (mismo
-- criterio que 418_sec011_revoke_default_grants_v_rentabilidad_zona_ruta.sql).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.asistente_acciones_pendientes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  UUID NOT NULL REFERENCES public.asistente_conversaciones(id) ON DELETE CASCADE,
  usuario_id       UUID NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  empresa_id       UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  tool_nombre      TEXT NOT NULL,
  tool_args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  resumen          TEXT NOT NULL, -- lo único que ve el usuario antes de confirmar, ver resumen() en asistente-tools.js
  estado           TEXT NOT NULL DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente','confirmada','cancelada','expirada','ejecutada','error')),
  resultado        JSONB,          -- se completa recién al ejecutar (o al fallar) la acción confirmada
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_en      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_asistente_acciones_pend_conv
  ON public.asistente_acciones_pendientes(conversacion_id, estado);

CREATE INDEX IF NOT EXISTS idx_asistente_acciones_pend_usuario
  ON public.asistente_acciones_pendientes(usuario_id, creado_en DESC);

ALTER TABLE public.asistente_acciones_pendientes ENABLE ROW LEVEL SECURITY;

-- Solo SELECT por RLS (mismo criterio que asistente_conversaciones /
-- asistente_mensajes): el INSERT/UPDATE real de esta tabla lo hace
-- siempre el handler con SERVICE_ROLE_KEY (ejecutarTool /
-- resolverAccionPendiente en lib/asistente-tools.js), nunca el
-- browser directo vía PostgREST.
DROP POLICY IF EXISTS asistente_acciones_pend_empresa ON public.asistente_acciones_pendientes;
CREATE POLICY asistente_acciones_pend_empresa ON public.asistente_acciones_pendientes
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

REVOKE ALL ON public.asistente_acciones_pendientes FROM anon, authenticated;
GRANT SELECT ON public.asistente_acciones_pendientes TO authenticated;

COMMENT ON TABLE public.asistente_acciones_pendientes IS
  'Propuestas de tools de ESCRITURA del asistente de ayuda esperando confirmación humana (click Confirmar/Cancelar en el chat-widget) antes de ejecutarse. Ver requiereConfirmacion en lib/asistente-tools.js.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '419_asistente_acciones_pendientes.sql', '419', 'claude-session',
        'Tabla asistente_acciones_pendientes: infraestructura de confirmación explícita (click Confirmar/Cancelar) antes de ejecutar cualquier tool de escritura del asistente de ayuda. Ninguna tool de escritura existe todavía — esto prepara el mecanismo para la primera que se agregue.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
