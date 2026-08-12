-- ============================================================================
-- 060_fix_vistas_puntos.sql
-- Corrige el sistema de puntos duplicado (hallazgo #2 de la auditoría v65).
--
-- Contexto:
--   - Existen dos pares de tablas para el mismo concepto de negocio:
--       Sistema A (real, alimentado por pedidos.js):  saldo_puntos / movimientos_puntos
--       Sistema B (huérfano, nunca recibe escrituras): puntos_saldo / puntos_log
--   - Las RPCs canjear_puntos / acreditar_puntos (redefinidas en 048) YA escriben
--     correctamente en el Sistema A. Verificado contra backup.sql real.
--   - frontend/admin/js/puntos.js todavía LEE del Sistema B (vista v_puntos_clientes
--     de 020, que nunca llegó a ejecutarse en producción, y tablas puntos_saldo/
--     puntos_log directamente como fallback). Por eso la pantalla /admin/puntos
--     siempre se ve vacía aunque se acrediten o canjeen puntos.
--
-- Esta migración NO borra el Sistema B (evita pérdida de datos si alguna vez se
-- usó manualmente), sólo lo deja marcado como deprecado y redirige las vistas
-- de lectura del admin hacia el Sistema A, manteniendo los mismos nombres de
-- columna que el frontend ya espera (saldo, total_ganado, total_canjeado,
-- updated_at, cliente_nombre, cliente_email) para no requerir cambios de JS
-- en el camino principal.
-- ============================================================================

-- ── 1. v_puntos_clientes — ahora sobre el sistema real (saldo_puntos) ───────
CREATE OR REPLACE VIEW public.v_puntos_clientes AS
SELECT
  sp.empresa_id,
  sp.cliente_id,
  COALESCE(c.razon_social, c.nombre_fantasia, 'Sin nombre') AS cliente_nombre,
  c.email                                                    AS cliente_email,
  sp.puntos_disponibles                                      AS saldo,
  sp.puntos_totales                                          AS total_ganado,
  sp.puntos_canjeados                                        AS total_canjeado,
  sp.ultimo_movimiento                                       AS updated_at
FROM public.saldo_puntos sp
JOIN public.clientes c ON c.id = sp.cliente_id
ORDER BY sp.puntos_disponibles DESC;

GRANT SELECT ON public.v_puntos_clientes TO authenticated;

COMMENT ON VIEW public.v_puntos_clientes IS
  'Resumen de saldo de puntos por cliente para /admin/puntos. Fuente real: saldo_puntos (Sistema A). Reemplaza la definición de 020_dt02_puntos.sql, que apuntaba al sistema huérfano puntos_saldo y nunca se ejecutó en producción.';

-- ── 2. v_puntos_movimientos — historial sobre movimientos_puntos ────────────
-- Replica la forma de la vieja tabla puntos_log (tipo, puntos, saldo_post,
-- concepto) que el frontend ya sabe renderizar, pero calculada sobre el
-- sistema real con una suma corrida (running total) por cliente.
CREATE OR REPLACE VIEW public.v_puntos_movimientos AS
SELECT
  mp.id,
  mp.empresa_id,
  mp.cliente_id,
  CASE mp.tipo
    WHEN 'ganancia' THEN 'acreditacion'
    ELSE mp.tipo
  END AS tipo,
  CASE mp.tipo
    WHEN 'canje' THEN -mp.cantidad
    ELSE mp.cantidad
  END AS puntos,
  SUM(
    CASE mp.tipo WHEN 'canje' THEN -mp.cantidad ELSE mp.cantidad END
  ) OVER (PARTITION BY mp.cliente_id ORDER BY mp.created_at, mp.id) AS saldo_post,
  mp.motivo        AS concepto,
  mp.referencia_id,
  mp.created_at
FROM public.movimientos_puntos mp;

GRANT SELECT ON public.v_puntos_movimientos TO authenticated;

COMMENT ON VIEW public.v_puntos_movimientos IS
  'Historial de movimientos de puntos por cliente para /admin/puntos, con saldo_post calculado vía suma corrida. Fuente real: movimientos_puntos (Sistema A).';

-- ── 3. Marcar el sistema huérfano como deprecado (no se borra, por seguridad) ─
COMMENT ON TABLE public.puntos_saldo IS
  'DEPRECADO (ver auditoría v65, hallazgo #2): tabla huérfana, nunca recibe escrituras desde el flujo real de pedidos. El sistema vigente es saldo_puntos. No usar para nuevo código.';

COMMENT ON TABLE public.puntos_log IS
  'DEPRECADO (ver auditoría v65, hallazgo #2): tabla huérfana, nunca recibe escrituras desde el flujo real de pedidos. El sistema vigente es movimientos_puntos. No usar para nuevo código.';
