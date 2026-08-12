-- 054_push_interno_secret.sql
-- Fase 6 parte 3: reemplaza el header hardcodeado x-trigger:supabase en el
-- trigger de push-interno por un secreto real almacenado en Supabase Vault.
--
-- INSTRUCCIONES DE DESPLIEGUE:
--   1. Generá un secreto fuerte (en tu máquina o en Vercel):
--        openssl rand -hex 32
--   2. Configurá ese valor como variable de entorno en Vercel:
--        INTERNAL_PUSH_SECRET=<valor generado>
--   3. Guardá ese mismo valor en Supabase Vault ejecutando este script
--      (reemplazá 'REEMPLAZAR_CON_EL_SECRETO_GENERADO' con el valor real):
--        UPDATE vault.secrets
--        SET secret = 'REEMPLAZAR_CON_EL_SECRETO_GENERADO'
--        WHERE name = 'internal_push_secret';
--   4. Corré esta migración completa en Supabase SQL Editor.
--   5. Verificá en los logs de Vercel que el warning de fallback ya no aparece.
--   6. Una vez confirmado, podés eliminar el bloque de fallback legacy
--      (el que acepta x-trigger:supabase) de lib/handlers/notif.js.
--
-- IMPORTANTE: este script NO guarda el secreto en texto plano en el código.
-- El INSERT de vault.secrets abajo usa un placeholder — reemplazalo antes
-- de ejecutar.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Crear el secreto en Vault (si no existe)
--    Reemplazá el placeholder antes de ejecutar.
INSERT INTO vault.secrets (name, secret, description)
VALUES (
  'internal_push_secret',
  'REEMPLAZAR_CON_EL_SECRETO_GENERADO',
  'Secreto para autenticar triggers de Supabase en el endpoint push-interno de Vercel'
)
ON CONFLICT (name) DO NOTHING;

-- 2. Función helper para leer el secreto del Vault
--    (necesaria porque pg_net no puede leer vault.secrets directamente
--    en el body del trigger — se llama desde el trigger)
CREATE OR REPLACE FUNCTION internal.get_push_secret()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'internal_push_secret';
  RETURN v_secret;
END;
$$;

-- 3. Función del trigger que envía el push-interno con el header correcto
--    Reemplaza la versión anterior que usaba x-trigger:supabase hardcodeado.
--
--    NOTA: ajustá la URL con tu dominio real de Vercel.
--    La URL actual es un placeholder — reemplazala antes de activar.
CREATE OR REPLACE FUNCTION public.trigger_push_interno()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url     text  := 'https://TU-PROYECTO.vercel.app/api/notif/push-interno';
  v_secret  text;
  v_payload jsonb;
BEGIN
  -- Leer el secreto desde Vault
  v_secret := internal.get_push_secret();

  -- Construir el payload según el evento
  -- (ajustar los campos según las tablas reales del trigger)
  v_payload := jsonb_build_object(
    'empresa_id', NEW.empresa_id,
    'tipo',       TG_ARGV[0],   -- se pasa como argumento al crear el trigger
    'titulo',     TG_ARGV[1],
    'cuerpo',     TG_ARGV[2],
    'datos',      '{}'::jsonb
  );

  -- Enviar la request HTTP con el secreto en el header correcto
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-push-secret', v_secret
    ),
    body    := v_payload::text
  );

  RETURN NEW;
END;
$$;

-- 4. Ejemplo de cómo reatar el trigger existente con la nueva función
--    (descomentá y ajustá el nombre del trigger y la tabla reales).
--    Si el trigger existente ya apunta a otra función, sólo cambiá esa
--    función para que use net.http_post con x-push-secret en vez de x-trigger.
--
-- DROP TRIGGER IF EXISTS trg_push_nuevo_pedido ON pedidos;
-- CREATE TRIGGER trg_push_nuevo_pedido
--   AFTER INSERT ON pedidos
--   FOR EACH ROW
--   EXECUTE FUNCTION public.trigger_push_interno('nuevo_pedido', 'Nuevo pedido', 'Hay un pedido nuevo esperando aprobación');
