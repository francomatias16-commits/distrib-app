-- =============================================================
-- 625_fn_rodar_pedidos_ciclos_demo_ventana_rodante
--
-- Mismo patrón que 605/606/607 (fn_rodar_lotes_trigger_demo,
-- fn_rodar_cheques_demo, fn_rodar_presupuestos_demo /
-- fn_rodar_reglas_precio_demo): fn_redistribuir_fechas_demo sí toca
-- `pedidos`, pero el delta que aplica es un hash fijo sobre el id de
-- cada fila (0..216 días) calculado siempre sobre la MISMA fecha base
-- del snapshot — no depende de CURRENT_DATE. Resultado: el calendario
-- de pedidos del demo es idéntico corrida tras corrida, y con el correr
-- de los días reales se va alejando cada vez más de "hoy".
--
-- Impacto real (reportado por el usuario): calcular_ciclos_cliente()
-- solo mira pedidos de "los últimos 6 meses" (relativo a now()) para
-- construir ciclos_compra, del cual depende la pantalla "Clientes en
-- fuga" (fn_clientes_en_fuga). Una vez que las compras repetidas de un
-- cliente/producto quedan fuera de esa ventana de 6 meses, ciclos_compra
-- deja de tener de dónde derivar el ciclo y la pantalla queda vacía —
-- siempre para los mismos clientes, todos los días, sin recuperarse
-- nunca sola (el reset restaura la misma foto vieja).
--
-- Fix: por cada cliente demo que tenga al menos un producto con >=3
-- compras históricas (mismo criterio de calcular_ciclos_cliente, pero
-- sin el filtro de 6 meses — es justo lo que se rompe con el tiempo),
-- se calcula UN delta en días para todo ese cliente y se aplica por
-- igual a todos sus pedidos reales (entregado/confirmado/despachado).
-- Al ser un desplazamiento uniforme, los intervalos relativos entre
-- compras (de los que depende el cálculo del ciclo) quedan exactamente
-- iguales — solo cambia en qué fecha de calendario caen. El delta se
-- elige para que la última compra quede lo bastante atrás como para
-- estar "en fuga" (más del 50% del intervalo típico de ese cliente,
-- que es lo que exige fn_clientes_en_fuga) pero sin salirse de la
-- ventana de 6 meses que necesita calcular_ciclos_cliente para poder
-- calcular el ciclo en primer lugar.
--
-- Límite conocido (mismo criterio que 605/606/607, que tampoco
-- cascadean a tablas relacionadas): esto solo mueve `pedidos`, no las
-- facturas/cta_cte/cobros asociados a esos pedidos puntuales — pueden
-- quedar con fecha desalineada respecto al pedido. No afecta a
-- "Clientes en fuga" (que no las usa), pero sí podría notarse si se
-- audita ese pedido puntual en otra pantalla.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_rodar_pedidos_ciclos_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id     uuid;
  v_rec            RECORD;
  v_offset_atraso  int;
  v_delta_dias     int;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar pedidos/ciclos';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

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
    -- Un delta por cliente (no por producto): si compró varios productos
    -- con ciclo propio, se toma el intervalo más largo de todos para
    -- fijar el atraso objetivo, así ningún ciclo del cliente queda
    -- "recién comprado" por error.
    SELECT
      cliente_id,
      MAX(ultima_compra) AS ultima_compra_cliente,
      MAX(intervalo_prom) AS intervalo_max
    FROM grupos
    GROUP BY cliente_id
  LOOP
    -- Atraso objetivo: bastante más que la mitad del intervalo más largo
    -- de este cliente (fn_clientes_en_fuga exige atraso > mitad del
    -- intervalo), acotado entre 5 y 150 días para no salirse nunca de
    -- la ventana de 6 meses (~180 días) que usa calcular_ciclos_cliente.
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

  -- Con las fechas ya frescas, recalcular ciclos ahora mismo — no hace
  -- falta esperar al cron de las 6:30 (/api/piloto?accion=recalcular-ciclos)
  -- para que "Clientes en fuga" muestre el efecto.
  PERFORM public.calcular_ciclos_cliente(v_empresa_id);
END;
$function$;

-- Enganchar en el reset periódico existente (mismo cron demo_reset_periodico,
-- cada 6h — no se crea ningún cron nuevo), después de fn_redistribuir_fechas_demo
-- para que esta corrección tenga la última palabra sobre las fechas de pedidos.
CREATE OR REPLACE FUNCTION public.fn_reset_demo_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := (SELECT id FROM public.empresas WHERE es_demo = true LIMIT 1);
  IF v_empresa_id IS NULL THEN
    RAISE NOTICE 'fn_reset_demo_cron: no hay ninguna empresa demo — nada que resetear';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.demo_snapshots WHERE empresa_id = v_empresa_id) THEN
    PERFORM public.fn_snapshot_demo_v2(v_empresa_id);
    RETURN;
  END IF;

  PERFORM public.fn_reset_demo_v2(v_empresa_id);
  PERFORM public.fn_redistribuir_fechas_demo(v_empresa_id);
  -- FIX 625: pedidos/ciclos_compra frescos para "Clientes en fuga" —
  -- ver comentario arriba.
  PERFORM public.fn_rodar_pedidos_ciclos_demo(v_empresa_id);
  PERFORM public.fn_generar_alertas_stock_autonomo(v_empresa_id);
  PERFORM public.fn_rodar_lotes_trigger_demo(v_empresa_id);
  PERFORM public.fn_rodar_cheques_demo(v_empresa_id);
  PERFORM public.fn_rodar_presupuestos_demo(v_empresa_id);
  PERFORM public.fn_rodar_reglas_precio_demo(v_empresa_id);
END;
$function$;
