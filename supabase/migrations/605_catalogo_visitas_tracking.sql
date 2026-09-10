-- 605_catalogo_visitas_tracking.sql
--
-- Tracking de origen del catálogo público (?src=ig-bio, ?src=qr-local, etc.)
-- para que el dueño vea de qué canal le llegan más visitas — panel en
-- empresa-config.html, botón "Ver visitas por canal".
--
-- Dos funciones, dos roles distintos:
--
--   1) registrar_visita_catalogo(p_empresa_id, p_origen) — SECURITY DEFINER,
--      llamada DIRECTO desde catalogo.html (sb.rpc, sin pasar por el
--      backend) por visitantes anónimos. Mismo gateo que SEC-008 (292,
--      cliente_productos_disponibles) y 476 (empresa_publica_por_id):
--      solo inserta si la empresa tiene
--      config->>'catalogo_publico_habilitado' = true. Si no, no hace nada
--      (no error, no filtra si la empresa existe) — evita que alguien use
--      este RPC para poblar basura en empresas que no lo tienen habilitado.
--      Best-effort desde el frontend: si falla, no bloquea la carga del
--      catálogo (ver catalogo.html, registrarVisitaOrigen()).
--
--   2) resumen_visitas_catalogo(p_empresa_id, p_dias) — agregación server-side
--      para el panel admin (GET /api/empresa/catalogo-visitas, gateado por
--      requerirPerfilAdmin() en Node, no por este RPC). Mismo gateo por las
--      dudas si alguna vez se expone via PostgREST directo. `p_origen NULL`
--      (visita sin ?src=) se agrupa como 'directo'.
--
-- La tabla en sí no tiene policy de INSERT para anon/authenticated — el
-- único camino de escritura es el RPC (1), que corre con los privilegios
-- del dueño de la función (SECURITY DEFINER), no los del caller.

CREATE TABLE IF NOT EXISTS public.catalogo_visitas (
  id          bigserial   PRIMARY KEY,
  empresa_id  uuid        NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  origen      text,
  creado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalogo_visitas_empresa_fecha
  ON public.catalogo_visitas (empresa_id, creado_en DESC);

COMMENT ON TABLE public.catalogo_visitas IS
  'Migración 605: una fila por carga del catálogo público con origen registrado (?src=). Poblada únicamente por registrar_visita_catalogo() — no tiene policy de INSERT directa para anon/authenticated.';

ALTER TABLE public.catalogo_visitas ENABLE ROW LEVEL SECURITY;

-- Lectura directa (PostgREST) restringida al dueño de los datos — mismo
-- criterio que el resto de las tablas tenant-scoped del proyecto. El panel
-- admin en la práctica lee vía el backend (service_role, bypasea RLS), esta
-- policy es la red de seguridad si algo alguna vez consulta la tabla directo.
CREATE POLICY catalogo_visitas_select_propia_empresa
  ON public.catalogo_visitas
  FOR SELECT
  USING (empresa_id = public.get_empresa_id());

-- ============================================================
-- RPC 1: registrar_visita_catalogo — público, gateado, best-effort
-- ============================================================
CREATE OR REPLACE FUNCTION public.registrar_visita_catalogo(p_empresa_id uuid, p_origen text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM p_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = p_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.catalogo_visitas (empresa_id, origen)
  VALUES (p_empresa_id, NULLIF(btrim(p_origen), ''));
END;
$function$;

REVOKE ALL ON FUNCTION public.registrar_visita_catalogo(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_visita_catalogo(uuid, text) TO anon, authenticated;

-- ============================================================
-- RPC 2: resumen_visitas_catalogo — agregado por canal, para el panel admin
-- ============================================================
CREATE OR REPLACE FUNCTION public.resumen_visitas_catalogo(p_empresa_id uuid, p_dias integer DEFAULT 30)
RETURNS TABLE(origen text, visitas bigint, ultima_visita timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM p_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = p_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(v.origen, 'directo') AS origen,
    COUNT(*)                      AS visitas,
    MAX(v.creado_en)              AS ultima_visita
  FROM public.catalogo_visitas v
  WHERE v.empresa_id = p_empresa_id
    AND v.creado_en >= now() - (GREATEST(1, LEAST(365, p_dias)) || ' days')::interval
  GROUP BY COALESCE(v.origen, 'directo')
  ORDER BY visitas DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.resumen_visitas_catalogo(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resumen_visitas_catalogo(uuid, integer) TO anon, authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '605_catalogo_visitas_tracking.sql', '605', 'claude-session', 'Tabla catalogo_visitas + RPCs registrar_visita_catalogo (público, gateado por catalogo_publico_habilitado, mismo patrón SEC-008) y resumen_visitas_catalogo (agregado por canal para GET /api/empresa/catalogo-visitas)')
ON CONFLICT DO NOTHING;
