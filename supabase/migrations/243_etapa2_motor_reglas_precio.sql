-- ============================================================
-- 243_etapa2_motor_reglas_precio.sql
-- Etapa 2 (Comercial y precios) — Plan por etapas. Ítem 1/3:
-- Motor de reglas de precio por volumen/zona/temporada,
-- combinable con precios especiales de cliente y listas ya
-- existentes.
--
-- Cadena de resolución de precio (de más a menos específico):
--   1. precios_clientes   (precio puntual cliente+producto)      → origen 'especial'
--   2. reglas_precio      (volumen / zona / temporada, la que    → origen 'regla'
--      matchee mejor y sea más beneficiosa para el cliente)
--   3. precios_items      (precio de la lista asignada al cliente)→ origen 'lista'
--   4. productos.precio_base                                     → origen 'base'
--
-- Las promociones (tabla `promociones`, NxM / %desc) siguen
-- siendo un mecanismo aparte que se aplica sobre este precio ya
-- resuelto (se combinan, no se pisan) — no se tocan acá.
--
-- NOTA DE INTEGRACIÓN: esta migración ya estaba aplicada en producción
-- (version 20260708024924) pero no venía incluida en ninguno de los tres
-- paquetes recibidos (v242 etapa1, v243 etapa5, etapa4 compras
-- inteligentes). Se reconstruyó 1:1 desde pg_get_functiondef / el registro
-- de la DB para dejar el repo en paridad con producción. NO incluye código
-- de frontend/admin: no había ninguna pantalla para administrar
-- `reglas_precio` en ninguno de los tres paquetes — queda pendiente si
-- se quiere UI para altas/bajas de reglas.
-- ============================================================

-- ── 1. Tabla de reglas ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reglas_precio (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nombre           text NOT NULL,

  -- Alcance del producto: si ambos son NULL, la regla aplica a todo el catálogo.
  producto_id      uuid REFERENCES public.productos(id) ON DELETE CASCADE,
  categoria_id     uuid REFERENCES public.categorias(id) ON DELETE CASCADE,

  -- Alcance geográfico: NULL = todas las zonas.
  zona_id          uuid REFERENCES public.zonas(id) ON DELETE CASCADE,

  -- Volumen: cantidad mínima del ítem en el pedido/venta para que aplique.
  -- NULL o 1 = sin piso de cantidad.
  cantidad_minima  numeric NOT NULL DEFAULT 1 CHECK (cantidad_minima >= 1),

  -- Descuento: por porcentaje sobre el precio base resuelto, o precio fijo.
  tipo_descuento   text NOT NULL CHECK (tipo_descuento IN ('porcentaje', 'precio_fijo')),
  valor            numeric NOT NULL CHECK (valor >= 0),

  -- Temporada: NULL en cualquiera de los dos = sin límite en ese extremo.
  fecha_desde      date,
  fecha_hasta      date,

  -- Si varias reglas matchean igual de específico, gana la de mayor prioridad.
  prioridad        integer NOT NULL DEFAULT 0,

  activa           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reglas_precio_no_prod_y_cat CHECK (NOT (producto_id IS NOT NULL AND categoria_id IS NOT NULL)),
  CONSTRAINT reglas_precio_vigencia_valida CHECK (fecha_desde IS NULL OR fecha_hasta IS NULL OR fecha_desde <= fecha_hasta),
  CONSTRAINT reglas_precio_pct_rango CHECK (tipo_descuento <> 'porcentaje' OR valor <= 100)
);

CREATE INDEX IF NOT EXISTS idx_reglas_precio_empresa_activa
  ON public.reglas_precio(empresa_id, activa);
CREATE INDEX IF NOT EXISTS idx_reglas_precio_producto
  ON public.reglas_precio(producto_id) WHERE producto_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reglas_precio_categoria
  ON public.reglas_precio(categoria_id) WHERE categoria_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reglas_precio_zona
  ON public.reglas_precio(zona_id) WHERE zona_id IS NOT NULL;

COMMENT ON TABLE public.reglas_precio IS
  'Etapa 2 del plan por etapas (Comercial y precios): reglas de descuento por volumen/zona/temporada, combinables con precios de lista y precios especiales de cliente. Resueltas por resolver_precios_cliente().';

CREATE TRIGGER tg_reglas_precio_updated_at
  BEFORE UPDATE ON public.reglas_precio
  FOR EACH ROW EXECUTE FUNCTION public.tg_precios_clientes_updated_at();
  -- reutiliza el trigger genérico "set updated_at = now()" que ya usa precios_clientes

-- ── 2. RLS (mismo patrón que precios_clientes / listas_precios) ──
ALTER TABLE public.reglas_precio ENABLE ROW LEVEL SECURITY;

CREATE POLICY reglas_precio_select ON public.reglas_precio
  FOR SELECT
  USING (empresa_id = get_empresa_id());

CREATE POLICY reglas_precio_modify ON public.reglas_precio
  FOR ALL
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])
  )
  WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])
  );

-- ── 3. resolver_precios_cliente(): nueva versión con cantidad ────
-- Se agrega p_cantidades (paralelo a p_producto_ids, misma posición
-- por índice) para poder evaluar reglas de volumen. Es un cambio de
-- firma (3 args → 4 args), así que se elimina la versión vieja para
-- no dejar un overload zombie sin uso (mismo criterio que usaron en
-- 139_drop_zombie_crear_pedido_cliente_overload).
DROP FUNCTION IF EXISTS public.resolver_precios_cliente(uuid, uuid[], uuid);

