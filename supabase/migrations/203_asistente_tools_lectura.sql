-- =============================================================
-- 203_asistente_tools_lectura.sql
-- Fase 2 del asistente de ayuda: RPCs de solo lectura para el
-- catálogo de "tool calling" (ver lib/asistente-tools.js).
--
-- NOTA DE NUMERACIÓN: esta migración se preparó originalmente como
-- "200_asistente_tools_lectura.sql", pero al momento de integrarla al
-- repo los números 200, 201 y 202 ya estaban tomados localmente por
-- otro trabajo (200_rpc_reportes_stock_agregados.sql,
-- 201_ajustar_stock_atomico_sin_clamp.sql,
-- 202_demo_infraestructura_versionada_y_fix_autosuspension.sql). Se
-- renumeró a 203 para no pisarlos. Los NOMBRES de las funciones (las
-- RPCs en sí) no cambian, solo el número de archivo de la migración.
--
-- Mismo criterio de seguridad que 195_asistente_ayuda.sql y
-- 196_asistente_pedidos_pendientes.sql:
--   - SECURITY DEFINER + SET search_path = public
--   - Reciben p_empresa_id como parámetro (el handler lo saca del
--     perfil ya verificado por verificarToken(), nunca del texto
--     libre del usuario) y TODO where filtra por ese valor.
--   - REVOKE de PUBLIC/anon/authenticated, GRANT solo a service_role.
--   - Ninguna arma SQL dinámico ni recibe columnas/tablas como
--     parámetro: son 6 preguntas fijas, con sus propios filtros fijos.
--
-- Búsquedas por nombre (proveedor/cliente): son ILIKE acotadas a la
-- empresa, con LIMIT bajo. Si hay 0 o 2+ candidatos, la función
-- devuelve eso explícito (encontrado=false / ambiguo=true) en vez de
-- adivinar cuál — el handler le pide al usuario que aclare.
--
-- FIX incluido de una: las 3 funciones "listar_*" ya llevan el cap
-- de 20 filas en el array (ver comentario en cada una) — probado a
-- mano con 51 cheques en 30 días antes de esta versión: sin el cap,
-- las 3 mandaban TODAS las filas encontradas al prompt del modelo,
-- carísimo y lento. total_* siempre es el conteo/suma real sobre
-- TODAS las filas, no solo las mostradas.
-- =============================================================

-- ── 1. Deuda a un proveedor puntual ─────────────────────────────
CREATE OR REPLACE FUNCTION public.consultar_deuda_proveedor(
  p_empresa_id UUID,
  p_nombre     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidatos JSONB;
  v_count      INT;
  v_proveedor  RECORD;
  v_saldo      NUMERIC;
  v_facturas_pendientes INT;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('id', id, 'nombre', COALESCE(nombre_fantasia, razon_social)))
    INTO v_candidatos
  FROM public.proveedores
  WHERE empresa_id = p_empresa_id
    AND (razon_social ILIKE '%' || p_nombre || '%' OR nombre_fantasia ILIKE '%' || p_nombre || '%')
  LIMIT 6;

  v_count := COALESCE(jsonb_array_length(v_candidatos), 0);

  IF v_count = 0 THEN
    RETURN jsonb_build_object('encontrado', false);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('encontrado', false, 'ambiguo', true, 'candidatos', v_candidatos);
  END IF;

  SELECT id, COALESCE(nombre_fantasia, razon_social) AS nombre
    INTO v_proveedor
  FROM public.proveedores
  WHERE empresa_id = p_empresa_id
    AND (razon_social ILIKE '%' || p_nombre || '%' OR nombre_fantasia ILIKE '%' || p_nombre || '%')
  LIMIT 1;

  SELECT COALESCE(SUM(total - total_pagado), 0), COUNT(*) FILTER (WHERE estado IN ('pendiente','parcial'))
    INTO v_saldo, v_facturas_pendientes
  FROM public.facturas_proveedor
  WHERE empresa_id = p_empresa_id
    AND proveedor_id = v_proveedor.id
    AND estado IN ('pendiente','parcial');

  RETURN jsonb_build_object(
    'encontrado', true,
    'proveedor', v_proveedor.nombre,
    'saldo_pendiente', v_saldo,
    'facturas_pendientes', v_facturas_pendientes
  );
END;
$$;

