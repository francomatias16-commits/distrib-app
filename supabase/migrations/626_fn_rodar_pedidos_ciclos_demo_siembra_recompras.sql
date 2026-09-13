-- =============================================================
-- 626_fn_rodar_pedidos_ciclos_demo_siembra_recompras
--
-- Continuación directa de 625 (fn_rodar_pedidos_ciclos_demo).
-- Verificado en vivo contra la empresa demo (Distribuidora del
-- Litoral): 625 corrió sin error, pero ciclos_compra siguió en 0.
-- Causa real: sobre los 36 pedidos válidos de esta empresa, ningún
-- cliente tiene 2 compras del mismo producto, y ninguno llega a 3
-- -- el dataset demo nunca tuvo cargado ese patrón de recompra. No
-- es un problema de fechas (lo que arregla 625): calcular_ciclos_
-- cliente exige >=3 compras del mismo producto por cliente con
-- intervalo positivo, y hoy no hay de dónde derivar eso.
--
-- Fix (agrega un paso 0 a fn_rodar_pedidos_ciclos_demo, antes del
-- rodado de fechas que ya existía): para cada cliente demo con al
-- menos 1 pedido válido pero sin ningún producto con >=3 compras,
-- se toma su producto más comprado (empate: el de compra más
-- reciente) y se insertan las compras sintéticas que falten para
-- llegar a 3 -- mismos cantidad/precio/vendedor/canal promedio de
-- su propia compra real, para no inventar datos ajenos al cliente.
-- Se fechan ANTES de su primera compra real de ese producto, así
-- la última compra real (la que ancla el resto de esta función y
-- "Clientes en fuga") no se toca.
--
-- Intervalo entre compras sintéticas: fijo en 21 días. No hay con
-- qué calcular uno real (por definición, el cliente no tiene 2+
-- compras de ese producto todavía) -- se usa un ciclo de reposición
-- típico de distribución mayorista B2B como aproximación
-- deliberada y documentada, solo para desbloquear el cálculo real
-- de ciclos_compra sobre el resto de los datos (que sí son reales).
--
-- Idempotente entre corridas de demo: fn_reset_demo_v2 restaura el
-- snapshot (que no incluye estas filas sintéticas) antes de que
-- esta función corra dentro de fn_reset_demo_cron, así que cada
-- ciclo de 6h parte de cero -- no se acumulan pedidos de más con
-- el correr de los días.
--
-- Límite conocido (mismo criterio que 605/606/607/625, que tampoco
-- cascadean): los pedidos sintéticos no generan factura/cta_cte/
-- cobro asociados, ni movimientos de stock -- son pedidos
-- "entregado" solo a nivel de la tabla pedidos + pedido_items, que
-- es todo lo que necesitan calcular_ciclos_cliente y "Clientes en
-- fuga". Si se audita alguno de estos pedidos puntuales desde otra
-- pantalla (ej. rentabilidad por producto), va a sumar de más esa
-- venta -- aceptado, mismo trade-off que ya existe en 605/606/607.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_rodar_pedidos_ciclos_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id      uuid;
  v_rec             RECORD;
  v_top             RECORD;
  v_offset_atraso   int;
  v_delta_dias      int;
  v_faltantes       int;
  v_intervalo_seed  CONSTANT int := 21;
  v_pedido_id       uuid;
  v_fecha_seed      timestamptz;
  v_cantidad_final  int;
  v_precio_final    numeric;
  v_subtotal        numeric;
  v_iva_pct         numeric;
  v_iva_monto       numeric;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar pedidos/ciclos';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- ---------------------------------------------------------
  -- PASO 0 (nuevo): sembrar recompras sintéticas faltantes.
  -- Ver comentario de cabecera.
  -- ---------------------------------------------------------
  FOR v_top IN
    WITH compras_cliente_producto AS (
      SELECT
        p.cliente_id,
        pi.producto_id,
        COUNT(*)                       AS veces,
        AVG(pi.cantidad)               AS cantidad_prom,
        AVG(pi.precio_unitario)        AS precio_prom,
        MIN(p.fecha_pedido)            AS primera_compra,
        (ARRAY_AGG(p.vendedor_id ORDER BY p.fecha_pedido DESC))[1] AS algun_vendedor_id,
        (ARRAY_AGG(p.canal ORDER BY p.fecha_pedido DESC))[1]       AS algun_canal
      FROM pedidos p
      JOIN pedido_items pi ON pi.pedido_id = p.id
      WHERE p.empresa_id = v_empresa_id
        AND p.estado IN ('entregado', 'confirmado', 'despachado')
      GROUP BY p.cliente_id, pi.producto_id
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY cliente_id ORDER BY veces DESC, primera_compra DESC
        ) AS rn
      FROM compras_cliente_producto
    ),
    clientes_calificados AS (
      -- Mismo criterio que usa el paso 1 más abajo (y calcular_
      -- ciclos_cliente): ya tienen de dónde derivar un ciclo, no
      -- tocar.
      SELECT cliente_id FROM compras_cliente_producto WHERE veces >= 3
    )
    SELECT r.cliente_id, r.producto_id, r.veces, r.cantidad_prom,
           r.precio_prom, r.primera_compra, r.algun_vendedor_id, r.algun_canal
    FROM ranked r
    WHERE r.rn = 1
      AND r.cliente_id NOT IN (SELECT cliente_id FROM clientes_calificados)
  LOOP
    v_faltantes := 3 - v_top.veces;
    CONTINUE WHEN v_faltantes <= 0;

    SELECT iva INTO v_iva_pct FROM productos WHERE id = v_top.producto_id;
    v_iva_pct        := COALESCE(v_iva_pct, 21);
    v_cantidad_final := GREATEST(ROUND(COALESCE(v_top.cantidad_prom, 1))::int, 1);
    v_precio_final   := ROUND(COALESCE(v_top.precio_prom, 0), 2);
    v_subtotal       := v_cantidad_final * v_precio_final;
    v_iva_monto      := ROUND(v_subtotal * v_iva_pct / 100, 2);

    FOR i IN 1..v_faltantes LOOP
      v_fecha_seed := v_top.primera_compra - (v_intervalo_seed * i || ' days')::interval;

      INSERT INTO pedidos (
        empresa_id, cliente_id, vendedor_id, estado,
        subtotal, descuento, iva_total, total,
        fecha_pedido, fecha_entrega, entregado_at,
        created_at, updated_at, canal
      )
      VALUES (
        v_empresa_id, v_top.cliente_id, v_top.algun_vendedor_id, 'entregado',
        v_subtotal, 0, v_iva_monto, v_subtotal + v_iva_monto,
        v_fecha_seed, v_fecha_seed::date, v_fecha_seed,
        v_fecha_seed, v_fecha_seed, COALESCE(v_top.algun_canal, 'web')
      )
      RETURNING id INTO v_pedido_id;

      INSERT INTO pedido_items (
        pedido_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
      )
      VALUES (
        v_pedido_id, v_top.producto_id, v_cantidad_final, v_precio_final, 0, v_subtotal
      );
    END LOOP;
  END LOOP;

  -- ---------------------------------------------------------
  -- PASO 1 (existente, sin cambios): un delta por cliente para
  -- que la última compra caiga "en fuga" sin salirse de la
  -- ventana de 6 meses. Corre después del paso 0 así que también
  -- alcanza a las compras sintéticas recién insertadas -- quedan
  -- todas desplazadas por igual, junto con el resto del historial
  -- real del cliente.
  -- ---------------------------------------------------------
  FOR v_rec IN
    WITH pares AS (
      SELECT
        p.cliente_id,
        pi2.producto_id,
        p.fecha_pedido,
        LAG(p.fecha_pedido) OVER (
          PARTITION BY p.cliente_id, pi2.producto_id ORDER BY p.fecha_pedido
        ) AS fecha_anterior
      FROM pedidos p
      JOIN pedido_items pi2 ON pi2.pedido_id = p.id
      WHERE p.empresa_id = v_empresa_id
        AND p.estado IN ('entregado', 'confirmado', 'despachado')
    ),
    grupos AS (
      SELECT
        cliente_id,
        producto_id,
        COUNT(*) AS total,
        AVG(EXTRACT(EPOCH FROM (fecha_pedido - fecha_anterior)) / 86400) AS intervalo_prom,
        MAX(fecha_pedido) AS ultima_compra
      FROM pares
      WHERE fecha_anterior IS NOT NULL
      GROUP BY cliente_id, producto_id
      HAVING COUNT(*) >= 3
         AND AVG(EXTRACT(EPOCH FROM (fecha_pedido - fecha_anterior)) / 86400) > 0
    )
    SELECT
      cliente_id,
      MAX(ultima_compra) AS ultima_compra_cliente,
      MAX(intervalo_prom) AS intervalo_max
    FROM grupos
    GROUP BY cliente_id
  LOOP
    v_offset_atraso := LEAST(GREATEST(CEIL(v_rec.intervalo_max * 0.8)::int, 5), 150);
    v_delta_dias := (CURRENT_DATE - v_offset_atraso) - v_rec.ultima_compra_cliente::date;

    IF v_delta_dias <> 0 THEN
      UPDATE pedidos
      SET fecha_pedido = fecha_pedido + (v_delta_dias || ' days')::interval,
          created_at   = created_at   + (v_delta_dias || ' days')::interval
      WHERE empresa_id = v_empresa_id
        AND cliente_id = v_rec.cliente_id
        AND estado IN ('entregado', 'confirmado', 'despachado');
    END IF;
  END LOOP;

  -- Con las fechas ya frescas (reales + sintéticas), recalcular
  -- ciclos ahora mismo -- no hace falta esperar al cron de las
  -- 6:30 para que "Clientes en fuga" muestre el efecto.
  PERFORM public.calcular_ciclos_cliente(v_empresa_id);
END;
$function$;
