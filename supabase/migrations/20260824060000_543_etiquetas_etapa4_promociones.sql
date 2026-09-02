-- ============================================================
-- 543 — Generador de etiquetas de precio/código de barras — Etapa 4:
--        precio promocional tachado usando reglas_precio.
-- ============================================================
--
-- Ver PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md, sección 6, Etapa 4
-- ("Precio tachado usando reglas_precio vigente para ese
-- producto/categoría/zona").
--
-- Motor de reglas ya existe (243_etapa2_motor_reglas_precio.sql,
-- resolver_precios_cliente) con pantalla de administración propia
-- (Admin → Descuentos automáticos, frontend/admin/reglas-precio.html) —
-- esta etapa NO duplica ese motor. Se agrega una función de resolución
-- dedicada porque resolver_precios_cliente() requiere un p_cliente_id
-- para poder resolver su zona, y una etiqueta física de góndola no
-- tiene cliente: es el mismo cartel para cualquiera que la lea. Por
-- eso acá solo se consideran reglas SIN zona (zona_id IS NULL,
-- "todas las zonas") y con cantidad_minima <= 1 (venta unitaria de
-- mostrador) — cualquier regla acotada a una zona o a un piso de
-- cantidad mayor no tiene forma de imprimirse en un único cartel
-- físico sin ambigüedad, así que se ignora acá (sigue aplicando
-- normalmente en POS/Pedidos vía resolver_precios_cliente).
--
-- También corrige un gap preexistente de la Etapa 1: config_etiquetas.
-- lista_precio_default_id se guardaba desde Admin → Hardware pero
-- nunca se usaba para resolver el precio impreso (obtenerProductosParaEtiquetas
-- siempre usaba productos.precio_base a secas) — se resuelve acá de
-- una vez, ya que el precio "regular" que se tacha tiene que ser el
-- mismo que la config dice que hay que imprimir.

-- ------------------------------------------------------------
-- 1. config_etiquetas.mostrar_promociones — mismo criterio que
--    incluir_iva: default de empresa, con override por impresión en
--    el modal de vista previa (frontend, no en esta migración).
-- ------------------------------------------------------------
ALTER TABLE public.config_etiquetas
  ADD COLUMN IF NOT EXISTS mostrar_promociones boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.config_etiquetas.mostrar_promociones IS
  'Etapa 4 (543): si hay una regla de precio general vigente para el producto, mostrarla tachada/promocional en la etiqueta. Default de empresa; se puede destildar por impresión en el modal de vista previa.';

-- ------------------------------------------------------------
-- 2. resolver_precios_etiquetas(): precio regular + promocional (si
--    corresponde) por producto, para el generador de etiquetas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolver_precios_etiquetas(
  p_empresa_id   uuid,
  p_producto_ids uuid[]
)
RETURNS TABLE(
  producto_id         uuid,
  precio_regular      numeric,
  precio_promocional  numeric,
  regla_id            uuid,
  regla_nombre        text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH cfg AS (
    SELECT lista_precio_default_id
    FROM config_etiquetas
    WHERE empresa_id = p_empresa_id
  ),
  base AS (
    SELECT
      prod.id           AS producto_id,
      prod.categoria_id AS categoria_id,
      -- Mismo orden de resolución que resolver_precios_cliente para el
      -- tramo lista→base (sin precios_clientes: una etiqueta no es de
      -- un cliente puntual, así que ese origen no aplica acá).
      COALESCE(pi.precio, prod.precio_base) AS precio_regular
    FROM unnest(p_producto_ids) AS pid(id)
    JOIN productos prod ON prod.id = pid.id AND prod.empresa_id = p_empresa_id
    LEFT JOIN cfg ON true
    LEFT JOIN precios_items pi
      ON pi.lista_id = cfg.lista_precio_default_id AND pi.producto_id = prod.id
  ),
  regla_candidata AS (
    SELECT
      b.producto_id,
      b.precio_regular,
      r.id     AS regla_id,
      r.nombre AS regla_nombre,
      CASE WHEN r.tipo_descuento = 'porcentaje'
           THEN round(b.precio_regular * (1 - r.valor / 100.0), 2)
           ELSE r.valor
      END AS precio_promocional,
      ROW_NUMBER() OVER (
        PARTITION BY b.producto_id
        ORDER BY
          (r.producto_id IS NOT NULL) DESC,  -- match directo a producto gana sobre categoría/general
          (r.categoria_id IS NOT NULL) DESC, -- match por categoría gana sobre general
          r.prioridad DESC,
          r.created_at DESC
      ) AS rn
    FROM base b
    JOIN reglas_precio r
      ON r.empresa_id = p_empresa_id
     AND r.activa = true
     AND r.zona_id IS NULL          -- sin zona: la etiqueta es un único cartel físico, no por cliente
     AND r.cantidad_minima <= 1     -- venta unitaria de mostrador (no hay "cantidad" en una góndola)
     AND (r.producto_id IS NULL OR r.producto_id = b.producto_id)
     AND (r.categoria_id IS NULL OR r.categoria_id = b.categoria_id)
     AND (r.fecha_desde IS NULL OR r.fecha_desde <= CURRENT_DATE)
     AND (r.fecha_hasta IS NULL OR r.fecha_hasta >= CURRENT_DATE)
  )
  SELECT
    b.producto_id,
    b.precio_regular,
    -- Nunca mostrar un "promocional" que sea igual o más caro que el
    -- regular (una regla de precio_fijo mal cargada, o una de 0%, no
    -- tiene que imprimir un tachado sin sentido).
    CASE WHEN rc.precio_promocional IS NOT NULL AND rc.precio_promocional < b.precio_regular
         THEN rc.precio_promocional
         ELSE NULL
    END AS precio_promocional,
    CASE WHEN rc.precio_promocional IS NOT NULL AND rc.precio_promocional < b.precio_regular
         THEN rc.regla_id
         ELSE NULL
    END AS regla_id,
    CASE WHEN rc.precio_promocional IS NOT NULL AND rc.precio_promocional < b.precio_regular
         THEN rc.regla_nombre
         ELSE NULL
    END AS regla_nombre
  FROM base b
  LEFT JOIN regla_candidata rc ON rc.producto_id = b.producto_id AND rc.rn = 1;
END;
$function$;

COMMENT ON FUNCTION public.resolver_precios_etiquetas(uuid, uuid[]) IS
  'Etapa 4 (543): precio regular (lista_precio_default_id de config_etiquetas, o precio_base) + precio promocional tachado si hay una reglas_precio activa general (sin zona, cantidad_minima<=1) vigente hoy para el producto o su categoría. Usado por obtenerProductosParaEtiquetas (lib/repos/productos.js).';

-- ------------------------------------------------------------
-- 3. Registro en la tabla de tracking de migraciones del proyecto.
--    (Se aprovecha para registrar también 20260824050000, la
--    migración de Etapa 1 de esta misma feature, que había quedado
--    sin fila acá — check-migraciones-registro.js la reportaba como
--    "sin registrar".)
-- ------------------------------------------------------------
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES
  (
    'supabase/migrations',
    '20260824050000_543_config_etiquetas.sql',
    '20260824050000',
    'claude_assistant',
    '543 Etapa 1: tabla config_etiquetas (singleton por empresa) + alta en fn_snapshot_demo_v2/fn_reset_demo_v2 (ord 56). Registrada acá retroactivamente — quedó sin fila cuando se aplicó.'
  ),
  (
    'supabase/migrations',
    '20260824060000_543_etiquetas_etapa4_promociones.sql',
    '20260824060000',
    'claude_assistant',
    '543 Etapa 4: config_etiquetas.mostrar_promociones + resolver_precios_etiquetas() (precio regular vía lista_precio_default_id/precio_base + precio promocional tachado vía reglas_precio general sin zona).'
  )
ON CONFLICT DO NOTHING;
