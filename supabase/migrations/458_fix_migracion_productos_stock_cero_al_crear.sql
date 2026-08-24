-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 458: fix — productos importados sin columna "stock" quedaban sin
-- ninguna fila en la tabla `stock` (ni siquiera en 0).
--
-- Bug reportado: se migran productos SIN datos de stock en el archivo → se
-- crean bien en `productos` (aparecen en la página de Productos) pero no
-- aparecen en Stock.html ni en "Reposición sugerida" / alertas de stock
-- crítico. Causa: fn_stock_lista_agrupada (y el resto de las consultas de
-- stock) hacen JOIN contra `stock`, no LEFT JOIN — un producto sin ninguna
-- fila en `stock` es invisible para esas pantallas, no "aparece con 0".
--
-- migracion_confirmar_productos_lote (desde la 158) solo llamaba a
-- migracion_alta_stock() cuando la fila traía v_stock IS NOT NULL, es decir,
-- cuando el archivo tenía la columna "stock" mapeada y con valor. Si no,
-- nunca se tocaba `stock` en absoluto.
--
-- Esto es inconsistente con el alta manual (fn_crear_producto, migración
-- 351/441), que SIEMPRE inserta una fila en `stock` con cantidad = 0 para
-- cada depósito elegido, sin importar si se cargó un stock inicial o no.
--
-- Fix: al CREAR un producto nuevo por migración (accion <> 'actualizar'),
-- se asegura la fila de stock en el depósito resuelto (por fila o el de la
-- sesión) con cantidad = COALESCE(v_stock, 0) — igual criterio que el alta
-- manual. Para 'actualizar' se mantiene el comportamiento anterior: si la
-- fila no trae stock, no se toca (no queremos pisar el stock real de un
-- producto existente solo porque esa columna no vino mapeada).
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

      -- Fix migración 458: al CREAR un producto (no al actualizar uno
      -- existente) siempre se asegura su fila de stock, aunque el archivo
      -- no traiga columna "stock" — igual criterio que fn_crear_producto
      -- (alta manual), que siempre deja el producto con 0 en el depósito
      -- elegido en vez de dejarlo sin ninguna fila en `stock`.
      IF COALESCE(v_deposito_fila, p_deposito_id) IS NOT NULL
         AND (v_stock IS NOT NULL OR v_fila.accion <> 'actualizar') THEN
        SELECT migracion_alta_stock(v_producto_id, COALESCE(v_deposito_fila, p_deposito_id), p_empresa_id, COALESCE(v_stock, 0), p_sesion_id, p_usuario_id)
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

COMMENT ON FUNCTION public.migracion_confirmar_productos_lote(uuid, uuid, uuid, uuid, uuid, int) IS
  'v458: fix — al crear un producto por migración siempre se le asegura una fila en stock (0 si el archivo no trae la columna), igual que el alta manual (fn_crear_producto). Antes, un producto migrado sin columna "stock" quedaba sin fila en stock y era invisible en Stock.html y en las alertas de reposición/crítico, aunque existiera en Productos.';
