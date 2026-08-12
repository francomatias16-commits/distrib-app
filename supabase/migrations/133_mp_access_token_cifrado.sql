-- 133_mp_access_token_cifrado.sql
--
-- Contexto: integraciones_pago.access_token se guardaba en texto plano
-- (el comentario original de la columna decía "Encriptado en producción"
-- pero nunca se implementó). A partir de v157, lib/handlers/pagos.js cifra
-- el access_token con lib/crypto-secrets.js (AES-256-GCM, misma clave
-- ARCA_SECRETS_KEY que ya se usa para los certificados ARCA) antes de
-- guardarlo, y lo descifra al leerlo para llamar a la API de Mercado Pago.
--
-- lib/crypto-secrets.js ya tiene compatibilidad retro: si el valor
-- almacenado no empieza con el prefijo "v1:", se trata como texto plano
-- legado. Esto permite que tokens guardados antes de este cambio sigan
-- funcionando sin downtime; se cifran automáticamente la próxima vez que
-- el admin los re-guarde desde /admin/mercadopago-config.
--
-- Esta migración no modifica datos existentes (no hay forma segura de
-- cifrar en SQL puro sin exponer la clave al motor de Postgres). Solo
-- documenta el cambio en el comentario de la columna para que quede
-- registrado en el esquema.

COMMENT ON COLUMN public.integraciones_pago.access_token IS
  'Cifrado con AES-256-GCM vía lib/crypto-secrets.js (prefijo "v1:"). '
  'Valores sin ese prefijo son texto plano legado, compatible hacia atrás '
  'hasta que el admin re-guarde la credencial desde /admin/mercadopago-config.';
