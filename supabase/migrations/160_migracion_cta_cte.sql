-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 160: cta_cte (histórico de cuenta corriente) como entidad del wizard
--
-- RECONSTRUIDO el 30/06 a partir del estado vivo de producción
-- (jgiquzjwoedmzwqgzubr). Esta función ya corría en producción pero el
-- archivo .sql nunca había quedado en supabase/migrations/ del repo — el
-- handler (lib/handlers/migracion.js) tiene comentarios que referencian
-- "migración 160" desde antes de que este archivo existiera. El contenido
-- de abajo es exactamente pg_get_functiondef() de lo que está vivo hoy, no
-- una reconstrucción aproximada.
--
-- Reglas de diseño (iguales a clientes/productos/pedidos):
--  - Cliente debe EXISTIR ya en el sistema (se resuelve por CUIT en el paso
--    de mapeo, no se autocrea). cliente_id_resuelto / tipo_resuelto /
--    monto_resuelto / fecha_iso se calculan server-side en el mapeo, esta
--    función no vuelve a parsear nada.
--  - 1 fila de archivo = 1 movimiento de cta_cte (no se agrupan filas como
--    en pedidos).
--  - El saldo se recalcula en cadena: cada movimiento toma el último saldo
--    conocido del cliente y le suma/resta el monto según el tipo
--    ('factura'/'debito'/'cargo' suman, el resto resta). Esto asume que las
--    filas se procesan en orden cronológico — por eso el SELECT del lote
--    ordena por (cliente_id_resuelto, fecha_iso) y no por fila_numero.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_sesiones DROP CONSTRAINT IF EXISTS migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY['clientes'::text, 'productos'::text, 'pedidos'::text, 'cta_cte'::text]));

CREATE OR REPLACE FUNCTION public.migracion_confirmar_cta_cte_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT  DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila          RECORD;
  v_d             JSONB;
  v_cliente_id    UUID;
  v_tipo          TEXT;
  v_monto         NUMERIC;
  v_fecha         TIMESTAMPTZ;
  v_saldo_anterior NUMERIC;
  v_saldo_nuevo   NUMERIC;
  v_creados       INT := 0;
  v_errores       JSONB := '[]'::jsonb;
  v_procesadas    INT := 0;
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
