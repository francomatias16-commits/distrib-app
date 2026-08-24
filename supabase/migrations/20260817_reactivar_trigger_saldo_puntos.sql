-- DB-01: el trigger estaba deshabilitado y la consulta previa confirmó
-- que no existen filas actuales de saldo_puntos sin empresa_id.
ALTER TABLE public.saldo_puntos ENABLE TRIGGER tg_force_empresa_saldo_puntos;
COMMENT ON TRIGGER tg_force_empresa_saldo_puntos ON public.saldo_puntos IS
  'DB-01: fuerza empresa_id en altas de saldo_puntos; reactivado por remediacion auditoria 2026.';
