-- 273_whatsapp_access_token_cifrado.sql
--
-- Contexto: empresa_whatsapp.access_token (migración 272) se guardaba en
-- texto plano — quedó anotado como pendiente en el comentario original de
-- esa migración. A partir de v293, lib/handlers/notif.js cifra el
-- access_token con lib/crypto-secrets.js (AES-256-GCM, misma clave
-- ARCA_SECRETS_KEY que ya se usa para los certificados ARCA y para
-- integraciones_pago.access_token de Mercado Pago — ver migración 133)
-- antes de guardarlo, y lo descifra al leerlo para llamar a la API de
-- WhatsApp Cloud.
--
-- lib/crypto-secrets.js ya tiene compatibilidad retro: si el valor
-- almacenado no empieza con el prefijo "v1:", se trata como texto plano
-- legado. Esto permite que el/los token(s) ya conectados antes de este
-- cambio sigan funcionando sin downtime; se cifran automáticamente la
-- próxima vez que esa empresa reconecte su WhatsApp (upsert en
-- whatsappEmbeddedSignupHandler).
--
-- Esta migración no modifica datos existentes (no hay forma segura de
-- cifrar en SQL puro sin exponer la clave al motor de Postgres). Solo
-- documenta el cambio en el comentario de la columna para que quede
-- registrado en el esquema, mismo criterio que la migración 133.

COMMENT ON COLUMN public.empresa_whatsapp.access_token IS
  'Cifrado con AES-256-GCM vía lib/crypto-secrets.js (prefijo "v1:"), misma '
  'clave ARCA_SECRETS_KEY que el resto de credenciales externas del '
  'proyecto. Valores sin ese prefijo son texto plano legado, compatible '
  'hacia atrás hasta que la empresa reconecte su WhatsApp.';
