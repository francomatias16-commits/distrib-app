-- ============================================================
-- 031_push_subscriptions.sql
-- distrib-v38-optimized | Módulo 4: Push Notifications
--
-- Tabla para suscripciones Web Push (VAPID).
-- Trigger que notifica al backend cuando se crea/actualiza un pedido.
-- ============================================================

BEGIN;

-- ── Tabla de suscripciones push ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id           BIGSERIAL    PRIMARY KEY,
    usuario_id   BIGINT       NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    endpoint     TEXT         NOT NULL,
    p256dh       TEXT         NOT NULL,   -- clave pública del cliente
    auth_key     TEXT         NOT NULL,   -- clave de autenticación del cliente
    user_agent   TEXT,
    portal       TEXT         NOT NULL DEFAULT 'cliente',  -- 'cliente' | 'chofer' | 'admin'
    activo       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (usuario_id, endpoint)
);

-- Índices para lookup eficiente
CREATE INDEX IF NOT EXISTS idx_push_subs_usuario
    ON public.push_subscriptions (usuario_id)
    WHERE activo = TRUE;

CREATE INDEX IF NOT EXISTS idx_push_subs_portal
    ON public.push_subscriptions (portal)
    WHERE activo = TRUE;

-- RLS
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "push_subs_own" ON public.push_subscriptions
    FOR ALL USING (
        auth.role() = 'service_role'
        OR usuario_id = public.auth_usuario_id()
    );


-- ── Tabla de log de notificaciones enviadas ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_log (
    id           BIGSERIAL    PRIMARY KEY,
    usuario_id   BIGINT       REFERENCES public.usuarios(id) ON DELETE SET NULL,
    tipo         TEXT         NOT NULL,   -- 'pedido_nuevo' | 'estado_cambio' | 'remito_sync' etc.
    titulo       TEXT         NOT NULL,
    cuerpo       TEXT,
    payload      JSONB,
    enviado      BOOLEAN      NOT NULL DEFAULT FALSE,
    error        TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_log_usuario
    ON public.push_log (usuario_id, created_at DESC);

ALTER TABLE public.push_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "push_log_admin" ON public.push_log
    FOR ALL USING (auth.role() = 'service_role' OR public.es_admin());


-- ── Función + Trigger: notificar API cuando cambia estado de pedido ───────────
-- Usa pg_notify para comunicación asíncrona DB→API sin polling

CREATE OR REPLACE FUNCTION public.trigger_notif_pedido_estado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Solo notificar si el estado realmente cambió
    IF OLD.estado IS DISTINCT FROM NEW.estado THEN
        PERFORM pg_notify(
            'pedido_estado_cambio',
            jsonb_build_object(
                'pedido_id',  NEW.id,
                'numero',     NEW.numero_pedido,
                'cliente_id', NEW.cliente_id,
                'chofer_id',  NEW.chofer_id,
                'estado_old', OLD.estado,
                'estado_new', NEW.estado,
                'ts',         EXTRACT(EPOCH FROM NOW())::BIGINT
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_pedido_estado ON public.pedidos;
CREATE TRIGGER trg_notif_pedido_estado
    AFTER UPDATE OF estado ON public.pedidos
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_notif_pedido_estado();


-- ── Función para obtener suscriptores por rol ─────────────────────────────────
-- Usada por la API /api/notif para resolver a quién enviar

CREATE OR REPLACE FUNCTION public.obtener_suscriptores_push(
    p_portal       TEXT    DEFAULT NULL,  -- NULL = todos los portales
    p_usuario_ids  BIGINT[] DEFAULT NULL  -- NULL = todos los activos
)
RETURNS TABLE (
    subscription_id BIGINT,
    usuario_id      BIGINT,
    endpoint        TEXT,
    p256dh          TEXT,
    auth_key        TEXT,
    portal          TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id, usuario_id, endpoint, p256dh, auth_key, portal
    FROM public.push_subscriptions
    WHERE activo = TRUE
      AND (p_portal IS NULL       OR portal     = p_portal)
      AND (p_usuario_ids IS NULL  OR usuario_id = ANY(p_usuario_ids));
$$;

REVOKE ALL ON FUNCTION public.obtener_suscriptores_push FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_suscriptores_push TO service_role;

COMMIT;
