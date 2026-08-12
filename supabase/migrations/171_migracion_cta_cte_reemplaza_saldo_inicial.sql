-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 171: cta_cte migrada reemplaza saldo_inicial
--
-- HOUSEKEEPING (30/06/2026): este archivo se reconstruyó a partir de la
-- definición real vigente en producción (jgiquzjwoedmzwqgzubr), NO se volvió
-- a aplicar. Se detectó que esta migración ya estaba viva en la base pero
-- faltaba en el repo/zip que se estaba usando en esa sesión (probablemente
-- aplicada directo contra la base en otra sesión y nunca commiteada). Ver
-- CHANGELOG_v182_housekeeping_migraciones.md para el precedente de este tipo
-- de reconstrucción.
--
-- Decisión de producto (responde la pregunta abierta en la sección 4 del
-- análisis de migraciones sobre doble conteo entre saldo_inicial y cta_cte
-- histórica): cuando se migra el histórico de cuenta corriente de un
-- cliente (migración 160/161), el saldo resultante de la cadena de
-- movimientos migrados REEMPLAZA a `clientes.saldo_cuenta_corriente` — no
-- se suma. Esto evita que un cliente que ya tenía saldo_inicial cargado
-- (desde la migración de clientes) termine con saldo duplicado si después
-- se migra también su cta_cte histórica.
--
-- Implementación: dentro de migracion_confirmar_cta_cte_lote, cada movimiento
-- migrado actualiza clientes.saldo_cuenta_corriente al v_saldo_nuevo que
-- acaba de calcular. Como las filas de un mismo cliente se procesan en
-- orden cronológico (ORDER BY cliente_id_resuelto, fecha_iso), el ÚLTIMO
-- UPDATE que corre para ese cliente — el de su movimiento más reciente — es
-- el que queda, y coincide exactamente con el saldo final de la cadena
-- migrada.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.migracion_confirmar_cta_cte_lote(
  p_sesion_id   UUID,
  p_empresa_id  UUID,
  p_usuario_id  UUID DEFAULT NULL,
  p_lote_size   INT  DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila           RECORD;
  v_d              JSONB;
  v_cliente_id     UUID;
  v_tipo           TEXT;
  v_monto          NUMERIC;
  v_fecha          TIMESTAMPTZ;
  v_saldo_anterior NUMERIC;
  v_saldo_nuevo    NUMERIC;
  v_creados        INT := 0;
  v_errores        JSONB := '[]'::jsonb;
  v_procesadas     INT := 0;
BEGIN
  FOR v_fila IN
    SELECT id, fila_numero, datos_mapeados
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     ORDER BY (datos_mapeados->>'cliente_id_resuelto'), (datos_mapeados->>'fecha_iso')
     LIMIT p_lote_size
       FOR UPDATE SKIP LOCKED
  LOOP
    v_procesadas := v_procesadas + 1;
    v_d := COALESCE(v_fila.datos_mapeados, '{}'::jsonb);

    BEGIN
      v_cliente_id := (v_d->>'cliente_id_resuelto')::UUID;
      v_tipo       := v_d->>'tipo_resuelto';
      v_monto      := (v_d->>'monto_resuelto')::NUMERIC;
      v_fecha      := (v_d->>'fecha_iso')::DATE;

      IF v_cliente_id IS NULL THEN
        RAISE EXCEPTION 'Cliente no resuelto';
      END IF;

      SELECT saldo INTO v_saldo_anterior
        FROM cta_cte
       WHERE cliente_id = v_cliente_id
       ORDER BY fecha DESC
       LIMIT 1;
      v_saldo_anterior := COALESCE(v_saldo_anterior, 0);

      v_saldo_nuevo := v_saldo_anterior +
        CASE WHEN v_tipo IN ('factura', 'debito', 'cargo') THEN v_monto ELSE -v_monto END;

      INSERT INTO cta_cte (
        empresa_id, cliente_id, tipo, monto, importe, saldo,
        nro_comprobante, descripcion, fecha
      ) VALUES (
        p_empresa_id, v_cliente_id, v_tipo, v_monto, v_monto, v_saldo_nuevo,
        NULLIF(TRIM(v_d->>'numero_comprobante'), ''),
        NULLIF(TRIM(v_d->>'descripcion'), ''),
        v_fecha
      );

      -- Migración 171: cta_cte migrada reemplaza saldo_inicial. El último
      -- UPDATE que corre para este cliente (el de su movimiento más
      -- reciente, por el ORDER BY de arriba) deja saldo_cuenta_corriente
      -- exactamente igual al resultado de la cadena migrada.
      UPDATE clientes
         SET saldo_cuenta_corriente = v_saldo_nuevo
       WHERE id = v_cliente_id
         AND empresa_id = p_empresa_id;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_cliente_id
       WHERE id = v_fila.id;

      v_creados := v_creados + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows
         SET procesado_en = now(), error_ejecucion = SQLERRM
       WHERE id = v_fila.id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'creados', v_creados,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;
