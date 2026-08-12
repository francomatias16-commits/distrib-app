-- ============================================================
-- 248_etapa3_conciliacion_bancaria.sql
-- Etapa 3 (Cobranzas y riesgo financiero) — Conciliación bancaria
-- automática: importar extracto bancario (CSV) y matchear cada
-- movimiento contra un cobro registrado en el sistema, dentro de
-- una tolerancia de fecha y monto configurable.
--
-- NOTA DE INTEGRACIÓN: esta migración se numera 248 (no 247) porque
-- el 247 ya está tomado por 247_etapa6_whatsapp_bidireccional, que
-- se aplicó primero contra esta misma base. Esta migración reconstruye
-- desde cero una sesión de trabajo previa cuyos archivos (SQL, repo,
-- handler, frontend) se perdieron sin llegar a guardarse ni aplicarse;
-- no reemplaza nada existente.
--
-- Diseño (retomado de la sesión original):
--   - conciliacion_bancaria_lotes: cada importación de extracto (CSV).
--   - conciliacion_bancaria_movimientos: una fila por línea del extracto.
--   - cobros.conciliado_bancario: flag que se prende cuando un movimiento
--     queda matcheado 1 a 1 contra ese cobro.
--   - Trigger de updated_at propio y autocontenido (NO se reutiliza
--     tg_precios_clientes_updated_at): ese trigger existe en producción
--     pero no está trackeado en el repo (fue detectado como "función
--     fantasma" al revisar la migración 243), así que para no repetir
--     esa deuda técnica esta tabla define su propia función.
--   - Matching por RPC con tolerancia de fecha/monto, no por UNIQUE
--     constraint: un movimiento puede tener 0, 1 o varios candidatos:
--     el usuario confirma el match desde la UI (o se auto-concilia
--     cuando hay un único candidato exacto).
-- ============================================================

-- ── 1. Lotes de importación ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conciliacion_bancaria_lotes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nombre_archivo         text NOT NULL,
  cantidad_movimientos   integer NOT NULL DEFAULT 0,
  cantidad_conciliados   integer NOT NULL DEFAULT 0,
  usuario_id             uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conciliacion_lotes_empresa
  ON public.conciliacion_bancaria_lotes(empresa_id, created_at DESC);

COMMENT ON TABLE public.conciliacion_bancaria_lotes IS
  'Etapa 3 (Cobranzas y riesgo financiero): cada importación de extracto bancario (CSV) para conciliación. Agrupa los movimientos de conciliacion_bancaria_movimientos.';

-- ── 2. Movimientos del extracto ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conciliacion_bancaria_movimientos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lote_id           uuid NOT NULL REFERENCES public.conciliacion_bancaria_lotes(id) ON DELETE CASCADE,

  fecha             date NOT NULL,
  descripcion       text,
  monto             numeric NOT NULL CHECK (monto > 0),
  tipo              text NOT NULL CHECK (tipo IN ('credito', 'debito')),

  estado            text NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente', 'conciliado', 'descartado')),
  cobro_id          uuid REFERENCES public.cobros(id) ON DELETE SET NULL,
  conciliado_en     timestamptz,
  conciliado_por    uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conciliacion_mov_cobro_solo_si_conciliado
    CHECK (estado = 'conciliado' OR cobro_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_conciliacion_mov_lote
  ON public.conciliacion_bancaria_movimientos(lote_id);
CREATE INDEX IF NOT EXISTS idx_conciliacion_mov_empresa_estado
  ON public.conciliacion_bancaria_movimientos(empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_conciliacion_mov_cobro
  ON public.conciliacion_bancaria_movimientos(cobro_id) WHERE cobro_id IS NOT NULL;

COMMENT ON TABLE public.conciliacion_bancaria_movimientos IS
  'Etapa 3: una fila por línea del extracto bancario importado. Se matchea contra cobros dentro de una tolerancia de fecha/monto vía las RPC conciliacion_buscar_candidatos / conciliacion_confirmar_match.';

-- ── 3. Flag de conciliación en cobros ────────────────────────────
ALTER TABLE public.cobros
  ADD COLUMN IF NOT EXISTS conciliado_bancario boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_cobros_conciliado_bancario
  ON public.cobros(empresa_id, conciliado_bancario) WHERE conciliado_bancario = false;

COMMENT ON COLUMN public.cobros.conciliado_bancario IS
  'true cuando este cobro quedó matcheado 1 a 1 contra un movimiento de conciliacion_bancaria_movimientos.';

-- ── 4. Trigger de updated_at (propio, autocontenido) ─────────────
CREATE OR REPLACE FUNCTION public.tg_conciliacion_bancaria_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER tg_conciliacion_mov_updated_at
  BEFORE UPDATE ON public.conciliacion_bancaria_movimientos
  FOR EACH ROW EXECUTE FUNCTION public.tg_conciliacion_bancaria_updated_at();

-- ── 5. RLS (mismo patrón que reglas_precio / precios_clientes) ───
ALTER TABLE public.conciliacion_bancaria_lotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conciliacion_bancaria_movimientos ENABLE ROW LEVEL SECURITY;

CREATE POLICY conciliacion_lotes_select ON public.conciliacion_bancaria_lotes
  FOR SELECT
  USING (empresa_id = get_empresa_id());

CREATE POLICY conciliacion_lotes_modify ON public.conciliacion_bancaria_lotes
  FOR ALL
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])
  )
  WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])
  );

