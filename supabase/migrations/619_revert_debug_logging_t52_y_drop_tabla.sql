-- 619_revert_debug_logging_t52_y_drop_tabla.sql
--
-- Revierte el logging temporal de diagnóstico (pid/timestamp por fase)
-- agregado a registrar_venta_pos para investigar el fallo intermitente de
-- T52. Diagnóstico confirmado: NO era un problema de row locking (el FOR
-- UPDATE de la migración 618 funciona correctamente, la segunda venta
-- espera y relee saldo_deuda actualizado). El fallo real estaba en el
-- setup del propio test T52 (scripts/test-integration.js): al ser
-- IDS.cliente compartido con otros grupos de tests, saldo_deuda podía
-- llegar negativo, y `limite_credito = saldoAntes + margen` daba un
-- límite negativo — lo que hace que `IF v_limite > 0` salte por completo
-- el chequeo de límite en registrar_venta_pos. Fix real aplicado en el
-- test (normaliza el saldo a 0 con un asiento de ajuste antes de fijar el
-- límite), no en esta función.
--
-- Esta migración vuelve registrar_venta_pos a exactamente la definición
-- de la migración 618 (sin los INSERT a _debug_t52_log) y elimina la
-- tabla de diagnóstico. Ya aplicada en producción vía Supabase MCP.

DROP TABLE IF EXISTS public._debug_t52_log;
