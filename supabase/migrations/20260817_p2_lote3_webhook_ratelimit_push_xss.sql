-- ============================================================================
-- P2 — Lote 3, parte DB: rate limiter distribuido (SEC-07).
-- El resto de Lote 3 (SEC-10/BUG-01 webhook MP, SEC-14 push fallback,
-- SEC-06 XSS saas-billing) es código JS/HTML, sin cambios de esquema —
-- va en archivos aparte, no en esta migración.
--
-- Reemplaza el Map en memoria de lib/rate-limit.js (inefectivo en
-- serverless multi-instancia, SEC-07) por un contador atómico en Postgres:
-- INSERT ... ON CONFLICT ... DO UPDATE en una sola sentencia, sin
-- check-then-act desde Node, así que dos instancias de Vercel concurrentes
-- no pueden pisarse el contador.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rate_limits (
  clave      text PRIMARY KEY,
  contador   integer NOT NULL DEFAULT 0,
  reset_at   timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Para el barrido de filas vencidas (evita crecimiento indefinido).
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON public.rate_limits (reset_at);

COMMENT ON TABLE public.rate_limits IS
  'Contador atómico de rate limiting distribuido. Reemplaza el Map en memoria de lib/rate-limit.js (SEC-07, auditoría 2026) — necesario porque en Vercel/serverless cada instancia tenía su propio Map, así que el límite real era N veces el configurado según cuántas instancias hubiera vivas.';

-- Función atómica: incrementa el contador de `p_clave` dentro de su ventana
-- vigente, o abre una ventana nueva si la anterior venció. Todo en una sola
-- sentencia (INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING), así que no
-- hay ventana de carrera entre leer y escribir el contador.
CREATE OR REPLACE FUNCTION public.rl_check_and_increment(
  p_clave text,
  p_max integer,
  p_window_ms integer
)
RETURNS TABLE(excedido boolean, contador integer, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_contador integer;
  v_reset_at timestamptz;
BEGIN
  IF p_clave IS NULL OR length(p_clave) = 0 OR length(p_clave) > 300 THEN
    RAISE EXCEPTION 'Clave de rate limit inválida';
  END IF;

  INSERT INTO public.rate_limits AS rl (clave, contador, reset_at, updated_at)
  VALUES (p_clave, 1, v_now + make_interval(secs => p_window_ms / 1000.0), v_now)
  ON CONFLICT (clave) DO UPDATE SET
    contador = CASE
                 WHEN rl.reset_at <= v_now THEN 1
                 ELSE rl.contador + 1
               END,
    reset_at = CASE
                 WHEN rl.reset_at <= v_now THEN v_now + make_interval(secs => p_window_ms / 1000.0)
                 ELSE rl.reset_at
               END,
    updated_at = v_now
  RETURNING rl.contador, rl.reset_at INTO v_contador, v_reset_at;

  -- Barrido oportunista y barato (1 de cada ~200 llamadas) de filas
  -- vencidas hace rato, para no depender de un cron aparte.
  IF random() < 0.005 THEN
    DELETE FROM public.rate_limits WHERE reset_at < v_now - interval '1 day';
  END IF;

  RETURN QUERY SELECT (v_contador > p_max), v_contador, v_reset_at;
END;
$function$;

-- Necesita poder ejecutarse tanto para requests sin sesión (login, reset de
-- password, checkout público) como con sesión — es solo un contador, no
-- expone ni modifica datos de negocio, así que el grant a anon acá no
-- reabre nada (a diferencia de exportar_contable/transferir_stock, que sí
-- tocaban datos reales).
REVOKE ALL ON FUNCTION public.rl_check_and_increment(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rl_check_and_increment(text, integer, integer) TO anon, authenticated, service_role;

-- La tabla en sí no debe ser legible/escribible directamente vía PostgREST
-- (todo pasa por la función SECURITY DEFINER de arriba).
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
-- Sin políticas = deny-by-default para anon/authenticated vía API; la
-- función SECURITY DEFINER sigue pudiendo leer/escribir porque corre como
-- su dueño, no como el rol del caller.
