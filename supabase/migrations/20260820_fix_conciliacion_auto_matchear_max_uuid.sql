-- 20260820_fix_conciliacion_auto_matchear_max_uuid.sql
--
-- BUG encontrado auditando "Auto-conciliar" en Cruzar con el banco
-- (conciliacion-bancaria.html): el botón tira "No se pudo auto-conciliar"
-- siempre que el lote tiene al menos un movimiento pendiente, sin importar
-- si tiene candidatos o no.
--
-- Causa: conciliacion_auto_matchear_lote (248_etapa3_conciliacion_bancaria.sql)
-- usa `MAX(cobro_id)` para quedarse con el único candidato cuando hay
-- exactamente 1. `cobro_id` es uuid, y Postgres no tiene una función de
-- agregación MAX() nativa para el tipo uuid (sí tiene operadores de
-- comparación/orden, pero no el agregado) — la consulta falla en el
-- planeo con "function max(uuid) does not exist", así que la excepción
-- se dispara apenas el loop procesa el primer movimiento pendiente,
-- independientemente de si termina habiendo 0 o 1 candidatos.
-- Reproducido en producción contra el lote real del extracto demo
-- (extracto-banco-demo-2026-08-19.csv, empresa 4462586e-e11a-4d34-a405-17103bb9cf9f).
--
-- FIX: reemplazar MAX(cobro_id) por (array_agg(cobro_id))[1], que sí
-- funciona para cualquier tipo. Con v_candidatos = 1 el array tiene un
-- solo elemento y el índice 1 es ese cobro_id; con 0 el array queda
-- vacío y el índice 1 es NULL, pero en ese caso v_candidatos != 1 y el
-- IF de abajo ni lo usa. Mismo comportamiento, sin el aggregate roto.

CREATE OR REPLACE FUNCTION public.conciliacion_auto_matchear_lote(
  p_lote_id          uuid,
  p_empresa_id       uuid,
  p_usuario_id       uuid DEFAULT NULL,
  p_tolerancia_dias  integer DEFAULT 1,
  p_tolerancia_monto numeric  DEFAULT 0.5
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_mov          record;
  v_candidatos   integer;
  v_unico_cobro  uuid;
  v_conciliados  integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conciliacion_bancaria_lotes
    WHERE id = p_lote_id AND empresa_id = p_empresa_id
  ) THEN
    RAISE EXCEPTION 'Lote no encontrado';
  END IF;

  FOR v_mov IN
    SELECT id FROM conciliacion_bancaria_movimientos
    WHERE lote_id = p_lote_id AND empresa_id = p_empresa_id AND estado = 'pendiente'
  LOOP
    SELECT COUNT(*), (array_agg(cobro_id))[1] INTO v_candidatos, v_unico_cobro
    FROM conciliacion_buscar_candidatos(v_mov.id, p_empresa_id, p_tolerancia_dias, p_tolerancia_monto);

    -- Solo auto-concilia cuando hay EXACTAMENTE un candidato dentro de la
    -- tolerancia ajustada (más estricta que la de búsqueda manual): evita
    -- matchear mal cuando dos cobros del mismo cliente caen muy cerca.
    IF v_candidatos = 1 THEN
      PERFORM conciliacion_confirmar_match(v_mov.id, v_unico_cobro, p_empresa_id, p_usuario_id);
      v_conciliados := v_conciliados + 1;
    END IF;
  END LOOP;

  RETURN v_conciliados;
END;
$function$;

COMMENT ON FUNCTION public.conciliacion_auto_matchear_lote(uuid, uuid, uuid, integer, numeric) IS
  'Etapa 3: auto-concilia los movimientos de un lote que tengan un único candidato dentro de tolerancia estricta. Devuelve cuántos quedaron conciliados. El resto se resuelve a mano desde la UI. FIX 2026-08-20: MAX(cobro_id) reemplazado por (array_agg(cobro_id))[1] — uuid no tiene aggregate MAX nativo en Postgres.';

-- Los grants (REVOKE FROM PUBLIC + GRANT a service_role) ya están
-- aplicados desde la migración 248 y CREATE OR REPLACE no los toca.
