-- 016_push_triggers.sql
-- Triggers que disparan notificaciones push vía pg_net (extensión de Supabase)
-- cuando ocurren eventos críticos:
--   1. Nuevo pedido de cliente → notifica a admins/vendedores
--   2. Stock bajo → notifica a admins/depositeros cuando cantidad <= 5 unidades
--
-- REQUISITO: habilitar la extensión pg_net en Supabase:
--   Dashboard → Database → Extensions → buscar "pg_net" → Enable
--
-- REQUISITO: la URL del endpoint de notificaciones push debe estar configurada
-- como un secreto de Supabase para que los triggers puedan llamarla:
--   Dashboard → Settings → Vault → crear secreto NOTIF_PUSH_URL
--   con valor: https://<tu-dominio>.vercel.app/api/notif/push-interno
--
-- NOTA IMPORTANTE: los triggers de Postgres NO pueden llamar directamente a
-- Firebase FCM (latencia, transacciones). El patrón correcto es:
--   trigger → pg_net → endpoint propio → Firebase
-- Esto desacopla la notificación de la transacción y evita timeouts.

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCIÓN HELPER: llamar al endpoint de push vía pg_net
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _notif_push_async(
  p_empresa_id  UUID,
  p_tipo        TEXT,         -- 'nuevo_pedido' | 'stock_critico'
  p_titulo      TEXT,
  p_cuerpo      TEXT,
  p_datos       JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_url TEXT;
BEGIN
  -- Leer URL desde vault (falla silenciosamente si no está configurado)
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'NOTIF_PUSH_URL'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL;
  END;

  IF v_url IS NULL OR v_url = '' THEN
    RETURN; -- Sin URL configurada, no hacer nada
  END IF;

  -- Llamada HTTP asíncrona — no bloquea la transacción principal
  PERFORM net.http_post(
    url     := v_url,
    headers := '{"Content-Type":"application/json","x-trigger":"supabase"}'::jsonb,
    body    := jsonb_build_object(
      'empresa_id', p_empresa_id,
      'tipo',       p_tipo,
      'titulo',     p_titulo,
      'cuerpo',     p_cuerpo,
      'datos',      p_datos
    )::text
  );

EXCEPTION WHEN OTHERS THEN
  -- Errores de red no deben romper la transacción del pedido/stock
  NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 1: Nuevo pedido de cliente
-- Dispara push a todos los admins y vendedores cuando un cliente hace un pedido
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _trigger_notif_nuevo_pedido()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cliente_nombre TEXT;
BEGIN
  -- Solo notificar cuando el estado pasa a 'pendiente' (pedido real, no borrador)
  IF NEW.estado <> 'pendiente' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado = 'pendiente' THEN
    RETURN NEW; -- Ya estaba pendiente, no re-notificar
  END IF;

  -- Obtener nombre del cliente
  SELECT razon_social INTO v_cliente_nombre
  FROM clientes WHERE id = NEW.cliente_id;

  PERFORM _notif_push_async(
    NEW.empresa_id,
    'nuevo_pedido',
    'Nuevo pedido recibido',
    (COALESCE(v_cliente_nombre, 'Un cliente') || ' realizó un pedido por $' ||
     to_char(COALESCE(NEW.total, 0), 'FM999G999G990')),
    jsonb_build_object(
      'pedido_id',   NEW.id,
      'cliente_id',  NEW.cliente_id,
      'total',       NEW.total,
      'link',        '/admin/pedidos'
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_nuevo_pedido ON pedidos;
CREATE TRIGGER trg_notif_nuevo_pedido
  AFTER INSERT OR UPDATE OF estado ON pedidos
  FOR EACH ROW
  EXECUTE FUNCTION _trigger_notif_nuevo_pedido();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 2: Stock crítico
-- Dispara cuando la cantidad disponible cae a 5 o menos unidades
-- (umbral configurable via UMBRAL_STOCK_CRITICO en vault, default: 5)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _trigger_notif_stock_critico()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_producto_nombre TEXT;
  v_empresa_id      UUID;
  v_umbral          NUMERIC := 5;
  v_disponible      NUMERIC;
BEGIN
  v_disponible := NEW.cantidad - COALESCE(NEW.cantidad_reservada, 0);

  -- Solo actuar si la cantidad disponible bajó y cruzó el umbral
  IF TG_OP = 'UPDATE' THEN
    DECLARE
      v_disponible_old NUMERIC;
    BEGIN
      v_disponible_old := OLD.cantidad - COALESCE(OLD.cantidad_reservada, 0);
      -- Si ya estaba bajo o no bajó, no notificar
      IF v_disponible_old <= v_umbral OR v_disponible > v_umbral THEN
        RETURN NEW;
      END IF;
    END;
  ELSIF TG_OP = 'INSERT' THEN
    IF v_disponible > v_umbral THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Obtener nombre del producto y empresa
  SELECT p.nombre, d.empresa_id
  INTO v_producto_nombre, v_empresa_id
  FROM productos p
  JOIN depositos d ON d.id = NEW.deposito_id
  WHERE p.id = NEW.producto_id;

  IF v_empresa_id IS NULL THEN RETURN NEW; END IF;

  PERFORM _notif_push_async(
    v_empresa_id,
    'stock_critico',
    'Stock crítico',
    (COALESCE(v_producto_nombre, 'Producto') || ': quedan ' ||
     to_char(v_disponible, 'FM990D99') || ' unidades disponibles'),
    jsonb_build_object(
      'producto_id',  NEW.producto_id,
      'deposito_id',  NEW.deposito_id,
      'disponible',   v_disponible,
      'link',         '/admin/stock'
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_stock_critico ON stock;
CREATE TRIGGER trg_notif_stock_critico
  AFTER INSERT OR UPDATE OF cantidad, cantidad_reservada ON stock
  FOR EACH ROW
  EXECUTE FUNCTION _trigger_notif_stock_critico();

-- ─────────────────────────────────────────────────────────────────────────────
-- COMENTARIOS
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON FUNCTION _notif_push_async IS
  'Helper asíncrono para push. Requiere extensión pg_net habilitada en Supabase '
  'y secreto NOTIF_PUSH_URL en vault apuntando al endpoint /api/notif/push-interno.';

COMMENT ON FUNCTION _trigger_notif_nuevo_pedido IS
  'Notifica nuevo pedido cuando estado pasa a pendiente. Solo en INSERT o '
  'primer cambio a pendiente — no re-notifica si ya estaba pendiente.';

COMMENT ON FUNCTION _trigger_notif_stock_critico IS
  'Notifica cuando stock disponible cruza hacia abajo el umbral de 5 unidades. '
  'No notifica en cada UPDATE si ya estaba bajo — solo en el cruce del umbral.';
