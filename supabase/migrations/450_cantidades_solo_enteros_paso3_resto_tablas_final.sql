-- 450_cantidades_solo_enteros_paso3_resto_tablas_final.sql
-- Ya aplicada en producción el 2026-08-09 (Supabase migration
-- 20260809212038 "690_cantidades_solo_enteros_paso5_resto_tablas_final").
-- Se agrega al repo por trazabilidad; NO reaplicar manualmente.
-- Continúa 449_cantidades_solo_enteros_paso2_stock.sql: convierte a
-- integer el resto de las columnas de cantidad del sistema y elimina
-- los triggers/funciones de validación "cantidad entera" que ya
-- quedan redundantes (el tipo de columna lo garantiza).

BEGIN;

DROP VIEW IF EXISTS public.v_rentabilidad_producto;
DROP VIEW IF EXISTS public.v_rentabilidad_vendedor;
DROP VIEW IF EXISTS public.v_rentabilidad_zona_ruta;

ALTER TABLE public.lotes
  ALTER COLUMN cantidad             TYPE integer USING round(cantidad)::integer,
  ALTER COLUMN cantidad_disponible  TYPE integer USING round(cantidad_disponible)::integer,
  ALTER COLUMN cantidad_reservada   TYPE integer USING round(cantidad_reservada)::integer;

ALTER TABLE public.movimientos_stock
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;

ALTER TABLE public.producto_insumos
  ALTER COLUMN cantidad_por_unidad TYPE integer USING round(cantidad_por_unidad)::integer;

ALTER TABLE public.ordenes_compra_items
  ALTER COLUMN cantidad          TYPE integer USING round(cantidad)::integer,
  ALTER COLUMN cantidad_recibida TYPE integer USING round(cantidad_recibida)::integer;

ALTER TABLE public.pedido_items
  ALTER COLUMN cantidad           TYPE integer USING round(cantidad)::integer,
  ALTER COLUMN cantidad_entregada TYPE integer USING round(cantidad_entregada)::integer;

ALTER TABLE public.presupuesto_items
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;

ALTER TABLE public.venta_pos_items
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;

ALTER TABLE public.carrito_items
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;

ALTER TABLE public.devolucion_items
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;

ALTER TABLE public.devoluciones_pos_items
  ALTER COLUMN cantidad_devuelta TYPE integer USING round(cantidad_devuelta)::integer;

ALTER TABLE public.notas_credito_items
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;

-- facturas_proveedor_items.subtotal es columna generada desde cantidad —
-- sacarla, convertir cantidad, y recrearla igual.
ALTER TABLE public.facturas_proveedor_items DROP COLUMN subtotal;
ALTER TABLE public.facturas_proveedor_items
  ALTER COLUMN cantidad TYPE integer USING round(cantidad)::integer;
ALTER TABLE public.facturas_proveedor_items
  ADD COLUMN subtotal numeric GENERATED ALWAYS AS (cantidad * precio_unitario) STORED;

ALTER TABLE public.conteos_stock
  ALTER COLUMN cantidad_contada TYPE integer USING round(cantidad_contada)::integer,
  ALTER COLUMN cantidad_sistema TYPE integer USING round(cantidad_sistema)::integer;

ALTER TABLE public.ofertas_liquidacion
  ALTER COLUMN cantidad_snapshot TYPE integer USING round(cantidad_snapshot)::integer;

ALTER TABLE public.reglas_precio
  ALTER COLUMN cantidad_minima TYPE integer USING round(cantidad_minima)::integer;

DROP TRIGGER IF EXISTS trg_movstock_cantidad_entera  ON public.movimientos_stock;
DROP TRIGGER IF EXISTS trg_lotes_cantidad_entera     ON public.lotes;
DROP TRIGGER IF EXISTS trg_ocitems_cantidad_entera   ON public.ordenes_compra_items;

