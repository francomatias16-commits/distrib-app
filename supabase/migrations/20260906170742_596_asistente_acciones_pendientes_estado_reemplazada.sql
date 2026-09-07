-- =============================================================
-- 596_asistente_acciones_pendientes_estado_reemplazada.sql
--
-- NOTA: esta migración ya fue APLICADA directo en producción
-- (jgiquzjwoedmzwqgzubr) en la sesión anterior, vía Supabase:apply_migration
-- (ver registro en schema_migrations_registry, número '596'). Se agrega/
-- corrige acá para que el historial del repo quede consistente con lo que
-- ya corre en la base — mismo criterio que 419_asistente_acciones_pendientes.sql.
-- Originalmente se había numerado como 577 en un intento anterior de esta
-- misma sesión, pero ese número ya lo usa 577_webhooks_recibidos.sql (otra
-- migración real, previa, que no estaba en el árbol que se tenía a mano en
-- ese momento) — se renumeró a 596 para que coincida con lo aplicado.
--
-- Fase 1 del plan de robustez conversacional (corrección sin reiniciar,
-- ver PLAN_MAESTRO_ROBUSTEZ_CONVERSACIONAL_ASISTENTE_2026.md).
--
-- Agrega el estado 'reemplazada' al CHECK de
-- asistente_acciones_pendientes. Por qué un estado nuevo y no reusar
-- 'cancelada': en auditoría se quiere distinguir "el usuario se
-- arrepintió y canceló" de "el usuario corrigió un dato de la propuesta
-- y el asistente volvió a llamar la misma tool con los datos
-- corregidos, sin que medie un Cancelar explícito".
--
-- Quién lo usa:
--   - lib/asistente-tools/index.js: al recibir una tool con
--     requiereConfirmacion:true en una conversación que ya tenía una
--     fila 'pendiente', marca esa fila anterior como 'reemplazada' antes
--     de insertar la nueva propuesta.
--   - lib/repos/asistente.js::obtenerAccionPendienteVigente: consulta la
--     propuesta 'pendiente' vigente de la conversación en cada turno
--     nuevo (lib/handlers/asistente.js la usa para poder decirle al
--     modelo "hay una propuesta sin confirmar, si te están corrigiendo
--     un dato volvé a llamar la misma función").
--
-- Constraint original: ver 419_asistente_acciones_pendientes.sql
--   CHECK (estado IN ('pendiente','confirmada','cancelada','expirada','ejecutada','error'))
-- =============================================================

ALTER TABLE public.asistente_acciones_pendientes
  DROP CONSTRAINT IF EXISTS asistente_acciones_pendientes_estado_check;

ALTER TABLE public.asistente_acciones_pendientes
  ADD CONSTRAINT asistente_acciones_pendientes_estado_check
  CHECK (estado IN ('pendiente','confirmada','cancelada','expirada','ejecutada','error','reemplazada'));

COMMENT ON COLUMN public.asistente_acciones_pendientes.estado IS
  'pendiente | confirmada | cancelada | expirada | ejecutada | error | reemplazada (el usuario corrigio un dato de la propuesta y se creo una nueva fila en su lugar, sin pasar por Cancelar).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '596_asistente_acciones_pendientes_estado_reemplazada.sql', '596', 'claude-session',
        'Fase 1 del plan de robustez conversacional: agrega el estado ''reemplazada'' al CHECK de asistente_acciones_pendientes, para distinguir correccion de una propuesta (el usuario dicta un dato corregido mientras sigue pendiente) de cancelacion explicita.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
