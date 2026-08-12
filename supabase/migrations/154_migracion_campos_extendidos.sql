-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 154: cobertura de campos extendida en el wizard de migración
--
-- Antes el wizard solo migraba:
--   productos: nombre, codigo, precio, stock
--   clientes:  razon_social, cuit, telefono, email, domicilio, localidad,
--              limite_credito, saldo_inicial
--
-- Se agregan campos opcionales del día uno para una distribuidora típica:
--   productos: categoria, proveedor, codigo_barras (flag), iva, unidad
--   clientes:  zona, condicion_iva, lista_precios, vendedor
--
-- Categoría / proveedor / zona / lista de precios se resuelven por nombre
-- dentro de la empresa y SE CREAN si no existen (igual que cuando se cargan
-- a mano desde el admin) — son catálogos de soporte, no hay riesgo en
-- autogenerarlos. El vendedor NO se autocrea (es una cuenta de usuario con
-- login): si el texto no matchea ningún vendedor existente de la empresa,
-- se deja sin asignar y se informa como advertencia, no como error bloqueante.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Resolvers "buscar o crear" ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.migracion_resolver_categoria(p_empresa_id UUID, p_nombre TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id UUID; v_nombre TEXT := NULLIF(TRIM(p_nombre), '');
BEGIN
  IF v_nombre IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM categorias WHERE empresa_id = p_empresa_id AND lower(nombre) = lower(v_nombre) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO categorias (empresa_id, nombre, activa) VALUES (p_empresa_id, v_nombre, true) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.migracion_resolver_proveedor(p_empresa_id UUID, p_nombre TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id UUID; v_nombre TEXT := NULLIF(TRIM(p_nombre), '');
BEGIN
  IF v_nombre IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM proveedores
   WHERE empresa_id = p_empresa_id
     AND (lower(razon_social) = lower(v_nombre) OR lower(nombre_fantasia) = lower(v_nombre))
   LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO proveedores (empresa_id, razon_social, activo) VALUES (p_empresa_id, v_nombre, true) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.migracion_resolver_zona(p_empresa_id UUID, p_nombre TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id UUID; v_nombre TEXT := NULLIF(TRIM(p_nombre), '');
BEGIN
  IF v_nombre IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM zonas WHERE empresa_id = p_empresa_id AND lower(nombre) = lower(v_nombre) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO zonas (empresa_id, nombre, activa) VALUES (p_empresa_id, v_nombre, true) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.migracion_resolver_lista_precio(p_empresa_id UUID, p_nombre TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id UUID; v_nombre TEXT := NULLIF(TRIM(p_nombre), '');
BEGIN
  IF v_nombre IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM listas_precios WHERE empresa_id = p_empresa_id AND lower(nombre) = lower(v_nombre) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO listas_precios (empresa_id, nombre, es_default, activa) VALUES (p_empresa_id, v_nombre, false, true) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END; $$;

-- Vendedor: NO se autocrea (es una cuenta de usuario). Solo matchea por
-- nombre o email contra usuarios con rol='vendedor' de la misma empresa.
CREATE OR REPLACE FUNCTION public.migracion_resolver_vendedor(p_empresa_id UUID, p_texto TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id UUID; v_texto TEXT := NULLIF(TRIM(p_texto), '');
BEGIN
  IF v_texto IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM usuarios
   WHERE empresa_id = p_empresa_id AND rol = 'vendedor'
     AND (lower(nombre) = lower(v_texto) OR lower(email) = lower(v_texto))
   LIMIT 1;
  RETURN v_id; -- NULL si no matchea: se deja sin asignar, no es error
END; $$;

-- Normaliza condición de IVA a valores canónicos (en la base hoy conviven
-- variantes como "Responsable Inscripto" / "responsable_inscripto").
CREATE OR REPLACE FUNCTION public.migracion_normalizar_condicion_iva(p_texto TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(regexp_replace(COALESCE(p_texto, ''), '[\s_-]+', '', 'g'))
    WHEN 'responsableinscripto' THEN 'responsable_inscripto'
    WHEN 'ri' THEN 'responsable_inscripto'
    WHEN 'monotributo' THEN 'monotributista'
    WHEN 'monotributista' THEN 'monotributista'
    WHEN 'exento' THEN 'exento'
    WHEN 'consumidorfinal' THEN 'consumidor_final'
    WHEN 'cf' THEN 'consumidor_final'
    ELSE NULLIF(TRIM(p_texto), '')
  END;
$$;


-- ─── Confirmar clientes: ahora resuelve zona / lista_precios / vendedor / IVA ──
CREATE OR REPLACE FUNCTION public.migracion_confirmar_clientes_lote(
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
  v_creados      INT := 0;
  v_actualizados INT := 0;
  v_errores      JSONB := '[]'::jsonb;
  v_advertencias JSONB := '[]'::jsonb;
  v_nuevo_id     UUID;
  v_procesadas   INT := 0;
  v_zona_id      UUID;
  v_lista_id     UUID;
  v_vendedor_id  UUID;
  v_cond_iva     TEXT;
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

    BEGIN
      v_zona_id     := migracion_resolver_zona(p_empresa_id, v_d->>'zona');
      v_lista_id    := migracion_resolver_lista_precio(p_empresa_id, v_d->>'lista_precios');
      v_cond_iva    := migracion_normalizar_condicion_iva(v_d->>'condicion_iva');

      IF NULLIF(TRIM(v_d->>'vendedor'), '') IS NOT NULL THEN
        v_vendedor_id := migracion_resolver_vendedor(p_empresa_id, v_d->>'vendedor');
        IF v_vendedor_id IS NULL THEN
          v_advertencias := v_advertencias || jsonb_build_object(
            'fila_numero', v_fila.fila_numero,
            'mensaje', 'Vendedor "' || (v_d->>'vendedor') || '" no encontrado, cliente quedó sin vendedor asignado'
          );
        END IF;
      ELSE
        v_vendedor_id := NULL;
      END IF;

      IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
        UPDATE clientes SET
          razon_social  = COALESCE(NULLIF(TRIM(v_d->>'razon_social'), ''), razon_social),
          cuit          = COALESCE(NULLIF(regexp_replace(v_d->>'cuit', '[^0-9]', '', 'g'), ''), cuit),
          telefono      = COALESCE(NULLIF(TRIM(v_d->>'telefono'), ''), telefono),
          email         = COALESCE(NULLIF(TRIM(v_d->>'email'), ''), email),
          domicilio     = COALESCE(NULLIF(TRIM(v_d->>'domicilio'), ''), domicilio),
          localidad     = COALESCE(NULLIF(TRIM(v_d->>'localidad'), ''), localidad),
          limite_credito = CASE WHEN NULLIF(TRIM(v_d->>'limite_credito'), '') IS NOT NULL
                                 THEN (v_d->>'limite_credito')::NUMERIC ELSE limite_credito END,
          saldo_cuenta_corriente = CASE WHEN NULLIF(TRIM(v_d->>'saldo_inicial'), '') IS NOT NULL
                                 THEN (v_d->>'saldo_inicial')::NUMERIC ELSE saldo_cuenta_corriente END,
          zona_id              = COALESCE(v_zona_id, zona_id),
          lista_precio_id      = COALESCE(v_lista_id, lista_precio_id),
          condicion_iva        = COALESCE(v_cond_iva, condicion_iva),
          vendedor_id_default  = COALESCE(v_vendedor_id, vendedor_id_default)
        WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;

        v_actualizados := v_actualizados + 1;
        UPDATE migracion_staging_rows
           SET procesado_en = now(), entidad_resultado_id = v_fila.entidad_existente_id
         WHERE id = v_fila.id;
      ELSE
        INSERT INTO clientes (
          empresa_id, razon_social, cuit, telefono, email, domicilio, localidad,
          limite_credito, saldo_cuenta_corriente,
          zona_id, lista_precio_id, condicion_iva, vendedor_id_default
        )
        VALUES (
          p_empresa_id,
          NULLIF(TRIM(v_d->>'razon_social'), ''),
          NULLIF(regexp_replace(v_d->>'cuit', '[^0-9]', '', 'g'), ''),
          NULLIF(TRIM(v_d->>'telefono'), ''),
          NULLIF(TRIM(v_d->>'email'), ''),
          NULLIF(TRIM(v_d->>'domicilio'), ''),
          NULLIF(TRIM(v_d->>'localidad'), ''),
          COALESCE(NULLIF(TRIM(v_d->>'limite_credito'), '')::NUMERIC, 0),
          COALESCE(NULLIF(TRIM(v_d->>'saldo_inicial'), '')::NUMERIC, 0),
          v_zona_id, v_lista_id, v_cond_iva, v_vendedor_id
        )
        RETURNING id INTO v_nuevo_id;

        v_creados := v_creados + 1;
        UPDATE migracion_staging_rows
           SET procesado_en = now(), entidad_resultado_id = v_nuevo_id
         WHERE id = v_fila.id;
      END IF;
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
    'advertencias', v_advertencias,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;


-- ─── Confirmar productos: ahora resuelve categoria / proveedor / iva / unidad / barcode ──
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

      IF v_stock IS NOT NULL AND p_deposito_id IS NOT NULL THEN
        SELECT migracion_alta_stock(v_producto_id, p_deposito_id, p_empresa_id, v_stock, p_sesion_id, p_usuario_id)
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
