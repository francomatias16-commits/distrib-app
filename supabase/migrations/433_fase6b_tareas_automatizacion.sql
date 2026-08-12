-- ============================================================
-- 433_fase6b_tareas_automatizacion.sql
-- PLAN_ERP_SINCRONIZACION_2026.md — Fase 6b: segundo y tercer tipo de
-- acción para las reglas de automatización (migración 432): además de
-- 'notificar_push', ahora una regla puede 'enviar_whatsapp' (a un
-- cliente, resuelto vía payload.cliente_id — no persiste nada nuevo,
-- reusa la tabla clientes y el endpoint /api/notif?tipo=whatsapp ya
-- existente) o 'crear_tarea', que sí necesita almacenamiento propio:
-- un pendiente visible en la sección "Tareas" de automatizacion.html
-- hasta que alguien lo marca como resuelto.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tareas_automatizacion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,

  -- Regla que la creó (informativo — se conserva aunque se borre la
  -- regla, para no perder el historial de tareas ya generadas).
  regla_id           uuid REFERENCES public.reglas_automatizacion(id) ON DELETE SET NULL,

  -- tipo_evento de eventos_negocio que disparó la regla (mismo criterio
  -- de texto libre que reglas_automatizacion.evento_disparador).
  evento_disparador  text NOT NULL,

  titulo             text NOT NULL,
  descripcion        text,

  -- Roles que pueden ver/completar esta tarea puntual (default
  -- dueño/admin si la regla no especifica roles, ver
  -- lib/reglas-automatizacion.js:ejecutarAccion). Array chico de
  -- rol_usuario en texto — no se tipa como rol_usuario[] para no atarse
  -- al enum si algún día se agregan roles ad-hoc.
  roles              text[] NOT NULL DEFAULT ARRAY['dueno', 'admin'],

  estado             text NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente', 'completada')),
  completada_por     uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  completada_en      timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tareas_automatizacion_titulo_no_vacio CHECK (btrim(titulo) <> '')
);

-- Query caliente del panel: tareas pendientes de una empresa filtradas
-- por rol (listarTareasAutomatizacion() usa .contains('roles', [rol])).
CREATE INDEX IF NOT EXISTS idx_tareas_automatizacion_empresa_estado
  ON public.tareas_automatizacion(empresa_id, estado, created_at DESC);

-- Acelera el filtro por rol (operador de contención sobre array).
CREATE INDEX IF NOT EXISTS idx_tareas_automatizacion_roles
  ON public.tareas_automatizacion USING gin(roles);

COMMENT ON TABLE public.tareas_automatizacion IS
  'Fase 6b de PLAN_ERP_SINCRONIZACION_2026.md: tareas creadas por la acción "crear_tarea" de una regla de automatización (migración 432). Visibles en la sección "Tareas" de automatizacion.html para cualquier rol interno al que se le hayan asignado, no solo dueño/admin.';

-- ── RLS ──────────────────────────────────────────────────────────────
-- A diferencia de reglas_automatizacion (solo dueño/admin), acá
-- cualquier rol interno de la empresa puede ver/completar las tareas
-- que le corresponden por rol — mismo criterio que
-- ROLES_TAREAS en lib/handlers/reglas-automatizacion.js. El portal
-- cliente y el portal chofer no entran (tienen su propia auth y no usan
-- este endpoint).
ALTER TABLE public.tareas_automatizacion ENABLE ROW LEVEL SECURITY;

CREATE POLICY tareas_automatizacion_select ON public.tareas_automatizacion
  FOR SELECT
  USING (
    empresa_id = get_empresa_id()
    AND (
      get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])
      OR get_rol_usuario()::text = ANY (roles)
    )
  );

CREATE POLICY tareas_automatizacion_update ON public.tareas_automatizacion
  FOR UPDATE
  USING (
    empresa_id = get_empresa_id()
    AND (
      get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])
      OR get_rol_usuario()::text = ANY (roles)
    )
  )
  WITH CHECK (empresa_id = get_empresa_id());

-- El insert de tareas nuevas lo hace exclusivamente el motor
-- (ejecutarAccion en lib/reglas-automatizacion.js), con
-- SERVICE_ROLE_KEY — no hay policy de INSERT para authenticated, mismo
-- patrón que reglas_automatizacion con su acceso vía handler.
--
-- lib/handlers/reglas-automatizacion.js y lib/reglas-automatizacion.js
-- usan SERVICE_ROLE_KEY (bypassea RLS) — la RLS de arriba es la barrera
-- para cualquier acceso directo con el token del usuario.
REVOKE ALL ON public.tareas_automatizacion FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.tareas_automatizacion TO authenticated;

CREATE TRIGGER tg_tareas_automatizacion_updated_at
  BEFORE UPDATE ON public.tareas_automatizacion
  FOR EACH ROW EXECUTE FUNCTION public.tg_precios_clientes_updated_at();

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '433_fase6b_tareas_automatizacion.sql',
  '433',
  'claude-session',
  'Fase 6b de PLAN_ERP_SINCRONIZACION_2026.md: segundo y tercer tipo de acción para reglas de automatización — enviar_whatsapp (no requiere tabla propia, reusa clientes + /api/notif?tipo=whatsapp) y crear_tarea, que sí necesita almacenamiento: tabla tareas_automatizacion con RLS abierta a cualquier rol interno asignado (no solo dueño/admin, a diferencia de reglas_automatizacion). CRUD de lectura/completado vía lib/handlers/reglas-automatizacion.js (_svc=tareas / _svc=tareas-completar), UI en la sección "Tareas" de automatizacion.html.'
)
ON CONFLICT (carpeta, archivo) DO NOTHING;
