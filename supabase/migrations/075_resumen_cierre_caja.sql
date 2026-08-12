-- ============================================================================
-- 075_resumen_cierre_caja.sql
--
-- Etapa 5 del POS: "Pantalla de cierre de caja con detalle por medio de
-- pago" (checklist de Etapa 5 en plan-pos-distrib.md).
--
-- Hoy cerrar_turno_caja() solo calcula el total de EFECTIVO (correcto para
-- el arqueo físico: es lo único que entra al cajón), pero el cajero no
-- tiene forma de ver el desglose completo (efectivo/transferencia/
-- tarjeta/qr/cuenta_corriente) antes de declarar el monto final.
--
--  1) resumen_turno_caja(p_turno_id): solo lectura, se puede llamar tantas
--     veces como haga falta mientras el turno sigue abierto (a diferencia
--     de cerrar_turno_caja, que es la operación que efectivamente cierra).
--     Devuelve el desglose por medio de pago + cantidad de ventas + el
--     mismo monto_calculado (efectivo) que después validará el cierre real,
--     para que el cajero pueda anticipar el arqueo sin comprometerse.
--
--  2) cerrar_turno_caja(): se le agrega el mismo desglose en la respuesta,
--     para que el toast de confirmación final también lo muestre. No
--     cambia ninguna columna ni el cálculo de monto_calculado/diferencia
--     que ya existía — solo agrega más campos al JSON de salida.
-- ============================================================================

-- ── 1. resumen_turno_caja(): desglose de solo lectura ───────────────────
CREATE OR REPLACE FUNCTION public.resumen_turno_caja(
  p_turno_id UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno          RECORD;
  v_por_medio      JSON;
  v_total_efectivo NUMERIC;
  v_cant_ventas    INTEGER;
  v_monto_calculado NUMERIC;
BEGIN
  SELECT * INTO v_turno FROM turnos_caja WHERE id = p_turno_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_no_encontrado', 'error', 'Turno no encontrado');
  END IF;

  -- Desglose por medio de pago, solo ventas completadas del turno.
  SELECT COALESCE(json_object_agg(medio, total), '{}'::json) INTO v_por_medio
  FROM (
    SELECT vpp.medio, SUM(vpp.monto) AS total
      FROM venta_pos_pagos vpp
      JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
     WHERE vp.turno_id = p_turno_id
       AND vp.estado = 'completada'
     GROUP BY vpp.medio
  ) t;

  SELECT COALESCE(SUM(vpp.monto), 0) INTO v_total_efectivo
    FROM venta_pos_pagos vpp
    JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
   WHERE vp.turno_id = p_turno_id
     AND vpp.medio = 'efectivo'
     AND vp.estado = 'completada';

  SELECT COUNT(*) INTO v_cant_ventas
    FROM ventas_pos
   WHERE turno_id = p_turno_id
     AND estado = 'completada';

  v_monto_calculado := v_turno.monto_inicial + v_total_efectivo;

  RETURN json_build_object(
    'ok', true,
    'monto_inicial', v_turno.monto_inicial,
    'total_efectivo', v_total_efectivo,
    'monto_calculado', v_monto_calculado,
    'cantidad_ventas', v_cant_ventas,
    'por_medio', v_por_medio
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resumen_turno_caja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resumen_turno_caja TO service_role;

-- ── 2. cerrar_turno_caja(): agrega el mismo desglose a la respuesta ─────
-- (no cambia el cálculo de monto_calculado/diferencia que ya hacía bien;
-- solo agrega 'por_medio' y 'cantidad_ventas' al JSON de salida).
CREATE OR REPLACE FUNCTION public.cerrar_turno_caja(
  p_turno_id              UUID,
  p_monto_final_declarado NUMERIC
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno             RECORD;
  v_total_efectivo    NUMERIC;
  v_monto_calculado   NUMERIC;
  v_por_medio         JSON;
  v_cant_ventas       INTEGER;
BEGIN
  SELECT * INTO v_turno FROM turnos_caja WHERE id = p_turno_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_no_encontrado', 'error', 'Turno no encontrado');
  END IF;

  IF v_turno.estado = 'cerrado' THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_ya_cerrado', 'error', 'El turno ya fue cerrado');
  END IF;

  SELECT COALESCE(SUM(vpp.monto), 0) INTO v_total_efectivo
    FROM venta_pos_pagos vpp
    JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
   WHERE vp.turno_id = p_turno_id
     AND vpp.medio = 'efectivo'
     AND vp.estado = 'completada';

  SELECT COALESCE(json_object_agg(medio, total), '{}'::json) INTO v_por_medio
  FROM (
    SELECT vpp.medio, SUM(vpp.monto) AS total
      FROM venta_pos_pagos vpp
      JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
     WHERE vp.turno_id = p_turno_id
       AND vp.estado = 'completada'
     GROUP BY vpp.medio
  ) t;

  SELECT COUNT(*) INTO v_cant_ventas
    FROM ventas_pos
   WHERE turno_id = p_turno_id
     AND estado = 'completada';

  v_monto_calculado := v_turno.monto_inicial + v_total_efectivo;

  UPDATE turnos_caja
     SET estado                  = 'cerrado',
         monto_final_declarado   = p_monto_final_declarado,
         monto_final_calculado   = v_monto_calculado,
         diferencia              = p_monto_final_declarado - v_monto_calculado,
         cerrado_at              = NOW()
   WHERE id = p_turno_id;

  RETURN json_build_object('ok', true,
    'monto_calculado', v_monto_calculado,
    'monto_declarado', p_monto_final_declarado,
    'diferencia', p_monto_final_declarado - v_monto_calculado,
    'por_medio', v_por_medio,
    'cantidad_ventas', v_cant_ventas);
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_turno_caja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cerrar_turno_caja TO service_role;
