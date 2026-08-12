-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 417: el botón "Cobrar" salda la factura puntual + facturar una
-- venta POS ya no infla la deuda con lo que se cobró en el momento
--
-- BUG 1 (por qué "Cobrar" seguía habilitado en una venta ya pagada en
-- efectivo en caja): emitirFactura() (lib/facturas.js) siempre debitaba
-- cta_cte por el TOTAL de la factura vía asentar_movimiento_cta_cte_factura,
-- sin mirar venta_pos_pagos — no distinguía entre lo que ya se cobró en el
-- momento (efectivo/tarjeta/transferencia) y lo que quedó a cuenta
-- corriente. Una venta 100% efectivo terminaba generando la misma deuda
-- que una 100% cuenta corriente.
--
-- BUG 2 (por qué esa factura nunca salía de "Facturas pendientes" ni
-- cobrándola): registrar_cobro_completo (fix aplicado acá, antes en
-- migración 199) solo registra el cobro a nivel CLIENTE (cta_cte + saldo
-- global) — nunca tocaba facturas.total_cobrado de una factura puntual.
-- v_cobranza_priorizada y fn_cobranzas_facturas filtran por
-- (total - total_cobrado) > 0, así que una factura emitida quedaba
-- "pendiente" para siempre, se cobrara o no.
--
-- Fix (este archivo, lado DB):
--   1) registrar_cobro_completo ahora acepta un p_factura_id opcional.
--      Si viene, además de asentar el cobro a nivel cliente (como siempre),
--      aplica el monto a esa factura puntual: incrementa total_cobrado
--      (topeado al total, por si se cobra de más) y la marca 'parcial' si
--      todavía queda saldo. 100% retrocompatible: los llamadores que no
--      mandan p_factura_id (webhook de Mercado Pago, cobro rápido de
--      rutas) siguen funcionando exactamente igual que antes.
--
-- El BUG 1 (que emitirFactura no infle la deuda con lo ya cobrado en POS)
-- se corrige del lado Node en lib/facturas.js — no requiere tocar
-- asentar_movimiento_cta_cte_factura (esa función no está versionada en
-- migrations, ver nota en REPORTE_FASE3_pedido_factura_ctacte_cobro.md;
-- se ajusta el monto que Node le pasa, no la función en sí).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.registrar_cobro_completo(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_monto       NUMERIC,
  p_medio       TEXT,
  p_referencia  TEXT DEFAULT NULL,
  p_notas       TEXT DEFAULT NULL,
  p_usuario_id  UUID DEFAULT NULL,
  p_factura_id  UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cobro_id UUID;
  v_nro      TEXT;
  v_saldo    NUMERIC;
  v_factura  RECORD;
  v_aplicado NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_monto <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  -- Si viene p_factura_id, validar que sea de este cliente/empresa y que
  -- todavía tenga saldo pendiente ANTES de registrar nada.
  IF p_factura_id IS NOT NULL THEN
    SELECT id, total, COALESCE(total_cobrado, 0) AS total_cobrado, estado
      INTO v_factura
      FROM facturas
     WHERE id = p_factura_id
       AND empresa_id = p_empresa_id
       AND cliente_id = p_cliente_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN json_build_object('ok', false, 'error', 'La factura indicada no existe o no pertenece a este cliente');
    END IF;

    IF v_factura.estado = 'anulada' THEN
      RETURN json_build_object('ok', false, 'error', 'La factura está anulada, no se le puede aplicar un cobro');
    END IF;

    IF (v_factura.total - v_factura.total_cobrado) <= 0 THEN
      RETURN json_build_object('ok', false, 'error', 'Esta factura ya está saldada');
    END IF;
  END IF;

  v_nro := siguiente_numero_comprobante(p_empresa_id, 'cobro');

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio, referencia, notas, usuario_id)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas,
          COALESCE(p_usuario_id, auth.uid()))
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, cobro_id,
                        nro_comprobante, descripcion, medio_pago)
  VALUES (p_empresa_id, p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
          'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  -- Aplicar el cobro a la factura puntual (tope: no puede superar el saldo
  -- pendiente de ESA factura, aunque p_monto sea mayor — el excedente queda
  -- como pago a cuenta general del cliente, ya cubierto por el INSERT de
  -- arriba en cta_cte).
  IF p_factura_id IS NOT NULL THEN
    v_aplicado := LEAST(p_monto, v_factura.total - v_factura.total_cobrado);

    UPDATE facturas
       SET total_cobrado = v_factura.total_cobrado + v_aplicado,
           estado = CASE
                      WHEN (v_factura.total_cobrado + v_aplicado) >= v_factura.total THEN estado
                      ELSE 'parcial'::estado_factura
                    END
     WHERE id = p_factura_id;
  END IF;

  -- FIX (Fase 3): reevaluar bloqueo por deuda sin importar el medio de pago.
  -- Mismo cálculo que usan cierre.js (detectarVencimientosYBloquear /
  -- desbloquearSiSaldado): suma de 'debito' menos suma de todo lo demás
  -- (cobro, credito, etc.) sobre cta_cte para el cliente.
  SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0)
  INTO v_saldo
  FROM cta_cte
  WHERE cliente_id = p_cliente_id;

  IF v_saldo <= 0 THEN
    UPDATE clientes
    SET bloqueado = false, bloqueado_motivo = NULL
    WHERE id = p_cliente_id AND bloqueado = true;

    UPDATE bloqueos_cliente
    SET activo = false
    WHERE cliente_id = p_cliente_id AND activo = true;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'cobro_id', v_cobro_id,
    'nro', v_nro,
    'factura_id', p_factura_id,
    'factura_saldada', CASE WHEN p_factura_id IS NOT NULL THEN (v_factura.total_cobrado + LEAST(p_monto, v_factura.total - v_factura.total_cobrado)) >= v_factura.total ELSE NULL END
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_cobro_completo FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_cobro_completo TO authenticated, service_role;

COMMENT ON FUNCTION public.registrar_cobro_completo IS
  'Crea cobro + movimiento en cta_cte de forma atómica, reevalúa el bloqueo por deuda del cliente, y opcionalmente (p_factura_id) aplica el cobro a una factura puntual actualizando su total_cobrado/estado — antes el cobro solo quedaba a nivel cliente y la factura nunca salía de "pendiente" en Cobranzas aunque se hubiera cobrado.';