CREATE POLICY conciliacion_mov_select ON public.conciliacion_bancaria_movimientos
  FOR SELECT
  USING (empresa_id = get_empresa_id());

CREATE POLICY conciliacion_mov_modify ON public.conciliacion_bancaria_movimientos
  FOR ALL
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])
  )
  WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])
  );

-- ── 6. RPC: buscar candidatos de match para un movimiento ────────
-- SECURITY INVOKER (default): corre con los permisos de quien llama.
-- El handler backend siempre pasa p_empresa_id desde el JWT ya
-- validado por verificarToken(), nunca desde input del cliente.
CREATE OR REPLACE FUNCTION public.conciliacion_buscar_candidatos(
  p_movimiento_id   uuid,
  p_empresa_id      uuid,
  p_tolerancia_dias  integer DEFAULT 3,
  p_tolerancia_monto numeric  DEFAULT 1
)
RETURNS TABLE(
  cobro_id        uuid,
  fecha           timestamptz,
  monto           numeric,
  cliente_nombre  text,
  medio           text,
  diff_dias       integer,
  diff_monto      numeric,
  score           numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_fecha  date;
  v_monto  numeric;
BEGIN
  SELECT m.fecha, m.monto INTO v_fecha, v_monto
  FROM conciliacion_bancaria_movimientos m
  WHERE m.id = p_movimiento_id AND m.empresa_id = p_empresa_id;

  IF v_fecha IS NULL THEN
    RETURN; -- movimiento inexistente o de otra empresa: sin candidatos
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.fecha,
    c.monto,
    cli.nombre,
    c.medio,
    ABS(c.fecha::date - v_fecha)::integer      AS diff_dias,
    ROUND(ABS(c.monto - v_monto), 2)            AS diff_monto,
    -- score simple: cuanto más cerca en fecha y monto, más alto.
    -- 100 = match exacto en ambos; baja linealmente dentro de la tolerancia.
    ROUND(
      100
      - (ABS(c.fecha::date - v_fecha)::numeric / GREATEST(p_tolerancia_dias, 1)) * 50
      - (ABS(c.monto - v_monto) / GREATEST(p_tolerancia_monto, 0.01)) * 50
    , 2) AS score
  FROM cobros c
  LEFT JOIN clientes cli ON cli.id = c.cliente_id
  WHERE c.empresa_id = p_empresa_id
    AND c.conciliado_bancario = false
    AND ABS(c.monto - v_monto) <= p_tolerancia_monto
    AND ABS(c.fecha::date - v_fecha) <= p_tolerancia_dias
  ORDER BY score DESC, diff_dias ASC
  LIMIT 20;
END;
$function$;

COMMENT ON FUNCTION public.conciliacion_buscar_candidatos(uuid, uuid, integer, numeric) IS
  'Etapa 3: candidatos de cobros para matchear un movimiento del extracto, dentro de tolerancia de fecha/monto. p_empresa_id lo fija siempre el backend desde el JWT, nunca el cliente.';

-- ── 7. RPC: confirmar match (movimiento ↔ cobro) ──────────────────
CREATE OR REPLACE FUNCTION public.conciliacion_confirmar_match(
  p_movimiento_id uuid,
  p_cobro_id      uuid,
  p_empresa_id    uuid,
  p_usuario_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote_id uuid;
BEGIN
  -- Validaciones de tenant + estado (ambas filas deben ser de la misma empresa)
  IF NOT EXISTS (
    SELECT 1 FROM conciliacion_bancaria_movimientos
    WHERE id = p_movimiento_id AND empresa_id = p_empresa_id AND estado = 'pendiente'
  ) THEN
    RAISE EXCEPTION 'Movimiento no encontrado o ya conciliado/descartado';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cobros
    WHERE id = p_cobro_id AND empresa_id = p_empresa_id AND conciliado_bancario = false
  ) THEN
    RAISE EXCEPTION 'Cobro no encontrado o ya conciliado con otro movimiento';
  END IF;

  UPDATE conciliacion_bancaria_movimientos
  SET cobro_id = p_cobro_id,
      estado = 'conciliado',
      conciliado_en = now(),
      conciliado_por = p_usuario_id
  WHERE id = p_movimiento_id
  RETURNING lote_id INTO v_lote_id;

  UPDATE cobros SET conciliado_bancario = true WHERE id = p_cobro_id;

  UPDATE conciliacion_bancaria_lotes
  SET cantidad_conciliados = cantidad_conciliados + 1
  WHERE id = v_lote_id;

  RETURN jsonb_build_object(
    'movimiento_id', p_movimiento_id,
    'cobro_id', p_cobro_id,
    'estado', 'conciliado'
  );
END;
$function$;

COMMENT ON FUNCTION public.conciliacion_confirmar_match(uuid, uuid, uuid, uuid) IS
  'Etapa 3: confirma el match entre un movimiento del extracto y un cobro. Prende cobros.conciliado_bancario y actualiza el contador del lote.';

-- ── 8. RPC: deshacer un match ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.conciliacion_deshacer_match(
  p_movimiento_id uuid,
  p_empresa_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_cobro_id uuid;
  v_lote_id  uuid;
BEGIN
  SELECT cobro_id, lote_id INTO v_cobro_id, v_lote_id
  FROM conciliacion_bancaria_movimientos
  WHERE id = p_movimiento_id AND empresa_id = p_empresa_id AND estado = 'conciliado';

  IF v_cobro_id IS NULL THEN
    RAISE EXCEPTION 'Movimiento no encontrado o no está conciliado';
  END IF;

  UPDATE conciliacion_bancaria_movimientos
  SET cobro_id = NULL, estado = 'pendiente', conciliado_en = NULL, conciliado_por = NULL
  WHERE id = p_movimiento_id;

  UPDATE cobros SET conciliado_bancario = false WHERE id = v_cobro_id AND empresa_id = p_empresa_id;

  UPDATE conciliacion_bancaria_lotes
  SET cantidad_conciliados = GREATEST(cantidad_conciliados - 1, 0)
  WHERE id = v_lote_id;

  RETURN jsonb_build_object('movimiento_id', p_movimiento_id, 'estado', 'pendiente');
END;
$function$;

COMMENT ON FUNCTION public.conciliacion_deshacer_match(uuid, uuid) IS
  'Etapa 3: revierte un match, dejando el movimiento en pendiente y apagando cobros.conciliado_bancario.';

-- ── 9. RPC: auto-conciliar un lote (solo matches únicos y exactos) ─
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
    SELECT COUNT(*), MAX(cobro_id) INTO v_candidatos, v_unico_cobro
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
  'Etapa 3: auto-concilia los movimientos de un lote que tengan un único candidato dentro de tolerancia estricta. Devuelve cuántos quedaron conciliados. El resto se resuelve a mano desde la UI.';

-- ── 10. Grants: revocar de PUBLIC, dejar solo a los roles que ya
--       tienen acceso al resto de las funciones del proyecto ──────
REVOKE ALL ON FUNCTION public.conciliacion_buscar_candidatos(uuid, uuid, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.conciliacion_confirmar_match(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.conciliacion_deshacer_match(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.conciliacion_auto_matchear_lote(uuid, uuid, uuid, integer, numeric) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.conciliacion_buscar_candidatos(uuid, uuid, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.conciliacion_confirmar_match(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conciliacion_deshacer_match(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conciliacion_auto_matchear_lote(uuid, uuid, uuid, integer, numeric) TO service_role;
-- No se otorga a anon/authenticated: estas RPC sólo se llaman desde el
-- backend (lib/repos/conciliacion-bancaria.js) con la service_role key,
-- nunca directo desde el navegador. Mismo criterio que corrigió la fuga
-- de resolver_cliente_por_telefono en 247b.

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '248_etapa3_conciliacion_bancaria.sql',
  '248',
  'claude_assistant',
  'Etapa 3 (Cobranzas y riesgo financiero): reconstrucción de la sesión de conciliación bancaria automática que se había perdido sin guardarse. Tablas conciliacion_bancaria_lotes/movimientos, flag cobros.conciliado_bancario, trigger de updated_at propio (no reutiliza tg_precios_clientes_updated_at), RLS, y 4 RPC de matching por tolerancia fecha/monto con grants restringidos a service_role desde el arranque (no repite el bug de grants de la migración 247).'
)
ON CONFLICT DO NOTHING;
