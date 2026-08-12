-- =============================================================
-- 189_fix_generar_ofertas_liquidacion_alias_bug.sql
-- Fix: bug de alias en generar_ofertas_liquidacion() detectado
-- durante el stress test de Fase 13 (compras en vivo, plan
-- maestro). 190 refina el cálculo de días sobre esta misma base.
--
-- NOTA DE SINCRONIZACIÓN (reconstrucción post-sesión): este
-- archivo y 190_fix_..._calculo_dias.sql se reconstruyeron a
-- partir de la definición final vigente en producción
-- (pg_get_functiondef), porque el diff intermedio entre 189 y 190
-- no quedó preservado en el historial de la sesión anterior. Como
-- CREATE OR REPLACE FUNCTION es idempotente, aplicar ambos no
-- rompe nada, pero el detalle línea a línea de qué cambió en 189
-- vs. 190 específicamente no se puede recuperar con certeza.
-- =============================================================

CREATE OR REPLACE FUNCTION public.generar_ofertas_liquidacion(p_empresa_id uuid, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reglas        RECORD;
  v_lote          RECORD;
  v_dias_rest     INT;
  v_pct           NUMERIC(5,2);
  v_precio_base   NUMERIC(12,2);
  v_precio_oferta NUMERIC(12,2);
  v_cant_disp     NUMERIC(12,3);
  v_creadas       JSONB := '[]'::JSONB;
  v_desactivadas  INT   := 0;
BEGIN
  SELECT * INTO v_reglas FROM reglas_liquidacion WHERE empresa_id = p_empresa_id;
  IF v_reglas IS NULL THEN
    v_reglas := ROW(
      gen_random_uuid(), p_empresa_id, true,
      7, 3, 10::NUMERIC, 1, 15::NUMERIC, 0, 25::NUMERIC,
      true, NOW(), NOW()
    )::reglas_liquidacion;
  END IF;
  IF NOT v_reglas.activo THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Reglas de liquidación desactivadas para esta empresa',
      'creadas', v_creadas,
      'desactivadas', v_desactivadas
    );
  END IF;

  FOR v_lote IN
    SELECT l.id, l.producto_id, l.cantidad, l.fecha_vencimiento,
           p.precio_base, (l.fecha_vencimiento - CURRENT_DATE)::INT AS dias_restantes
    FROM lotes l
    JOIN productos p ON l.producto_id = p.id
    WHERE l.empresa_id = p_empresa_id
      AND l.estado = 'activo'
      AND l.cantidad > 0
      AND l.fecha_vencimiento <= (CURRENT_DATE + (v_reglas.dias_alerta || ' days')::INTERVAL)
      AND l.fecha_vencimiento >= CURRENT_DATE
    ORDER BY l.fecha_vencimiento ASC
  LOOP
    v_dias_rest     := v_lote.dias_restantes;
    v_precio_base   := v_lote.precio_base;
    v_cant_disp     := v_lote.cantidad;

    IF v_dias_rest <= v_reglas.dias_nivel3 THEN
      v_pct := v_reglas.pct_nivel3;
    ELSIF v_dias_rest <= v_reglas.dias_nivel2 THEN
      v_pct := v_reglas.pct_nivel2;
    ELSE
      v_pct := v_reglas.pct_nivel1;
    END IF;

    v_precio_oferta := v_precio_base * (1 - v_pct / 100);

    INSERT INTO ofertas_liquidacion (
      empresa_id, lote_id, producto_id, precio_oferta, descuento_pct,
      cantidad_snapshot, dias_restantes_al_crear, activa, vence_oferta_at
    ) VALUES (
      p_empresa_id, v_lote.id, v_lote.producto_id, v_precio_oferta, v_pct,
      v_cant_disp, v_dias_rest, true,
      NOW() + INTERVAL '7 days'
    )
    ON CONFLICT (lote_id, empresa_id) WHERE activa
    DO UPDATE SET
      precio_oferta = v_precio_oferta,
      descuento_pct = v_pct,
      cantidad_snapshot = v_cant_disp,
      dias_restantes_al_crear = v_dias_rest,
      updated_at = NOW();

    v_creadas := v_creadas || jsonb_build_object('lote_id', v_lote.id::TEXT, 'producto_id', v_lote.producto_id::TEXT);
  END LOOP;

  UPDATE ofertas_liquidacion SET
    activa = false,
    desactivada_at = NOW(),
    razon_desactivacion = 'lote_agotado_o_oferta_vencida'
  WHERE empresa_id = p_empresa_id
    AND activa = true
    AND (
      EXISTS (SELECT 1 FROM lotes WHERE id = ofertas_liquidacion.lote_id AND estado IN ('agotado', 'vencido'))
      OR vence_oferta_at < NOW()
    );

  GET DIAGNOSTICS v_desactivadas = ROW_COUNT;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'modo', 'dry_run',
      'creadas', v_creadas,
      'desactivadas', v_desactivadas
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'creadas', v_creadas,
    'desactivadas', v_desactivadas
  );
END;
$function$
