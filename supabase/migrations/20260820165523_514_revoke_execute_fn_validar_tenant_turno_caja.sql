-- Hallazgo de get_advisors tras la migración 513: fn_validar_tenant_turno_caja
-- quedó con EXECUTE para anon/authenticated por default de Postgres al crear
-- la función. Es una función de uso exclusivo del trigger
-- trg_validar_tenant_turno_caja (BEFORE INSERT/UPDATE en turnos_caja); no
-- tiene sentido ni necesidad de que se pueda invocar como RPC directo.
-- El trigger sigue funcionando igual: la ejecución vía trigger no depende
-- de que anon/authenticated tengan EXECUTE explícito.

REVOKE EXECUTE ON FUNCTION public.fn_validar_tenant_turno_caja() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_validar_tenant_turno_caja() FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_validar_tenant_turno_caja() FROM authenticated;

COMMENT ON FUNCTION public.fn_validar_tenant_turno_caja() IS
  'Defensa en profundidad (hallazgo 20/8): garantiza a nivel de DB que caja_id, usuario_id y cerrado_forzado_por de un turno pertenezcan todos a la misma empresa, incluso si el INSERT/UPDATE viene de un import o corrección manual que se salte la validación del handler de aplicación. EXECUTE revocado de anon/authenticated (20/8, hallazgo de get_advisors post-513): función de uso exclusivo del trigger, no debe ser invocable como RPC directo.';
