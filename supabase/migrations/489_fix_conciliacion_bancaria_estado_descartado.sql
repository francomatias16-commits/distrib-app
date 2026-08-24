-- FIX MERCADOPAGO-AUDIT-01... no, este es CONCILIACION-AUDIT-01 (auditoría etapa 3):
-- lib/repos/conciliacion-bancaria.js:descartarMovimiento() hace
-- UPDATE ... SET estado = 'descartado', pero el CHECK constraint de la
-- tabla solo permite ('pendiente','conciliado','sin_match','conciliado_manual').
-- 'descartado' no está en la lista -> todo intento de descartar un
-- movimiento (botón real en la UI) falla con violación de constraint.
-- Se agrega 'descartado' a los valores permitidos, sin tocar los demás
-- (sin_match/conciliado_manual quedan reservados, ningún código los usa
-- hoy, pero no corresponde borrarlos sin confirmar con Matías si eran
-- para un flujo pensado y no terminado).
ALTER TABLE public.conciliacion_bancaria_movimientos
  DROP CONSTRAINT conciliacion_bancaria_movimientos_estado_check;

ALTER TABLE public.conciliacion_bancaria_movimientos
  ADD CONSTRAINT conciliacion_bancaria_movimientos_estado_check
  CHECK (estado = ANY (ARRAY['pendiente'::text, 'conciliado'::text, 'sin_match'::text, 'conciliado_manual'::text, 'descartado'::text]));