DROP FUNCTION IF EXISTS public.trg_fn_stock_cantidad_entera();
DROP FUNCTION IF EXISTS public.trg_fn_movstock_cantidad_entera();
DROP FUNCTION IF EXISTS public.trg_fn_lotes_cantidad_entera();
DROP FUNCTION IF EXISTS public.trg_fn_ocitems_cantidad_entera();
DROP FUNCTION IF EXISTS public.fn_check_cantidad_entera(uuid, numeric, text);

CREATE VIEW public.v_rentabilidad_producto AS
 WITH lineas AS (
         SELECT p.empresa_id,
            pi.producto_id,
            COALESCE(p.fecha_entrega, p.fecha_pedido::date) AS fecha,
            COALESCE(pi.cantidad_entregada, pi.cantidad) AS cantidad,
            COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario AS facturado,
            COALESCE(pi.cantidad_entregada, pi.cantidad) * (pi.precio_unitario - COALESCE(pr_1.costo, 0::numeric)) AS margen,
            'pedido'::text AS origen
           FROM pedidos p
             JOIN pedido_items pi ON pi.pedido_id = p.id
             JOIN productos pr_1 ON pr_1.id = pi.producto_id
          WHERE p.estado = 'entregado'::estado_pedido
        UNION ALL
         SELECT vp.empresa_id,
            vpi.producto_id,
            vp.created_at::date AS fecha,
            vpi.cantidad,
            vpi.cantidad * vpi.precio_unitario AS facturado,
            vpi.cantidad * (vpi.precio_unitario - COALESCE(pr_1.costo, 0::numeric)) AS margen,
            'pos'::text AS origen
           FROM ventas_pos vp
             JOIN venta_pos_items vpi ON vpi.venta_pos_id = vp.id
             JOIN productos pr_1 ON pr_1.id = vpi.producto_id
          WHERE vp.estado = 'completada'::text
        )
 SELECT l.empresa_id,
    l.producto_id,
    pr.nombre AS producto_nombre,
    pr.codigo AS producto_codigo,
    pr.categoria_id,
    cat.nombre AS categoria_nombre,
    l.fecha,
    l.origen,
    sum(l.cantidad) AS cantidad_vendida,
    sum(l.facturado) AS facturado_total,
    sum(l.margen) AS margen_total,
        CASE
            WHEN sum(l.facturado) > 0::numeric THEN round(sum(l.margen) / sum(l.facturado) * 100::numeric, 2)
            ELSE NULL::numeric
        END AS margen_pct
   FROM lineas l
     JOIN productos pr ON pr.id = l.producto_id
     LEFT JOIN categorias cat ON cat.id = pr.categoria_id
  GROUP BY l.empresa_id, l.producto_id, pr.nombre, pr.codigo, pr.categoria_id, cat.nombre, l.fecha, l.origen
  ORDER BY l.fecha DESC;

CREATE VIEW public.v_rentabilidad_vendedor AS
 WITH lineas AS (
         SELECT p.empresa_id,
            p.vendedor_id,
            p.id AS doc_id,
            COALESCE(p.fecha_entrega, p.fecha_pedido::date) AS fecha,
            COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario AS facturado,
            COALESCE(pi.cantidad_entregada, pi.cantidad) * (pi.precio_unitario - COALESCE(pr.costo, 0::numeric)) AS margen,
            'pedido'::text AS origen
           FROM pedidos p
             JOIN pedido_items pi ON pi.pedido_id = p.id
             JOIN productos pr ON pr.id = pi.producto_id
          WHERE p.estado = 'entregado'::estado_pedido
        UNION ALL
         SELECT vp.empresa_id,
            vp.vendedor_id,
            vp.id AS doc_id,
            vp.created_at::date AS fecha,
            vpi.cantidad * vpi.precio_unitario AS facturado,
            vpi.cantidad * (vpi.precio_unitario - COALESCE(pr.costo, 0::numeric)) AS margen,
            'pos'::text AS origen
           FROM ventas_pos vp
             JOIN venta_pos_items vpi ON vpi.venta_pos_id = vp.id
             JOIN productos pr ON pr.id = vpi.producto_id
          WHERE vp.estado = 'completada'::text
        )
 SELECT l.empresa_id,
    l.vendedor_id,
    u.nombre AS vendedor_nombre,
    l.fecha,
    l.origen,
    count(DISTINCT l.doc_id) AS documentos,
    sum(l.facturado) AS facturado_total,
    sum(l.margen) AS margen_total,
        CASE
            WHEN sum(l.facturado) > 0::numeric THEN round(sum(l.margen) / sum(l.facturado) * 100::numeric, 2)
            ELSE NULL::numeric
        END AS margen_pct
   FROM lineas l
     LEFT JOIN usuarios u ON u.id = l.vendedor_id
  GROUP BY l.empresa_id, l.vendedor_id, u.nombre, l.fecha, l.origen
  ORDER BY l.fecha DESC;

