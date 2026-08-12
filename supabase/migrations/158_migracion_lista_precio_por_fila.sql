-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 158: lista de precios por fila en la migración de productos
--
-- Mismo problema que el depósito (migración 157), pero con precios: si el
-- archivo trae precio mayorista Y minorista, hasta acá hacía falta correr
-- dos importaciones separadas, una por lista. Se agrega el campo opcional
-- "lista_precio" al mapeo de productos para elegir lista destino por fila.
--
-- Reutiliza migracion_resolver_lista_precio() (ya existe desde la 154, usada
-- hoy para clientes) — busca por nombre dentro de la empresa y la crea si no
-- existe. Retrocompatible: si la fila no trae lista mapeada, cae al
-- p_lista_id de la sesión, igual que antes.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.migracion_confirmar_productos_lote(
  p_sesion_id   UUID,
  p_empresa_id  UUID,
  p_deposito_id UUID,
  p_lista_id    UUID,
  p_usuario_id  UUID DEFAULT NULL,
  p_lote_size   INT  DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila         RECORD;
  v_d            JSONB;
  v_creados      INT := 0;
  v_actualizados INT := 0;
  v_errores      JSONB := '[]'::jsonb;
  v_producto_id  UUID;
  v_precio       NUMERIC;
  v_stock        NUMERIC;
  v_iva          NUMERIC;
  v_categoria_id UUID;
  v_proveedor_id UUID;
  v_deposito_fila UUID;
  v_lista_fila   UUID;
  v_es_barras    BOOLEAN;
  v_procesadas   INT := 0;
  v_rpc_stock    JSONB;
BEGIN
  FOR v_fila IN
    SELECT id, fila_numero, datos_mapeados, accion, entidad_existente_id
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
    v_producto_id := v_fila.entidad_existente_id;
    v_precio := NULLIF(TRIM(v_d->>'precio'), '')::NUMERIC;
    v_stock  := NULLIF(TRIM(v_d->>'stock'), '')::NUMERIC;
    v_iva    := NULLIF(TRIM(v_d->>'iva'), '')::NUMERIC;
    v_es_barras := lower(COALESCE(v_d->>'codigo_barras', '')) IN ('si', 'sí', 'true', '1', 'yes', 'x');

    BEGIN
      v_categoria_id := migracion_resolver_categoria(p_empresa_id, v_d->>'categoria');
      v_proveedor_id := migracion_resolver_proveedor(p_empresa_id, v_d->>'proveedor');
      v_deposito_fila := migracion_resolver_deposito(p_empresa_id, v_d->>'deposito');
      -- Migración 158: lista de precios por fila.
      v_lista_fila := migracion_resolver_lista_precio(p_empresa_id, v_d->>'lista_precio');

      IF v_fila.accion = 'actualizar' AND v_producto_id IS NOT NULL THEN
        UPDATE productos SET
          nombre               = COALESCE(NULLIF(TRIM(v_d->>'nombre'), ''), nombre),
          codigo               = COALESCE(NULLIF(TRIM(v_d->>'codigo'), ''), codigo),
          precio_base          = COALESCE(v_precio, precio_base),
          categoria_id         = COALESCE(v_categoria_id, categoria_id),
          proveedor_id_default = COALESCE(v_proveedor_id, proveedor_id_default),
          iva                  = COALESCE(v_iva, iva),
          unidad               = COALESCE(NULLIF(TRIM(v_d->>'unidad'), ''), unidad),
          codigo_es_barras     = CASE WHEN NULLIF(v_d->>'codigo_barras', '') IS NOT NULL THEN v_es_barras ELSE codigo_es_barras END
        WHERE id = v_producto_id AND empresa_id = p_empresa_id;

        v_actualizados := v_actualizados + 1;
      ELSE
        INSERT INTO productos (
          empresa_id, nombre, codigo, precio_base,
          categoria_id, proveedor_id_default, iva, unidad, codigo_es_barras
        )
        VALUES (
          p_empresa_id,
          NULLIF(TRIM(v_d->>'nombre'), ''),
          NULLIF(TRIM(v_d->>'codigo'), ''),
          COALESCE(v_precio, 0),
          v_categoria_id, v_proveedor_id, v_iva,
          NULLIF(TRIM(v_d->>'unidad'), ''),
          v_es_barras
        )
        RETURNING id INTO v_producto_id;

        v_creados := v_creados + 1;
      END IF;

      IF v_precio IS NOT NULL AND COALESCE(v_lista_fila, p_lista_id) IS NOT NULL THEN
        INSERT INTO precios_items (lista_id, producto_id, precio)
        VALUES (COALESCE(v_lista_fila, p_lista_id), v_producto_id, v_precio)
        ON CONFLICT (lista_id, producto_id) DO UPDATE SET precio = EXCLUDED.precio;
      END IF;

      IF v_stock IS NOT NULL AND COALESCE(v_deposito_fila, p_deposito_id) IS NOT NULL THEN
        SELECT migracion_alta_stock(v_producto_id, COALESCE(v_deposito_fila, p_deposito_id), p_empresa_id, v_stock, p_sesion_id, p_usuario_id)
          INTO v_rpc_stock;
        IF v_rpc_stock IS NOT NULL AND (v_rpc_stock->>'ok') = 'false' THEN
          v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', 'stock: ' || (v_rpc_stock->>'error'));
        END IF;
      END IF;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_producto_id
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
