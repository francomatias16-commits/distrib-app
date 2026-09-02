-- Etapa 7 (Bloque 1, Devoluciones) — fix correctivo sobre la migración 570.
--
-- La migración 570 movió la validación de "cantidad disponible" a
-- rpc_crear_devolucion_validada, pero al hacerlo se perdió la resolución
-- de cliente_id a partir de pedido_id que hacía la versión anterior de
-- crearDevolucionCore en JS (vía obtenerClienteIdDePedido, hoy sin uso en
-- ningún handler — lib/repos/pedidos.js:567).
--
-- Esto rompe el canal MÁS USADO para crear devoluciones: el POST
-- /api/chofer/devolucion (frontend/chofer/chofer-offline.js) manda
-- pedido_id, motivo, notas, foto_url, items — nunca cliente_id. Con la
-- 570 tal cual quedó, crearDevolucionCore pasaba p_cliente_id=null y la
-- RPC devolvía 'cliente_id requerido (directo o vía pedido_id)' para
-- TODA devolución de chofer, sin excepción — el mensaje de error ya
-- prometía la resolución "vía pedido_id" que nunca se implementó.
--
-- El alta manual del admin y la tool de WhatsApp (lib/asistente-tools/
-- pedidos.js) no se ven afectados: ambos ya mandan cliente_id explícito.
--
-- Fix: si p_cliente_id viene null y hay p_pedido_id, resolverlo del
-- pedido antes de la validación — dentro de la misma transacción, así
-- que sigue siendo atómico junto con el advisory lock.

CREATE OR REPLACE FUNCTION public.rpc_crear_devolucion_validada(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_pedido_id uuid,
  p_chofer_id uuid,
  p_motivo text,
  p_notas text,
  p_foto_url text,
  p_offline_local_id text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_devolucion      jsonb;
  v_devolucion_id    uuid;
  v_producto_id      uuid;
  v_cantidad         numeric;
  v_comprado         numeric;
  v_reservado        numeric;
  v_disponible       numeric;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  -- Fast path de idempotencia offline (mismo criterio que antes en JS)
  IF p_offline_local_id IS NOT NULL THEN
    SELECT to_jsonb(d) INTO v_devolucion
      FROM devoluciones d
     WHERE d.empresa_id = p_empresa_id AND d.offline_local_id = p_offline_local_id
     LIMIT 1;
    IF v_devolucion IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'offline_replay', true, 'devolucion', v_devolucion);
    END IF;
  END IF;

  -- FIX 571: resolver cliente_id desde el pedido cuando no viene directo
  -- (canal del chofer — ver comentario arriba). Se hace acá, adentro de
  -- la transacción, para que quede cubierto por el mismo advisory lock
  -- que serializa altas concurrentes.
  IF p_cliente_id IS NULL AND p_pedido_id IS NOT NULL THEN
    SELECT p.cliente_id INTO p_cliente_id
      FROM pedidos p
     WHERE p.id = p_pedido_id AND p.empresa_id = p_empresa_id;
  END IF;

  IF p_cliente_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cliente_id requerido (directo o vía pedido_id)');
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La devolución necesita al menos un ítem');
  END IF;

  -- Serializa altas concurrentes del mismo cliente en esta empresa —
  -- cierra la ventana de la condición de carrera. Se libera solo al
  -- terminar la transacción (commit o rollback).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_empresa_id::text || ':' || p_cliente_id::text, 0));

  IF p_pedido_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) it
      WHERE NOT EXISTS (
        SELECT 1 FROM pedido_items pi
        JOIN pedidos p ON p.id = pi.pedido_id
        WHERE pi.pedido_id = p_pedido_id
          AND p.empresa_id = p_empresa_id
          AND pi.producto_id = (it->>'producto_id')::uuid
      )
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Uno o más productos de la devolución no pertenecen al pedido seleccionado.');
    END IF;
  END IF;

  FOR v_producto_id, v_cantidad IN
    SELECT (it->>'producto_id')::uuid, SUM((it->>'cantidad')::numeric)
      FROM jsonb_array_elements(p_items) it
     GROUP BY 1
  LOOP
    IF v_producto_id IS NULL OR v_cantidad IS NULL OR v_cantidad <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'La cantidad devuelta tiene que ser mayor a 0.');
    END IF;

    SELECT COALESCE(SUM(pi.cantidad), 0) INTO v_comprado
      FROM pedido_items pi JOIN pedidos p ON p.id = pi.pedido_id
     WHERE p.cliente_id = p_cliente_id AND p.empresa_id = p_empresa_id
       AND pi.producto_id = v_producto_id;

    IF v_comprado = 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Este cliente nunca compró uno de los producto(s) seleccionados. Elegí un producto de su historial de compras.');
    END IF;

    SELECT COALESCE(SUM(di.cantidad), 0) INTO v_reservado
      FROM devolucion_items di JOIN devoluciones d ON d.id = di.devolucion_id
     WHERE d.cliente_id = p_cliente_id AND d.empresa_id = p_empresa_id
       AND d.estado IN ('pendiente', 'aprobada')
       AND di.producto_id = v_producto_id;

    v_disponible := v_comprado - v_reservado;
    IF v_cantidad > v_disponible THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', format(
          'Cantidad a devolver (%s) supera lo disponible para devolver de ese producto (%s — sobre %s comprados en total).',
          v_cantidad, GREATEST(v_disponible, 0), v_comprado
        )
      );
    END IF;
  END LOOP;

  INSERT INTO devoluciones (empresa_id, pedido_id, cliente_id, chofer_id, motivo, notas, foto_url, estado, offline_local_id)
  VALUES (p_empresa_id, p_pedido_id, p_cliente_id, p_chofer_id, p_motivo, p_notas, p_foto_url, 'pendiente', p_offline_local_id)
  RETURNING id INTO v_devolucion_id;

  -- Precio server-side: el del pedido vinculado si el producto está ahí,
  -- si no el precio_base actual del producto (mismo criterio que antes en JS).
  INSERT INTO devolucion_items (devolucion_id, producto_id, cantidad, precio_unitario)
  SELECT
    v_devolucion_id,
    (it->>'producto_id')::uuid,
    (it->>'cantidad')::numeric,
    COALESCE(
      (SELECT pi.precio_unitario FROM pedido_items pi
        WHERE pi.pedido_id = p_pedido_id AND pi.producto_id = (it->>'producto_id')::uuid
        LIMIT 1),
      (SELECT pr.precio_base FROM productos pr
        WHERE pr.id = (it->>'producto_id')::uuid AND pr.empresa_id = p_empresa_id),
      0
    )
  FROM jsonb_array_elements(p_items) it;

  SELECT to_jsonb(d) INTO v_devolucion FROM devoluciones d WHERE d.id = v_devolucion_id;

  RETURN jsonb_build_object('ok', true, 'devolucion', v_devolucion);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_crear_devolucion_validada FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_crear_devolucion_validada TO authenticated, service_role;
