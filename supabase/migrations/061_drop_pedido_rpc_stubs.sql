-- ============================================================================
-- 061_drop_pedido_rpc_stubs.sql
-- Etapa 4 (auditoria v70, seccion 4.2): limpieza de RPC duplicadas de pedidos
--
-- CONTEXTO IMPORTANTE (corrige un supuesto incorrecto de la auditoria v70):
--
-- La auditoria v70 asumio que en los 3 pares duplicados, la version con
-- firma (p_pedido_id, p_usuario_id [, ...]) era siempre el "stub" y la otra
-- la version completa. Eso es cierto para confirmar_pedido, pero FALSO para
-- cancelar_pedido y marcar_preparado, donde es al reves:
--
--   confirmar_pedido(p_pedido_id, p_forzar)               -> COMPLETA
--   confirmar_pedido(p_pedido_id, p_usuario_id)            -> stub (DROP)
--
--   cancelar_pedido(p_pedido_id)                           -> COMPLETA
--   cancelar_pedido(p_pedido_id, p_usuario_id, p_motivo)   -> stub (DROP)
--
--   marcar_preparado(p_pedido_id)                          -> COMPLETA
--   marcar_preparado(p_pedido_id, p_usuario_id)            -> stub (DROP)
--
-- Ademas, frontend/admin/js/pedidos.js (cambiarEstado) en v73 estaba
-- llamando a la version STUB en 2 de los 3 casos (cancelar_pedido y
-- marcar_preparado), a pesar de que el comentario del propio archivo dice
-- "Reconectado a RPCs transaccionales". Es decir: el bug original de la
-- auditoria v70 (cancelaciones y pase a "preparando" sin liberar/validar
-- stock correctamente) seguia vigente para 2 de los 3 flujos. El fix de
-- pedidos.js que acompana a esta migracion corrige eso (ver
-- ETAPA_4_LIMPIEZA_RPC_DUPLICADAS.md).
--
-- Esta migracion:
--   1. Agrega un parametro opcional p_motivo a la version completa de
--      cancelar_pedido(p_pedido_id), para no perder la funcionalidad de
--      registrar el motivo en notas_internas que tenia el stub.
--   2. Elimina las 3 funciones stub.
--   3. Deja comentarios COMMENT ON FUNCTION documentando cual es la fuente
--      de verdad, para que no vuelva a pasar.
--
-- Prerrequisito: pedidos.js ya NO debe llamar a ninguna de las 3 firmas
-- que se eliminan aca (verificado: es el unico caller de las tres RPC en
-- todo el proyecto, frontend y backend).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Recrear cancelar_pedido(p_pedido_id) con p_motivo opcional, preservando
--    toda la logica transaccional existente (libera stock, anula facturas).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancelar_pedido(
  p_pedido_id uuid,
  p_motivo    text DEFAULT NULL::text
) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_pedido  RECORD;
  v_item    RECORD;
  v_stock   RECORD;
  v_uid     UUID;
BEGIN
  v_uid := auth.uid();

  SELECT * INTO v_pedido
    FROM pedidos
   WHERE id = p_pedido_id
     AND empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado IN ('entregado', 'cancelado') THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'No se puede cancelar un pedido ' || v_pedido.estado
    );
  END IF;

  -- Liberar stock solo si ya estaba reservado
  IF v_pedido.estado IN ('confirmado', 'preparando') THEN
    FOR v_item IN
      SELECT pi.producto_id, pi.cantidad
        FROM pedido_items pi
       WHERE pi.pedido_id = p_pedido_id
    LOOP
      SELECT s.deposito_id INTO v_stock
        FROM stock s
        JOIN depositos d ON d.id = s.deposito_id
       WHERE s.producto_id = v_item.producto_id
         AND d.empresa_id  = v_pedido.empresa_id
       ORDER BY d.es_principal DESC
       LIMIT 1;

      IF FOUND THEN
        PERFORM liberar_stock_reservado(
          v_item.producto_id, v_stock.deposito_id, v_item.cantidad
        );

        INSERT INTO movimientos_stock
          (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
        VALUES
          (v_item.producto_id, v_stock.deposito_id, 'liberacion', v_item.cantidad,
           p_pedido_id, 'Cancelación pedido', v_uid);
      END IF;
    END LOOP;
  END IF;

  -- Cancelar el pedido (preservando el motivo si vino informado, igual que
  -- hacía el stub eliminado)
  UPDATE pedidos
     SET estado = 'cancelado',
         notas_internas = COALESCE(p_motivo, notas_internas)
   WHERE id = p_pedido_id;

  -- Anular facturas pendientes vinculadas
  UPDATE facturas
     SET estado = 'anulada'
   WHERE pedido_id = p_pedido_id
     AND estado IN ('pendiente', 'emitida');

  RETURN json_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.cancelar_pedido(uuid, text) IS
  'Fuente de verdad unica para cancelar pedidos (etapa 4, post-auditoria v70). '
  'Libera stock reservado, anula facturas pendientes vinculadas y registra '
  'movimientos_stock. p_motivo es opcional y se guarda en notas_internas.';

-- ----------------------------------------------------------------------------
-- 2. Eliminar las 3 funciones stub. Solo se llega aca si pedidos.js ya fue
--    actualizado para no usarlas (ver fix adjunto a esta etapa).
-- ----------------------------------------------------------------------------

-- stub de confirmar_pedido: solo hacia UPDATE estado, sin validar credito
-- ni reservar stock.
DROP FUNCTION IF EXISTS public.confirmar_pedido(uuid, uuid);

-- stub de cancelar_pedido (firma vieja con p_usuario_id + p_motipo separados):
-- reemplazado por cancelar_pedido(uuid, text) arriba, que ya incluye p_motivo.
DROP FUNCTION IF EXISTS public.cancelar_pedido(uuid, uuid, text);

-- stub de marcar_preparado: solo hacia UPDATE estado, sin validar que el
-- pedido estuviera en estado 'confirmado'.
DROP FUNCTION IF EXISTS public.marcar_preparado(uuid, uuid);

-- ----------------------------------------------------------------------------
-- 3. Documentar las funciones que sobreviven, para que quede explícito en
--    \df+ / pg_proc cuál es la version vigente.
-- ----------------------------------------------------------------------------
COMMENT ON FUNCTION public.confirmar_pedido(uuid, boolean) IS
  'Fuente de verdad unica para confirmar pedidos (etapa 4, post-auditoria v70). '
  'Valida limite de credito (salteable con p_forzar), reserva stock por '
  'item y registra movimientos_stock.';

COMMENT ON FUNCTION public.marcar_preparado(uuid) IS
  'Fuente de verdad unica para pasar un pedido a "preparando" (etapa 4, '
  'post-auditoria v70). Valida que el pedido esté en estado confirmado. '
  'NOTA: no descuenta stock real (solo cantidad_reservada se gestiona en '
  'confirmar_pedido/cancelar_pedido) — ver hallazgo en '
  'ETAPA_4_LIMPIEZA_RPC_DUPLICADAS.md sobre el descuento de stock real.';

COMMIT;

-- ============================================================================
-- Verificacion post-migracion (ejecutar a mano, no es parte de la transaccion):
--
--   SELECT proname, pg_get_function_identity_arguments(oid)
--     FROM pg_proc
--    WHERE proname IN ('confirmar_pedido','cancelar_pedido','marcar_preparado')
--      AND pronamespace = 'public'::regnamespace
--    ORDER BY proname;
--
-- Resultado esperado: exactamente 1 fila por nombre de funcion.
-- ============================================================================
