-- ════════════════════════════════════════════════════════════════════
-- 20260915130000_631_permite_negativo_pos_y_abm.sql
--
-- Diagnóstico (2026-09-15, punto 1 de la auditoría del POS "vender sin
-- stock"): la columna productos.permite_negativo existe desde la
-- migración 001 y la migración 438 la respeta a nivel de datos (el
-- trigger fn_stock_valida_negativo solo deja stock < 0 cuando el
-- producto la tiene en true). Pero ARRIBA de esa capa nadie la usaba:
--
--   1. registrar_venta_pos cortaba SIEMPRE con 'stock_insuficiente'
--      cuando la cantidad pedida superaba el stock del depósito, sin
--      mirar permite_negativo. Es decir: el dato existía, el trigger lo
--      respetaba, y la venta igual se bloqueaba antes de llegar ahí.
--   2. fn_productos_lista no devolvía la columna, así que el ABM de
--      Productos no podía ni mostrarla ni editarla.
--   3. fn_crear_producto no la aceptaba: un producto nuevo nacía
--      siempre con permite_negativo = false y solo se podía cambiar por
--      SQL directo.
--
-- NOTA DE NOMBRE: en el chat previo se hablaba de una columna nueva
-- `permite_stock_negativo` (supuesta migración 630). Esa columna NO
-- existe en producción — el nombre real, desde 001, es
-- `permite_negativo`. No se renombra nada: se usa el nombre real y el
-- frontend se alinea a él (ver CHANGELOG_v1088).
--
-- De paso (bug menor encontrado acá): fn_productos_lista tampoco
-- devolvía `stock_objetivo`, aunque el modal de producto lo lee
-- (normalizarRpc → p.stock_objetivo) y lo escribe desde la 547. Al
-- editar un producto el campo aparecía siempre en 0 y guardaba 0,
-- pisando en silencio el valor cargado. Se suma a la salida.
--
-- Este archivo:
--   (a) registrar_venta_pos respeta permite_negativo.
--   (b) fn_productos_lista suma permite_negativo + stock_objetivo.
--   (c) fn_crear_producto acepta p_permite_negativo.
-- ════════════════════════════════════════════════════════════════════

-- ── (a) registrar_venta_pos: respeta productos.permite_negativo ───────
-- Base: versión vigente en producción (618 row locking + 622 promo en
-- venta_pos_items). Único cambio funcional: el chequeo de stock.
CREATE OR REPLACE FUNCTION public.registrar_venta_pos(
  p_empresa_id uuid, p_caja_id uuid, p_turno_id uuid, p_vendedor_id uuid,
  p_cliente_id uuid, p_deposito_id uuid, p_items jsonb, p_pagos jsonb,
  p_subtotal numeric, p_iva_total numeric, p_total numeric,
  p_descuento_global_pct numeric DEFAULT 0,
  p_offline_local_id text DEFAULT NULL::text
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta_id         UUID;
  v_numero           TEXT;
  v_item             JSONB;
  v_pago             JSONB;
  v_producto_id      UUID;
  v_cantidad         NUMERIC;
  v_disponible       NUMERIC;
  v_hay_fila_stock   BOOLEAN;
  v_permite_negativo BOOLEAN;
  v_suma_pagos       NUMERIC := 0;
  v_suma_no_efectivo NUMERIC := 0;
  v_limite           NUMERIC;
  v_saldo_actual     NUMERIC;
  v_monto_cta_cte    NUMERIC := 0;
  v_existente_id     UUID;
  v_existente_num    TEXT;
  v_mov_id           UUID;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'tipo', 'no_autorizado', 'error', 'No autorizado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id, numero INTO v_existente_id, v_existente_num
      FROM public.ventas_pos
     WHERE empresa_id = p_empresa_id AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN json_build_object(
        'ok', true, 'venta_id', v_existente_id, 'numero', v_existente_num, 'ya_existia', true
      );
    END IF;
  END IF;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_suma_pagos
    FROM jsonb_array_elements(p_pagos) p;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_suma_no_efectivo
    FROM jsonb_array_elements(p_pagos) p
   WHERE p->>'medio' <> 'efectivo';

  IF v_suma_pagos < p_total - 1 THEN
    RETURN json_build_object('ok', false, 'tipo', 'pagos_no_coinciden',
      'error', 'La suma de los pagos no coincide con el total de la venta');
  END IF;

  IF v_suma_no_efectivo > p_total + 1 THEN
    RETURN json_build_object('ok', false, 'tipo', 'pagos_no_coinciden',
      'error', 'La suma de los pagos no coincide con el total de la venta');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.turnos_caja
     WHERE id = p_turno_id AND caja_id = p_caja_id AND estado = 'abierto'
  ) THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_cerrado',
      'error', 'No hay un turno abierto para esta caja');
  END IF;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_monto_cta_cte
    FROM jsonb_array_elements(p_pagos) p WHERE p->>'medio' = 'cuenta_corriente';

  IF v_monto_cta_cte > 0 THEN
    IF p_cliente_id IS NULL THEN
      RETURN json_build_object('ok', false, 'tipo', 'cliente_requerido',
        'error', 'No se puede imputar a cuenta corriente sin un cliente seleccionado');
    END IF;

    SELECT limite_credito, COALESCE(saldo_deuda, 0) INTO v_limite, v_saldo_actual
      FROM public.clientes WHERE id = p_cliente_id
      FOR UPDATE;

    IF v_limite > 0 THEN
      IF v_saldo_actual + v_monto_cta_cte > v_limite THEN
        RETURN json_build_object('ok', false, 'tipo', 'limite_credito',
          'error', 'Supera el límite de crédito del cliente');
      END IF;
    END IF;
  END IF;

  SELECT 'POS-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
         LPAD(nextval('public.seq_ventas_pos')::TEXT, 5, '0')
    INTO v_numero;

  INSERT INTO public.ventas_pos (
    empresa_id, caja_id, turno_id, cliente_id, vendedor_id, numero,
    subtotal, iva_total, total, estado, descuento_global_pct,
    offline_local_id, es_offline
  ) VALUES (
    p_empresa_id, p_caja_id, p_turno_id, p_cliente_id, p_vendedor_id, v_numero,
    ROUND(p_subtotal, 2), ROUND(p_iva_total, 2), ROUND(p_total, 2),
    'completada',
    COALESCE(p_descuento_global_pct, 0),
    p_offline_local_id, (p_offline_local_id IS NOT NULL)
  ) RETURNING id INTO v_venta_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_producto_id := (v_item->>'producto_id')::UUID;
    v_cantidad    := (v_item->>'cantidad')::NUMERIC;

    -- FIX 622: se agregan promocion_id/promocion_descripcion al INSERT,
    -- que ya vienen en v_item pero antes se descartaban en silencio.
    INSERT INTO public.venta_pos_items (
      venta_pos_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal,
      promocion_id, promocion_descripcion
    ) VALUES (
      v_venta_id, v_producto_id, v_cantidad,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      ROUND((v_item->>'subtotal')::NUMERIC, 2),
      NULLIF(v_item->>'promocion_id', '')::UUID,
      NULLIF(v_item->>'promocion_descripcion', '')
    );

    SELECT cantidad INTO v_disponible
      FROM public.stock
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id
       FOR UPDATE;

    v_hay_fila_stock := FOUND;

    -- FIX 631: hasta acá el chequeo era `IF NOT FOUND OR v_disponible <
    -- v_cantidad THEN RAISE 'stock_insuficiente'`, sin mirar nunca
    -- productos.permite_negativo. Ahora, si el producto tiene el flag en
    -- true, la venta sigue y el stock queda en negativo — que es
    -- exactamente lo que el trigger fn_stock_valida_negativo (438) ya
    -- permite para esos productos. Sin el flag, el comportamiento es
    -- idéntico al anterior (mismo mensaje, mismo tipo de error).
    SELECT COALESCE(p.permite_negativo, false) INTO v_permite_negativo
      FROM public.productos p
     WHERE p.id = v_producto_id;

    IF (NOT v_hay_fila_stock) OR v_disponible < v_cantidad THEN
      IF NOT COALESCE(v_permite_negativo, false) THEN
        RAISE EXCEPTION 'stock_insuficiente:% disponible:%',
          v_producto_id::TEXT, COALESCE(v_disponible, 0)::TEXT;
      END IF;

      -- Producto autorizado a quedar en negativo: si todavía no existe la
      -- fila de stock en este depósito, se crea en 0 para que el UPDATE
      -- de abajo tenga sobre qué descontar (antes ese caso ni siquiera
      -- llegaba acá porque abortaba con stock_insuficiente).
      IF NOT v_hay_fila_stock THEN
        INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada)
        VALUES (v_producto_id, p_deposito_id, 0, 0)
        ON CONFLICT (producto_id, deposito_id) DO NOTHING;
      END IF;
    END IF;

    UPDATE public.stock
       SET cantidad            = cantidad - v_cantidad,
           updated_at          = NOW()
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id;

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_producto_id, p_deposito_id, 'egreso', v_cantidad,
       v_venta_id, 'Venta POS ' || v_numero, p_vendedor_id)
    RETURNING id INTO v_mov_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    SELECT v_mov_id, f.lote_id, f.cantidad_consumida, 'consumo'
      FROM fn_lotes_consumir_fefo(v_producto_id, p_deposito_id, v_cantidad, 'Venta POS ' || v_numero, p_vendedor_id) f;
  END LOOP;

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO public.venta_pos_pagos (venta_pos_id, medio, monto, referencia, codigo_externo)
    VALUES (v_venta_id, v_pago->>'medio', (v_pago->>'monto')::NUMERIC, v_pago->>'referencia', v_pago->>'codigo');
  END LOOP;

  IF v_monto_cta_cte > 0 THEN
    INSERT INTO public.cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (p_empresa_id, p_cliente_id, 'debito', v_monto_cta_cte,
            'Venta POS ' || v_numero, NOW());
  END IF;

  RETURN json_build_object(
    'ok',       true,
    'venta_id', v_venta_id,
    'numero',   v_numero,
    'total',    p_total
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id, numero INTO v_existente_id, v_existente_num
        FROM public.ventas_pos
       WHERE empresa_id = p_empresa_id AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN json_build_object(
          'ok', true, 'venta_id', v_existente_id, 'numero', v_existente_num, 'ya_existia', true
        );
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'stock_insuficiente:%' THEN
      RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente', 'error', SQLERRM);
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.registrar_venta_pos(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric, text) IS
  'v631: el chequeo de stock respeta productos.permite_negativo (si el producto lo tiene habilitado, la venta procede y el stock queda en negativo, creando la fila de stock del depósito si no existía). Resto idéntico a la versión 618/622.';

-- ── (b) fn_productos_lista: suma permite_negativo y stock_objetivo ────
-- Cambian las columnas de salida, así que hay que dropear antes de
-- recrear (igual que hizo la 542).
DROP FUNCTION IF EXISTS public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_productos_lista(
  p_busqueda      text    DEFAULT NULL,
  p_categoria_id  uuid    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_orden         text    DEFAULT 'nombre',
  p_asc           boolean DEFAULT true,
  p_limit         integer DEFAULT 50,
  p_offset        integer DEFAULT 0,
  p_mes           integer DEFAULT NULL,
  p_anio          integer DEFAULT NULL,
  p_foto_fuente   text    DEFAULT NULL,
  p_etiqueta_id   uuid    DEFAULT NULL
)
RETURNS TABLE(
  id uuid, codigo text, nombre text, activo boolean, estado text,
  categoria_id uuid, categoria_nombre text, precio_base numeric, costo numeric,
  stock_minimo numeric, stock_objetivo numeric, stock_disponible numeric,
  updated_at timestamp with time zone,
  created_at timestamp with time zone, foto_url text, foto_fuente text,
  destacado boolean, permite_negativo boolean, total_count bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_orden_col  text;
  v_dir        text := CASE WHEN p_asc THEN 'ASC' ELSE 'DESC' END;
  v_sql        text;
BEGIN
  v_orden_col := CASE p_orden
    WHEN 'nombre'      THEN 'nombre'
    WHEN 'precio'      THEN 'precio_base'
    WHEN 'precio_base' THEN 'precio_base'
    WHEN 'costo'       THEN 'costo'
    WHEN 'stock'       THEN 'stock_disponible'
    WHEN 'fechaAct'    THEN 'updated_at'
    WHEN 'updated_at'  THEN 'updated_at'
    ELSE 'nombre'
  END;

  v_sql := format(
    $q$
    WITH stock_por_producto AS (
      SELECT s.producto_id,
             SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
      FROM public.stock s
      JOIN public.depositos d ON d.id = s.deposito_id
      WHERE d.empresa_id = $1
      GROUP BY s.producto_id
    ),
    base AS (
      SELECT
        p.id, p.codigo, p.nombre, p.activo,
        CASE
          WHEN NOT p.activo THEN 'borrador'
          WHEN COALESCE(sp.disponible, 0) <= 0 THEN 'sin_stock'
          ELSE 'activo'
        END AS estado,
        p.categoria_id, c.nombre AS categoria_nombre,
        p.precio_base, p.costo,
        p.stock_minimo::numeric   AS stock_minimo,
        p.stock_objetivo::numeric AS stock_objetivo,
        COALESCE(sp.disponible, 0) AS stock_disponible,
        p.updated_at, p.created_at, p.foto_url, p.foto_fuente,
        p.destacado,
        COALESCE(p.permite_negativo, false) AS permite_negativo
      FROM public.productos p
      LEFT JOIN stock_por_producto sp ON sp.producto_id = p.id
      LEFT JOIN public.categorias c   ON c.id = p.categoria_id
      WHERE p.empresa_id = $1
        AND ($2::uuid IS NULL OR p.categoria_id = $2)
        AND (
          $3::text IS NULL OR $3 = '' OR
          (COALESCE(p.nombre, '') || ' ' || COALESCE(p.codigo, '')) ILIKE '%%' || $3 || '%%'
        )
        AND ($7::int IS NULL OR EXTRACT(MONTH FROM p.created_at) = $7)
        AND ($8::int IS NULL OR EXTRACT(YEAR  FROM p.created_at) = $8)
        AND (
          $10::uuid IS NULL OR EXISTS (
            SELECT 1 FROM public.entidad_etiquetas ee
            WHERE ee.entidad_tipo = 'productos'
              AND ee.entidad_id = p.id
              AND ee.etiqueta_id = $10
          )
        )
    )
    SELECT b.id, b.codigo, b.nombre, b.activo, b.estado,
           b.categoria_id, b.categoria_nombre,
           b.precio_base, b.costo, b.stock_minimo, b.stock_objetivo, b.stock_disponible,
           b.updated_at, b.created_at, b.foto_url, b.foto_fuente,
           b.destacado, b.permite_negativo,
           COUNT(*) OVER() AS total_count
    FROM base b
    WHERE ($4::text IS NULL OR $4 = '' OR b.estado = $4)
      AND (
        $9::text IS NULL OR $9 = '' OR
        ($9 = 'sin_foto' AND b.foto_url IS NULL) OR
        ($9 = 'generica' AND b.foto_fuente = 'pexels') OR
        ($9 = 'real' AND b.foto_url IS NOT NULL
                     AND (b.foto_fuente IS NULL OR b.foto_fuente <> 'pexels'))
      )
    ORDER BY b.%I %s NULLS LAST, b.id
    LIMIT $5 OFFSET $6
    $q$,
    v_orden_col, v_dir
  );

  RETURN QUERY EXECUTE v_sql
    USING v_empresa_id, p_categoria_id, p_busqueda, p_estado, p_limit, p_offset, p_mes, p_anio, p_foto_fuente, p_etiqueta_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid) IS
  'v631: suma a la salida permite_negativo (para el toggle del ABM y el badge del POS) y stock_objetivo (que el modal ya leía pero el RPC nunca devolvía, así que al editar se pisaba con 0). stock_minimo se castea explícitamente a numeric para no depender de si la 542 llegó a aplicarse en este entorno. Filtros y firma de entrada: sin cambios respecto a 542/528/474.';

-- El DROP de más arriba se lleva puesto el REVOKE que fijó la migración
-- 258 (fn_productos_lista es RPC de admin, sin caso de uso legítimo para
-- anon). Se vuelve a aplicar, igual que hizo la 542.
REVOKE EXECUTE ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text, uuid)
  TO authenticated, service_role;

