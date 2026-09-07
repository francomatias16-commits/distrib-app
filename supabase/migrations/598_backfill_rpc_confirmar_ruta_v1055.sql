-- 598_backfill_rpc_confirmar_ruta_v1055.sql
--
-- BACKFILL, no cambia nada en producción: esta función ya está viva en
-- Supabase (jgiquzjwoedmzwqgzubr) desde el fix de v1055 (Etapa 7 transversal,
-- Bloque 3), pero nunca se guardó como migración en el repo — el comentario
-- de `frontend/admin/js/rutas.js` cita "migración 576", y ese número
-- corresponde en realidad a otro archivo
-- (576_plan_limites_whatsapp_etiquetas_mercadopago.sql), sin relación con
-- rutas. Este archivo solo documenta en el repo lo que ya corre en
-- producción, verificado hoy contra `pg_get_functiondef` en vivo — sin él,
-- una restauración de la base solo con migraciones perdería esta función.
--
-- Qué resuelve: antes, confirmar una ruta eran 3 escrituras sueltas
-- (INSERT rutas, INSERT entregas, UPDATE pedidos) sin transacción — si la
-- 2da o 3ra fallaba a mitad de camino quedaba una ruta fantasma sin
-- entregas, o pedidos "atrapados" en preparando sin ruta real. Ahora los 3
-- pasos van en una única función transaccional, con:
--   - un advisory lock por empresa (pg_advisory_xact_lock) que serializa
--     confirmaciones de ruta concurrentes de la misma empresa;
--   - una revalidación server-side de que los pedidos sigan disponibles
--     (no fueron tomados por otra ruta ni cambiaron de estado) antes de
--     escribir nada;
--   - reversión automática de los 3 pasos si algo falla (todo corre dentro
--     de la misma función/transacción de Postgres).

CREATE OR REPLACE FUNCTION public.rpc_confirmar_ruta(
  p_empresa_id uuid,
  p_chofer_id  uuid,
  p_fecha      date,
  p_notas      text,
  p_pedido_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ruta_id      uuid;
  v_ruta         jsonb;
  v_pedido_id    uuid;
  v_orden        int := 0;
  v_invalidos    uuid[];
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_chofer_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'chofer_id requerido');
  END IF;

  IF p_pedido_ids IS NULL OR array_length(p_pedido_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La ruta necesita al menos un pedido');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_empresa_id::text || ':confirmar_ruta', 0));

  SELECT array_agg(pid) INTO v_invalidos
  FROM unnest(p_pedido_ids) pid
  WHERE NOT EXISTS (
    SELECT 1 FROM pedidos p
     WHERE p.id = pid
       AND p.empresa_id = p_empresa_id
       AND p.estado IN ('confirmado', 'preparando')
  ) OR EXISTS (
    SELECT 1 FROM entregas e
    JOIN rutas r ON r.id = e.ruta_id
    WHERE e.pedido_id = pid
      AND e.estado IN ('pendiente', 'en_camino')
      AND r.estado NOT IN ('completada', 'cancelada')
  );

  IF v_invalidos IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Uno o más pedidos ya no están disponibles para despachar (fueron tomados por otra ruta o cambiaron de estado). Actualizá la lista e intentá de nuevo.',
      'pedidos_invalidos', to_jsonb(v_invalidos)
    );
  END IF;

  INSERT INTO rutas (empresa_id, chofer_id, fecha, estado, notas)
  VALUES (p_empresa_id, p_chofer_id, p_fecha, 'pendiente', p_notas)
  RETURNING id INTO v_ruta_id;

  FOREACH v_pedido_id IN ARRAY p_pedido_ids LOOP
    v_orden := v_orden + 1;
    INSERT INTO entregas (ruta_id, pedido_id, orden, estado)
    VALUES (v_ruta_id, v_pedido_id, v_orden, 'pendiente');
  END LOOP;

  UPDATE pedidos
     SET estado = 'preparando'
   WHERE id = ANY(p_pedido_ids)
     AND empresa_id = p_empresa_id;

  SELECT to_jsonb(r) INTO v_ruta FROM rutas r WHERE r.id = v_ruta_id;

  RETURN jsonb_build_object('ok', true, 'ruta', v_ruta);
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
