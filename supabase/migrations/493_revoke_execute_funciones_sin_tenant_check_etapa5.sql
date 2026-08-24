-- SEC-ETAPA5-01/02/03/04/05: auditoría de seguridad de la etapa 5 vía
-- audit_security_definer_grants() (migración 249) encontró 5 funciones
-- SECURITY DEFINER con EXECUTE otorgado a anon/authenticated (vía
-- PostgREST, con solo la anon key pública) y SIN ningún chequeo de
-- tenant/auth en el cuerpo:
--
--   - conciliar_lote_bancario / conciliar_movimiento_manual: legacy sin
--     auth alguno, EXECUTE a PUBLIC+anon+authenticated — cualquiera podía
--     manipular conciliación bancaria de cualquier empresa. Superseded
--     por conciliacion_auto_matchear_lote / conciliacion_confirmar_match.
--   - fn_lotes_consumir_fefo: EXECUTE a PUBLIC+anon+authenticated, sin
--     chequeo de empresa — permitía vaciar stock de lotes de cualquier
--     empresa sin login.
--   - fn_incrementar_contador_api: EXECUTE a authenticated sin chequeo de
--     rol — cualquier usuario autenticado podía inflar contadores de uso
--     de APIs pagas de la empresa (Serper). Uso legítimo es 100%
--     server-side con service_role (lib/repos/auto-imagenes.js).
--   - limpiar_whatsapp_reset_codigos_expirados: sin chequeo, bajo riesgo
--     real (solo borra códigos ya vencidos), revocado por higiene.
--
-- Verificado contra el código: ninguna de las 5 se llama desde el
-- frontend; fn_incrementar_contador_api solo se invoca server-side.
-- Revoca EXECUTE de PUBLIC/anon/authenticated — quedan solo accesibles
-- vía service_role (backend).
REVOKE EXECUTE ON FUNCTION public.conciliar_lote_bancario(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.conciliar_movimiento_manual(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_lotes_consumir_fefo(uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_incrementar_contador_api(text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.limpiar_whatsapp_reset_codigos_expirados() FROM PUBLIC, anon, authenticated;
