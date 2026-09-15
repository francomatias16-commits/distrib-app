-- 630_sync_entregas_rutas_desde_estado_pedido.sql
--
-- PROBLEMA
-- La pantalla de Repartos (frontend/admin/js/rutas.js) se alimenta 100% de
-- `entregas.estado` y `rutas.estado`; nunca lee `pedidos.estado`. La única
-- pieza de código que sincronizaba esas tablas al cambiar el estado de un
-- pedido vivía en `PATCH /api/pedidos` (lib/handlers/pedidos/index.js, fix
-- v1086) — pero la pantalla de Pedidos NUNCA llama a ese endpoint:
-- `cambiarEstado()` escribe con supabase-js directo (`despachado`,
-- `entregado`) o vía RPC (`confirmar_pedido`, `marcar_preparado`,
-- `cancelar_pedido`), y ninguna de esas rutas toca `entregas`/`rutas`.
-- Verificado además que ninguna de esas 3 RPC menciona `entregas`/`rutas` y
-- que no existía ningún trigger sobre `pedidos` que lo hiciera.
--
-- Consecuencias observadas en producción:
--   * 30 entregas en 'pendiente' con el pedido ya en 'entregado'.
--   * `entregas.estado = 'en_camino'` era un estado muerto: ningún camino de
--     código lo escribía nunca, así que despachar no movía la parada.
--   * Cancelar un pedido dejaba la entrega activa para siempre: la ruta nunca
--     podía pasar a 'completada' y el pedido quedaba bloqueado como
--     "ya en ruta" para futuras asignaciones.
--
-- DECISIÓN
-- La sincronización se baja a la base de datos (trigger) en vez de
-- replicarse en cada call site. Así queda garantizada venga el cambio de
-- donde venga: UI de Pedidos, PATCH admin, portal del chofer, asistente por
-- voz, replay offline o un UPDATE manual. `sincronizarEstadoRuta()` en JS se
-- deja como está — pasa a ser redundante pero idempotente.

