-- ============================================================
-- 080_pos_fase3.sql
-- POS Fase 3 — ítems 10-15 (Movimientos caja, Descuentos, Favoritos, PIN supervisor, Reporte Z):
--
--  TABLAS NUEVAS
--   · pos_favoritos       — grilla de productos de acceso rápido (ítem 13)
--   · movimientos_caja    — sangría / refuerzo / retiro (ítem 10)
--
--  COLUMNAS NUEVAS
--   · empresas.supervisor_pin               — PIN numérico para autorizar
--                                            descuentos grandes / anulaciones (ítem 14)
--   · usuarios.supervisor_umbral_descuento_pct — umbral personal por cajero
--   · ventas_pos.descuento_global_pct       — registra el % aplicado a la venta
--
--  RPCS NUEVOS / ACTUALIZADOS
--   · resumen_turno_caja()                  — NUEVO (ya era llamado en producción
--                                            pero nunca existió → crash garantizado)
--   · cerrar_turno_caja()                   — ACTUALIZADO: arqueo correcto considera
--                                            movimientos de caja (antes sólo sumaba ventas)
--   · registrar_venta_pos()                 — ACTUALIZADO: acepta descuento_global_pct
--
-- Todo aditivo. No toca tablas/funciones de otros módulos.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLAS NUEVAS
-- ============================================================