-- ── 2. Facturas de proveedor por vencer (cap de 20 filas) ───────
CREATE OR REPLACE FUNCTION public.listar_facturas_proveedor_por_vencer(
  p_empresa_id UUID,
  p_dias       INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT fp.*, COALESCE(p.nombre_fantasia, p.razon_social) AS proveedor_nombre
    FROM public.facturas_proveedor fp
    JOIN public.proveedores p ON p.id = fp.proveedor_id
    WHERE fp.empresa_id = p_empresa_id
      AND fp.estado IN ('pendiente','parcial')
      AND fp.fecha_vencimiento BETWEEN CURRENT_DATE AND CURRENT_DATE + GREATEST(p_dias, 0)
  ), top AS (
    SELECT * FROM filas ORDER BY fecha_vencimiento LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_facturas', (SELECT COUNT(*) FROM filas),
    'total_saldo', (SELECT COALESCE(SUM(total - total_pagado), 0) FROM filas),
    'facturas_mostradas', (SELECT COUNT(*) FROM top),
    'facturas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'proveedor', proveedor_nombre,
        'numero_factura', numero_factura,
        'vence', fecha_vencimiento,
        'saldo', total - total_pagado
      ) ORDER BY fecha_vencimiento) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── 3. Lotes por vencer / riesgo de liquidación (cap de 20 filas) ─
CREATE OR REPLACE FUNCTION public.listar_lotes_por_vencer(
  p_empresa_id UUID,
  p_dias       INT DEFAULT 15
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT l.*, pr.nombre AS producto_nombre
    FROM public.lotes l
    JOIN public.productos pr ON pr.id = l.producto_id
    WHERE l.empresa_id = p_empresa_id
      AND l.estado = 'activo'
      AND l.cantidad_disponible > 0
      AND l.fecha_vencimiento BETWEEN CURRENT_DATE AND CURRENT_DATE + GREATEST(p_dias, 0)
  ), top AS (
    SELECT * FROM filas ORDER BY fecha_vencimiento LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_lotes', (SELECT COUNT(*) FROM filas),
    'lotes_mostrados', (SELECT COUNT(*) FROM top),
    'lotes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'producto', producto_nombre,
        'lote', numero_lote,
        'cantidad_disponible', cantidad_disponible,
        'vence', fecha_vencimiento
      ) ORDER BY fecha_vencimiento) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── 4. Cheques por vencer o rechazados (cap de 20 filas) ────────
CREATE OR REPLACE FUNCTION public.listar_cheques_alerta(
  p_empresa_id UUID,
  p_dias       INT DEFAULT 7
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT ch.*, c.razon_social AS cliente_nombre
    FROM public.cheques ch
    LEFT JOIN public.clientes c ON c.id = ch.cliente_id
    WHERE ch.empresa_id = p_empresa_id
      AND (
        ch.estado = 'rechazado'
        OR (ch.estado IN ('en_cartera','pendiente','depositado')
            AND ch.fecha_vto BETWEEN CURRENT_DATE AND CURRENT_DATE + GREATEST(p_dias, 0))
      )
  ), top AS (
    -- rechazados primero, después por fecha de vencimiento más próxima
    SELECT * FROM filas ORDER BY (estado = 'rechazado') DESC, fecha_vto LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_cheques', (SELECT COUNT(*) FROM filas),
    'cheques_mostrados', (SELECT COUNT(*) FROM top),
    'cheques', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'cliente', cliente_nombre,
        'banco', banco,
        'numero', numero,
        'monto', monto,
        'vence', fecha_vto,
        'estado', estado
      ) ORDER BY (estado = 'rechazado') DESC, fecha_vto) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── 5. Estado de bloqueo de un cliente puntual ──────────────────
