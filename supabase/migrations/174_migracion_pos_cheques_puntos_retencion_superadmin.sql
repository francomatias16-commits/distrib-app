-- 174_migracion_pos_cheques_puntos_retencion_superadmin.sql
-- Cierre del plan P2 (puntos 10-14), salvo notas de crédito/débito históricas
-- (ver nota abajo — bloqueado por la misma definición de producto pendiente
-- que Gap crítico 1 / punto 6, porque notas_credito solo admite comprobantes
-- fiscales reales con CAE, no hay tabla de "notas de débito" hoy, y crear una
-- ND/NC histórica sin CAE en esa tabla generaría un comprobante fiscalmente
-- inválido).

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Entidades nuevas del wizard: cheques, puntos_fidelizacion, ventas_pos
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE migracion_sesiones DROP CONSTRAINT IF EXISTS migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY[
    'clientes','productos','pedidos','cta_cte','precios_clientes',
    'proveedores','ordenes_compra','pagos_proveedores','lotes',
    'categorias','depositos','listas_precios','zonas',
    'cheques','puntos_fidelizacion','ventas_pos'
  ]::text[]));

-- ─── Cheques históricos ────────────────────────────────────────────────
-- 1 fila = 1 cheque, sin agrupación (igual que cta_cte/pagos_proveedores).
-- Cliente es OPCIONAL (cheques.cliente_id es nullable en el schema real —
-- puede ser un cheque de terceros sin cliente asociado) pero si se informa
-- debe existir ya (nunca se autocrea, mismo criterio que cta_cte).
CREATE OR REPLACE FUNCTION public.migracion_confirmar_cheques_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila       RECORD;
  v_d          JSONB;
  v_creados    INT := 0;
  v_errores    JSONB := '[]'::jsonb;
  v_nuevo_id   UUID;
  v_procesadas INT := 0;
BEGIN
  FOR v_fila IN
    SELECT id, fila_numero, datos_mapeados
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     ORDER BY fila_numero
     LIMIT p_lote_size
       FOR UPDATE SKIP LOCKED
  LOOP
    v_procesadas := v_procesadas + 1;
    v_d := COALESCE(v_fila.datos_mapeados, '{}'::jsonb);

    BEGIN
      INSERT INTO cheques (empresa_id, cliente_id, banco, numero, monto, fecha_vto, estado, notas)
      VALUES (
        p_empresa_id,
        NULLIF(v_d->>'cliente_id_resuelto', '')::UUID,
        NULLIF(TRIM(v_d->>'banco'), ''),
        NULLIF(TRIM(v_d->>'numero'), ''),
        (v_d->>'monto')::NUMERIC,
        COALESCE((v_d->>'fecha_vto_iso')::DATE, (v_d->>'fecha_vto')::DATE),
        COALESCE(NULLIF(TRIM(v_d->>'estado'), ''), 'en_cartera'),
        NULLIF(TRIM(v_d->>'notas'), '')
      )
      RETURNING id INTO v_nuevo_id;

      v_creados := v_creados + 1;
      UPDATE migracion_staging_rows SET procesado_en = now(), entidad_resultado_id = v_nuevo_id WHERE id = v_fila.id;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows SET procesado_en = now(), error_ejecucion = SQLERRM WHERE id = v_fila.id;
    END;
  END LOOP;

  RETURN jsonb_build_object('procesadas', v_procesadas, 'creados', v_creados, 'errores', v_errores, 'hay_mas', v_procesadas >= p_lote_size);
END;
$function$;

-- ─── Puntos de fidelización históricos ─────────────────────────────────
-- Reimplementa (no reutiliza) la lógica de registrar_movimiento_puntos()
-- porque esa función siempre usa NOW() para el movimiento y acá necesitamos
-- respetar la fecha histórica real del archivo — se evita tocar la función
-- compartida con el flujo de pedidos en vivo para no arriesgar ese camino.
-- Cliente debe existir ya (se resuelve por CUIT, nunca se autocrea).
CREATE OR REPLACE FUNCTION public.migracion_confirmar_puntos_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila       RECORD;
  v_d          JSONB;
  v_creados    INT := 0;
  v_errores    JSONB := '[]'::jsonb;
  v_nuevo_id   UUID;
  v_procesadas INT := 0;
  v_cliente_id UUID;
  v_tipo       TEXT;
  v_cantidad   NUMERIC;
  v_fecha      TIMESTAMPTZ;
