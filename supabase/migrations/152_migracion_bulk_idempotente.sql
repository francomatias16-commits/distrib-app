-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 152: migración masiva en bloque + idempotente
--
-- Problema que resuelve:
--  - mapearSesion / confirmarSesion hacían 1 round-trip a Supabase por fila
--    (insert/update secuencial). Con 3.000-5.000 filas eso son miles de
--    round-trips uno atrás del otro: riesgo real de timeout en serverless.
--  - confirmarSesion no era idempotente: si se cortaba a la mitad, no había
--    forma de saber qué filas ya se habían insertado. Un reintento volvía a
--    insertar las mismas filas "crear" (duplicados).
--
-- Solución:
--  1. Columnas nuevas en migracion_staging_rows para trackear qué fila ya se
--     procesó (y con qué resultado), por fila.
--  2. migracion_mapear_bulk: aplica el mapeo/validación de un lote de filas
--     en una sola sentencia SQL (UPDATE ... FROM jsonb_to_recordset), en vez
--     de N updates.
--  3. migracion_confirmar_clientes_lote / migracion_confirmar_productos_lote:
--     procesan un lote acotado de filas (ej. 500) server-side, en loop dentro
--     de Postgres (sin latencia de red entre filas), y marcan cada fila como
--     procesada apenas se confirma. Cada llamada RPC es su propia transacción,
--     así que si el proceso se corta a mitad de camino, las filas ya
--     confirmadas quedan marcadas y un reintento simplemente continúa con las
--     que faltan (no vuelve a tocar las ya hechas).
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE migracion_staging_rows
  ADD COLUMN IF NOT EXISTS procesado_en        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS entidad_resultado_id UUID,
  ADD COLUMN IF NOT EXISTS error_ejecucion      TEXT;

-- Para que el filtro "WHERE sesion_id = X AND procesado_en IS NULL" sea rápido
-- incluso con archivos grandes.
CREATE INDEX IF NOT EXISTS idx_migracion_staging_pendientes
  ON migracion_staging_rows (sesion_id, procesado_en)
  WHERE procesado_en IS NULL;


-- ─── 1) Mapeo en bloque ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.migracion_mapear_bulk(
  p_sesion_id UUID,
  p_filas     JSONB  -- array de {id, datos_mapeados, es_valida, errores, accion, entidad_existente_id}
) RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH actualizadas AS (
    UPDATE migracion_staging_rows t
       SET datos_mapeados        = f.datos_mapeados,
           es_valida              = f.es_valida,
           errores                = f.errores,
           accion                 = f.accion,
           entidad_existente_id   = f.entidad_existente_id
      FROM jsonb_to_recordset(p_filas) AS f(
             id UUID, datos_mapeados JSONB, es_valida BOOLEAN,
             errores JSONB, accion TEXT, entidad_existente_id UUID
           )
     WHERE t.id = f.id AND t.sesion_id = p_sesion_id
    RETURNING t.id
  )
  SELECT COUNT(*)::INT FROM actualizadas;
$function$;


-- ─── 2) Confirmar clientes, un lote a la vez (server-side loop) ───────────────
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
  v_fila        RECORD;
  v_d           JSONB;
  v_creados     INT := 0;
  v_actualizados INT := 0;
  v_errores     JSONB := '[]'::jsonb;
  v_nuevo_id    UUID;
  v_procesadas  INT := 0;
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
      IF v_fila.accion = 'actualizar' AND v_fila.entidad_existente_id IS NOT NULL THEN
        UPDATE clientes SET
          razon_social = COALESCE(NULLIF(TRIM(v_d->>'razon_social'), ''), razon_social),
          cuit          = COALESCE(NULLIF(regexp_replace(v_d->>'cuit', '[^0-9]', '', 'g'), ''), cuit),
          telefono      = COALESCE(NULLIF(TRIM(v_d->>'telefono'), ''), telefono),
          email         = COALESCE(NULLIF(TRIM(v_d->>'email'), ''), email),
          domicilio     = COALESCE(NULLIF(TRIM(v_d->>'domicilio'), ''), domicilio),
          localidad     = COALESCE(NULLIF(TRIM(v_d->>'localidad'), ''), localidad),
          limite_credito = CASE WHEN NULLIF(TRIM(v_d->>'limite_credito'), '') IS NOT NULL
                                 THEN (v_d->>'limite_credito')::NUMERIC ELSE limite_credito END,
          saldo_cuenta_corriente = CASE WHEN NULLIF(TRIM(v_d->>'saldo_inicial'), '') IS NOT NULL
                                 THEN (v_d->>'saldo_inicial')::NUMERIC ELSE saldo_cuenta_corriente END
        WHERE id = v_fila.entidad_existente_id AND empresa_id = p_empresa_id;

        v_actualizados := v_actualizados + 1;
        UPDATE migracion_staging_rows
           SET procesado_en = now(), entidad_resultado_id = v_fila.entidad_existente_id
         WHERE id = v_fila.id;
      ELSE
        INSERT INTO clientes (empresa_id, razon_social, cuit, telefono, email, domicilio, localidad, limite_credito, saldo_cuenta_corriente)
        VALUES (
          p_empresa_id,
          NULLIF(TRIM(v_d->>'razon_social'), ''),
          NULLIF(regexp_replace(v_d->>'cuit', '[^0-9]', '', 'g'), ''),
          NULLIF(TRIM(v_d->>'telefono'), ''),
          NULLIF(TRIM(v_d->>'email'), ''),
          NULLIF(TRIM(v_d->>'domicilio'), ''),
          NULLIF(TRIM(v_d->>'localidad'), ''),
          COALESCE(NULLIF(TRIM(v_d->>'limite_credito'), '')::NUMERIC, 0),
          COALESCE(NULLIF(TRIM(v_d->>'saldo_inicial'), '')::NUMERIC, 0)
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
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;


-- ─── 3) Confirmar productos, un lote a la vez (server-side loop + FEFO) ───────
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
  v_fila        RECORD;
  v_d           JSONB;
  v_creados     INT := 0;
  v_actualizados INT := 0;
  v_errores     JSONB := '[]'::jsonb;
  v_producto_id UUID;
  v_precio      NUMERIC;
  v_stock       NUMERIC;
  v_procesadas  INT := 0;
  v_rpc_stock   JSONB;
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

    BEGIN
      IF v_fila.accion = 'actualizar' AND v_producto_id IS NOT NULL THEN
        UPDATE productos SET
          nombre      = COALESCE(NULLIF(TRIM(v_d->>'nombre'), ''), nombre),
          codigo      = COALESCE(NULLIF(TRIM(v_d->>'codigo'), ''), codigo),
          precio_base = COALESCE(v_precio, precio_base)
        WHERE id = v_producto_id AND empresa_id = p_empresa_id;

        v_actualizados := v_actualizados + 1;
      ELSE
        INSERT INTO productos (empresa_id, nombre, codigo, precio_base)
        VALUES (p_empresa_id, NULLIF(TRIM(v_d->>'nombre'), ''), NULLIF(TRIM(v_d->>'codigo'), ''), COALESCE(v_precio, 0))
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