-- ── 1. Recalcular el estado de una ruta a partir de sus entregas ──────────
-- Espejo exacto de sincronizarEstadoRuta() (lib/handlers/pedidos/_helpers.js),
-- incluido el reporte de eficiencia que v1086/Kello generaban desde JS.
CREATE OR REPLACE FUNCTION public.fn_sync_estado_ruta(p_ruta_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_estado_actual TEXT;
  v_total         INT;
  v_terminales    INT;
  v_iniciadas     INT;
  v_nuevo         TEXT;
BEGIN
  IF p_ruta_id IS NULL THEN RETURN; END IF;

  SELECT estado INTO v_estado_actual FROM rutas WHERE id = p_ruta_id;

  -- Nunca pisar una ruta cancelada o ya completada.
  IF v_estado_actual IS NULL OR v_estado_actual IN ('cancelada', 'completada') THEN
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE estado IN ('entregado', 'no_entregado')),
         count(*) FILTER (WHERE estado IN ('entregado', 'no_entregado', 'en_camino'))
    INTO v_total, v_terminales, v_iniciadas
    FROM entregas
   WHERE ruta_id = p_ruta_id;

  IF v_total = 0 THEN RETURN; END IF;

  IF v_terminales = v_total THEN
    v_nuevo := 'completada';
  ELSIF v_iniciadas > 0 AND v_estado_actual = 'pendiente' THEN
    v_nuevo := 'en_camino';
  ELSE
    RETURN;
  END IF;

  IF v_nuevo = v_estado_actual THEN RETURN; END IF;

  UPDATE rutas SET estado = v_nuevo WHERE id = p_ruta_id;

  -- Reporte de eficiencia: misma lógica que generarReporteEficienciaRuta()
  -- (lib/repos/rutas.js). Se genera acá para que exista aunque la ruta se
  -- complete por un camino que no pasa por el backend Node.
  IF v_nuevo = 'completada' THEN
    INSERT INTO reportes_ruta (
      ruta_id, empresa_id, chofer_id, total_paradas, entregadas,
      no_entregadas, km_estimados, tiempo_total_min, pct_completitud
    )
    SELECT r.id,
           r.empresa_id,
           r.chofer_id,
           count(e.*),
           count(*) FILTER (WHERE e.estado = 'entregado'),
           count(e.*) - count(*) FILTER (WHERE e.estado = 'entregado'),
           COALESCE(sum(e.distancia_km), 0),
           COALESCE(sum(e.duracion_minutos), 0),
           CASE WHEN count(e.*) > 0
                THEN count(*) FILTER (WHERE e.estado = 'entregado')::NUMERIC / count(e.*) * 100
                ELSE 0 END
      FROM rutas r
      LEFT JOIN entregas e ON e.ruta_id = r.id
     WHERE r.id = p_ruta_id
     GROUP BY r.id, r.empresa_id, r.chofer_id
    ON CONFLICT (ruta_id) DO UPDATE SET
      total_paradas    = EXCLUDED.total_paradas,
      entregadas       = EXCLUDED.entregadas,
      no_entregadas    = EXCLUDED.no_entregadas,
      km_estimados     = EXCLUDED.km_estimados,
      tiempo_total_min = EXCLUDED.tiempo_total_min,
      pct_completitud  = EXCLUDED.pct_completitud,
      generado_en      = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sync_estado_ruta(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_sync_estado_ruta(UUID) TO authenticated, service_role;

-- ── 2. Trigger: pedidos.estado → entregas.estado → rutas.estado ───────────
CREATE OR REPLACE FUNCTION public.fn_sync_entregas_desde_pedido()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_destino  TEXT;
  v_ruta_ids UUID[];
  v_ruta_id  UUID;
BEGIN
  IF NEW.estado IS NOT DISTINCT FROM OLD.estado THEN RETURN NEW; END IF;

  v_destino := CASE NEW.estado
    WHEN 'despachado' THEN 'en_camino'
    WHEN 'entregado'  THEN 'entregado'
    WHEN 'cancelado'  THEN 'no_entregado'
    ELSE NULL
  END;

  -- 'confirmado' / 'preparando' / 'borrador' no tienen efecto sobre la
  -- entrega: la fila en `entregas` recién se crea al armar la ruta, y un
  -- retroceso de estado no debe revivir una entrega ya cerrada por el chofer.
  IF v_destino IS NULL THEN RETURN NEW; END IF;

  -- Rutas afectadas (antes del UPDATE, mientras las entregas siguen activas).
  SELECT array_agg(DISTINCT ruta_id)
    INTO v_ruta_ids
    FROM entregas
   WHERE pedido_id = NEW.id
     AND estado IN ('pendiente', 'en_camino')
     AND ruta_id IS NOT NULL;

  -- Solo se toca la entrega ACTIVA: nunca se pisa un 'entregado' /
  -- 'no_entregado' ya confirmado por el chofer desde su app.
  UPDATE entregas e
     SET estado = v_destino,
         fecha_confirmacion = CASE
           WHEN v_destino = 'entregado' THEN COALESCE(e.fecha_confirmacion, now())
           ELSE e.fecha_confirmacion END,
         motivo_no_entrega = CASE
           WHEN v_destino = 'no_entregado' THEN COALESCE(e.motivo_no_entrega, 'otro')
           ELSE e.motivo_no_entrega END,
         notas_entrega = CASE
           WHEN v_destino = 'no_entregado' THEN COALESCE(e.notas_entrega, 'Pedido cancelado desde el panel')
           ELSE e.notas_entrega END
   WHERE e.pedido_id = NEW.id
     AND e.estado IN ('pendiente', 'en_camino')
     AND e.estado IS DISTINCT FROM v_destino;

  IF v_ruta_ids IS NOT NULL THEN
    FOREACH v_ruta_id IN ARRAY v_ruta_ids LOOP
      PERFORM fn_sync_estado_ruta(v_ruta_id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_entregas_desde_pedido ON public.pedidos;
CREATE TRIGGER trg_sync_entregas_desde_pedido
AFTER UPDATE OF estado ON public.pedidos
FOR EACH ROW
WHEN (OLD.estado IS DISTINCT FROM NEW.estado)
EXECUTE FUNCTION public.fn_sync_entregas_desde_pedido();

COMMENT ON TRIGGER trg_sync_entregas_desde_pedido ON public.pedidos IS
  'Mantiene entregas.estado y rutas.estado sincronizados con pedidos.estado, '
  'venga el cambio de la UI de Pedidos, del PATCH admin, del portal del chofer, '
  'del asistente por voz o del replay offline. Ver migración 630.';

-- ── 3. Backfill de las filas ya desincronizadas ───────────────────────────
-- `tg_cierre_financiero` encola facturación al pasar una entrega a
-- 'entregado'. Para el backfill se desactiva a propósito: estos pedidos ya
-- fueron entregados (y facturados) hace tiempo por el circuito viejo;
-- encolarlos ahora generaría facturación retroactiva duplicada. A partir del
-- trigger nuevo, las entregas futuras sí lo disparan normalmente.
-- `tg_score_entrega` además exige contexto de empresa del caller
-- (assert_empresa_access), que no existe en una migración: también se
-- desactiva durante el backfill para no recalcular scores históricos.
ALTER TABLE public.entregas DISABLE TRIGGER tg_cierre_financiero;
ALTER TABLE public.entregas DISABLE TRIGGER tg_score_entrega;

UPDATE entregas e
   SET estado = 'entregado',
       fecha_confirmacion = COALESCE(e.fecha_confirmacion, p.fecha_entrega, e.updated_at),
       notas_entrega = COALESCE(e.notas_entrega, 'Sincronizado con el pedido (migración 630)')
  FROM pedidos p
 WHERE p.id = e.pedido_id
   AND p.estado = 'entregado'
   AND e.estado IN ('pendiente', 'en_camino');

UPDATE entregas e
   SET estado = 'no_entregado',
       motivo_no_entrega = COALESCE(e.motivo_no_entrega, 'otro'),
       notas_entrega = COALESCE(e.notas_entrega, 'Pedido cancelado (migración 630)')
  FROM pedidos p
 WHERE p.id = e.pedido_id
   AND p.estado = 'cancelado'
   AND e.estado IN ('pendiente', 'en_camino');

UPDATE entregas e
   SET estado = 'en_camino'
  FROM pedidos p
 WHERE p.id = e.pedido_id
   AND p.estado = 'despachado'
   AND e.estado = 'pendiente';

ALTER TABLE public.entregas ENABLE TRIGGER tg_score_entrega;
ALTER TABLE public.entregas ENABLE TRIGGER tg_cierre_financiero;

-- Recalcular el estado de toda ruta tocada por el backfill.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT ruta_id FROM entregas WHERE ruta_id IS NOT NULL LOOP
    PERFORM fn_sync_estado_ruta(r.ruta_id);
  END LOOP;
END;
$$;
