-- =============================================================
-- 20260818_sync02_whatsapp_conversacion_scope_por_empresa.sql
-- Auditoría Integral 2026 — SYNC-02
--
-- Problema (ver Matriz de hallazgos — Auditoría Integral 2026):
--   idx_whatsapp_conv_telefono_abierta (migración 247) es un índice único
--   GLOBAL por `telefono` (WHERE estado <> 'cerrada'), sin empresa_id.
--   Combinado con que resolverEmpresaCliente() en lib/handlers/notif.js
--   consultaba "conversación abierta por teléfono" antes de considerar
--   phone_number_id, un mismo número de teléfono que sea cliente de más
--   de una empresa de la plataforma solo podía tener UNA conversación
--   abierta a la vez a nivel de toda la base — la segunda empresa que
--   recibiera un mensaje de ese teléfono terminaba leyendo/escribiendo
--   la conversación de la primera.
--   Marcado en la matriz como 🔍 no verificado en datos actuales (QA no
--   tiene teléfonos duplicados hoy) — riesgo condicional de configuración
--   multi-tenant, no un incidente confirmado en producción.
--
-- Fix de esquema: el índice único de "una conversación abierta por
-- teléfono" pasa a ser por (empresa_id, telefono) — cada empresa puede
-- tener su propia conversación abierta con un teléfono compartido, sin
-- pisarse. El fix de código que acompaña esta migración (notif.js/
-- whatsapp-bot.js) deja de resolver "conversación abierta" sin acotar
-- por empresa cuando el phone_number_id ya identifica la empresa
-- receptora sin ambigüedad.

DROP INDEX IF EXISTS public.idx_whatsapp_conv_telefono_abierta;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_conv_empresa_telefono_abierta
  ON public.whatsapp_conversaciones(empresa_id, telefono)
  WHERE estado <> 'cerrada';

COMMENT ON INDEX public.idx_whatsapp_conv_empresa_telefono_abierta IS
  'Solo puede haber una conversación no cerrada por (empresa_id, telefono) — reemplaza al índice único global por telefono de la migración 247 (SYNC-02, Auditoría Integral 2026): ese índice impedía que dos empresas distintas tuvieran cada una su propia conversación abierta con un mismo número compartido.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '20260818_sync02_whatsapp_conversacion_scope_por_empresa.sql', '20260818c', 'claude-session',
        'SYNC-02 (Auditoría Integral 2026): reemplaza el índice único global de conversación abierta por teléfono por uno acotado a (empresa_id, telefono), para que un teléfono compartido entre clientes de distintas empresas no fuerce que solo una tenga conversación abierta a la vez. Acompaña el fix de código en lib/handlers/notif.js y lib/repos/whatsapp-bot.js que deja de resolver conversación abierta sin acotar por empresa cuando phone_number_id ya la identifica.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
