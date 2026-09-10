-- ============================================================
-- MIGRACIÓN 611 — permite conectar el catálogo sin tener WhatsApp
-- de mensajería (Embedded Signup) conectado
-- distrib
--
-- La migración 272 creó empresa_whatsapp con waba_id/phone_number_id/
-- access_token NOT NULL, pensada para 1 fila = 1 número de mensajería
-- conectado. La 610 agregó las columnas catalog_* a la misma tabla (es
-- la misma cuenta de Meta, un permiso más), pero eso significa que una
-- empresa que SOLO quiere sincronizar catálogo — sin usar el bot de
-- WhatsApp para pedidos — no puede insertar su fila: no tiene
-- waba_id/phone_number_id/access_token porque nunca pasó por Embedded
-- Signup.
--
-- Se relajan esas 3 columnas a NULLABLE. No rompe nada existente:
--  - Las filas ya conectadas por Embedded Signup siguen teniendo esos
--    valores (esta migración no los toca).
--  - Todo el código de mensajería (notif.js, whatsapp-bot.js) sigue
--    andando igual porque solo llega a leer una fila de empresa_whatsapp
--    cuando hay un phone_number_id que matchear (viene del lado de
--    Meta/webhook), nunca asume que toda fila de empresa_whatsapp tiene
--    mensajería.
--  - resolverCredencialesWhatsapp (notif.js) ya maneja `data` sin
--    phone_number_id/access_token cayendo a su fallback (número global
--    de prueba) — ver ese código, no hace falta tocarlo acá.
-- ============================================================

ALTER TABLE public.empresa_whatsapp
  ALTER COLUMN waba_id DROP NOT NULL,
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

COMMENT ON TABLE public.empresa_whatsapp IS
  'Credenciales de WhatsApp de cada empresa — mensajería propia (Etapa 7, '
  'Embedded Signup: waba_id/phone_number_id/access_token) y/o catálogo de '
  'Commerce Manager (migración 610, catalog_*). Una empresa puede tener '
  'una sola, ambas, o ninguna — todas las columnas de credenciales son '
  'NULLABLE desde esta migración (611). Escritura solo service_role; '
  'lectura de columnas no sensibles vía v_empresa_whatsapp_estado / '
  'v_empresa_whatsapp_catalog_estado para dueño/admin.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '611_whatsapp_catalog_sin_mensajeria.sql',
  '611',
  'claude-session',
  'Relaja waba_id/phone_number_id/access_token de empresa_whatsapp a '
  'NULLABLE para poder conectar solo el catálogo (610) sin haber pasado '
  'por Embedded Signup de mensajería (272).'
)
ON CONFLICT DO NOTHING;
