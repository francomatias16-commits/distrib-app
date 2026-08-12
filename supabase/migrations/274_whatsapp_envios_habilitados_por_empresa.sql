-- 274_whatsapp_envios_habilitados_por_empresa.sql
--
-- Contexto: hasta v291, el bloqueo de notificaciones salientes con costo
-- (templates "utility": pedido_despachado, pedido_entregado,
-- pedido_por_llegar, pedido_no_entregado, cheques_por_vencer,
-- deuda_vencida) era un interruptor GLOBAL (WA_NOTIF_SALIENTES_HABILITADAS
-- en Vercel) — afectaba a todas las empresas de la plataforma a la vez.
--
-- Esta migración agrega el flag a nivel empresa para las que ya conectaron
-- su propio WhatsApp por Embedded Signup, así se puede habilitar el envío
-- real de a una, a medida que se cierra el esquema de costos con cada
-- cliente, sin afectar a las demás.
--
-- Empresas que todavía usan el número compartido de prueba (sin fila en
-- empresa_whatsapp) siguen rigiéndose por el interruptor global de
-- siempre — ver lib/handlers/notif.js, resolverCredencialesWhatsapp().

ALTER TABLE public.empresa_whatsapp
  ADD COLUMN IF NOT EXISTS envios_habilitados BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresa_whatsapp.envios_habilitados IS
  'Habilita el envío real de templates salientes con costo (categoría '
  '"utility" de Meta) para esta empresa puntual. Default false '
  '(fail-safe: no generar costo sin que se haya acordado el esquema de '
  'precios con el cliente). Se activa a mano, por SQL o desde el panel '
  'admin si se agrega esa UI más adelante. No afecta la conversación '
  'bidireccional del bot (texto libre, gratis) ni las alertas internas '
  'del dashboard.';

-- Para habilitar los envíos de una empresa puntual una vez acordado el
-- esquema de costos con ese cliente:
--
--   UPDATE public.empresa_whatsapp
--   SET envios_habilitados = true
--   WHERE empresa_id = '<uuid-de-la-empresa>';
--
-- Ojo: el resultado de resolverCredencialesWhatsapp() se cachea en memoria
-- hasta 60 segundos (CACHE_CREDENCIALES_TTL_MS) — el cambio puede tardar
-- hasta un minuto en reflejarse en la instancia serverless que lo tenía
-- en caché.
