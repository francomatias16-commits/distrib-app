-- Etapa 13, Hallazgo 1 (auditoría UX) — el catálogo de recompensas era
-- enteramente decorativo: no existía ningún camino, en ningún portal, para
-- canjear una recompensa puntual. Esta función implementa el canje real,
-- siguiendo el mismo patrón de bloqueo/validación que canjear_puntos()
-- (auth interna vía empresa_id, FOR UPDATE sobre saldo_puntos, chequeo de
-- saldo suficiente antes de descontar).
--
-- A diferencia de canjear_puntos() (que se llama directo desde el admin
-- con el JWT del usuario), esta función se llama SOLO desde el backend
-- (lib/handlers/fidelizacion.js) usando la service_role key, porque el
-- cliente_id tiene que derivarse server-side de la sesión autenticada del
-- cliente — nunca confiar en un cliente_id que mande el navegador, para
-- evitar que un cliente canjee puntos de otro cliente de la misma empresa.
--
-- NOTA: esta migración ya fue aplicada directo sobre la base de producción
-- (jgiquzjwoedmzwqgzubr) vía Supabase MCP. Este archivo la deja registrada
-- en el repo para que quede versionada junto al resto del historial.
CREATE OR REPLACE FUNCTION public.canjear_recompensa(
  p_empresa_id  uuid,
  p_cliente_id  uuid,
  p_recompensa_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recompensa      RECORD;
  v_saldo_actual    NUMERIC;
  v_saldo_nuevo     NUMERIC;
  v_canje_id        uuid;
BEGIN
  -- Esta función solo la puede llamar el backend (service_role). Un
  -- cliente autenticado directo (authenticated) nunca debería poder
  -- ejecutarla — ver GRANT más abajo.
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  -- Lockear la recompensa para evitar doble canje concurrente sobre el
  -- último stock disponible.
  SELECT * INTO v_recompensa
    FROM public.recompensas
   WHERE id = p_recompensa_id
     AND empresa_id = p_empresa_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La recompensa no existe';
  END IF;

  IF NOT v_recompensa.activa THEN
    RAISE EXCEPTION 'La recompensa no está activa';
  END IF;

  IF v_recompensa.fecha_inicio IS NOT NULL AND v_recompensa.fecha_inicio > CURRENT_DATE THEN
    RAISE EXCEPTION 'La recompensa todavía no está disponible';
  END IF;

  IF v_recompensa.fecha_fin IS NOT NULL AND v_recompensa.fecha_fin < CURRENT_DATE THEN
    RAISE EXCEPTION 'La recompensa ya venció';
  END IF;

  IF v_recompensa.cantidad_disponible IS NOT NULL
     AND (v_recompensa.cantidad_disponible - COALESCE(v_recompensa.cantidad_canjeada, 0)) <= 0 THEN
    RAISE EXCEPTION 'La recompensa se agotó';
  END IF;

  -- Lockear el saldo de puntos del cliente (mismo patrón que canjear_puntos).
  SELECT COALESCE(puntos_disponibles, 0) INTO v_saldo_actual
    FROM public.saldo_puntos
   WHERE cliente_id = p_cliente_id
     AND empresa_id = p_empresa_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cliente no tiene saldo de puntos';
  END IF;

  IF v_saldo_actual < v_recompensa.puntos_requeridos THEN
    RAISE EXCEPTION 'Saldo insuficiente (disponible: %, requerido: %)', v_saldo_actual, v_recompensa.puntos_requeridos;
  END IF;

  v_saldo_nuevo := v_saldo_actual - v_recompensa.puntos_requeridos;

  UPDATE public.saldo_puntos
     SET puntos_disponibles = v_saldo_nuevo,
         puntos_canjeados   = COALESCE(puntos_canjeados, 0) + v_recompensa.puntos_requeridos,
         ultimo_movimiento  = now()
   WHERE cliente_id = p_cliente_id
     AND empresa_id = p_empresa_id;

  UPDATE public.recompensas
     SET cantidad_canjeada = COALESCE(cantidad_canjeada, 0) + 1
   WHERE id = p_recompensa_id;

  INSERT INTO public.canjes_recompensas
         (cliente_id, recompensa_id, empresa_id, puntos_gastados, estado)
  VALUES (p_cliente_id, p_recompensa_id, p_empresa_id, v_recompensa.puntos_requeridos, 'pendiente')
  RETURNING id INTO v_canje_id;

  INSERT INTO public.movimientos_puntos
         (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
  VALUES (p_cliente_id, p_empresa_id, 'canje', v_recompensa.puntos_requeridos,
          'Canje: ' || v_recompensa.nombre, v_canje_id);

  RETURN json_build_object(
    'ok', true,
    'canje_id', v_canje_id,
    'saldo_nuevo', v_saldo_nuevo,
    'recompensa_nombre', v_recompensa.nombre
  );
END;
$function$;

-- Solo el backend (service_role) puede ejecutarla — el cliente_id se
-- deriva server-side de la sesión, nunca del body de la request.
REVOKE ALL ON FUNCTION public.canjear_recompensa(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canjear_recompensa(uuid, uuid, uuid) TO service_role;