-- Favoritos / grilla de acceso rápido (ítem 13)
-- Una entrada por (empresa, producto). La posición se controla
-- por el campo `orden`; el front lo respeta al renderizar la grilla.
CREATE TABLE IF NOT EXISTS pos_favoritos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  etiqueta    TEXT,                           -- nombre corto para el botón (opcional)
  color       TEXT DEFAULT '#28a745',         -- color del botón en el front
  orden       INT  DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (empresa_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_favoritos_empresa ON pos_favoritos(empresa_id);

COMMENT ON TABLE pos_favoritos IS
  'Productos de acceso rápido en el POS. Un producto por empresa, máximo 1 entrada. '
  'El front los muestra como botones de color en una grilla encima de la búsqueda.';

-- Movimientos de caja (ítem 10)
-- Sangría (retiro parcial), Refuerzo (agregar efectivo) y Retiro final
-- (vaciado antes del cierre). TODOS impactan el arqueo.
CREATE TABLE IF NOT EXISTS movimientos_caja (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  turno_id    UUID NOT NULL REFERENCES turnos_caja(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('sangria', 'refuerzo', 'retiro_final')),
  monto       NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  concepto    TEXT,
  usuario_id  UUID REFERENCES usuarios(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movimientos_caja_turno   ON movimientos_caja(turno_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_empresa ON movimientos_caja(empresa_id);

COMMENT ON TABLE movimientos_caja IS
  'Entradas y salidas de efectivo fuera de ventas: sangrías, refuerzos y retiro final. '
  'Todos afectan el monto_calculado al cerrar el turno (arqueo).';

-- ============================================================
-- 2. COLUMNAS NUEVAS
-- ============================================================

-- PIN de supervisor para autorizar descuentos grandes y anulaciones.
-- Se guarda en la empresa (no por usuario) porque es un PIN compartido
-- que el supervisor le da al cajero en el momento. En producción
-- reemplazar por bcrypt hash; por ahora texto plano con PIN numérico.
-- NULL = función deshabilitada (overrides no requieren PIN).
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS supervisor_pin TEXT DEFAULT NULL;

COMMENT ON COLUMN empresas.supervisor_pin IS
  'PIN numérico 4-8 dígitos para autorizaciones en el POS (descuentos grandes, anulaciones). '
  'NULL = función deshabilitada. TODO: migrar a bcrypt hash antes de producción masiva.';

-- Umbral (%) a partir del cual se requiere PIN de supervisor por descuento.
-- Valor por defecto 15 % (configurable por cajero/vendedor).
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS supervisor_umbral_descuento_pct INT DEFAULT 15;

COMMENT ON COLUMN usuarios.supervisor_umbral_descuento_pct IS
  'Descuento % a partir del cual se solicita PIN de supervisor en el POS.';

-- Descuento global aplicado a la venta completa (ítem 12).
-- Se guarda como porcentaje; el monto se puede derivar de total + subtotal.
ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS descuento_global_pct NUMERIC(5,2) DEFAULT 0;

COMMENT ON COLUMN ventas_pos.descuento_global_pct IS
  'Porcentaje de descuento aplicado a la venta completa (sobre el subtotal + IVA), '
  'independiente de los descuentos por línea de ítem.';

-- ============================================================
-- 3. RLS — nuevas tablas
-- ============================================================

ALTER TABLE pos_favoritos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_caja ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_role_all_pos_favoritos ON pos_favoritos
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY service_role_all_movimientos_caja ON movimientos_caja
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- 4. RPC: resumen_turno_caja()
--    NUEVA — ya era llamada en el handler de producción pero
--    nunca existió: causa un 500 garantizado al abrir el modal
--    "Cerrar caja". Se crea acá.
--
--    Devuelve el estado del turno SIN cerrarlo: totales por
--    medio de pago, lista de movimientos de caja y el monto
--    calculado (efectivo esperado en caja).
-- ============================================================

CREATE OR REPLACE FUNCTION public.resumen_turno_caja(
  p_turno_id UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno             RECORD;
  v_por_medio         JSON;
  v_movs              JSON;
  v_efectivo_ventas   NUMERIC;
  v_neto_movimientos  NUMERIC;
  v_monto_calculado   NUMERIC;
BEGIN
  SELECT tc.monto_inicial, tc.estado
    INTO v_turno
    FROM turnos_caja tc
   WHERE tc.id = p_turno_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Turno no encontrado');
  END IF;

  -- Totales por medio de pago (ventas completadas solamente)
  SELECT COALESCE(json_object_agg(medio, total_medio ORDER BY medio), '{}'::JSON)
    INTO v_por_medio
    FROM (
      SELECT vpp.medio, SUM(vpp.monto) AS total_medio
        FROM venta_pos_pagos vpp
        JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
       WHERE vp.turno_id = p_turno_id
         AND vp.estado   = 'completada'
       GROUP BY vpp.medio
    ) t;

  -- Movimientos de caja del turno
  SELECT COALESCE(json_agg(
    json_build_object(
      'tipo',      tipo,
      'concepto',  concepto,
      'monto',     monto
    ) ORDER BY created_at
  ), '[]'::JSON)
    INTO v_movs
    FROM movimientos_caja
   WHERE turno_id = p_turno_id;

  -- Efectivo de ventas
  SELECT COALESCE(SUM(vpp.monto), 0)
    INTO v_efectivo_ventas
    FROM venta_pos_pagos vpp
    JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
   WHERE vp.turno_id = p_turno_id
     AND vpp.medio    = 'efectivo'
     AND vp.estado    = 'completada';

  -- Neto movimientos de caja:
  --   refuerzo  → suma (ingresa efectivo)
  --   sangria   → resta (sale efectivo)
  --   retiro_final → resta (sale efectivo)
  SELECT COALESCE(SUM(
    CASE WHEN tipo = 'refuerzo' THEN monto ELSE -monto END
  ), 0)
    INTO v_neto_movimientos
    FROM movimientos_caja
   WHERE turno_id = p_turno_id;

  v_monto_calculado := v_turno.monto_inicial + v_efectivo_ventas + v_neto_movimientos;

  RETURN json_build_object(
    'ok',               true,
    'monto_inicial',    v_turno.monto_inicial,
    'por_medio',        v_por_medio,
    'movimientos_caja', v_movs,
    'monto_calculado',  v_monto_calculado
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.resumen_turno_caja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resumen_turno_caja TO service_role;

COMMENT ON FUNCTION public.resumen_turno_caja IS
  'Resumen de caja sin cerrar el turno. Incluye totales por medio de pago, '
  'movimientos de caja (sangrías/refuerzos) y el monto calculado de efectivo '
  'esperado en caja.';

-- ============================================================
-- 5. RPC: cerrar_turno_caja()
--    ACTUALIZADO — la versión anterior ignoraba los movimientos
--    de caja (sangrías/refuerzos) al calcular monto_calculado.
--    Ahora el arqueo es correcto:
--      monto_inicial + cobros_efectivo + neto_movimientos_caja
-- ============================================================

CREATE OR REPLACE FUNCTION public.cerrar_turno_caja(
  p_turno_id              UUID,
  p_monto_final_declarado NUMERIC
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_turno             RECORD;
  v_total_efectivo    NUMERIC;
  v_neto_movimientos  NUMERIC;
  v_monto_calculado   NUMERIC;
BEGIN
  SELECT * INTO v_turno FROM turnos_caja WHERE id = p_turno_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_no_encontrado',
      'error', 'Turno no encontrado');
  END IF;

  IF v_turno.estado = 'cerrado' THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_ya_cerrado',
      'error', 'El turno ya fue cerrado');
  END IF;

  -- Efectivo de ventas del turno
  SELECT COALESCE(SUM(vpp.monto), 0) INTO v_total_efectivo
    FROM venta_pos_pagos vpp
    JOIN ventas_pos vp ON vp.id = vpp.venta_pos_id
   WHERE vp.turno_id = p_turno_id
     AND vpp.medio   = 'efectivo'
     AND vp.estado   = 'completada';

  -- Neto de movimientos de caja
  SELECT COALESCE(SUM(
    CASE WHEN tipo = 'refuerzo' THEN monto ELSE -monto END
  ), 0) INTO v_neto_movimientos
    FROM movimientos_caja
   WHERE turno_id = p_turno_id;

  v_monto_calculado := v_turno.monto_inicial + v_total_efectivo + v_neto_movimientos;

  UPDATE turnos_caja
     SET estado                = 'cerrado',
         monto_final_declarado = p_monto_final_declarado,
         monto_final_calculado = v_monto_calculado,
         diferencia            = p_monto_final_declarado - v_monto_calculado,
         cerrado_at            = NOW()
   WHERE id = p_turno_id;

  RETURN json_build_object(
    'ok',               true,
    'monto_calculado',  v_monto_calculado,
    'monto_declarado',  p_monto_final_declarado,
    'diferencia',       p_monto_final_declarado - v_monto_calculado
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_turno_caja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cerrar_turno_caja TO service_role;

COMMENT ON FUNCTION public.cerrar_turno_caja IS
  'Cierra el turno con arqueo automático. '
  'monto_calculado = monto_inicial + cobros_efectivo + neto_movimientos_caja. '
  'v2: ahora incluye sangrías/refuerzos/retiros en el cálculo.';

-- ============================================================
-- 6. RPC: registrar_venta_pos()
--    ACTUALIZADO — agrega p_descuento_global_pct (DEFAULT 0
--    para compatibilidad con llamadas existentes) y lo guarda
--    en ventas_pos.descuento_global_pct.
-- ============================================================

CREATE OR REPLACE FUNCTION public.registrar_venta_pos(
  p_empresa_id            UUID,
  p_caja_id               UUID,
  p_turno_id              UUID,
  p_vendedor_id           UUID,
  p_cliente_id            UUID,
  p_deposito_id           UUID,
  p_items                 JSONB,
  p_pagos                 JSONB,
  p_subtotal              NUMERIC,
  p_iva_total             NUMERIC,
  p_total                 NUMERIC,
  p_descuento_global_pct  NUMERIC DEFAULT 0   -- NUEVO (backward-compatible)
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_venta_id      UUID;
  v_numero        TEXT;
  v_item          JSONB;
  v_pago          JSONB;
  v_producto_id   UUID;
  v_cantidad      NUMERIC;
  v_disponible    NUMERIC;
  v_suma_pagos    NUMERIC := 0;
  v_limite        NUMERIC;
  v_saldo_actual  NUMERIC;
  v_monto_cta_cte NUMERIC := 0;
BEGIN
  -- 1. La suma de los pagos tiene que coincidir con el total
  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_suma_pagos
    FROM jsonb_array_elements(p_pagos) p;

  IF ABS(v_suma_pagos - p_total) > 0.01 THEN
    RETURN json_build_object('ok', false, 'tipo', 'pagos_no_coinciden',
      'error', 'La suma de los pagos no coincide con el total de la venta');
  END IF;

  -- 2. Turno abierto
  IF NOT EXISTS (
    SELECT 1 FROM turnos_caja
     WHERE id = p_turno_id AND caja_id = p_caja_id AND estado = 'abierto'
  ) THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_cerrado',
      'error', 'No hay un turno abierto para esta caja');
  END IF;

  -- 3. Límite de crédito si hay pago a cuenta corriente
  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_monto_cta_cte
    FROM jsonb_array_elements(p_pagos) p WHERE p->>'medio' = 'cuenta_corriente';

  IF v_monto_cta_cte > 0 THEN
    IF p_cliente_id IS NULL THEN
      RETURN json_build_object('ok', false, 'tipo', 'cliente_requerido',
        'error', 'No se puede imputar a cuenta corriente sin un cliente seleccionado');
    END IF;

    SELECT limite_credito INTO v_limite FROM clientes WHERE id = p_cliente_id;

    IF v_limite > 0 THEN
      SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0)
        INTO v_saldo_actual
        FROM cta_cte WHERE cliente_id = p_cliente_id;

      IF v_saldo_actual + v_monto_cta_cte > v_limite THEN
        RETURN json_build_object('ok', false, 'tipo', 'limite_credito',
          'error', 'Supera el límite de crédito del cliente');
      END IF;
    END IF;
  END IF;

  -- 4. Cabecera (ahora incluye descuento_global_pct)
  SELECT 'POS-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
         LPAD(nextval('seq_ventas_pos')::TEXT, 5, '0')
    INTO v_numero;

  INSERT INTO ventas_pos (
    empresa_id, caja_id, turno_id, cliente_id, vendedor_id, numero,
    subtotal, iva_total, total, estado, descuento_global_pct
  ) VALUES (
    p_empresa_id, p_caja_id, p_turno_id, p_cliente_id, p_vendedor_id, v_numero,
    ROUND(p_subtotal, 2), ROUND(p_iva_total, 2), ROUND(p_total, 2),
    'completada',
    COALESCE(p_descuento_global_pct, 0)
  ) RETURNING id INTO v_venta_id;

  -- 5. Ítems + descuento de stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_producto_id := (v_item->>'producto_id')::UUID;
    v_cantidad    := (v_item->>'cantidad')::NUMERIC;

    INSERT INTO venta_pos_items (
      venta_pos_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_venta_id, v_producto_id, v_cantidad,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      ROUND((v_item->>'subtotal')::NUMERIC, 2)
    );

    SELECT cantidad INTO v_disponible
      FROM stock
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id
       FOR UPDATE;

    IF NOT FOUND OR v_disponible < v_cantidad THEN
      RAISE EXCEPTION 'stock_insuficiente:% disponible:%',
        v_producto_id::TEXT, COALESCE(v_disponible, 0)::TEXT;
    END IF;

    UPDATE stock
       SET cantidad            = cantidad - v_cantidad,
           cantidad_disponible = cantidad_disponible - v_cantidad,
           updated_at          = NOW()
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id;

    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_producto_id, p_deposito_id, 'egreso', v_cantidad,
       v_venta_id, 'Venta POS ' || v_numero, p_vendedor_id);
  END LOOP;

  -- 6. Pagos
  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO venta_pos_pagos (venta_pos_id, medio, monto, referencia)
    VALUES (v_venta_id, v_pago->>'medio', (v_pago->>'monto')::NUMERIC, v_pago->>'referencia');
  END LOOP;

  -- 7. Débito en cta_cte si corresponde
  IF v_monto_cta_cte > 0 THEN
    INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (p_empresa_id, p_cliente_id, 'debito', v_monto_cta_cte,
            'Venta POS ' || v_numero, NOW());
  END IF;

  RETURN json_build_object(
    'ok',       true,
    'venta_id', v_venta_id,
    'numero',   v_numero,
    'total',    p_total
  );

EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'stock_insuficiente:%' THEN
      RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente', 'error', SQLERRM);
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_venta_pos FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_venta_pos TO service_role;

COMMENT ON FUNCTION public.registrar_venta_pos IS
  'Venta mostrador: crea ventas_pos + items + pagos, descuenta stock REAL. '
  'v2: acepta p_descuento_global_pct y lo guarda en ventas_pos.descuento_global_pct. '
  'Parámetro con DEFAULT 0 → 100% backward-compatible con llamadas anteriores.';

COMMIT;

-- ============================================================
-- NOTA POST-DEPLOY
-- 1. Configurar el PIN de supervisor para cada empresa:
--      UPDATE empresas SET supervisor_pin = '1234'
--      WHERE id = '<empresa_id>';
--    Con supervisor_pin = NULL, los descuentos grandes y las
--    anulaciones quedan bloqueadas para cajeros (sin rol admin).
--
-- 2. El umbral por defecto es 15%. Para cambiarlo por usuario:
--      UPDATE usuarios SET supervisor_umbral_descuento_pct = 20
--      WHERE id = '<usuario_id>';
-- ============================================================