CREATE OR REPLACE FUNCTION public.consultar_bloqueo_cliente(
  p_empresa_id UUID,
  p_nombre     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidatos JSONB;
  v_count      INT;
  v_cliente    RECORD;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('id', id, 'nombre', COALESCE(nombre_fantasia, razon_social)))
    INTO v_candidatos
  FROM public.clientes
  WHERE empresa_id = p_empresa_id
    AND (razon_social ILIKE '%' || p_nombre || '%' OR nombre_fantasia ILIKE '%' || p_nombre || '%')
  LIMIT 6;

  v_count := COALESCE(jsonb_array_length(v_candidatos), 0);

  IF v_count = 0 THEN
    RETURN jsonb_build_object('encontrado', false);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('encontrado', false, 'ambiguo', true, 'candidatos', v_candidatos);
  END IF;

  SELECT razon_social, bloqueado, bloqueado_motivo, score_actual, score_categoria,
         saldo_deuda, limite_credito
    INTO v_cliente
  FROM public.clientes
  WHERE empresa_id = p_empresa_id
    AND (razon_social ILIKE '%' || p_nombre || '%' OR nombre_fantasia ILIKE '%' || p_nombre || '%')
  LIMIT 1;

  RETURN jsonb_build_object(
    'encontrado', true,
    'cliente', v_cliente.razon_social,
    'bloqueado', COALESCE(v_cliente.bloqueado, false),
    'motivo_bloqueo', v_cliente.bloqueado_motivo,
    'score', v_cliente.score_actual,
    'score_categoria', v_cliente.score_categoria,
    'saldo_deuda', v_cliente.saldo_deuda,
    'limite_credito', v_cliente.limite_credito
  );
END;
$$;

-- ── 6. Ruta / entregas del día ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.consultar_ruta_dia(
  p_empresa_id     UUID,
  p_fecha          DATE DEFAULT CURRENT_DATE,
  p_chofer_nombre  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'fecha', p_fecha,
    'total_rutas', COUNT(DISTINCT r.id),
    'rutas', COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'chofer', u.nombre,
        'estado_ruta', r.estado,
        'entregas_total', ent.total,
        'entregas_pendientes', ent.pendientes,
        'entregas_confirmadas', ent.confirmadas
      )) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb)
  )
  FROM public.rutas r
  JOIN public.usuarios u ON u.id = r.chofer_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE e.estado = 'pendiente') AS pendientes,
      COUNT(*) FILTER (WHERE e.estado NOT IN ('pendiente')) AS confirmadas
    FROM public.entregas e
    WHERE e.ruta_id = r.id
  ) ent ON true
  WHERE r.empresa_id = p_empresa_id
    AND r.fecha = p_fecha
    AND (p_chofer_nombre IS NULL OR u.nombre ILIKE '%' || p_chofer_nombre || '%')
  LIMIT 1;
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.consultar_deuda_proveedor(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.listar_facturas_proveedor_por_vencer(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.listar_lotes_por_vencer(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.listar_cheques_alerta(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consultar_bloqueo_cliente(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consultar_ruta_dia(UUID, DATE, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.consultar_deuda_proveedor(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.listar_facturas_proveedor_por_vencer(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.listar_lotes_por_vencer(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.listar_cheques_alerta(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consultar_bloqueo_cliente(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consultar_ruta_dia(UUID, DATE, TEXT) TO service_role;

COMMENT ON FUNCTION public.consultar_deuda_proveedor IS
  'Tool del asistente: saldo pendiente con un proveedor puntual (búsqueda por nombre, scopeada por empresa).';
COMMENT ON FUNCTION public.listar_facturas_proveedor_por_vencer IS
  'Tool del asistente: facturas de proveedor pendientes/parciales que vencen en los próximos N días (máx. 20 filas mostradas, total_* es el real).';
COMMENT ON FUNCTION public.listar_lotes_por_vencer IS
  'Tool del asistente: lotes activos con stock disponible que vencen en los próximos N días (riesgo de liquidación; máx. 20 filas mostradas, total_* es el real).';
COMMENT ON FUNCTION public.listar_cheques_alerta IS
  'Tool del asistente: cheques rechazados o por vencer en los próximos N días (máx. 20 filas mostradas, total_* es el real).';
COMMENT ON FUNCTION public.consultar_bloqueo_cliente IS
  'Tool del asistente: estado de bloqueo, score y deuda de un cliente puntual (búsqueda por nombre, scopeada por empresa).';
COMMENT ON FUNCTION public.consultar_ruta_dia IS
  'Tool del asistente: rutas del día (opcionalmente filtradas por chofer) con resumen de entregas.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '203_asistente_tools_lectura.sql', '203', 'claude-session',
        'Fase 2 asistente: 6 RPCs de solo lectura para tool calling (deuda proveedor, facturas proveedor por vencer, lotes por vencer, cheques en alerta, bloqueo de cliente, ruta del día). Incluye desde el inicio el cap de 20 filas en las 3 funciones de listado (renumerada de 200 a 203 para no chocar con migraciones locales existentes).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
