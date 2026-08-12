-- ============================================================
-- MIGRACIÓN 272 — Etapa 7: WhatsApp Embedded Signup (credenciales por empresa)
-- distrib v286
--
-- Hasta acá (247/271, Etapa 6) toda la plataforma comparte un único
-- WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN globales (variables de entorno),
-- que son el número de prueba/sandbox de Meta. Esta migración agrega el
-- lado "cada empresa con su propio WhatsApp Business" vía Embedded
-- Signup: el dueño conecta su Facebook, Meta le crea/asocia un WABA +
-- número propio, y guardamos esas credenciales acá.
--
-- Decisiones de diseño:
--
--  1. empresa_whatsapp es 1 fila por empresa (empresa_id es PK, no hay
--     multi-número por empresa en esta primera vuelta).
--  2. El access_token se guarda en texto plano por ahora, igual que el
--     resto de credenciales externas del proyecto (BCRA, etc.) — nota
--     pendiente: cifrar a nivel columna antes de escalar en serio.
--  3. RLS habilitado SIN policies sobre la tabla base → sólo
--     service_role puede leer/escribir (lo hace notif.js con la key de
--     servicio). El panel admin NO debe leer access_token nunca.
--  4. Para que el frontend pueda mostrar "conectado / no conectado" sin
--     pasar por el backend, se expone una VISTA con solo las columnas
--     no sensibles, con su propia policy de solo-lectura scopeada a
--     dueño/admin de la empresa vía get_empresa_id()/get_rol_usuario()
--     (mismas funciones SECURITY DEFINER STABLE que usa el resto del
--     proyecto para RLS, ver 002_rls.sql).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.empresa_whatsapp (
  empresa_id       UUID PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  waba_id          TEXT NOT NULL,
  phone_number_id  TEXT NOT NULL,
  access_token     TEXT NOT NULL,
  register_pin     TEXT,               -- PIN de 6 dígitos usado al registrar el número (por si hace falta re-registrar)
  verified_name    TEXT,               -- nombre verificado del número, devuelto por Meta
  conectado_por    UUID REFERENCES public.usuarios(id),
  conectado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS empresa_whatsapp_phone_number_id_key
  ON public.empresa_whatsapp (phone_number_id);

CREATE OR REPLACE FUNCTION public.set_empresa_whatsapp_actualizado_en()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_empresa_whatsapp_actualizado_en ON public.empresa_whatsapp;
CREATE TRIGGER trg_empresa_whatsapp_actualizado_en
  BEFORE UPDATE ON public.empresa_whatsapp
  FOR EACH ROW EXECUTE FUNCTION public.set_empresa_whatsapp_actualizado_en();

-- ============================================================
-- RLS de la tabla base — sin policies: solo service_role.
-- ============================================================
ALTER TABLE public.empresa_whatsapp ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.empresa_whatsapp FROM anon, authenticated;

-- ============================================================
-- Vista pública (sin access_token/register_pin) para que el panel
-- admin muestre el estado de conexión leyendo directo por Supabase.
-- ============================================================
CREATE OR REPLACE VIEW public.v_empresa_whatsapp_estado AS
SELECT
  ew.empresa_id,
  ew.phone_number_id,
  ew.verified_name,
  ew.conectado_por,
  ew.conectado_en,
  ew.actualizado_en
FROM public.empresa_whatsapp ew;

ALTER VIEW public.v_empresa_whatsapp_estado SET (security_invoker = true);

-- La vista hereda RLS de authenticated vía policy propia (misma tabla
-- base, pero acá sí permitimos SELECT a dueño/admin de esa empresa,
-- usando las mismas funciones helper que el resto del proyecto).
DROP POLICY IF EXISTS empresa_whatsapp_lectura_dueno_admin ON public.empresa_whatsapp;
CREATE POLICY empresa_whatsapp_lectura_dueno_admin ON public.empresa_whatsapp
  FOR SELECT USING (
    empresa_id IS NOT DISTINCT FROM public.get_empresa_id()
    AND public.get_rol_usuario() IN ('dueno', 'admin')
  );

-- security_invoker=true hace que la vista chequee los permisos del
-- usuario que consulta, no los del dueño de la vista — por eso hace
-- falta este GRANT column-level además de la policy: le da a
-- `authenticated` acceso de columna a lo no sensible únicamente (nunca
-- a access_token/register_pin), y la policy de arriba filtra las filas.
GRANT SELECT (empresa_id, phone_number_id, verified_name, conectado_por, conectado_en, actualizado_en)
  ON public.empresa_whatsapp TO authenticated;
GRANT SELECT ON public.v_empresa_whatsapp_estado TO authenticated;

COMMENT ON TABLE public.empresa_whatsapp IS
  'Credenciales de WhatsApp Business propias de cada empresa, obtenidas vía Embedded Signup (Etapa 7). Acceso de escritura solo service_role; lectura de columnas no sensibles vía v_empresa_whatsapp_estado para dueño/admin.';
COMMENT ON COLUMN public.empresa_whatsapp.access_token IS
  'Texto plano por ahora (mismo criterio que otras credenciales externas del proyecto) — pendiente cifrado a nivel columna antes de escalar.';