CREATE VIEW public.v_rentabilidad_zona_ruta AS
 WITH margen_entrega AS (
         SELECT e.id AS entrega_id,
            e.ruta_id,
            e.distancia_km,
            e.duracion_minutos,
            e.estado AS estado_entrega,
            p.cliente_id,
            sum(COALESCE(pi.cantidad_entregada, pi.cantidad) * (pi.precio_unitario - COALESCE(pr.costo, 0::numeric))) AS margen_entrega,
            sum(COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario) AS facturado_entrega
           FROM entregas e
             JOIN pedidos p ON p.id = e.pedido_id
             JOIN pedido_items pi ON pi.pedido_id = p.id
             JOIN productos pr ON pr.id = pi.producto_id
          WHERE e.estado = 'entregado'::text
          GROUP BY e.id, e.ruta_id, e.distancia_km, e.duracion_minutos, e.estado, p.cliente_id
        ), costo_km_empresa AS (
         SELECT empresas.id AS empresa_id,
            COALESCE((empresas.config ->> 'costo_km'::text)::numeric, 0::numeric) AS costo_km
           FROM empresas
        )
 SELECT rt.empresa_id,
    z.id AS zona_id,
    z.nombre AS zona_nombre,
    rt.id AS ruta_id,
    rt.fecha AS ruta_fecha,
    rt.chofer_id,
    count(DISTINCT me.entrega_id) AS entregas_completadas,
    sum(me.margen_entrega) AS margen_total,
    sum(me.facturado_entrega) AS facturado_total,
    sum(me.distancia_km) AS km_recorridos,
    sum(me.duracion_minutos) AS minutos_recorridos,
    ck.costo_km AS costo_km_configurado,
    round(sum(me.distancia_km) * ck.costo_km, 2) AS costo_logistico_estimado,
    round(sum(me.margen_entrega) - sum(me.distancia_km) * ck.costo_km, 2) AS margen_neto_estimado,
        CASE
            WHEN sum(me.distancia_km) > 0::numeric THEN round((sum(me.margen_entrega) - sum(me.distancia_km) * ck.costo_km) / sum(me.distancia_km), 2)
            ELSE NULL::numeric
        END AS margen_neto_por_km
   FROM margen_entrega me
     JOIN rutas rt ON rt.id = me.ruta_id
     JOIN clientes c ON c.id = me.cliente_id
     LEFT JOIN zonas z ON z.id = c.zona_id
     JOIN costo_km_empresa ck ON ck.empresa_id = rt.empresa_id
  GROUP BY rt.empresa_id, z.id, z.nombre, rt.id, rt.fecha, rt.chofer_id, ck.costo_km
  ORDER BY rt.fecha DESC, (round(sum(me.margen_entrega) - sum(me.distancia_km) * ck.costo_km, 2)) DESC;

COMMIT;

NOTIFY pgrst, 'reload schema';
