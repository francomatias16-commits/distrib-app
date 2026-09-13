-- =============================================================================
-- 20260912200000_624_fix_regresion_signo_transferir_stock_y_conciliar_por_deposito.sql
--
-- Continúa A2 de PLAN_CIERRE_DEFINITIVO_2026-09.md ("Conciliación de stock por
-- depósito no es posible hoy"). Al re-verificar el hallazgo contra el código Y
-- contra el historial de migraciones (no solo el estado actual), apareció algo
-- más específico que "falta una columna de dirección":
--
--   • 400_fix_signo_movimientos_transferencia.sql (2026, anterior) YA había
--     arreglado esto: cantidad NEGATIVA en el movimiento del depósito origen,
--     POSITIVA en el de destino — exactamente para poder sumar por depósito.
--   • 446_offline_dedup_transferencia_stock.sql (posterior, agregó el dedup de
--     offline_local_id) reescribió transferir_stock() completo y, al hacerlo,
--     perdió el `-p_cantidad` del origen sin que ninguna nota lo mencione —
--     una regresión silenciosa, no una decisión. 465 y 508 heredaron el bug
--     sin tocarlo.
--   • Confirmado en vivo contra producción (jgiquzjwoedmzwqgzubr): la función
--     que corre HOY hace INSERT con `p_cantidad` (positivo) en ambos lados.
--   • Confirmado que el hermano `transferir_stock_entre_depositos` (migración
--     471, usado solo desde el POS vía lib/repos/pos.js) SÍ tiene el signo
--     correcto (`-p_cantidad` en origen) — nunca sufrió la regresión porque
--     es una función separada. Esa asimetría es la prueba de que 446 fue un
--     descuido, no un cambio de criterio.
--   • transferir_stock() es la que usan el panel admin (frontend/admin/js/
--     stock.js) y el asistente IA (lib/asistente-tools/stock.js) — los dos
--     caminos de transferencia MANUAL, que son justo los que un depositero
--     usaría para mover stock entre depósitos.
--
-- Impacto en datos existentes: solo hay 2 filas tipo='transferencia' en toda
-- la base de producción (un único movimiento de prueba, 2026-08-19, 10
-- unidades), ambas con cantidad=+10. Se corrige esa fila puntual con el
-- backfill de abajo — el par se identificó sin ambigüedad por su ctid físico
-- (el INSERT de origen corre antes que el de destino dentro de la misma
-- transacción, así que su ctid queda antes).
--
-- Fix de esta migración:
--   1) CREATE OR REPLACE de transferir_stock(): vuelve a insertar -p_cantidad
--      en el movimiento del depósito origen (igual que 400 y que el hermano
--      471). Nada más cambia respecto a la versión vigente (508).
--   2) Backfill puntual de la única fila afectada.
--   3) Nueva RPC de solo lectura conciliar_stock_por_deposito(empresa_id):
--      ahora que 'transferencia' viene con signo correcto, se puede sumar
--      junto con ingreso/egreso/ajuste agrupando por (producto_id,
--      deposito_id) y comparar contra stock.cantidad fila por fila — lo que
--      conciliar_stock_por_producto (620) no podía hacer por diseño (esa
--      agrega por producto solamente, y a propósito excluye 'transferencia'
--      porque before de este fix sumaba en falso). service_role únicamente
--      (ver nota de seguridad de la migración 620 sobre grants de más).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.transferir_stock(
  p_producto_id       UUID,
  p_deposito_origen   UUID,
  p_deposito_destino  UUID,
  p_cantidad          NUMERIC,
  p_motivo            TEXT DEFAULT 'transferencia_manual',
  p_notas             TEXT DEFAULT NULL,
  p_usuario_id        UUID DEFAULT NULL,
  p_offline_local_id  TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa_origen      UUID;
  v_empresa_destino     UUID;
  v_dep_lock1           UUID;
  v_dep_lock2           UUID;
  v_stock_origen        NUMERIC;
  v_stock_destino       NUMERIC;
  v_stock_origen_nuevo  NUMERIC;
  v_stock_destino_nuevo NUMERIC;
  v_existente_id        UUID;
  v_mov_origen_id       UUID;
  v_mov_destino_id      UUID;
  v_lote                RECORD;
  v_restante            NUMERIC;
  v_consumir            NUMERIC;
  v_lote_destino_id     UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  SELECT empresa_id INTO v_empresa_origen  FROM public.depositos WHERE id = p_deposito_origen;
  SELECT empresa_id INTO v_empresa_destino FROM public.depositos WHERE id = p_deposito_destino;

  IF v_empresa_origen IS NULL OR v_empresa_destino IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.movimientos_stock
     WHERE empresa_id = v_empresa_origen
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad INTO v_stock_origen_nuevo
        FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;
      SELECT cantidad INTO v_stock_destino_nuevo
        FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

      RETURN json_build_object(
        'ok',                   true,
        'stock_origen_nuevo',   COALESCE(v_stock_origen_nuevo, 0),
        'stock_destino_nuevo',  COALESCE(v_stock_destino_nuevo, 0),
        'deposito_origen',      p_deposito_origen,
        'deposito_destino',     p_deposito_destino,
        'cantidad',             p_cantidad,
        'ya_existia',           true
      );
    END IF;
  END IF;

  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  IF v_empresa_origen <> v_empresa_destino THEN
    RETURN json_build_object('ok', false, 'error', 'Ambos depósitos deben pertenecer a la misma empresa');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_origen
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_origen
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_origen, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_destino, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  IF p_deposito_origen < p_deposito_destino THEN
    v_dep_lock1 := p_deposito_origen;
    v_dep_lock2 := p_deposito_destino;
  ELSE
    v_dep_lock1 := p_deposito_destino;
    v_dep_lock2 := p_deposito_origen;
  END IF;

  PERFORM cantidad FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = v_dep_lock1 FOR UPDATE;
  PERFORM cantidad FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = v_dep_lock2 FOR UPDATE;

  SELECT cantidad INTO v_stock_origen
    FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;
  SELECT cantidad INTO v_stock_destino
    FROM public.stock WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

  v_stock_origen_nuevo  := COALESCE(v_stock_origen, 0) - p_cantidad;
  v_stock_destino_nuevo := COALESCE(v_stock_destino, 0) + p_cantidad;

  IF v_stock_origen_nuevo < 0 THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'Stock insuficiente en el depósito de origen para transferir',
      'stock_disponible', COALESCE(v_stock_origen, 0)
    );
  END IF;

  UPDATE public.stock SET cantidad = v_stock_origen_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_origen;

  UPDATE public.stock SET cantidad = v_stock_destino_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_destino;

  -- FIX A2 (esta migración): -p_cantidad en el lado origen (antes: p_cantidad,
  -- regresión de 446 respecto del fix original de 400). El lado destino se
  -- mantiene positivo, sin cambios.
  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, offline_local_id)
  VALUES
    (v_empresa_origen, p_producto_id, p_deposito_origen, 'transferencia', -p_cantidad, p_motivo, p_deposito_destino, p_usuario_id, p_notas,
     p_offline_local_id)
  RETURNING id INTO v_mov_origen_id;

  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, offline_local_id)
  VALUES
    (v_empresa_destino, p_producto_id, p_deposito_destino, 'transferencia', p_cantidad, p_motivo, p_deposito_origen, p_usuario_id, p_notas,
     CASE WHEN p_offline_local_id IS NOT NULL THEN p_offline_local_id || '-destino' ELSE NULL END)
  RETURNING id INTO v_mov_destino_id;

  v_restante := p_cantidad;

  FOR v_lote IN
    SELECT id, cantidad_disponible, costo_unitario, fecha_vencimiento,
           numero_lote, fecha_fabricacion
      FROM public.lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_origen
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY fecha_vencimiento ASC NULLS LAST, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE public.lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = now()
     WHERE id = v_lote.id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_origen_id, v_lote.id, v_consumir, 'consumo');

    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
    ) VALUES (
      v_empresa_origen, p_producto_id, p_deposito_destino,
      COALESCE(v_lote.numero_lote, 'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI')),
      v_consumir, v_consumir,
      v_lote.costo_unitario, v_lote.fecha_fabricacion, v_lote.fecha_vencimiento,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_consumir, 'alta');

    v_restante := v_restante - v_consumir;
  END LOOP;

  IF v_restante > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible, estado
    ) VALUES (
      v_empresa_origen, p_producto_id, p_deposito_destino,
      'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_restante, v_restante,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_restante, 'alta');
  END IF;

  RETURN json_build_object(
    'ok',                   true,
    'stock_origen_nuevo',   v_stock_origen_nuevo,
    'stock_destino_nuevo',  v_stock_destino_nuevo,
    'deposito_origen',      p_deposito_origen,
    'deposito_destino',     p_deposito_destino,
    'cantidad',             p_cantidad
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill puntual: la única fila de transferencia ya existente en
-- producción (origen) tenía el signo viejo (regresión de 446). Identificada
-- sin ambigüedad por ctid físico (el INSERT de origen corre antes que el de
-- destino en la misma transacción).
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.movimientos_stock
   SET cantidad = -10
 WHERE id = '14fae4d6-69fa-4957-a81e-39d3e94a5868'
   AND tipo = 'transferencia'
   AND cantidad = 10;

-- ─────────────────────────────────────────────────────────────────────────
-- Nueva RPC: conciliación por depósito (lo que A2 pedía). Solo service_role.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.conciliar_stock_por_deposito(p_empresa_id uuid)
 RETURNS TABLE(
   producto_id           uuid,
   producto_nombre       text,
   deposito_id           uuid,
   deposito_nombre       text,
   cantidad_mostrada     numeric,
   cantidad_recalculada  numeric,
   diferencia            numeric
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    p.id,
    p.nombre,
    d.id,
    d.nombre,
    COALESCE(st.cantidad, 0)         AS cantidad_mostrada,
    COALESCE(m.total_recalculado, 0) AS cantidad_recalculada,
    COALESCE(st.cantidad, 0) - COALESCE(m.total_recalculado, 0) AS diferencia
  FROM public.productos p
  JOIN public.depositos d
    ON d.empresa_id = p.empresa_id
  LEFT JOIN public.stock st
    ON st.producto_id = p.id AND st.deposito_id = d.id
  LEFT JOIN (
    SELECT ms.producto_id, ms.deposito_id,
      SUM(CASE
            WHEN ms.tipo IN ('ingreso', 'entrada_compra') THEN ms.cantidad
            WHEN ms.tipo = 'egreso'                       THEN -ms.cantidad
            WHEN ms.tipo = 'ajuste'                        THEN ms.cantidad
            -- ya viene con signo correcto (negativo en origen, positivo en
            -- destino) desde este mismo fix — no re-signar acá.
            WHEN ms.tipo = 'transferencia'                 THEN ms.cantidad
          END) AS total_recalculado
    FROM public.movimientos_stock ms
    WHERE ms.empresa_id = p_empresa_id
      AND ms.tipo IN ('ingreso', 'entrada_compra', 'egreso', 'ajuste', 'transferencia')
    GROUP BY ms.producto_id, ms.deposito_id
  ) m ON m.producto_id = p.id AND m.deposito_id = d.id
  WHERE p.empresa_id = p_empresa_id
    AND (st.cantidad IS NOT NULL OR m.total_recalculado IS NOT NULL);
$function$;

-- Igual criterio que 620: pensada para uso exclusivo de service_role, sin
-- grant a anon/authenticated (a diferencia del hallazgo de seguridad que
-- 620 dejó documentado sobre sus propias RPCs, acá no se repite).
GRANT EXECUTE ON FUNCTION public.conciliar_stock_por_deposito(uuid) TO service_role;

COMMENT ON FUNCTION public.conciliar_stock_por_deposito IS
  'Conciliación de stock por (producto, depósito) — cierra A2 de '
  'PLAN_CIERRE_DEFINITIVO_2026-09.md. Requiere que transferir_stock() '
  'inserte cantidad con signo (negativo en origen, positivo en destino, '
  'ver esta misma migración) para poder sumar por depósito sin ambigüedad. '
  'Solo service_role.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '20260912200000_624_fix_regresion_signo_transferir_stock_y_conciliar_por_deposito.sql', '624', 'claude-session',
  'A2 del plan de cierre: transferir_stock() había perdido el signo negativo '
  'del movimiento de origen (regresión de 446 sobre el fix de 400, nunca '
  'notada porque 446 solo tocó transferir_stock y no su hermana '
  'transferir_stock_entre_depositos, que sí lo conservaba). Restaurado + '
  'backfill de la única fila afectada en producción + nueva RPC '
  'conciliar_stock_por_deposito() que ahora puede sumar transferencia por '
  'depósito sin ambigüedad.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