CREATE OR REPLACE FUNCTION public.resolver_precios_cliente(
  p_cliente_id    uuid,
  p_producto_ids  uuid[],
  p_empresa_id    uuid,
  p_cantidades    numeric[] DEFAULT NULL  -- paralelo a p_producto_ids; si es NULL, se asume 1 para todos
)
RETURNS TABLE(
  producto_id     uuid,
  precio          numeric,
  origen          text,
  regla_id        uuid,
  regla_nombre    text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_zona_id uuid;
BEGIN
  SELECT cli.zona_id INTO v_zona_id FROM clientes cli WHERE cli.id = p_cliente_id;

  RETURN QUERY
  WITH entrada AS (
    -- reconstruye producto_id + cantidad por índice; si no vino p_cantidades
    -- (llamadas viejas que no lo pasen), se asume cantidad = 1
    SELECT
      prod_id,
      COALESCE(p_cantidades[ix], 1) AS cantidad
    FROM unnest(p_producto_ids) WITH ORDINALITY AS u(prod_id, ix)
  ),
  base AS (
    SELECT
      prod.id                AS producto_id,
      prod.categoria_id      AS categoria_id,
      e.cantidad              AS cantidad,
      COALESCE(pc.precio, pi.precio, prod.precio_base) AS precio_base_resuelto,
      CASE
        WHEN pc.precio IS NOT NULL THEN 'especial'
        WHEN pi.precio IS NOT NULL THEN 'lista'
        ELSE 'base'
      END AS origen_base
    FROM entrada e
    JOIN productos prod ON prod.id = e.prod_id AND prod.empresa_id = p_empresa_id
    LEFT JOIN precios_clientes pc
      ON pc.cliente_id = p_cliente_id AND pc.producto_id = prod.id
    LEFT JOIN clientes cli
      ON cli.id = p_cliente_id
    LEFT JOIN precios_items pi
      ON pi.lista_id = cli.lista_precio_id AND pi.producto_id = prod.id
  ),
  regla_candidata AS (
    -- reglas que matchean cada producto+cantidad, priorizando especificidad
    SELECT
      b.producto_id,
      b.precio_base_resuelto,
      b.origen_base,
      r.id    AS regla_id,
      r.nombre AS regla_nombre,
      CASE WHEN r.tipo_descuento = 'porcentaje'
           THEN round(b.precio_base_resuelto * (1 - r.valor / 100.0), 2)
           ELSE r.valor
      END AS precio_con_regla,
      ROW_NUMBER() OVER (
        PARTITION BY b.producto_id
        ORDER BY
          (r.producto_id IS NOT NULL) DESC,   -- match directo a producto gana sobre categoría/general
          (r.categoria_id IS NOT NULL) DESC,  -- match por categoría gana sobre general
          (r.zona_id IS NOT NULL) DESC,       -- match específico de zona gana sobre "todas las zonas"
          r.cantidad_minima DESC,             -- entre las que matchean, la de mayor piso de cantidad gana
          r.prioridad DESC,
          r.created_at DESC
      ) AS rn
    FROM base b
    JOIN reglas_precio r
      ON r.empresa_id = p_empresa_id
     AND r.activa = true
     AND (r.producto_id IS NULL OR r.producto_id = b.producto_id)
     AND (r.categoria_id IS NULL OR r.categoria_id = b.categoria_id)
     AND (r.zona_id IS NULL OR r.zona_id = v_zona_id)
     AND r.cantidad_minima <= b.cantidad
     AND (r.fecha_desde IS NULL OR r.fecha_desde <= CURRENT_DATE)
     AND (r.fecha_hasta IS NULL OR r.fecha_hasta >= CURRENT_DATE)
  )
  SELECT
    b.producto_id,
    COALESCE(rc.precio_con_regla, b.precio_base_resuelto) AS precio,
    CASE WHEN rc.regla_id IS NOT NULL THEN 'regla' ELSE b.origen_base END AS origen,
    rc.regla_id,
    rc.regla_nombre
  FROM base b
  LEFT JOIN regla_candidata rc ON rc.producto_id = b.producto_id AND rc.rn = 1;
END;
$function$;

COMMENT ON FUNCTION public.resolver_precios_cliente(uuid, uuid[], uuid, numeric[]) IS
  'Resuelve el precio final por producto para un cliente dado, en orden de prioridad: precio especial de cliente > mejor regla de precio (volumen/zona/temporada) > precio de lista > precio base. p_cantidades es opcional y paralelo a p_producto_ids (se asume 1 si no se pasa). Usado por pos.js y pedidos.js.';

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '243_etapa2_motor_reglas_precio.sql',
  '243',
  'claude_assistant',
  'Etapa 2 del plan por etapas (Comercial y precios), ítem 1/3: tabla reglas_precio (volumen/zona/temporada) + resolver_precios_cliente() extendida con p_cantidades para poder evaluar reglas de volumen. Reemplaza el overload viejo de 3 argumentos.'
)
ON CONFLICT DO NOTHING;
