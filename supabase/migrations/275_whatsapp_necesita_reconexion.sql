-- 275_whatsapp_necesita_reconexion.sql
--
-- Contexto: cuando el token de una empresa vence (error 190 de Meta), hoy
-- lo único que pasa es un push a los admins (alertarTokenWhatsAppVencido,
-- agregada antes de esta migración) — pero nada queda registrado en la
-- tabla, así que el panel "Conectar WhatsApp" sigue mostrando "conectado"
-- aunque el número ya no mande nada. Esta migración agrega el campo para
-- que el estado se pueda reflejar en pantalla.

ALTER TABLE public.empresa_whatsapp
  ADD COLUMN IF NOT EXISTS necesita_reconexion BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresa_whatsapp.necesita_reconexion IS
  'true cuando la última llamada a la API de WhatsApp con el access_token '
  'de esta empresa devolvió error 190 (OAuthException / token vencido o '
  'inválido). Se pone en true desde marcarEstadoTokenWhatsapp() en '
  'lib/handlers/notif.js al detectar el 190, y se limpia solo (false) en '
  'el próximo envío exitoso, o al reconectar desde "Conectar mi WhatsApp".';

-- La vista pública (272) necesita exponer la columna nueva para que el
-- panel admin la pueda leer sin pasar por el backend — mismo criterio que
-- el resto de columnas no sensibles ya expuestas ahí.
CREATE OR REPLACE VIEW public.v_empresa_whatsapp_estado AS
SELECT
  ew.empresa_id,
  ew.phone_number_id,
  ew.verified_name,
  ew.necesita_reconexion,
  ew.conectado_por,
  ew.conectado_en,
  ew.actualizado_en
FROM public.empresa_whatsapp ew;

ALTER VIEW public.v_empresa_whatsapp_estado SET (security_invoker = true);

-- El GRANT de columnas de la migración 272 hay que reemplazarlo (no basta
-- con agregar, GRANT es aditivo pero el original no incluía esta columna).
GRANT SELECT (empresa_id, phone_number_id, verified_name, necesita_reconexion, conectado_por, conectado_en, actualizado_en)
  ON public.empresa_whatsapp TO authenticated;
