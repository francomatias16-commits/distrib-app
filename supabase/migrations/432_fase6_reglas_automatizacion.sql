-- ============================================================
-- 432_fase6_reglas_automatizacion.sql
-- PLAN_ERP_SINCRONIZACION_2026.md — Fase 6: motor de automatización sobre
-- el bus de eventos (eventos_negocio, migración 431).
--
-- A diferencia de los listeners de código fijo (lib/eventos-listeners/*),
-- estas son reglas que el propio cliente arma desde la UI
-- (automatizacion.html, sección "Reglas personalizadas"): "cuando pase
-- evento X, si se cumple esta condición, ejecutá esta acción". Se evalúan
-- desde despacharReglasAutomatizacion() en lib/eventos-dispatcher.js,
-- independientemente de los listeners fijos (no afectan el estado
-- 'procesado'/'error' de eventos_negocio, ver comentario en ese archivo).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reglas_automatizacion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  nombre             text NOT NULL,
  descripcion        text,

  -- Tipo de evento que dispara la evaluación de esta regla. Debe
  -- coincidir con evento.tipo_evento en eventos_negocio (pedido_creado,
  -- pedido_facturado, factura_anulada, cliente_en_mora,
  -- cheques_por_vencer, ...) — no hay FK porque tipo_evento es texto
  -- libre en eventos_negocio (fase 1), la validación de valores conocidos
  -- se hace en la app (lib/repos/reglas-automatizacion.js:EVENTOS_DISPONIBLES).
  evento_disparador  text NOT NULL,

  -- Condición en JSON, evaluada por evaluarCondicion() en
  -- lib/reglas-automatizacion.js. {} = siempre matchea.
  -- Formatos: {campo,operador,valor} | {y:[...]} | {o:[...]}.
  condicion          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Acción a ejecutar si la condición matchea, evaluada por
  -- ejecutarAccion(). MVP: solo {"tipo":"notificar_push", "titulo":...,
  -- "mensaje":..., "roles":[...]}.
  accion             jsonb NOT NULL,

  activa             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reglas_automatizacion_accion_tiene_tipo CHECK (accion ? 'tipo')
);

-- Índice que soporta la query caliente del despachador: reglas activas de
-- una empresa para un tipo de evento puntual (obtenerReglasActivas()).
CREATE INDEX IF NOT EXISTS idx_reglas_automatizacion_empresa_evento_activa
  ON public.reglas_automatizacion(empresa_id, evento_disparador, activa);

COMMENT ON TABLE public.reglas_automatizacion IS
  'Fase 6 de PLAN_ERP_SINCRONIZACION_2026.md: reglas de automatización armadas por el cliente desde automatizacion.html ("Reglas personalizadas"), evaluadas sobre el bus de eventos_negocio en paralelo a los listeners de código fijo. MVP de acción soportada: notificar_push.';

CREATE TRIGGER tg_reglas_automatizacion_updated_at
  BEFORE UPDATE ON public.reglas_automatizacion
  FOR EACH ROW EXECUTE FUNCTION public.tg_precios_clientes_updated_at();
  -- reutiliza el trigger genérico "set updated_at = now()" ya usado por
  -- precios_clientes / reglas_precio (migración 243).

-- ── RLS ──────────────────────────────────────────────────────────────
-- Reglas de automatización disparan notificaciones a nombre de la
-- empresa — se restringe a dueño/admin (no se abre a vendedor/contador/
-- depositero), mismo criterio que aplica el handler de la API.
ALTER TABLE public.reglas_automatizacion ENABLE ROW LEVEL SECURITY;

CREATE POLICY reglas_automatizacion_select ON public.reglas_automatizacion
  FOR SELECT
  USING (empresa_id = get_empresa_id());

CREATE POLICY reglas_automatizacion_modify ON public.reglas_automatizacion
  FOR ALL
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])
  )
  WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])
  );

-- lib/handlers/reglas-automatizacion.js y lib/reglas-automatizacion.js
-- usan SERVICE_ROLE_KEY (bypassea RLS) — la RLS de arriba es la barrera
-- para cualquier acceso directo con el token del usuario (ej. futuras
-- lecturas server-side rendered o clientes que no pasen por la API).
REVOKE ALL ON public.reglas_automatizacion FROM anon, authenticated;
GRANT SELECT ON public.reglas_automatizacion TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '432_fase6_reglas_automatizacion.sql',
  '432',
  'claude-session',
  'Fase 6 de PLAN_ERP_SINCRONIZACION_2026.md: tabla reglas_automatizacion — motor de automatización configurable por el cliente sobre el bus de eventos_negocio (Fase 1). Se evalúa en paralelo a los listeners fijos desde eventos-dispatcher.js:despacharReglasAutomatizacion(), sin afectar el estado procesado/error que ya prueban los tests existentes del despachador. MVP de acción: notificar_push. CRUD de administración vía lib/handlers/reglas-automatizacion.js + UI en automatizacion.html ("Reglas personalizadas").'
)
ON CONFLICT (carpeta, archivo) DO NOTHING;
