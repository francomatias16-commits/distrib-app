-- ============================================================
-- 027_refresh_tokens.sql
-- distrib-v38-optimized | Módulo 2: Seguridad JWT
--
-- Tabla para Refresh Token Rotation con detección de reuso.
-- Mantiene el prefijo de numeración existente (026_, 027_, ...)
-- ============================================================

BEGIN;

-- ── Tabla de refresh tokens ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id           BIGSERIAL    PRIMARY KEY,
    usuario_id   BIGINT       NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    token_hash   CHAR(64)     NOT NULL UNIQUE,  -- SHA-256 del token (nunca el crudo)
    expires_at   TIMESTAMPTZ  NOT NULL,
    revocado     BOOLEAN      NOT NULL DEFAULT FALSE,
    ip           TEXT,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índice para lookup por hash (login/refresh críticos)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash
    ON public.refresh_tokens (token_hash)
    WHERE revocado = FALSE;

-- Índice para revocar todos los tokens de un usuario (logout global)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario
    ON public.refresh_tokens (usuario_id)
    WHERE revocado = FALSE;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;

-- Solo el service role puede leer/escribir (nunca expuesto al cliente)
CREATE POLICY "solo_service_role" ON public.refresh_tokens
    USING (auth.role() = 'service_role');

-- ── Limpieza automática: tokens expirados o revocados > 30 días ───────────────
CREATE OR REPLACE FUNCTION public.limpiar_refresh_tokens_expirados()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.refresh_tokens
    WHERE expires_at < NOW()
       OR (revocado = TRUE AND created_at < NOW() - INTERVAL '30 days');
END;
$$;

-- Programar limpieza diaria via pg_cron (si está habilitado en Supabase)
-- Descomentar si tenés pg_cron activado:
-- SELECT cron.schedule('limpiar-refresh-tokens', '0 3 * * *', 'SELECT public.limpiar_refresh_tokens_expirados()');

-- ── Comentarios ───────────────────────────────────────────────────────────────
COMMENT ON TABLE  public.refresh_tokens                IS 'Refresh tokens hasheados para rotación segura de sesiones';
COMMENT ON COLUMN public.refresh_tokens.token_hash     IS 'SHA-256 del JWT de refresh. Nunca almacenar el token crudo.';
COMMENT ON COLUMN public.refresh_tokens.revocado       IS 'TRUE si fue usado (rotado) o el usuario hizo logout.';

COMMIT;
