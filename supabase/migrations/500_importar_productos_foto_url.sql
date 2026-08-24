-- 500_importar_productos_foto_url.sql
--
-- Agrega soporte de imagen opcional al import masivo de productos
-- (RPC importar_productos_lote, ver 025_rpc_importar_productos.sql).
--
-- Contexto: el import por lote solo contemplaba
-- {codigo,nombre,precio,costo,iva,unidad,categoria}. No tocaba
-- productos.foto_url en absoluto — a diferencia del alta manual (353) y
-- del auto-completado por código de barras (/api/auto-imagenes, 440),
-- que sí la resuelven.
--
-- Este cambio agrega un campo `foto_url` OPCIONAL por fila:
--   - si la fila trae foto_url y es una URL http(s) con forma válida,
--     se guarda en productos.foto_url con foto_fuente = 'importado'.
--   - si la fila no trae foto_url (o viene vacía/mal formada), el
--     producto se crea/actualiza igual que antes — nunca es motivo de
--     error de fila, es puramente opcional.
--   - en un producto EXISTENTE, solo se pisa la foto si la fila trae
--     una foto_url nueva y válida; si la fila no trae nada, se
--     preserva la que ya tenía (no se borra una foto cargada a mano
--     o resuelta por auto-imagenes).
--
-- No modifica banco_codigos_producto (el banco compartido entre
-- empresas) — se deja fuera de alcance a propósito: ese banco se
-- alimenta hoy de altas confirmadas por UI o fuentes externas
-- verificadas (OFF/OPF/Mercado Libre), y una URL pegada a mano en un
-- Excel de import no tiene el mismo nivel de confianza para
-- compartirse con otras empresas del SaaS.

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
  v_foto_url    TEXT;
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

      -- foto_url: opcional. Solo se toma si tiene forma de URL http(s)
      -- razonable; si no, se ignora en silencio (no es error de fila).
      v_foto_url := NULLIF(TRIM(v_fila->>'foto_url'), '');
      IF v_foto_url IS NOT NULL AND v_foto_url !~* '^https?://[^\s]+\.[^\s]+' THEN
        v_foto_url := NULL;
      END IF;

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

        IF v_precio_act IS NOT NULL AND ABS(v_precio_act - v_precio) < 0.01 AND v_foto_url IS NULL THEN
          -- Sin cambio (ni precio ni foto)
          v_sin_cambio := v_sin_cambio + 1;
        ELSE
          -- Actualizar precio_base y reactivar si estaba inactivo.
          -- foto_url solo se pisa si la fila trajo una nueva y válida —
          -- si no, se preserva la que ya tenía el producto.
          UPDATE productos
          SET precio_base  = v_precio,
              activo       = TRUE,
              categoria_id = COALESCE(v_cat_id, categoria_id),
              foto_url     = COALESCE(v_foto_url, foto_url),
              foto_fuente  = CASE WHEN v_foto_url IS NOT NULL THEN 'importado' ELSE foto_fuente END
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
        -- Producto nuevo: insertar (con foto_url si vino en la fila)
        INSERT INTO productos (
          empresa_id, codigo, nombre, categoria_id,
          unidad, costo, precio_base, iva, activo, permite_negativo,
          foto_url, foto_fuente
        )
        VALUES (
          p_empresa_id, v_codigo, v_nombre, v_cat_id,
          v_unidad, v_costo, v_precio, v_iva, TRUE, FALSE,
          v_foto_url, CASE WHEN v_foto_url IS NOT NULL THEN 'importado' ELSE NULL END
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

-- Se mantienen los mismos permisos que la versión original (025):
-- solo el backend (service_role) puede ejecutar esta función.
REVOKE ALL ON FUNCTION importar_productos_lote FROM PUBLIC;
GRANT EXECUTE ON FUNCTION importar_productos_lote TO service_role;