BEGIN
  FOR v_fila IN
    SELECT id, fila_numero, datos_mapeados
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     ORDER BY fila_numero
     LIMIT p_lote_size
       FOR UPDATE SKIP LOCKED
  LOOP
    v_procesadas := v_procesadas + 1;
    v_d := COALESCE(v_fila.datos_mapeados, '{}'::jsonb);

    BEGIN
      v_cliente_id := NULLIF(v_d->>'cliente_id_resuelto', '')::UUID;
      IF v_cliente_id IS NULL THEN
        RAISE EXCEPTION 'Cliente no resuelto (CUIT no encontrado)';
      END IF;

      v_tipo     := COALESCE(v_d->>'tipo_resuelto', 'ganancia');
      v_cantidad := (v_d->>'cantidad')::NUMERIC;
      v_fecha    := COALESCE((v_d->>'fecha_iso')::TIMESTAMPTZ, now());

      INSERT INTO movimientos_puntos (cliente_id, empresa_id, tipo, cantidad, motivo, created_at)
      VALUES (v_cliente_id, p_empresa_id, v_tipo, v_cantidad, NULLIF(TRIM(v_d->>'motivo'), ''), v_fecha)
      RETURNING id INTO v_nuevo_id;

      -- Asegura que exista la fila de saldo antes de actualizarla (a
      -- diferencia de registrar_movimiento_puntos, que asume que ya existe).
      INSERT INTO saldo_puntos (cliente_id, empresa_id, puntos_disponibles, puntos_canjeados, puntos_totales)
      VALUES (v_cliente_id, p_empresa_id, 0, 0, 0)
      ON CONFLICT (cliente_id, empresa_id) DO NOTHING;

      UPDATE saldo_puntos SET
        puntos_disponibles = CASE WHEN v_tipo = 'ganancia' THEN puntos_disponibles + v_cantidad WHEN v_tipo = 'canje' THEN puntos_disponibles - v_cantidad ELSE puntos_disponibles END,
        puntos_canjeados   = CASE WHEN v_tipo = 'canje' THEN puntos_canjeados + v_cantidad ELSE puntos_canjeados END,
        puntos_totales     = puntos_totales + CASE WHEN v_tipo = 'ganancia' THEN v_cantidad WHEN v_tipo = 'canje' THEN -v_cantidad ELSE 0 END,
        ultimo_movimiento  = v_fecha
      WHERE cliente_id = v_cliente_id AND empresa_id = p_empresa_id;

      v_creados := v_creados + 1;
      UPDATE migracion_staging_rows SET procesado_en = now(), entidad_resultado_id = v_nuevo_id WHERE id = v_fila.id;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows SET procesado_en = now(), error_ejecucion = SQLERRM WHERE id = v_fila.id;
    END;
  END LOOP;

  RETURN jsonb_build_object('procesadas', v_procesadas, 'creados', v_creados, 'errores', v_errores, 'hay_mas', v_procesadas >= p_lote_size);
END;
$function$;

-- ─── Ventas POS históricas ──────────────────────────────────────────────
-- Mismo patrón cabecera+items que migracion_confirmar_ordenes_compra_lote,
-- agrupando por numero_venta (+ cliente, que puede ser NULL a diferencia de
-- proveedor en OC). Son ventas ya cerradas: no tocan caja/turno en vivo
-- (caja_id/turno_id/vendedor_id quedan NULL) ni generan factura real
-- (factura_id NULL) — son registros de solo lectura para reportes de
-- rentabilidad histórica, como aclara el punto 14 del plan.
CREATE OR REPLACE FUNCTION public.migracion_confirmar_ventas_pos_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_grupo      RECORD;
  v_venta_id   UUID;
  v_creados    INT := 0;
  v_errores    JSONB := '[]'::jsonb;
  v_procesadas INT := 0;
