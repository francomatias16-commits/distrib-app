-- ============================================================
-- MIGRACIÓN 544 — WhatsApp: guardar business_id (Business Portfolio)
-- para poder reinyectarlo al reconectar
-- distrib v986
--
-- Contexto: el postMessage FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING de
-- Meta trae, además de waba_id, un business_id (el ID del Business
-- Portfolio/Business Manager que quedó dueño del WABA) — hasta ahora
-- no se guardaba. Sin él, cada vez que un dueño reconecta o cambia de
-- número (botón "Reconectar / cambiar número"), Embedded Signup le
-- vuelve a mostrar la pantalla de "crear un negocio nuevo" en vez de
-- reusar el Business Manager que ya tiene — y esa pantalla es la que
-- choca con el límite de Meta de negocios creables por cuenta de
-- Facebook ("Alcanzaste el número máximo de negocios que puedes
-- crear en este momento").
--
-- Guardando el business_id la primera vez, en la próxima reconexión
-- el frontend puede inyectarlo en extras.setup.business.id (ver
-- "Pre-filling screens" de Meta) para que Embedded Signup salte
-- directo la pantalla de negocio y de selección/creación de WABA,
-- reduciendo la exposición al error.
-- ============================================================

ALTER TABLE public.empresa_whatsapp
  ADD COLUMN IF NOT EXISTS business_id TEXT;

COMMENT ON COLUMN public.empresa_whatsapp.business_id IS
  'ID del Business Portfolio (Business Manager) de Meta dueño del WABA, '
  'devuelto por el postMessage FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING. '
  'Se reinyecta como extras.setup.business.id en reconexiones para que '
  'Embedded Signup salte la pantalla de creación de negocio.';

-- OJO: CREATE OR REPLACE VIEW no permite insertar una columna nueva en
-- medio del SELECT existente, solo agregar al final (42P16: "cannot
-- change name of view column ... to business_id") — se descubrió al
-- aplicar contra producción. business_id va al final del SELECT.
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
  ew.actualizado_en,
  ew.business_id
FROM public.empresa_whatsapp ew;

ALTER VIEW public.v_empresa_whatsapp_estado SET (security_invoker = true);

-- Mismo criterio que 275/436: el GRANT de columnas no es acumulativo,
-- hay que reemplazarlo entero con las columnas viejas + la nueva.
GRANT SELECT (
  empresa_id, phone_number_id, verified_name, necesita_reconexion,
  es_coexistencia, historial_sincronizado, desconectado_en, business_id,
  conectado_por, conectado_en, actualizado_en
) ON public.empresa_whatsapp TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '20260825000000_544_whatsapp_business_id_prefill_reconexion.sql', '544', 'claude-session',
        'Columna business_id en empresa_whatsapp (Business Portfolio del WABA), expuesta en v_empresa_whatsapp_estado (al final del SELECT, ver 42P16), para reinyectar en reconexiones y saltear la pantalla de creación de negocio.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
