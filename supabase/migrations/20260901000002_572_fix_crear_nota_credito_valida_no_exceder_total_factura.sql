-- Etapa 7 (Bloque 1, Devoluciones) — caso borde "devolución sobre pedido con
-- NC previa", visto desde facturación/ARCA.
--
-- Contexto: junto con esta migración se corrigió lib/handlers/facturas.js
-- para que una NC nacida de una devolución PARCIAL (no cubre el total de la
-- factura) ya no pase por emitirNotaCreditoARCA -- esa función anulaba la
-- factura completa y pedía el CAE por el total completo, sin importar el
-- monto real de la NC (ver comentario ahí). Con ese fix, la factura
-- original queda 'emitida' después de una NC parcial, en vez de 'anulada'.
--
-- Eso resuelve un problema (obtenerFacturaRecienteDePedido dejaba de
-- encontrar la factura para una segunda devolución sobre el mismo pedido,
-- porque solo busca en estado 'emitida'/'pagada') pero abre otro: nada
-- impedía -- ni antes ni después de ese fix -- que dos o más devoluciones
-- sobre el mismo pedido, cada una con su propia NC parcial, terminaran
-- acreditando en conjunto más de lo que esa factura realmente vale. La RPC
-- rpc_crear_devolucion_validada (570/571) sí evita devolver más CANTIDAD de
-- la comprada, pero crear_nota_credito nunca validó el MONTO acumulado
-- contra la factura vinculada -- son dos validaciones independientes y solo
-- existía la primera.
--
-- Fix: al crear una NC con p_factura_id, sumar el total de las NC ya
-- existentes para esa factura (cualquier estado salvo 'anulada', que no
-- cuenta) y rechazar si, sumado el nuevo total, se pasa del total de la
-- factura (con la misma tolerancia de 0.05 que usa wsfev1.js para redondeo).

CREATE OR REPLACE FUNCTION public.crear_nota_credito(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_tipo text,
  p_motivo text,
  p_items jsonb,
  p_factura_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_nc_id UUID;
  v_item  JSONB;
  v_neto  NUMERIC := 0;
  v_iva   NUMERIC := 0;
  v_sub   NUMERIC;
  v_total NUMERIC;
  v_factura_total     NUMERIC;
  v_ya_acreditado     NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  IF p_factura_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM facturas WHERE id = p_factura_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sub  := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_unitario')::NUMERIC;
    v_neto := v_neto + v_sub;
  END LOOP;

  IF p_tipo IN ('A','B') THEN
    v_iva := v_neto * 0.21;
  END IF;

  v_total := v_neto + v_iva;

  -- FIX 572: tope contra lo ya acreditado sobre la misma factura.
  IF p_factura_id IS NOT NULL THEN
    SELECT f.total INTO v_factura_total FROM facturas f WHERE f.id = p_factura_id;

    SELECT COALESCE(SUM(nc.total), 0) INTO v_ya_acreditado
      FROM notas_credito nc
     WHERE nc.factura_id = p_factura_id
       AND nc.estado <> 'anulada';

    IF v_factura_total IS NOT NULL AND (v_ya_acreditado + v_total) > (v_factura_total + 0.05) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', format(
          'Esta nota de crédito ($%s) sumada a lo ya acreditado sobre esta factura ($%s) supera el total facturado ($%s). Revisar devoluciones previas sobre el mismo pedido.',
          v_total, v_ya_acreditado, v_factura_total
        )
      );
    END IF;
  END IF;

  INSERT INTO notas_credito
    (empresa_id, cliente_id, factura_id, tipo, motivo, neto, iva, total,
     estado, created_by)
  VALUES
    (p_empresa_id, p_cliente_id, p_factura_id, p_tipo, p_motivo,
     v_neto, v_iva, v_total, 'pendiente', COALESCE(p_created_by, auth.uid()))
  RETURNING id INTO v_nc_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_unitario')::NUMERIC;
    INSERT INTO notas_credito_items
      (nota_credito_id, descripcion, cantidad, precio_unitario, subtotal)
    VALUES (
      v_nc_id,
      v_item->>'descripcion',
      (v_item->>'cantidad')::NUMERIC,
      (v_item->>'precio_unitario')::NUMERIC,
      v_sub
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_nc_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.crear_nota_credito FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crear_nota_credito TO authenticated, service_role;
