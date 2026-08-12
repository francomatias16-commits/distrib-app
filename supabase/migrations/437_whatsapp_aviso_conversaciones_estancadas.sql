-- ============================================================
-- MIGRACIÓN 437 — Aviso de conversaciones de WhatsApp estancadas
-- distrib v606
--
-- PROBLEMA:
--   El bot de pedidos por WhatsApp (Etapa 6, migración 247) ya avisa por
--   push a dueño/admin/vendedor en tres casos de corte (mensaje no
--   soportado, > MAX_TURNOS_SIN_CONFIRMAR, falla de IA) y en el caso de
--   derivación explícita pedida por el cliente (whatsapp-pedido-tools.js,
--   derivar_humano). Los cuatro casos comparten un mismo defecto: sólo se
--   disparan cuando llega un MENSAJE NUEVO del cliente al webhook.
--
--   Si el cliente arma un pedido con el bot, llega a
--   'esperando_confirmacion' (el bot ya mandó el resumen con el total) y
--   simplemente deja de responder, no hay ningún mensaje entrante que
--   dispare nada — la conversación queda colgada indefinidamente y nadie
--   se entera. Es, probablemente, el caso más común de "pedido que no se
--   llega a cerrar por WhatsApp".
--
-- SOLUCIÓN:
--   Un job de pg_cron (corre cada 10 minutos, independiente del límite de
--   1 corrida/día de los cron jobs de Vercel en el plan Hobby — ver
--   comentario en handleDeudaCron, lib/handlers/notif.js) que:
--     1. Busca conversaciones en estado 'activa' o 'esperando_confirmacion'
--        CON un borrador de pedido en curso (pedido_borrador IS NOT NULL —
--        si nunca llegó a armar nada, no hay "pedido sin cerrar" real que
--        seguir) cuya última interacción tiene más de 40 minutos.
--     2. Las pasa a 'derivada_humano' con un motivo específico — mismo
--        estado que usan los otros 4 casos, así que aparecen igual en el
--        panel /admin/whatsapp-conversaciones sin tocar el frontend.
--     3. Dispara un push por Postgres (mismo patrón que
--        trigger_push_nuevo_pedido / trigger_push_stock_critico, migración
--        112) a POST /api/notif/push-interno con x-push-secret — no hace
--        falta esperar a que corra ningún endpoint de Vercel.
--
--   Al pasar a 'derivada_humano' la fila sale del filtro de la próxima
--   corrida (estado IN ('activa','esperando_confirmacion')), así que el
--   cron nunca vuelve a tocarla ni duplica avisos.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Índice de soporte — la query no está scopeada por empresa_id (a
--    diferencia de idx_whatsapp_conv_empresa_estado), así que conviene
--    uno propio sobre el filtro real del cron.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_estancadas
  ON public.whatsapp_conversaciones (ultima_interaccion)
  WHERE estado IN ('activa', 'esperando_confirmacion')
    AND pedido_borrador IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Función del cron
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.whatsapp_avisar_conversaciones_estancadas()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_row     record;
  v_secret  text;
  v_payload jsonb;
  v_motivo  text := 'Cliente dejó de responder sin confirmar el pedido';
BEGIN
  v_secret := public.get_push_secret();

  FOR v_row IN
    SELECT id, empresa_id, telefono
    FROM public.whatsapp_conversaciones
    WHERE estado IN ('activa', 'esperando_confirmacion')
      AND pedido_borrador IS NOT NULL
      AND ultima_interaccion < now() - interval '40 minutes'
  LOOP
    UPDATE public.whatsapp_conversaciones
    SET estado = 'derivada_humano',
        motivo_derivacion = v_motivo
        -- ultima_interaccion NO se toca: así el panel sigue mostrando
        -- desde cuándo el cliente está en silencio, no desde que corrió
        -- el cron (mismo criterio que manejarMensajeEnConversacionDerivada
        -- en notif.js, que la usa para calcular UMBRAL_REAVISO_DERIVADA_MIN).
    WHERE id = v_row.id;

    v_payload := jsonb_build_object(
      'empresa_id', v_row.empresa_id,
      'tipo',       'whatsapp_estancado',
      'titulo',     'WhatsApp sin confirmar',
      'cuerpo',     v_motivo || ' (' || v_row.telefono || ')',
      'datos',      jsonb_build_object('tipo', 'whatsapp_derivado', 'link', '/admin/whatsapp-conversaciones')
    );

    BEGIN
      PERFORM net.http_post(
        url     := 'https://distrib-app-nine.vercel.app/api/notif/push-interno',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'x-push-secret', v_secret
        ),
        body    := v_payload
      );
    EXCEPTION WHEN OTHERS THEN
      -- Un error de red/push nunca debe frenar el resto del barrido.
      NULL;
    END;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.whatsapp_avisar_conversaciones_estancadas() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_avisar_conversaciones_estancadas() TO service_role;

-- ------------------------------------------------------------
-- 3. Programación — cada 10 minutos. Con el umbral de 40 min de
--    inactividad de arriba, el peor caso es ~50 min desde que el cliente
--    se quedó callado hasta que un vendedor recibe el push.
-- ------------------------------------------------------------
SELECT cron.schedule(
  'whatsapp_avisar_conversaciones_estancadas',
  '*/10 * * * *',
  $$SELECT public.whatsapp_avisar_conversaciones_estancadas()$$
);

COMMENT ON FUNCTION public.whatsapp_avisar_conversaciones_estancadas() IS
  'Cron (pg_cron, cada 10 min): deriva a humano y avisa por push las conversaciones de WhatsApp con un borrador de pedido armado que llevan >40 min sin respuesta del cliente.';

COMMIT;
