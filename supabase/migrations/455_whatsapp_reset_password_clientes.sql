-- 455 — Reset de contraseña por WhatsApp para el portal cliente
--
-- Contexto (ver CHANGELOG_v719): lib/handlers/auth.js ya tenía un
-- POST /api/auth/reset-password completo (rate limit, generateLink,
-- mail brandeado) pero:
--   1. Ningún frontend lo llamaba — quedó huérfano.
--   2. Buscaba el usuario por usuarios.email, que para cliente guarda el
--      email FICTICIO del portal (54911xxxxx@portal.distrib), no un email
--      real de contacto — aunque se hubiera conectado, el mail nunca
--      habría llegado a nadie.
--
-- El cliente del portal ya se identifica 100% por su número de WhatsApp
-- (frontend/cliente/login.html usa el teléfono para armar el email
-- ficticio de Supabase Auth, no pide email real en ningún lado). Por eso
-- el reset natural para este portal es por WhatsApp, no por email —
-- reaprovechando el canal de mensajería saliente que ya existe
-- (lib/handlers/notif.js, templates aprobados por Meta).
--
-- Esta tabla guarda el código de 6 dígitos (hasheado, nunca en texto
-- plano — mismo criterio que refresh_tokens.token_hash) que se manda por
-- WhatsApp y se valida contra la nueva contraseña.

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_reset_codigos (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id   UUID         NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    cliente_id   UUID         NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    usuario_id   UUID         NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    telefono     TEXT         NOT NULL,
    codigo_hash  CHAR(64)     NOT NULL,  -- SHA-256 del código de 6 dígitos (nunca el crudo)
    intentos     INT          NOT NULL DEFAULT 0,
    usado        BOOLEAN      NOT NULL DEFAULT FALSE,
    expira_at    TIMESTAMPTZ  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Lookup del código vigente de un usuario (el más reciente, no usado)
CREATE INDEX IF NOT EXISTS idx_whatsapp_reset_codigos_usuario
    ON public.whatsapp_reset_codigos (usuario_id, created_at DESC)
    WHERE usado = FALSE;

-- ── RLS — mismo patrón que refresh_tokens (027): nunca expuesto al cliente,
-- solo el service role (supabaseAdmin, desde el handler) lee/escribe acá.
ALTER TABLE public.whatsapp_reset_codigos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "solo_service_role" ON public.whatsapp_reset_codigos
    USING (auth.role() = 'service_role');

-- ── Limpieza automática: códigos expirados o usados > 1 día ──────────────
-- Mismo criterio y mismo estado que limpiar_refresh_tokens_expirados()
-- (027): la función queda lista pero el pg_cron.schedule() real está
-- comentado, igual que en 027 — no hay ningún cron diario corriendo hoy
-- en el proyecto que la llame. Si se decide agregar uno, agendar ambas
-- limpiezas (refresh_tokens y esta) juntas.
-- SELECT cron.schedule('limpiar-whatsapp-reset-codigos', '0 3 * * *', 'SELECT public.limpiar_whatsapp_reset_codigos_expirados()');
CREATE OR REPLACE FUNCTION public.limpiar_whatsapp_reset_codigos_expirados()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.whatsapp_reset_codigos
   WHERE expira_at < NOW() - INTERVAL '1 day'
      OR (usado = TRUE AND created_at < NOW() - INTERVAL '1 day');
END;
$$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '455_whatsapp_reset_password_clientes.sql', '455', 'claude-session', 'Tabla whatsapp_reset_codigos + limpieza: soporte para reset de contraseña por WhatsApp en el portal cliente (POST /api/auth/reset-password-whatsapp y /api/auth/confirmar-codigo-whatsapp)')
ON CONFLICT DO NOTHING;

COMMIT;
