-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 162: precios especiales por cliente (precios_clientes) como
-- entidad del wizard
--
-- RECONSTRUIDO el 30/06 a partir del estado vivo de producción
-- (jgiquzjwoedmzwqgzubr) — ver nota de la migración 160.
--
-- Reglas de diseño (igual que cta_cte): cliente y producto deben EXISTIR ya
-- (se resuelven por CUIT/código en el mapeo, no se autocrean). 1 fila =
-- 1 override de precio cliente+producto. Usa el UNIQUE (cliente_id,
-- producto_id) ya existente en la tabla precios_clientes para hacer
-- upsert: si el par ya existe, actualiza el precio; si no, lo crea.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_sesiones DROP CONSTRAINT IF EXISTS migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY['clientes'::text, 'productos'::text, 'pedidos'::text, 'cta_cte'::text, 'precios_clientes'::text]));

CREATE OR REPLACE FUNCTION public.migracion_confirmar_precios_cliente_lote(
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
  v_fila         RECORD;
  v_d            JSONB;
  v_cliente_id   UUID;
  v_producto_id  UUID;
  v_precio       NUMERIC;
  v_id_final     UUID;
  v_existe       BOOLEAN;
  v_creados      INT := 0;
  v_actualizados INT := 0;
  v_errores      JSONB := '[]'::jsonb;
  v_procesadas   INT := 0;
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
      v_cliente_id  := (v_d->>'cliente_id_resuelto')::UUID;
      v_producto_id := (v_d->>'producto_id_resuelto')::UUID;
      v_precio      := (v_d->>'precio')::NUMERIC;

      IF v_cliente_id IS NULL THEN RAISE EXCEPTION 'Cliente no resuelto'; END IF;
      IF v_producto_id IS NULL THEN RAISE EXCEPTION 'Producto no resuelto'; END IF;
      IF v_precio IS NULL OR v_precio < 0 THEN RAISE EXCEPTION 'Precio inválido'; END IF;

      SELECT EXISTS(
        SELECT 1 FROM precios_clientes
         WHERE cliente_id = v_cliente_id AND producto_id = v_producto_id
      ) INTO v_existe;

      INSERT INTO precios_clientes (empresa_id, cliente_id, producto_id, precio, notas)
      VALUES (p_empresa_id, v_cliente_id, v_producto_id, v_precio, NULLIF(TRIM(v_d->>'notas'), ''))
      ON CONFLICT (cliente_id, producto_id) DO UPDATE
        SET precio = EXCLUDED.precio, notas = EXCLUDED.notas, updated_at = now()
      RETURNING id INTO v_id_final;

      IF v_existe THEN v_actualizados := v_actualizados + 1;
      ELSE v_creados := v_creados + 1;
      END IF;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_id_final
       WHERE id = v_fila.id;
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
    'actualizados', v_actualizados,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;
