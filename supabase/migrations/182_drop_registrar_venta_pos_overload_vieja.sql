-- ============================================================
-- 182_drop_registrar_venta_pos_overload_vieja.sql
--
-- La migración 179 hizo CREATE OR REPLACE de registrar_venta_pos()
-- agregando p_offline_local_id, pero al cambiar la firma Postgres no
-- reemplazó la función original: creó un OVERLOAD nuevo y dejó viva
-- la versión vieja de 12 parámetros (sin offline_local_id). Dos
-- funciones con el mismo nombre y comportamiento distinto es
-- exactamente el tipo de drift que venimos evitando — cualquier
-- caller que no pase el parámetro nuevo (o algún RPC directo desde
-- otro lado) podría resolver contra la versión vieja sin dedup.
--
-- Se elimina la versión vieja. El handler de pos.js ya siempre pasa
-- p_offline_local_id (null si no aplica), así que no hay callers que
-- dependan de la firma de 12 argumentos.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.registrar_venta_pos(
  uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric
);

COMMIT;
