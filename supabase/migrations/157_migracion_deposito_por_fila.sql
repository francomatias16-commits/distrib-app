-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 157: depósito por fila en la migración de productos
--
-- Hasta acá (migración 156) el wizard de productos permitía elegir UN
-- depósito destino para toda la sesión. Si el archivo trae stock repartido
-- por sucursal (columna "depósito" por fila), no había forma de respetarlo:
-- todo iba al depósito elegido para la sesión completa.
--
-- Se agrega el campo opcional "deposito" al mapeo de columnas de productos.
-- Se resuelve por nombre dentro de la empresa y SE CREA si no existe (mismo
-- criterio que categoria/proveedor en la migración 154: es un catálogo de
-- soporte, no hay riesgo en autogenerarlo).
--
-- Retrocompatible: si la fila no trae depósito mapeado (o el archivo no
-- tiene esa columna), cae al p_deposito_id de la sesión — el comportamiento
-- exacto de antes de esta migración.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.migracion_resolver_deposito(p_empresa_id UUID, p_nombre TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id UUID; v_nombre TEXT := NULLIF(TRIM(p_nombre), '');
BEGIN
  IF v_nombre IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM depositos WHERE empresa_id = p_empresa_id AND lower(nombre) = lower(v_nombre) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO depositos (empresa_id, nombre, es_principal) VALUES (p_empresa_id, v_nombre, false) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END; $$;

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

      -- Migración 157: depósito por fila. Si la fila trae depósito mapeado,
      -- se resuelve (y crea si hace falta) y pisa al de la sesión solo para
      -- esta fila. Si no trae, cae al p_deposito_id de siempre.
      v_deposito_fila := migracion_resolver_deposito(p_empresa_id, v_d->>'deposito');

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

      IF v_precio IS NOT NULL AND p_lista_id IS NOT NULL THEN
        INSERT INTO precios_items (lista_id, producto_id, precio)
        VALUES (p_lista_id, v_producto_id, v_precio)
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
