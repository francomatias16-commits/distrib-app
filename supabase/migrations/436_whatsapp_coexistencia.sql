-- ============================================================
-- MIGRACIÓN 436 — WhatsApp Coexistencia (Onboard WhatsApp Business
-- app users)
-- distrib v601
--
-- Contexto: hasta acá Embedded Signup solo ofrecía "Crea uno nuevo"
-- (featureType vacío) — el dueño tenía que resignar su WhatsApp
-- Business de toda la vida (o usar un número nuevo) para conectar
-- distrib. Esta migración agrega el soporte de datos para el flujo
-- alternativo de Meta ("Coexistencia"): el número sigue viviendo en
-- la app de WhatsApp Business del celular Y en Cloud API al mismo
-- tiempo, con el historial de mensajes sincronizado entre las dos.
--
-- Columnas nuevas:
--   es_coexistencia         — true si esta empresa conectó su número
--                              vía el flujo de Coexistencia (en vez de
--                              crear un WABA nuevo). Distingue el caso
--                              en el que NO hay que llamar a /register
--                              (el número ya está registrado en la app)
--                              y en el que la desconexión no pasa por
--                              el flujo normal de "necesita_reconexion"
--                              sino por los webhooks de account_update
--                              (PARTNER_REMOVED/ACCOUNT_OFFBOARDED).
--   historial_sincronizado  — true una vez que se pidieron (no
--                              necesariamente terminaron: eso es
--                              asincrónico vía webhooks) la sync de
--                              contactos (smb_app_state_sync) y de
--                              historial de chats (history) tras el
--                              alta. Solo aplica a coexistencia.
--   desconectado_en         — se completa cuando Meta avisa por
--                              webhook que el dueño desconectó el
--                              número desde la app (PARTNER_REMOVED /
--                              ACCOUNT_OFFBOARDED); se limpia si vuelve
--                              a conectar (ACCOUNT_RECONNECTED o repite
--                              el flujo de Embedded Signup).
-- ============================================================

ALTER TABLE public.empresa_whatsapp
  ADD COLUMN IF NOT EXISTS es_coexistencia        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS historial_sincronizado  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS desconectado_en         TIMESTAMPTZ;

COMMENT ON COLUMN public.empresa_whatsapp.es_coexistencia IS
  'true si el número se conectó vía el flujo de Coexistencia de Meta '
  '(featureType=whatsapp_business_app_onboarding): el dueño sigue usando '
  'su WhatsApp Business normal desde el celular y distrib manda/recibe '
  'por el mismo número via Cloud API. Cuando es true no se llama a '
  '/register (el número ya está registrado) y la desconexión llega por '
  'webhook (account_update) en vez de por error 190 de token.';
COMMENT ON COLUMN public.empresa_whatsapp.historial_sincronizado IS
  'true una vez pedida (no necesariamente terminada) la sincronización '
  'de contactos + historial de chats tras un alta por Coexistencia. '
  'Solo se puede pedir una vez por alta — si hay que repetirla, el '
  'cliente primero tiene que desconectar y volver a hacer el flujo.';
COMMENT ON COLUMN public.empresa_whatsapp.desconectado_en IS
  'Marca de cuándo Meta avisó (webhook account_update, evento '
  'PARTNER_REMOVED o ACCOUNT_OFFBOARDED) que el dueño desconectó el '
  'número de Cloud API desde la app de WhatsApp Business. Se limpia '
  'sola al reconectar.';

-- La vista pública (272/275) necesita exponer las columnas nuevas para
-- que el panel admin distinga "conectado por coexistencia" (y pueda
-- mostrar el estado de desconexión) sin pasar por el backend.
CREATE OR REPLACE VIEW public.v_empresa_whatsapp_estado AS
SELECT
  ew.empresa_id,
  ew.phone_number_id,
  ew.verified_name,
  ew.necesita_reconexion,
  ew.es_coexistencia,
  ew.historial_sincronizado,
  ew.desconectado_en,
  ew.conectado_por,
  ew.conectado_en,
  ew.actualizado_en
FROM public.empresa_whatsapp ew;

ALTER VIEW public.v_empresa_whatsapp_estado SET (security_invoker = true);

-- El GRANT de columnas es aditivo pero no acumulativo respecto de la
-- lista completa (mismo criterio que dejó anotado la migración 275):
-- hay que reemplazarlo entero con las columnas viejas + las nuevas.
GRANT SELECT (
  empresa_id, phone_number_id, verified_name, necesita_reconexion,
  es_coexistencia, historial_sincronizado, desconectado_en,
  conectado_por, conectado_en, actualizado_en
) ON public.empresa_whatsapp TO authenticated;

-- Índice para resolver empresa por waba_id (webhooks de account_update
-- no traen phone_number_id, solo el WABA_ID en entry.id).
CREATE INDEX IF NOT EXISTS empresa_whatsapp_waba_id_idx
  ON public.empresa_whatsapp (waba_id);

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '436_whatsapp_coexistencia.sql', '436', 'claude-session',
        'Soporte de datos para WhatsApp Coexistencia: es_coexistencia/historial_sincronizado/desconectado_en en empresa_whatsapp, vista actualizada, índice por waba_id.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
