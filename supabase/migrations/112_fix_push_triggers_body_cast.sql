-- ════════════════════════════════════════════════════════════════════
-- 112_fix_push_triggers_body_cast.sql
--
-- PROBLEMA (diagnosticado 2026-06-26):
--   trigger_push_nuevo_pedido y trigger_push_stock_critico llaman a
--   net.http_post() pasando body := v_payload::text
--   pero la versión instalada de pg_net espera body como jsonb, no text.
--   Resultado: la transacción completa (crear pedido / actualizar stock)
--   fallaba con:
--     "function net.http_post(url=>unknown, headers=>jsonb, body=>text)
--      does not exist"
--
-- SÍNTOMA EN PRODUCCIÓN:
--   - Clientes confirmaban el pedido → carrito no se vaciaba, pedido no aparecía
--   - Stock de productos no se actualizaba correctamente
--
-- FIX:
--   1. Eliminar el cast ::text — v_payload ya es jsonb, se pasa directo.
--   2. Agregar EXCEPTION WHEN OTHERS THEN NULL en ambas funciones para
--      que un fallo de red/push NUNCA pueda tumbar la transacción de negocio.
--      (_notif_push_async ya tenía esta protección; estos dos triggers no.)
--
-- Aplicado en prod: 2026-06-26 (vía Supabase MCP, migración 112)
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trigger_push_nuevo_pedido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_secret  text;
  v_payload jsonb;
BEGIN
  v_secret := public.get_push_secret();
  v_payload := jsonb_build_object(
    'empresa_id', NEW.empresa_id,
    'tipo',       'nuevo_pedido',
    'titulo',     'Nuevo pedido recibido',
    'cuerpo',     'Hay un pedido nuevo esperando confirmación',
    'datos',      jsonb_build_object('pedido_id', NEW.id)
  );

  BEGIN
    PERFORM net.http_post(
      url     := 'https://distrib-app-nine.vercel.app/api/notif/push-interno',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-push-secret', v_secret
      ),
      body    := v_payload   -- FIX: era v_payload::text; pg_net espera jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Un error de red/push nunca debe abortar la transacción del pedido
    NULL;
  END;

  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trigger_push_stock_critico()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_secret   text;
  v_payload  jsonb;
  v_minimo   numeric;
  v_empresa  uuid;
BEGIN
  IF NEW.cantidad IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.cantidad IS NOT NULL AND OLD.cantidad <= NEW.cantidad THEN
    RETURN NEW;
  END IF;

  SELECT p.stock_minimo, p.empresa_id
  INTO v_minimo, v_empresa
  FROM public.productos p
  WHERE p.id = NEW.producto_id;

  IF v_minimo IS NULL OR NEW.cantidad >= v_minimo THEN
    RETURN NEW;
  END IF;
  IF OLD.cantidad IS NOT NULL AND OLD.cantidad < v_minimo THEN
    RETURN NEW;
  END IF;

  v_secret := public.get_push_secret();
  v_payload := jsonb_build_object(
    'empresa_id', v_empresa,
    'tipo',       'stock_critico',
    'titulo',     'Stock crítico',
    'cuerpo',     'Un producto bajó del stock mínimo',
    'datos',      jsonb_build_object(
      'producto_id',  NEW.producto_id,
      'cantidad',     NEW.cantidad,
      'stock_minimo', v_minimo
    )
  );

  BEGIN
    PERFORM net.http_post(
      url     := 'https://distrib-app-nine.vercel.app/api/notif/push-interno',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'x-push-secret', v_secret
      ),
      body    := v_payload   -- FIX: era v_payload::text; pg_net espera jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    -- Un error de red/push nunca debe abortar la transacción de stock
    NULL;
  END;

  RETURN NEW;
END;
$$;
