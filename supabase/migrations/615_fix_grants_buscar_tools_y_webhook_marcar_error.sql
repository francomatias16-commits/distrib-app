-- =============================================================
-- 615_fix_grants_buscar_tools_y_webhook_marcar_error.sql
--
-- Punto 7 de AUDITORIA_PROGRESO_2026-09-11: confirma que ninguna de las
-- dos funciones era falso positivo.
--
-- fn_webhook_marcar_error — el más serio de los dos. Es SECURITY DEFINER
-- (bypasea la RLS de webhooks_recibidos, que solo tiene policy de SELECT
-- dueño/admin) y tenía EXECUTE otorgado a anon. Cualquiera sin sesión
-- podía llamar la RPC con cualquier p_id y marcar como 'error' un
-- webhook de Mercado Pago ya procesado bien. El cron
-- webhooks-reprocesar-cron (lib/handlers/notif.js) toma las filas en
-- estado='error' y vuelve a correr procesarEventoMP(payload) sobre
-- ellas — permitía forzar reprocesamiento arbitrario de pagos ya
-- cerrados, o agotar el maxIntentos=5 de un webhook legítimo a
-- propósito.
--
-- buscar_tools_asistente_rpc — bajo impacto (solo lee el catálogo
-- interno de nombres de tools del asistente, asistente_tools_embeddings,
-- sin datos de cliente), pero mismo patrón: sin caso de uso legítimo
-- para que anon la ejecute. Cero referencias desde frontend, solo se
-- llama desde lib/repos/asistente.js con la service role key.
--
-- Nota: este archivo versiona un cambio que ya se aplicó directamente en
-- producción (vía Supabase MCP) antes de escribirse el .sql — verificado
-- cuerpo por cuerpo contra pg_get_functiondef y grants contra
-- has_function_privilege antes de confirmarlo acá. CREATE OR REPLACE
-- puro (no cambia lógica), solo deja los REVOKE/GRANT versionados y
-- registrados.
-- =============================================================

CREATE OR REPLACE FUNCTION public.buscar_tools_asistente_rpc(query_embedding vector, match_count integer DEFAULT 8, match_threshold double precision DEFAULT 0.5)
 RETURNS TABLE(tool_nombre text, similarity double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT
    t.tool_nombre,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM public.asistente_tools_embeddings t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) >= match_threshold
  ORDER BY t.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
$function$;

CREATE OR REPLACE FUNCTION public.fn_webhook_marcar_error(p_id bigint, p_error text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE webhooks_recibidos
  SET estado = 'error',
      intentos = intentos + 1,
      ultimo_error = p_error,
      actualizado_at = now()
  WHERE id = p_id;
$function$;

REVOKE ALL ON FUNCTION public.buscar_tools_asistente_rpc(vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buscar_tools_asistente_rpc(vector, integer, double precision) TO service_role;

REVOKE ALL ON FUNCTION public.fn_webhook_marcar_error(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_webhook_marcar_error(bigint, text) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '615_fix_grants_buscar_tools_y_webhook_marcar_error.sql', '615', 'claude-session',
        'Punto 7: revoca EXECUTE de PUBLIC/anon/authenticated y deja solo service_role en buscar_tools_asistente_rpc y fn_webhook_marcar_error. La segunda es SECURITY DEFINER sobre webhooks_recibidos y permitia a anon forzar reprocesamiento de webhooks de MP ya cerrados via el cron webhooks-reprocesar-cron. CREATE OR REPLACE puro, sin cambio de logica.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