BEGIN
  FOR v_grupo IN
    SELECT datos_mapeados->>'numero_venta' AS numero_venta,
           NULLIF(datos_mapeados->>'cliente_id_resuelto', '')::UUID AS cliente_id,
           MIN(COALESCE(NULLIF(datos_mapeados->>'estado', ''), 'completada')) AS estado_raw,
           MIN(datos_mapeados->>'fecha_iso') AS fecha_raw,
           MIN(fila_numero) AS primera_fila
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     GROUP BY 1, 2
     ORDER BY MIN(fila_numero)
     LIMIT p_lote_size
  LOOP
    v_procesadas := v_procesadas + 1;

    BEGIN
      INSERT INTO ventas_pos (empresa_id, cliente_id, numero, estado, created_at)
      VALUES (
        p_empresa_id, v_grupo.cliente_id,
        'MIG-' || COALESCE(v_grupo.numero_venta, v_grupo.primera_fila::text),
        COALESCE(v_grupo.estado_raw, 'completada'),
        COALESCE(v_grupo.fecha_raw::timestamptz, now())
      )
      RETURNING id INTO v_venta_id;

      INSERT INTO venta_pos_items (venta_pos_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal)
      SELECT
        v_venta_id,
        (msr.datos_mapeados->>'producto_id_resuelto')::UUID,
        (msr.datos_mapeados->>'cantidad')::NUMERIC,
        (msr.datos_mapeados->>'precio_unitario')::NUMERIC,
        COALESCE(NULLIF(msr.datos_mapeados->>'descuento_pct', '')::NUMERIC, 0),
        (msr.datos_mapeados->>'cantidad')::NUMERIC * (msr.datos_mapeados->>'precio_unitario')::NUMERIC
          * (1 - COALESCE(NULLIF(msr.datos_mapeados->>'descuento_pct', '')::NUMERIC, 0) / 100)
      FROM migracion_staging_rows msr
      WHERE msr.sesion_id = p_sesion_id
        AND msr.es_valida = true AND msr.accion <> 'omitir' AND msr.procesado_en IS NULL
        AND msr.datos_mapeados->>'numero_venta' IS NOT DISTINCT FROM v_grupo.numero_venta
        AND NULLIF(msr.datos_mapeados->>'cliente_id_resuelto', '')::UUID IS NOT DISTINCT FROM v_grupo.cliente_id;

      UPDATE ventas_pos SET
        subtotal  = (SELECT COALESCE(SUM(subtotal), 0) FROM venta_pos_items WHERE venta_pos_id = v_venta_id),
        iva_total = (SELECT COALESCE(SUM(vpi.subtotal * COALESCE(p.iva, 21) / 100), 0)
                       FROM venta_pos_items vpi JOIN productos p ON p.id = vpi.producto_id
                      WHERE vpi.venta_pos_id = v_venta_id),
        total     = (SELECT COALESCE(SUM(vpi.subtotal * (1 + COALESCE(p.iva, 21) / 100)), 0)
                       FROM venta_pos_items vpi JOIN productos p ON p.id = vpi.producto_id
                      WHERE vpi.venta_pos_id = v_venta_id)
      WHERE id = v_venta_id;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_venta_id
       WHERE sesion_id = p_sesion_id
         AND datos_mapeados->>'numero_venta' IS NOT DISTINCT FROM v_grupo.numero_venta
         AND NULLIF(datos_mapeados->>'cliente_id_resuelto', '')::UUID IS NOT DISTINCT FROM v_grupo.cliente_id
         AND procesado_en IS NULL;

      v_creados := v_creados + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('numero_venta', v_grupo.numero_venta, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows
         SET procesado_en = now(), error_ejecucion = SQLERRM
       WHERE sesion_id = p_sesion_id
         AND datos_mapeados->>'numero_venta' IS NOT DISTINCT FROM v_grupo.numero_venta
         AND NULLIF(datos_mapeados->>'cliente_id_resuelto', '')::UUID IS NOT DISTINCT FROM v_grupo.cliente_id
         AND procesado_en IS NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object('procesadas', v_procesadas, 'ventas_creadas', v_creados, 'errores', v_errores, 'hay_mas', v_procesadas >= p_lote_size);
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Punto 14 del plan: retención de migracion_staging_rows
-- ═══════════════════════════════════════════════════════════════════════
-- Purga las filas de staging (datos_originales/datos_mapeados en JSONB,
-- lo pesado) de sesiones YA cerradas (completado/deshecho/cancelado) hace
-- más de 180 días. migracion_sesiones (con sus contadores agregados) NO se
-- toca — queda el registro de auditoría, solo se libera el detalle fila por
-- fila que ya no tiene utilidad práctica pasado ese tiempo.
CREATE OR REPLACE FUNCTION public.migracion_purgar_staging_antiguo()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_borradas INT;
BEGIN
  DELETE FROM migracion_staging_rows msr
  USING migracion_sesiones ms
  WHERE msr.sesion_id = ms.id
    AND ms.estado IN ('completado', 'deshecho', 'cancelado')
    AND ms.created_at < now() - interval '180 days';

  GET DIAGNOSTICS v_borradas = ROW_COUNT;
  RETURN v_borradas;
END;
$function$;

SELECT cron.schedule(
  'migracion_purgar_staging_semanal',
  '0 4 * * 0',  -- domingos 04:00
  'SELECT public.migracion_purgar_staging_antiguo()'
);

-- ═══════════════════════════════════════════════════════════════════════
-- 3) Punto 12 del plan: panel de superadmin — migraciones en curso/falladas
-- ═══════════════════════════════════════════════════════════════════════
-- NOTA: la versión de esta función aplicada originalmente en esta migración
-- 174 quedó SIN chequeo de autorización interno — bug de seguridad real
-- (cualquier autenticado, o anónimo, podía leer sesiones de migración de
-- TODAS las empresas vía sb.rpc directo). Corregido en la migración 175 —
-- ver ese archivo, que agrega el guard is_saas_owner(). Se deja esta
-- definición tal cual se aplicó originalmente por prolijidad histórica del
-- changelog; 175 la reemplaza con CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.migracion_superadmin_resumen()
RETURNS TABLE (
  empresa_id      UUID,
  empresa_nombre  TEXT,
  sesion_id       UUID,
  entidad         TEXT,
  estado          TEXT,
  total_filas     INT,
  filas_validas   INT,
  filas_con_error INT,
  created_at      TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT ms.empresa_id, e.nombre, ms.id, ms.entidad, ms.estado,
         ms.total_filas, ms.filas_validas, ms.filas_con_error, ms.created_at
    FROM migracion_sesiones ms
    JOIN empresas e ON e.id = ms.empresa_id
   WHERE ms.estado IN ('error', 'confirmando', 'mapeado', 'validado', 'subido')
      OR ms.created_at > now() - interval '14 days'
   ORDER BY
     CASE WHEN ms.estado = 'error' THEN 0 ELSE 1 END,
     ms.created_at DESC
   LIMIT 300;
$function$;
