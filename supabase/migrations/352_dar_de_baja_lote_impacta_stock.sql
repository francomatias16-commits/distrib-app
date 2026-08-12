-- ─────────────────────────────────────────────────────────────────────────
-- 352: "Dar de baja" un lote (ej: vencido) ahora impacta el stock real.
--
-- Antes, la única forma de "dar de baja" un lote desde Lotes y vencimientos
-- era editarlo a mano y poner la cantidad en 0 — pero la tabla `lotes` es
-- un tracking manual desconectado de `stock`, así que eso no descontaba
-- nada del stock disponible real. El cartel decía "revisar y dar de baja"
-- pero no existía ninguna acción que efectivamente diera de baja: ni
-- botón, ni RPC, ni vínculo con stock.
--
-- Esta migración agrega fn_lotes_dar_de_baja(): en una sola transacción,
-- descuenta del stock real (producto_id + deposito_id del lote) la
-- cantidad restante del lote, deja un movimiento de stock (tipo 'egreso')
-- para el historial/auditoría, y pone el lote en 0 (cantidad y
-- cantidad_disponible). No usa ajustar_stock()/fn_lotes_consumir_fefo()
-- a propósito: esas funciones consumen lotes por FEFO (el de vencimiento
-- más próximo primero) sin importar cuál eligió el usuario, así que si
-- hay más de un lote vencido del mismo producto/depósito, dar de baja UNO
-- específico podría terminar vaciando OTRO. Acá se ataca directamente el
-- lote elegido y se descuenta exactamente esa cantidad del stock.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_lotes_dar_de_baja(
  p_lote_id    uuid,
  p_motivo     text DEFAULT 'Baja de lote vencido',
  p_usuario_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote          RECORD;
  v_empresa_id    uuid;
  v_stock_actual  numeric;
  v_stock_nuevo   numeric;
BEGIN
  SELECT l.id, l.empresa_id, l.producto_id, l.deposito_id, l.numero_lote,
         l.cantidad, l.costo_unitario
    INTO v_lote
    FROM public.lotes l
   WHERE l.id = p_lote_id
   FOR UPDATE;

  IF v_lote.id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Lote no encontrado');
  END IF;

  v_empresa_id := v_lote.empresa_id;

  -- Callers de sesión real (frontend, authenticated): mismo chequeo que
  -- ajustar_stock(). Callers service_role (backend): el handler ya validó
  -- token + rol + que el lote pertenece a la empresa del usuario.
  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF v_lote.cantidad <= 0 THEN
    RETURN json_build_object('ok', true, 'ya_estaba_en_cero', true, 'cantidad_dada_de_baja', 0);
  END IF;

  IF v_lote.deposito_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error',
      'El lote no tiene depósito asignado — asignale uno desde "Editar" antes de darlo de baja.');
  END IF;

  -- Descontar del stock real (nunca negativo: si el stock real ya está por
  -- debajo de lo que marca el lote —desfasajes históricos—, lo deja en 0
  -- en vez de fallar o irse a negativo).
  SELECT cantidad INTO v_stock_actual
    FROM public.stock
   WHERE producto_id = v_lote.producto_id AND deposito_id = v_lote.deposito_id
   FOR UPDATE;

  v_stock_nuevo := GREATEST(0, COALESCE(v_stock_actual, 0) - v_lote.cantidad);

  UPDATE public.stock
     SET cantidad = v_stock_nuevo, updated_at = now()
   WHERE producto_id = v_lote.producto_id AND deposito_id = v_lote.deposito_id;
  -- cantidad_disponible del stock se resincroniza sola vía
  -- trg_sync_stock_disponible (BEFORE UPDATE OF cantidad).

  -- Movimiento de stock, igual que cualquier ajuste manual, para que quede
  -- en el historial (Stock → movimientos) y no sea un descuento invisible.
  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, costo_unitario)
  VALUES
    (v_lote.producto_id, v_lote.deposito_id, 'egreso', v_lote.cantidad, p_motivo, v_lote.id,
     p_usuario_id, 'Baja de lote ' || COALESCE(v_lote.numero_lote, v_lote.id::text), v_lote.costo_unitario);

  -- Pone el lote en 0: deja de figurar como vencido/pendiente de revisión
  -- (cantidad_disponible también en 0 porque no es una columna generada,
  -- se mantiene sincronizada a mano en el resto del código de lotes).
  UPDATE public.lotes
     SET cantidad = 0, cantidad_disponible = 0, updated_at = now()
   WHERE id = p_lote_id;

  RETURN json_build_object(
    'ok', true,
    'cantidad_dada_de_baja', v_lote.cantidad,
    'stock_anterior', COALESCE(v_stock_actual, 0),
    'stock_nuevo', v_stock_nuevo
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.fn_lotes_dar_de_baja(uuid, text, uuid) IS
  'Da de baja un lote específico (ej: vencido): descuenta su cantidad del '
  'stock real (producto_id + deposito_id del lote), deja un movimiento de '
  'stock tipo egreso para el historial, y pone el lote en cantidad=0. '
  'A diferencia de ajustar_stock()/fn_lotes_consumir_fefo() (que consumen '
  'lotes por FEFO), ataca puntualmente el lote elegido por el usuario.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '352_dar_de_baja_lote_impacta_stock.sql', '352', 'claude-session',
  'Agrega fn_lotes_dar_de_baja(): la pantalla de Lotes y vencimientos avisaba "revisar y dar de baja" pero no existia ninguna accion real para eso — editar la cantidad a mano no tocaba el stock real (lotes es tracking manual, desconectado de stock). Ahora dar de baja un lote descuenta esa cantidad del stock del deposito correspondiente y deja movimiento en el historial, en una sola transaccion.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