-- ── (c) fn_crear_producto: acepta p_permite_negativo ──────────────────
-- Cambia la firma (parámetro nuevo al final), así que se dropea la
-- versión 547 explícitamente en vez de dejar dos overloads conviviendo
-- — con dos sobrecargas, una llamada por nombre de parámetro desde
-- PostgREST se vuelve ambigua y falla.
DROP FUNCTION IF EXISTS public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text, boolean, numeric);
DROP FUNCTION IF EXISTS public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, integer, boolean, text, boolean, numeric);
DROP FUNCTION IF EXISTS public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, integer, boolean, text, boolean);

CREATE OR REPLACE FUNCTION public.fn_crear_producto(
  p_nombre            text,
  p_deposito_ids      uuid[],
  p_codigo            text DEFAULT NULL::text,
  p_categoria_id      uuid DEFAULT NULL::uuid,
  p_precio_base       numeric DEFAULT 0,
  p_costo             numeric DEFAULT 0,
  p_stock_minimo      numeric DEFAULT 0,
  p_activo            boolean DEFAULT true,
  p_foto_url          text DEFAULT NULL::text,
  p_destacado         boolean DEFAULT false,
  p_stock_objetivo    numeric DEFAULT 0,
  p_permite_negativo  boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id  uuid := public.get_empresa_id();
  v_producto_id uuid;
  v_ids_validos uuid[];
BEGIN
  -- SECNEW-02 (2026-08-28): chequeo de rol (dueno/admin/depositero), se
  -- mantiene igual que en la versión anterior de esta función.
  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno', 'admin', 'depositero') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
    RAISE EXCEPTION 'El nombre del producto es obligatorio.';
  END IF;

  SELECT array_agg(d.id) INTO v_ids_validos
  FROM public.depositos d
  WHERE d.empresa_id = v_empresa_id
    AND d.id = ANY(p_deposito_ids);

  IF v_ids_validos IS NULL OR array_length(v_ids_validos, 1) IS NULL THEN
    RAISE EXCEPTION 'Debe seleccionar al menos un depósito válido para el producto nuevo.';
  END IF;

  INSERT INTO public.productos (
    empresa_id, codigo, nombre, categoria_id,
    precio_base, costo, stock_minimo, activo, foto_url, destacado,
    stock_objetivo, permite_negativo
  ) VALUES (
    v_empresa_id, NULLIF(trim(p_codigo), ''), p_nombre, p_categoria_id,
    p_precio_base, p_costo, p_stock_minimo, p_activo, NULLIF(trim(p_foto_url), ''),
    COALESCE(p_destacado, false),
    COALESCE(p_stock_objetivo, 0),
    COALESCE(p_permite_negativo, false)
  )
  RETURNING id INTO v_producto_id;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad, cantidad_reservada, costo_promedio)
  SELECT v_producto_id, d, 0, 0, COALESCE(p_costo, 0)
  FROM unnest(v_ids_validos) AS d
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  RETURN v_producto_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text, boolean, numeric, boolean) IS
  'v631: suma p_permite_negativo (columna productos.permite_negativo, existente desde 001) para poder dar de alta un producto ya autorizado a vender sin stock. Resto idéntico a 547 (stock_objetivo + destacado + elección de depósitos + stock inicial en 0 + chequeo de rol de SECNEW-02).';

REVOKE EXECUTE ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text, boolean, numeric, boolean)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_crear_producto(text, uuid[], text, uuid, numeric, numeric, numeric, boolean, text, boolean, numeric, boolean)
  TO authenticated, service_role;

-- ── Registro ──────────────────────────────────────────────────────────
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '20260915130000_631_permite_negativo_pos_y_abm.sql', '631', 'claude-session',
  'Punto 1 de la auditoría del POS "vender sin stock": productos.permite_negativo existía desde 001 y el trigger de 438 la respetaba, pero registrar_venta_pos cortaba igual con stock_insuficiente, fn_productos_lista no la devolvía y fn_crear_producto no la aceptaba. Se cierra el circuito en las tres. De paso fn_productos_lista suma stock_objetivo, que el modal de producto leía pero el RPC nunca devolvía (al editar se guardaba 0 pisando el valor real).')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
