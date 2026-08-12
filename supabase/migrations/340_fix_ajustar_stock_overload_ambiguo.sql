-- 340_fix_ajustar_stock_overload_ambiguo.sql
--
-- Síntoma: al registrar cualquier movimiento de stock desde el panel admin
-- (ingreso/egreso/ajuste/transferencia), Supabase respondía con:
--   "No se pudo guardar el movimiento por un problema de conexión."
--
-- Causa real: existían DOS versiones de ajustar_stock() en producción:
--   - la de la migración 201 (6 argumentos)
--   - una versión más nueva con p_usuario_id agregado (7 argumentos),
--     aplicada directamente en Supabase en algún momento sin dejar
--     migración registrada.
-- Como p_usuario_id tiene DEFAULT, cualquier llamada que no lo incluya
-- (el frontend nunca lo manda) matchea ambas firmas por igual. PostgREST
-- no puede decidir cuál usar y devuelve HTTP 300 "Could not choose the
-- best candidate function" (PGRST203). El cliente supabase-js lo propaga
-- como un error genérico, que el catch de stock.js muestra como
-- "problema de conexión" — no era de red, era la función duplicada.
--
-- Fix: eliminar la versión vieja (6 args) y dejar sólo la de 7 args, que
-- además valida que el producto pertenezca a la empresa del depósito y
-- soporta llamadas service_role (backend) sin repetir el check de rol.
--
-- Aplicado directamente en producción el 2026-07-16; esta migración deja
-- el cambio registrado en el repo para no perder el historial.

DROP FUNCTION IF EXISTS public.ajustar_stock(uuid, uuid, numeric, tipo_movimiento, text, text);

NOTIFY pgrst, 'reload schema';
