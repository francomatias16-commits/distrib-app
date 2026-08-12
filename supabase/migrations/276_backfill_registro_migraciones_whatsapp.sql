-- 276_backfill_registro_migraciones_whatsapp.sql
--
-- Contexto: las migraciones 271, 273, 274 y 275 (whatsapp bidireccional /
-- embedded signup) se aplicaron directamente a la base sin dejar registro
-- en schema_migrations_registry, salteando la convención del proyecto.
-- Esta migración solo regulariza el registro (no toca schema ni datos de
-- negocio); las columnas que esas migraciones agregaron ya existen.

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES
  ('db', '271_etapa6_whatsapp_conversacion_tomada.sql', '271', 'claude-session', 'Backfill: aplicada previamente sin registrar (detectado en auditoria v295)'),
  ('db', '273_whatsapp_access_token_cifrado.sql', '273', 'claude-session', 'Backfill: aplicada previamente sin registrar (detectado en auditoria v295)'),
  ('db', '274_whatsapp_envios_habilitados_por_empresa.sql', '274', 'claude-session', 'Backfill: aplicada previamente sin registrar (detectado en auditoria v295)'),
  ('db', '275_whatsapp_necesita_reconexion.sql', '275', 'claude-session', 'Backfill: aplicada previamente sin registrar (detectado en auditoria v295)')
ON CONFLICT DO NOTHING;
