-- 025_rpc_importar_productos.sql
-- RPC: importar_productos_lote
--
-- Recibe un lote de productos en JSONB y los upserta eficientemente dentro de la DB.
-- Al correr en Postgres no tiene límite de tiempo de Vercel ni overhead de red.
-- La API de Vercel solo autentica y delega — toda la lógica vive aquí.
--
-- Parámetros:
--   p_empresa_id      UUID   empresa del usuario autenticado
--   p_filas           JSONB  array de productos [{codigo,nombre,precio,costo,iva,unidad,categoria}]
--   p_lista_precio_id UUID   lista de precios destino (NULL = usar default)
--   p_lista_nombre    TEXT   nombre para crear lista nueva (NULL = no crear)
--   p_deposito_id     UUID   depósito para inicializar stock (NULL = usar principal)
--
-- Retorna JSONB: { ok, resumen:{nuevos,actualizados,sin_cambio,errores}, lista_precio_id, errores_detalle[] }

CREATE OR REPLACE FUNCTION importar_productos_lote(
  p_empresa_id      UUID,
  p_filas           JSONB,
  p_lista_precio_id UUID    DEFAULT NULL,
  p_lista_nombre    TEXT    DEFAULT NULL,
  p_deposito_id     UUID    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lista_id    UUID := p_lista_precio_id;
  v_deposito_id UUID := p_deposito_id;
  v_fila        JSONB;
  v_nombre      TEXT;
  v_codigo      TEXT;
  v_precio      NUMERIC;
  v_costo       NUMERIC;
  v_iva         NUMERIC;
  v_unidad      TEXT;
  v_categoria   TEXT;
  v_cat_id      UUID;
  v_prod_id     UUID;
  v_precio_act  NUMERIC;
  v_nuevos      INT := 0;
  v_actualizados INT := 0;
  v_sin_cambio  INT := 0;
  v_errores     INT := 0;
  v_err_detalle JSONB := '[]'::JSONB;
BEGIN

  -- ── 1. Resolver lista de precios ─────────────────────────────────────────
  IF v_lista_id IS NULL AND p_lista_nombre IS NOT NULL THEN
    INSERT INTO listas_precios (empresa_id, nombre, es_default, activa)
    VALUES (p_empresa_id, p_lista_nombre, FALSE, TRUE)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_lista_id;

    IF v_lista_id IS NULL THEN
      SELECT id INTO v_lista_id FROM listas_precios
      WHERE empresa_id = p_empresa_id AND nombre = p_lista_nombre LIMIT 1;
    END IF;
  END IF;

  IF v_lista_id IS NULL THEN
    SELECT id INTO v_lista_id FROM listas_precios
    WHERE empresa_id = p_empresa_id AND es_default = TRUE AND activa = TRUE
    LIMIT 1;
  END IF;

  -- ── 2. Resolver depósito principal ────────────────────────────────────────
  IF v_deposito_id IS NULL THEN
    SELECT id INTO v_deposito_id FROM depositos
    WHERE empresa_id = p_empresa_id AND es_principal = TRUE
    LIMIT 1;
  END IF;

  -- ── 3. Procesar cada fila ─────────────────────────────────────────────────
  FOR v_fila IN SELECT * FROM jsonb_array_elements(p_filas)
  LOOP
    BEGIN
      v_nombre    := TRIM(v_fila->>'nombre');
      v_codigo    := NULLIF(TRIM(v_fila->>'codigo'), '');
      v_precio    := COALESCE((v_fila->>'precio')::NUMERIC, 0);
      v_costo     := COALESCE((v_fila->>'costo')::NUMERIC,  0);
      v_iva       := COALESCE((v_fila->>'iva')::NUMERIC,    21);
      v_unidad    := COALESCE(NULLIF(TRIM(v_fila->>'unidad'), ''), 'unidad');
      v_categoria := NULLIF(TRIM(v_fila->>'categoria'), '');

      IF v_nombre IS NULL OR LENGTH(v_nombre) < 1 THEN
        v_errores := v_errores + 1;
        v_err_detalle := v_err_detalle || jsonb_build_object('codigo', v_codigo, 'error', 'Nombre vacío');
        CONTINUE;
      END IF;

      -- Resolver o crear categoría
      v_cat_id := NULL;
      IF v_categoria IS NOT NULL THEN
        SELECT id INTO v_cat_id FROM categorias
        WHERE empresa_id = p_empresa_id
          AND LOWER(TRIM(nombre)) = LOWER(v_categoria)
        LIMIT 1;

        IF v_cat_id IS NULL THEN
          INSERT INTO categorias (empresa_id, nombre, orden)
          VALUES (p_empresa_id, v_categoria, 0)
          ON CONFLICT DO NOTHING
          RETURNING id INTO v_cat_id;

          IF v_cat_id IS NULL THEN
            SELECT id INTO v_cat_id FROM categorias
            WHERE empresa_id = p_empresa_id AND LOWER(TRIM(nombre)) = LOWER(v_categoria)
            LIMIT 1;
          END IF;
        END IF;
      END IF;

      -- Buscar producto existente por código
      v_prod_id := NULL;
      IF v_codigo IS NOT NULL THEN
        SELECT id INTO v_prod_id FROM productos
        WHERE empresa_id = p_empresa_id AND codigo = v_codigo
        LIMIT 1;
      END IF;

      IF v_prod_id IS NOT NULL THEN
        -- Producto existe: verificar si cambió precio
        v_precio_act := NULL;
        IF v_lista_id IS NOT NULL THEN
          SELECT precio INTO v_precio_act FROM precios_items
          WHERE lista_id = v_lista_id AND producto_id = v_prod_id;
        END IF;

        IF v_precio_act IS NOT NULL AND ABS(v_precio_act - v_precio) < 0.01 THEN
          -- Sin cambio
          v_sin_cambio := v_sin_cambio + 1;
        ELSE
          -- Actualizar precio_base y reactivar si estaba inactivo
          UPDATE productos
          SET precio_base = v_precio,
              activo      = TRUE,
              categoria_id = COALESCE(v_cat_id, categoria_id)
          WHERE id = v_prod_id;

          -- Upsert en lista de precios
          IF v_lista_id IS NOT NULL AND v_precio > 0 THEN
            INSERT INTO precios_items (lista_id, producto_id, precio)
            VALUES (v_lista_id, v_prod_id, v_precio)
            ON CONFLICT (lista_id, producto_id) DO UPDATE SET precio = EXCLUDED.precio;
          END IF;

          v_actualizados := v_actualizados + 1;
        END IF;

      ELSE
        -- Producto nuevo: insertar
        INSERT INTO productos (
          empresa_id, codigo, nombre, categoria_id,
          unidad, costo, precio_base, iva, activo, permite_negativo
        )
        VALUES (
          p_empresa_id, v_codigo, v_nombre, v_cat_id,
          v_unidad, v_costo, v_precio, v_iva, TRUE, FALSE
        )
        RETURNING id INTO v_prod_id;

        -- Vincular a lista de precios
        IF v_lista_id IS NOT NULL AND v_precio > 0 THEN
          INSERT INTO precios_items (lista_id, producto_id, precio)
          VALUES (v_lista_id, v_prod_id, v_precio)
          ON CONFLICT (lista_id, producto_id) DO UPDATE SET precio = EXCLUDED.precio;
        END IF;

        -- Inicializar stock en 0
        IF v_deposito_id IS NOT NULL THEN
          INSERT INTO stock (producto_id, deposito_id, cantidad, cantidad_reservada)
          VALUES (v_prod_id, v_deposito_id, 0, 0)
          ON CONFLICT (producto_id, deposito_id) DO NOTHING;
        END IF;

        v_nuevos := v_nuevos + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores + 1;
      v_err_detalle := v_err_detalle || jsonb_build_object(
        'codigo', v_codigo,
        'nombre', v_nombre,
        'error',  SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',             TRUE,
    'lista_precio_id', v_lista_id,
    'resumen', jsonb_build_object(
      'nuevos',       v_nuevos,
      'actualizados', v_actualizados,
      'sin_cambio',   v_sin_cambio,
      'errores',      v_errores
    ),
    'errores_detalle', v_err_detalle
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok',    FALSE,
    'error', SQLERRM
  );
END;
$$;

-- Solo el backend (service_role) puede ejecutar esta función
REVOKE ALL ON FUNCTION importar_productos_lote FROM PUBLIC;
GRANT EXECUTE ON FUNCTION importar_productos_lote TO service_role;
