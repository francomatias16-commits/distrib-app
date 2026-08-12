-- ============================================================
-- MIGRACIÓN 247 — Etapa 6: WhatsApp Business API bidireccional
-- distrib v246
--
-- Hasta acá (068_piloto_whatsapp.sql, notif.js _svc=whatsapp) el flujo era
-- unidireccional: el sistema manda templates aprobados por Meta (aviso de
-- pedido sugerido, proximidad de entrega, deuda vencida). Esta migración
-- agrega el lado que faltaba: RECIBIR mensajes de texto libre del cliente
-- vía el webhook de Meta y convertirlos en un pedido, reutilizando el motor
-- de precios/stock ya existente (resolver_precios_cliente + crear_pedido_cliente,
-- ver 115_fix_canal_portal_real_crear_pedido_cliente.sql) en vez de duplicar
-- esa lógica.
--
-- Decisiones de diseño:
--
--  1. Un número de WhatsApp único para toda la plataforma (mismo criterio
--     que el piloto saliente: WA_PHONE_NUMBER_ID es una env var global, no
--     por empresa — ver notif.js/piloto.js). Por eso el matching de un
--     mensaje entrante a "qué empresa, qué cliente" se hace por teléfono
--     normalizado contra TODA la tabla clientes, no por empresa conocida
--     de antemano. resolver_cliente_por_telefono() devuelve todos los
--     matches; si hay más de uno (un mismo número siendo cliente de dos
--     empresas de la plataforma — caso raro pero posible), el handler
--     desambigua por conversación abierta más reciente o pide precisar.
--
--  2. whatsapp_conversaciones guarda el ESTADO de la conversación (no el
--     texto completo turno a turno — eso vive en whatsapp_mensajes). El
--     borrador de pedido en curso (productos + cantidades que el modelo
--     fue armando) se guarda en pedido_borrador (jsonb) para poder
--     recuperarlo si el cliente tarda en confirmar.
--
--  3. whatsapp_mensajes.wa_message_id es UNIQUE: Meta reintenta la entrega
--     del webhook si no responde 200 rápido, y sin este dedupe un mismo
--     mensaje podría procesarse dos veces (ej: crear el pedido duplicado).
--
--  4. No se automatiza la creación del pedido sin confirmación explícita
--     del cliente ("sí"/"confirmar"/botón). El modelo arma el borrador,
--     pero SIEMPRE hay un paso de confirmación humana antes de reservar
--     stock — mismo criterio que confirmar_pedido_sugerido() del piloto.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Conversaciones (una fila por número de teléfono en curso)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_conversaciones (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id         uuid REFERENCES public.clientes(id) ON DELETE CASCADE,
  telefono           text NOT NULL,
  estado             text NOT NULL DEFAULT 'activa'
                       CHECK (estado IN ('activa', 'esperando_confirmacion', 'derivada_humano', 'cerrada')),
  -- Borrador de pedido en curso: { items: [{producto_id, nombre, cantidad, precio}], notas }
  pedido_borrador    jsonb,
  pedido_creado_id   uuid REFERENCES public.pedidos(id),
  motivo_derivacion  text,
  ultima_interaccion timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_telefono
  ON public.whatsapp_conversaciones(telefono, ultima_interaccion DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_empresa_estado
  ON public.whatsapp_conversaciones(empresa_id, estado)
  WHERE estado <> 'cerrada';

-- Solo puede haber UNA conversación no cerrada por teléfono a la vez
-- (si el cliente escribe de nuevo, se reusa la misma fila en vez de crear
-- otra — ver resolverConversacionWhatsapp() en lib/handlers/notif.js).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_conv_telefono_abierta
  ON public.whatsapp_conversaciones(telefono)
  WHERE estado <> 'cerrada';

-- ============================================================
-- 2. Mensajes (historial turno a turno, in/out)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_mensajes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  uuid NOT NULL REFERENCES public.whatsapp_conversaciones(id) ON DELETE CASCADE,
  direccion        text NOT NULL CHECK (direccion IN ('in', 'out')),
  wa_message_id    text,
  texto            text,
  tipo             text NOT NULL DEFAULT 'text',
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Dedupe de reintentos del webhook de Meta. Parcial porque los mensajes
-- salientes armados por el propio sistema (recordatorios, etc.) no
-- siempre tienen wa_message_id al momento de insertar la fila.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_mensajes_wa_id
  ON public.whatsapp_mensajes(wa_message_id)
  WHERE wa_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_mensajes_conv_fecha
  ON public.whatsapp_mensajes(conversacion_id, created_at);

-- ============================================================
-- 3. RPC: matchear teléfono entrante contra clientes de toda la plataforma
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolver_cliente_por_telefono(p_telefono text)
RETURNS TABLE (
  empresa_id     uuid,
  cliente_id     uuid,
  cliente_nombre text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
BEGIN
  RETURN QUERY
  SELECT c.empresa_id, c.id, COALESCE(c.nombre_fantasia, c.razon_social)
  FROM clientes c
  JOIN empresas e ON e.id = c.empresa_id
  WHERE regexp_replace(c.telefono, '[^0-9]', '', 'g') LIKE '%' || right(regexp_replace(p_telefono, '[^0-9]', '', 'g'), 10)
    AND c.activo    = true
    AND c.bloqueado = false
    AND e.activa    = true;
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_cliente_por_telefono(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolver_cliente_por_telefono(text) TO service_role;

-- ============================================================
-- 4. Vista de monitoreo para el panel admin (Etapa 6 dashboard)
-- ============================================================
CREATE OR REPLACE VIEW public.v_whatsapp_conversaciones_activas AS
SELECT
  wc.id,
  wc.empresa_id,
  wc.cliente_id,
  COALESCE(c.nombre_fantasia, c.razon_social) AS cliente_nombre,
  wc.telefono,
  wc.estado,
  wc.motivo_derivacion,
  wc.ultima_interaccion,
  (SELECT count(*) FROM whatsapp_mensajes m WHERE m.conversacion_id = wc.id) AS cant_mensajes
FROM whatsapp_conversaciones wc
LEFT JOIN clientes c ON c.id = wc.cliente_id
WHERE wc.estado <> 'cerrada';

-- ============================================================
-- 5. RLS — mismo criterio que asistente_conversaciones (204): solo
--    lectura scopeada por empresa para el panel admin; escritura solo
--    vía service_role desde el handler del webhook.
-- ============================================================
ALTER TABLE public.whatsapp_conversaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_mensajes       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_conversaciones_empresa ON public.whatsapp_conversaciones;
CREATE POLICY whatsapp_conversaciones_empresa ON public.whatsapp_conversaciones
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

DROP POLICY IF EXISTS whatsapp_mensajes_empresa ON public.whatsapp_mensajes;
CREATE POLICY whatsapp_mensajes_empresa ON public.whatsapp_mensajes
  FOR SELECT USING (
    conversacion_id IN (
      SELECT id FROM public.whatsapp_conversaciones
      WHERE empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    )
  );

REVOKE ALL ON public.whatsapp_conversaciones FROM anon, authenticated;
REVOKE ALL ON public.whatsapp_mensajes       FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_conversaciones TO authenticated;
GRANT SELECT ON public.whatsapp_mensajes       TO authenticated;
GRANT SELECT ON public.v_whatsapp_conversaciones_activas TO authenticated;

COMMENT ON TABLE public.whatsapp_conversaciones IS
  'Estado de cada conversación de WhatsApp entrante en curso (Etapa 6 — bidireccional). Ver lib/handlers/notif.js _svc=whatsapp-webhook.';
COMMENT ON TABLE public.whatsapp_mensajes IS
  'Historial turno a turno (in/out) de whatsapp_conversaciones. wa_message_id dedupea reintentos del webhook de Meta.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '247_etapa6_whatsapp_bidireccional.sql', '247', 'claude-session',
        'Etapa 6: tablas whatsapp_conversaciones/whatsapp_mensajes + RPC resolver_cliente_por_telefono para el webhook entrante de WhatsApp Business API.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

COMMIT;
