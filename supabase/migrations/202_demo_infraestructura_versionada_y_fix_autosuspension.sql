-- ============================================================
-- 202 — Versionar infraestructura de la demo + fix autosuspensión
-- ============================================================
--
-- CONTEXTO:
-- La columna `empresas.es_demo`, el usuario demo@distrib-test.local y la
-- empresa "Distribuidora Demo S.A." se crearon directo en Supabase (fuera
-- de este repo) para el fix de v219. Esta migración:
--
--   1. Deja `es_demo` versionada (idempotente: no rompe si ya existe).
--   2. Corrige un bug real: los crons de facturación/suspensión SaaS
--      (saas_cron_trial_check, saas_cron_facturacion_mensual,
--      saas_cron_suspender_morosos — definidos en 123_saas_billing.sql)
--      NO excluían empresas demo. Si "Distribuidora Demo S.A." está en
--      saas_plan='activo' o 'trial', estos crons le generan factura mensual
--      real y, como nadie la paga, la terminan suspendiendo sola —
--      tumbando la demo pública sin que nadie lo note.
--   3. Si la empresa demo ya existe, normaliza su estado SaaS para que
--      quede a salvo de inmediato (no solo de cara al futuro).
--
-- Es seguro correr esta migración aunque `es_demo` ya exista en producción
-- (todo con IF NOT EXISTS / CREATE OR REPLACE).

-- ------------------------------------------------------------
-- 1. Columna es_demo (idempotente)
-- ------------------------------------------------------------
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS es_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresas.es_demo IS
  'Marca la empresa como demo pública compartida. Bloquea integraciones '
  'reales (ARCA, WhatsApp, email, ver lib/demo-mode.js) y debe excluirse '
  'siempre de los crons de facturación/suspensión SaaS (ver más abajo).';

CREATE INDEX IF NOT EXISTS idx_empresas_es_demo ON public.empresas(es_demo) WHERE es_demo = true;

-- ------------------------------------------------------------
-- 2. Normalizar la empresa demo si ya existe, para que quede a salvo ya
--    mismo (no solo de cara a corridas futuras del cron).
-- ------------------------------------------------------------
UPDATE public.empresas
SET
  es_demo             = true,
  saas_plan           = 'activo',
  saas_suspendida     = false,
  saas_suspendida_at  = NULL,
  saas_trial_fin      = NULL,
  activa              = true
WHERE nombre = 'Distribuidora Demo S.A.'
  AND es_demo IS DISTINCT FROM true;

-- ------------------------------------------------------------
-- 3. Excluir empresas demo de los 3 crons de billing SaaS
--    (mismo cuerpo que 123_saas_billing.sql, + filtro es_demo = false)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.saas_cron_trial_check()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cfg   public.saas_config%ROWTYPE;
  rec     RECORD;
  v_fid   UUID;
BEGIN
  SELECT * INTO v_cfg FROM public.saas_config WHERE id = 1;

  -- ── Empresas cuyo trial venció hoy o antes y siguen en plan trial ──
  FOR rec IN
    SELECT id, email, nombre, saas_trial_fin
    FROM public.empresas
    WHERE saas_plan = 'trial'
      AND saas_trial_fin < CURRENT_DATE
      AND saas_suspendida = false
      AND es_demo = false
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.saas_facturas
      WHERE empresa_id = rec.id
        AND periodo = TO_CHAR(NOW(), 'YYYY-MM')
        AND estado IN ('pendiente','enviada')
    ) THEN
      v_fid := public.saas_crear_factura(
        rec.id,
        'Activación suscripción mensual distrib SaaS'
      );
    END IF;

    PERFORM public.saas_suspender_empresa(rec.id);
  END LOOP;

  -- ── Empresas con N días de aviso antes del vencimiento del trial ──
  FOR rec IN
    SELECT id, email, nombre, saas_trial_fin
    FROM public.empresas
    WHERE saas_plan = 'trial'
      AND saas_trial_fin = CURRENT_DATE + v_cfg.dias_aviso_trial
      AND saas_suspendida = false
      AND es_demo = false
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.saas_facturas
      WHERE empresa_id = rec.id
        AND periodo = TO_CHAR(NOW(), 'YYYY-MM')
        AND estado IN ('pendiente','enviada')
    ) THEN
      v_fid := public.saas_crear_factura(
        rec.id,
        'Activación suscripción mensual distrib SaaS'
      );
    END IF;

    INSERT INTO public.saas_email_log (empresa_id, factura_id, tipo, destinatario)
    VALUES (rec.id, v_fid, 'trial_aviso', rec.email)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.saas_cron_facturacion_mensual()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec   RECORD;
  v_fid UUID;
BEGIN
  FOR rec IN
    SELECT id, email, nombre
    FROM public.empresas
    WHERE saas_plan = 'activo'
      AND saas_suspendida = false
      AND activa = true
      AND es_demo = false
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.saas_facturas
      WHERE empresa_id = rec.id
        AND periodo = TO_CHAR(NOW(), 'YYYY-MM')
    ) THEN
      v_fid := public.saas_crear_factura(rec.id);

      INSERT INTO public.saas_email_log (empresa_id, factura_id, tipo, destinatario)
      VALUES (rec.id, v_fid, 'factura', rec.email);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.saas_cron_suspender_morosos()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT DISTINCT f.empresa_id
    FROM public.saas_facturas f
    JOIN public.empresas e ON e.id = f.empresa_id
    WHERE f.estado IN ('pendiente', 'enviada')
      AND f.fecha_vencimiento < CURRENT_DATE
      AND e.saas_suspendida = false
      AND e.saas_plan != 'cancelado'
      AND e.es_demo = false
  LOOP
    UPDATE public.saas_facturas
    SET estado = 'vencida'
    WHERE empresa_id = rec.empresa_id
      AND estado IN ('pendiente', 'enviada')
      AND fecha_vencimiento < CURRENT_DATE;

    PERFORM public.saas_suspender_empresa(rec.empresa_id);
  END LOOP;
END $$;

-- Los GRANT/REVOKE de estas funciones ya quedaron bien en 142/143;
-- CREATE OR REPLACE no toca privilegios, así que no hace falta repetirlos.
