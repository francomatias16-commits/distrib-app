-- 427_asistente_cobros.sql
-- Tool del asistente: listar_cobros
-- Cierra brecha funcional: cobros (con su detalle de aplicación a
-- facturas en cobro_facturas_aplicadas) se usa activamente en el
-- sistema, pero el asistente no tenía tool para consultarla.
--
-- Scope de seguridad: cobros tiene empresa_id propio (igual que
-- ordenes_compra/movimientos_caja/conteos_stock), no hace falta
-- resolver vía join. Cap de 20 filas mostradas; total_cobros es el
-- conteo real. No hay CHECK constraint sobre medio (texto libre).
-- clientes NO tiene columna 'nombre' (tiene razon_social y
-- nombre_fantasia, mismo patrón que proveedores) — se resuelve con
-- COALESCE, verificado contra la base real antes de aplicar.

CREATE OR REPLACE FUNCTION public.listar_cobros(
  p_empresa_id UUID,
  p_cliente    TEXT DEFAULT NULL,
  p_medio      TEXT DEFAULT NULL,
  p_dias       INT  DEFAULT 30
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      c.id, c.monto, c.medio, c.referencia, c.notas, c.fecha,
      c.conciliado_bancario,
      COALESCE(cl.nombre_fantasia, cl.razon_social) AS cliente_nombre,
      u.nombre AS usuario_nombre,
      (
        SELECT jsonb_agg(jsonb_build_object(
          'factura', f.numero,
          'monto_aplicado', cfa.monto_aplicado
        ))
        FROM public.cobro_facturas_aplicadas cfa
        JOIN public.facturas f ON f.id = cfa.factura_id
        WHERE cfa.cobro_id = c.id
      ) AS facturas_aplicadas
    FROM public.cobros c
    JOIN public.clientes cl ON cl.id = c.cliente_id
    LEFT JOIN public.usuarios u ON u.id = c.usuario_id
    WHERE c.empresa_id = p_empresa_id
      AND c.fecha >= CURRENT_DATE - GREATEST(p_dias, 0)
      AND (p_cliente IS NULL OR COALESCE(cl.nombre_fantasia, cl.razon_social) ILIKE '%' || p_cliente || '%')
      AND (p_medio IS NULL OR c.medio = p_medio)
  ), top AS (
    SELECT * FROM filas ORDER BY fecha DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_cobros', (SELECT COUNT(*) FROM filas),
    'cobros_mostrados', (SELECT COUNT(*) FROM top),
    'monto_total', (SELECT COALESCE(SUM(monto), 0) FROM filas),
    'cobros', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'cliente', cliente_nombre,
        'monto', monto,
        'medio', medio,
        'referencia', referencia,
        'notas', notas,
        'conciliado_bancario', conciliado_bancario,
        'facturas_aplicadas', COALESCE(facturas_aplicadas, '[]'::jsonb),
        'usuario', usuario_nombre,
        'fecha', fecha
      ) ORDER BY fecha DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.listar_cobros(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_cobros(UUID, TEXT, TEXT, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.listar_cobros(UUID, TEXT, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.listar_cobros(UUID, TEXT, TEXT, INT) FROM authenticated;

COMMENT ON FUNCTION public.listar_cobros IS
  'Tool del asistente: historial de cobros a clientes en los últimos N días, opcionalmente filtrado por cliente y/o medio de pago, incluyendo el detalle de facturas a las que se aplicó cada cobro (máx. 20 filas mostradas, total_cobros es el real). Grants explícitos a anon/authenticated revocados en la misma migración por default privileges del proyecto.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '427_asistente_cobros.sql', '427', 'claude-session',
        'Cierra brecha funcional detectada: cobros (con su detalle en cobro_facturas_aplicadas) se usa en el sistema pero el asistente no tenía tool para consultarla. Agrega RPC listar_cobros (scopeada por empresa_id directo, cap 20 filas, monto_total del período, detalle de facturas aplicadas por cobro) y su entrada correspondiente en lib/asistente-tools.js. clientes no tiene columna nombre (usa COALESCE(nombre_fantasia, razon_social), mismo patrón que proveedores, verificado contra la base real). Incluye revoke explícito de anon/authenticated desde el inicio (lección de 423b).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
