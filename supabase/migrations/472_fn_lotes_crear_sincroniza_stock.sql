-- ═══════════════════════════════════════════════════════════════════════════
-- 472_fn_lotes_crear_sincroniza_stock.sql [reconstruida, ver 462]
--
-- Fix: el alta manual de lote (POST /api/lotes) hacía un INSERT plano y
-- nunca tocaba stock/movimientos_stock — a diferencia de editar cantidad
-- (fn_lotes_ajustar_cantidad, mig. 470) y dar de baja (fn_lotes_dar_de_baja,
-- mig. 352), que ya sincronizaban. Esta función generaliza el mismo patrón
-- transaccional para el alta: crea el lote y, si tiene depósito (explícito o
-- el es_principal de la empresa), suma la cantidad a `stock`, registra el
-- ingreso en movimientos_stock y deja el alta en movimientos_stock_lotes.
-- Si no hay depósito disponible, crea el lote sin sincronizar (igual que el
-- comportamiento ya existente de fn_lotes_ajustar_cantidad para lotes
-- legado sin depósito).
--
-- Handler (lib/handlers/stock.js POST) y repo (lib/repos/stock.js
-- crearLote) llaman a esta RPC en vez de hacer el INSERT directo.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_lotes_crear(
  p_empresa_id        uuid,
  p_producto_id       uuid,
  p_cantidad          numeric,
  p_deposito_id       uuid DEFAULT NULL::uuid,
  p_numero_lote       text DEFAULT NULL::text,
  p_costo_unitario    numeric DEFAULT NULL::numeric,
  p_fecha_fabricacion date DEFAULT NULL::date,
  p_fecha_vencimiento date DEFAULT NULL::date,
  p_estado            text DEFAULT 'activo'::text,
  p_usuario_id        uuid DEFAULT NULL::uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deposito_id   uuid;
  v_lote_id       uuid;
  v_stock_actual  numeric;
  v_stock_nuevo   numeric;
  v_mov_id        uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = p_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF p_producto_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'producto_id es requerido');
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado');
  END IF;

  v_deposito_id := p_deposito_id;

  IF v_deposito_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.depositos WHERE id = v_deposito_id AND empresa_id = p_empresa_id
    ) THEN
      RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
    END IF;
  ELSE
    SELECT id INTO v_deposito_id
      FROM public.depositos
     WHERE empresa_id = p_empresa_id AND es_principal = true AND activa = true
     LIMIT 1;
  END IF;

  INSERT INTO public.lotes
    (empresa_id, producto_id, deposito_id, numero_lote, cantidad,
     costo_unitario, fecha_fabricacion, fecha_vencimiento, estado)
  VALUES
    (p_empresa_id, p_producto_id, v_deposito_id, p_numero_lote, p_cantidad,
     p_costo_unitario, p_fecha_fabricacion, p_fecha_vencimiento, COALESCE(p_estado, 'activo'))
  RETURNING id INTO v_lote_id;

  IF v_deposito_id IS NOT NULL THEN
    INSERT INTO public.stock (producto_id, deposito_id, cantidad)
    VALUES (p_producto_id, v_deposito_id, 0)
    ON CONFLICT (producto_id, deposito_id) DO NOTHING;

    SELECT cantidad INTO v_stock_actual
      FROM public.stock
     WHERE producto_id = p_producto_id AND deposito_id = v_deposito_id
     FOR UPDATE;

    v_stock_nuevo := COALESCE(v_stock_actual, 0) + p_cantidad;

    UPDATE public.stock
       SET cantidad = v_stock_nuevo, updated_at = now()
     WHERE producto_id = p_producto_id AND deposito_id = v_deposito_id;

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, costo_unitario)
    VALUES
      (p_producto_id, v_deposito_id, 'ingreso', p_cantidad, 'alta_lote', v_lote_id,
       p_usuario_id, 'Alta de lote ' || COALESCE(p_numero_lote, v_lote_id::text), p_costo_unitario)
    RETURNING id INTO v_mov_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_id, v_lote_id, p_cantidad, 'alta');
  END IF;

  RETURN json_build_object(
    'ok', true,
    'id', v_lote_id,
    'deposito_id', v_deposito_id,
    'stock_sincronizado', (v_deposito_id IS NOT NULL),
    'stock_nuevo', v_stock_nuevo
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_lotes_crear TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_lotes_crear IS
  'Crea un lote y, si tiene depósito (explícito o el principal de la '
  'empresa), sincroniza stock/movimientos_stock y deja el alta en '
  'movimientos_stock_lotes (mig. 462). Reemplaza el INSERT plano previo del '
  'alta manual de lote.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '472_fn_lotes_crear_sincroniza_stock.sql', '472', 'claude-session',
  'Fix: el alta manual de lote (POST /api/lotes) hacía un INSERT plano y nunca tocaba stock/movimientos_stock — a diferencia de editar cantidad (fn_lotes_ajustar_cantidad, mig. 470) y dar de baja (fn_lotes_dar_de_baja, mig. 352), que ya sincronizaban. Nueva fn_lotes_crear generaliza el mismo patrón transaccional para el alta. Si no se manda deposito_id, usa el depósito es_principal de la empresa; si no hay ninguno, crea el lote sin sincronizar (igual que el comportamiento ya existente de fn_lotes_ajustar_cantidad para lotes legado sin depósito). Handler (lib/handlers/stock.js POST) y repo (lib/repos/stock.js crearLote) actualizados para llamar esta RPC en vez del INSERT directo.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
