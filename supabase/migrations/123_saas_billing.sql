-- ═══════════════════════════════════════════════════════════════════════════
-- 123_saas_billing.sql — Sistema de cobro SaaS por factura + transferencia
-- Flujo: trial 10 días → factura → 10 días para transferir → suspensión automática
-- Panel superadmin para confirmar pago y reactivar con un click.
-- Idempotente: usa IF NOT EXISTS / OR REPLACE en todo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- 0. Extensiones necesarias
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pg_cron";      -- scheduler interno de Supabase
CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- ya instalada; seguro repetir

-- ---------------------------------------------------------------------------
-- 1. ENUMs
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE saas_plan AS ENUM ('trial', 'activo', 'suspendido', 'cancelado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE saas_factura_estado AS ENUM ('pendiente', 'enviada', 'pagada', 'vencida');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Columnas SaaS en la tabla empresas
--    (sin tocar las columnas existentes)
-- ---------------------------------------------------------------------------
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS saas_plan         saas_plan     NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS saas_trial_fin    DATE,                         -- vence a los 10 días del alta
  ADD COLUMN IF NOT EXISTS saas_precio_mes   NUMERIC(10,2) NOT NULL DEFAULT 15000.00,
  ADD COLUMN IF NOT EXISTS saas_suspendida   BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS saas_suspendida_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS saas_cbu          TEXT,                         -- CBU del distribuidor (global)
  ADD COLUMN IF NOT EXISTS saas_alias        TEXT;                         -- alias del CBU

-- Poblar trial_fin para empresas existentes que no lo tengan
UPDATE public.empresas
SET saas_trial_fin = (created_at + INTERVAL '10 days')::DATE
WHERE saas_trial_fin IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Tabla: saas_facturas
--    Una factura por empresa por período (mes o trial)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.saas_facturas (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID          NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  numero          TEXT          NOT NULL,                 -- ej: "SAAS-2026-0001"
  periodo         TEXT          NOT NULL,                 -- ej: "2026-07"  o  "TRIAL-2026-07-01"
  concepto        TEXT          NOT NULL DEFAULT 'Suscripción mensual distrib SaaS',
  monto           NUMERIC(10,2) NOT NULL,
  estado          saas_factura_estado NOT NULL DEFAULT 'pendiente',
  fecha_emision   DATE          NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento DATE        NOT NULL,                 -- emision + 10 días
  fecha_pago      TIMESTAMPTZ,                            -- cuando el admin confirma
  confirmado_por  UUID          REFERENCES public.usuarios(id),
  notas           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_facturas_empresa  ON public.saas_facturas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_saas_facturas_estado   ON public.saas_facturas(estado);
CREATE INDEX IF NOT EXISTS idx_saas_facturas_venc     ON public.saas_facturas(fecha_vencimiento) WHERE estado IN ('pendiente','enviada');

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.saas_facturas_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_saas_facturas_updated_at ON public.saas_facturas;
CREATE TRIGGER trg_saas_facturas_updated_at
  BEFORE UPDATE ON public.saas_facturas
  FOR EACH ROW EXECUTE FUNCTION public.saas_facturas_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Tabla: saas_email_log
--    Registro de todos los emails SaaS enviados (para no duplicar y auditar)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.saas_email_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID        NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  factura_id  UUID        REFERENCES public.saas_facturas(id),
  tipo        TEXT        NOT NULL,   -- 'trial_aviso', 'factura', 'suspension', 'reactivacion'
  destinatario TEXT       NOT NULL,
  enviado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok          BOOLEAN     NOT NULL DEFAULT true,
  detalle     TEXT
);

CREATE INDEX IF NOT EXISTS idx_saas_email_log_empresa ON public.saas_email_log(empresa_id);
CREATE INDEX IF NOT EXISTS idx_saas_email_log_tipo    ON public.saas_email_log(empresa_id, tipo, enviado_at);

-- ---------------------------------------------------------------------------
-- 5. Tabla: saas_config
--    Configuración global del SaaS (una sola fila)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.saas_config (
  id                  INT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
  cbu                 TEXT NOT NULL DEFAULT '',
  alias               TEXT NOT NULL DEFAULT '',
  titular             TEXT NOT NULL DEFAULT '',
  banco               TEXT NOT NULL DEFAULT '',
  precio_mensual      NUMERIC(10,2) NOT NULL DEFAULT 15000.00,
  dias_trial          INT  NOT NULL DEFAULT 10,
  dias_vencimiento    INT  NOT NULL DEFAULT 10,   -- días para pagar una factura
  dias_aviso_trial    INT  NOT NULL DEFAULT 5,    -- avisar cuando quedan N días de trial
  email_admin         TEXT NOT NULL DEFAULT '',   -- email del superadmin para recibir alertas
  updated_at          TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.saas_config (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Contador correlativo de facturas SaaS
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.saas_factura_seq START 1;

-- ---------------------------------------------------------------------------
-- 7. Función: saas_generar_numero_factura()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_generar_numero_factura()
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'SAAS-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
         LPAD(nextval('public.saas_factura_seq')::TEXT, 4, '0');
END $$;

-- ---------------------------------------------------------------------------
-- 8. Función: saas_crear_factura(empresa_id, concepto_override)
--    Genera una factura para una empresa y la marca como 'enviada'.
--    Retorna el id de la factura creada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_crear_factura(
  p_empresa_id  UUID,
  p_concepto    TEXT DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cfg       public.saas_config%ROWTYPE;
  v_empresa   public.empresas%ROWTYPE;
  v_periodo   TEXT;
  v_factura_id UUID;
  v_concepto  TEXT;
BEGIN
  SELECT * INTO v_cfg FROM public.saas_config WHERE id = 1;
  SELECT * INTO v_empresa FROM public.empresas WHERE id = p_empresa_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa % no encontrada', p_empresa_id;
  END IF;

  v_periodo  := TO_CHAR(NOW(), 'YYYY-MM');
  v_concepto := COALESCE(p_concepto, 'Suscripción mensual distrib SaaS — ' || TO_CHAR(NOW(), 'MM/YYYY'));

  INSERT INTO public.saas_facturas (
    empresa_id, numero, periodo, concepto, monto,
    estado, fecha_emision, fecha_vencimiento
  ) VALUES (
    p_empresa_id,
    public.saas_generar_numero_factura(),
    v_periodo,
    v_concepto,
    COALESCE(v_empresa.saas_precio_mes, v_cfg.precio_mensual),
    'enviada',
    CURRENT_DATE,
    CURRENT_DATE + v_cfg.dias_vencimiento
  )
  RETURNING id INTO v_factura_id;

  RETURN v_factura_id;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Función: saas_confirmar_pago(factura_id, usuario_admin_id)
--    El superadmin hace click → cuenta activa, factura marcada 'pagada'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_confirmar_pago(
  p_factura_id    UUID,
  p_admin_user_id UUID DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_factura public.saas_facturas%ROWTYPE;
BEGIN
  SELECT * INTO v_factura FROM public.saas_facturas WHERE id = p_factura_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  -- Marcar factura como pagada
  UPDATE public.saas_facturas SET
    estado         = 'pagada',
    fecha_pago     = now(),
    confirmado_por = p_admin_user_id
  WHERE id = p_factura_id;

  -- Reactivar la empresa
  UPDATE public.empresas SET
    saas_plan        = 'activo',
    saas_suspendida  = false,
    saas_suspendida_at = NULL,
    activa           = true
  WHERE id = v_factura.empresa_id;

  -- Registrar email de reactivación en log (el envío real lo hace el Edge Function)
  INSERT INTO public.saas_email_log (empresa_id, factura_id, tipo, destinatario)
  SELECT v_factura.empresa_id, p_factura_id, 'reactivacion', email
  FROM public.empresas WHERE id = v_factura.empresa_id;

  RETURN jsonb_build_object(
    'ok',         true,
    'empresa_id', v_factura.empresa_id,
    'factura_id', p_factura_id
  );
END $$;

-- ---------------------------------------------------------------------------
-- 10. Función: saas_suspender_empresa(empresa_id)
--     Suspende una empresa (usada por el cron y también manualmente).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_suspender_empresa(p_empresa_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.empresas SET
    saas_plan         = 'suspendido',
    saas_suspendida   = true,
    saas_suspendida_at = now(),
    activa            = false
  WHERE id = p_empresa_id
    AND saas_plan != 'cancelado';   -- no tocar canceladas

  -- Log para que el Edge Function dispare el email
  INSERT INTO public.saas_email_log (empresa_id, tipo, destinatario)
  SELECT p_empresa_id, 'suspension', email
  FROM public.empresas WHERE id = p_empresa_id
  ON CONFLICT DO NOTHING;
END $$;

-- ---------------------------------------------------------------------------
-- 11. Función CRON #1: saas_cron_trial_check()
--     Corre diariamente. Evalúa empresas en trial:
--       - quedan 5 días  → email de aviso + genera factura de transición
--       - vencido        → suspende
-- ---------------------------------------------------------------------------
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
  LOOP
    -- Generar factura de activación si no existe ya para este mes
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

    -- Suspender
    PERFORM public.saas_suspender_empresa(rec.id);
  END LOOP;

  -- ── Empresas con N días de aviso antes del vencimiento del trial ──
  FOR rec IN
    SELECT id, email, nombre, saas_trial_fin
    FROM public.empresas
    WHERE saas_plan = 'trial'
      AND saas_trial_fin = CURRENT_DATE + v_cfg.dias_aviso_trial
      AND saas_suspendida = false
  LOOP
    -- Generar factura anticipada si no existe
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

    -- Log de email de aviso
    INSERT INTO public.saas_email_log (empresa_id, factura_id, tipo, destinatario)
    VALUES (rec.id, v_fid, 'trial_aviso', rec.email)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 12. Función CRON #2: saas_cron_facturacion_mensual()
--     Corre el día 1 de cada mes a las 08:00 ART.
--     Genera y envía factura a todas las empresas activas.
-- ---------------------------------------------------------------------------
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
  LOOP
    -- Evitar duplicado si ya existe factura para este mes
    IF NOT EXISTS (
      SELECT 1 FROM public.saas_facturas
      WHERE empresa_id = rec.id
        AND periodo = TO_CHAR(NOW(), 'YYYY-MM')
    ) THEN
      v_fid := public.saas_crear_factura(rec.id);

      -- Log para disparo del Edge Function de email
      INSERT INTO public.saas_email_log (empresa_id, factura_id, tipo, destinatario)
      VALUES (rec.id, v_fid, 'factura', rec.email);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 13. Función CRON #3: saas_cron_suspender_morosos()
--     Corre diariamente. Suspende empresas con facturas vencidas sin pago.
-- ---------------------------------------------------------------------------
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
  LOOP
    -- Marcar factura como vencida
    UPDATE public.saas_facturas
    SET estado = 'vencida'
    WHERE empresa_id = rec.empresa_id
      AND estado IN ('pendiente', 'enviada')
      AND fecha_vencimiento < CURRENT_DATE;

    -- Suspender empresa
    PERFORM public.saas_suspender_empresa(rec.empresa_id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 14. Trigger: cuando se crea una empresa nueva → set trial_fin automático
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_trigger_nuevo_empresa()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_dias INT;
BEGIN
  SELECT dias_trial INTO v_dias FROM public.saas_config WHERE id = 1;
  v_dias := COALESCE(v_dias, 10);

  NEW.saas_plan      := 'trial';
  NEW.saas_trial_fin := (NEW.created_at + (v_dias || ' days')::INTERVAL)::DATE;
  NEW.saas_precio_mes := COALESCE(
    NEW.saas_precio_mes,
    (SELECT precio_mensual FROM public.saas_config WHERE id = 1)
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_saas_nuevo_empresa ON public.empresas;
CREATE TRIGGER trg_saas_nuevo_empresa
  BEFORE INSERT ON public.empresas
  FOR EACH ROW EXECUTE FUNCTION public.saas_trigger_nuevo_empresa();

-- ---------------------------------------------------------------------------
-- 15. Vista: saas_panel_admin
--     Lo que ve el superadmin en su panel de un vistazo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.saas_panel_admin AS
SELECT
  e.id                              AS empresa_id,
  e.nombre,
  e.email,
  e.saas_plan,
  e.saas_trial_fin,
  e.saas_suspendida,
  e.saas_suspendida_at,
  e.saas_precio_mes,
  e.created_at                      AS alta,
  -- Factura más reciente
  f.id                              AS ultima_factura_id,
  f.numero                          AS ultima_factura_numero,
  f.periodo                         AS ultima_factura_periodo,
  f.monto                           AS ultima_factura_monto,
  f.estado                          AS ultima_factura_estado,
  f.fecha_emision                   AS ultima_factura_emision,
  f.fecha_vencimiento               AS ultima_factura_vencimiento,
  f.fecha_pago                      AS ultima_factura_pago,
  -- Días hasta vencimiento (negativo = ya venció)
  (f.fecha_vencimiento - CURRENT_DATE) AS dias_para_vencer
FROM public.empresas e
LEFT JOIN LATERAL (
  SELECT *
  FROM public.saas_facturas
  WHERE empresa_id = e.id
  ORDER BY created_at DESC
  LIMIT 1
) f ON true
ORDER BY
  CASE e.saas_plan
    WHEN 'suspendido' THEN 1
    WHEN 'trial'      THEN 2
    WHEN 'activo'     THEN 3
    ELSE 4
  END,
  e.saas_suspendida_at DESC NULLS LAST,
  e.nombre;

-- ---------------------------------------------------------------------------
-- 16. RLS en las nuevas tablas
--    saas_facturas y saas_email_log: solo superadmin (service role)
--    desde la app normal no se accede directamente; se usa via RPC.
-- ---------------------------------------------------------------------------
ALTER TABLE public.saas_facturas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_config    ENABLE ROW LEVEL SECURITY;

-- Política: cada empresa ve solo sus propias facturas (para portal de cliente)
DROP POLICY IF EXISTS "saas_facturas_own" ON public.saas_facturas;
CREATE POLICY "saas_facturas_own" ON public.saas_facturas
  FOR SELECT
  USING (empresa_id = public.get_empresa_id());

-- email_log: solo service role / admin (sin política de lectura pública)
-- saas_config: solo lectura para usuarios autenticados (necesita CBU para mostrar)
DROP POLICY IF EXISTS "saas_config_read" ON public.saas_config;
CREATE POLICY "saas_config_read" ON public.saas_config
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- 17. Registrar los jobs en pg_cron
--    (Supabase necesita que pg_cron esté habilitado en el proyecto:
--     Dashboard → Database → Extensions → pg_cron)
-- ---------------------------------------------------------------------------

-- Limpiar jobs previos si existen (idempotente)
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN (
  'saas_trial_check_diario',
  'saas_facturacion_mensual',
  'saas_suspender_morosos_diario'
);

-- Job 1: Chequeo diario de trials (08:00 ART = 11:00 UTC)
SELECT cron.schedule(
  'saas_trial_check_diario',
  '0 11 * * *',
  $$SELECT public.saas_cron_trial_check()$$
);

-- Job 2: Facturación mensual — día 1 de cada mes a las 08:00 ART
SELECT cron.schedule(
  'saas_facturacion_mensual',
  '0 11 1 * *',
  $$SELECT public.saas_cron_facturacion_mensual()$$
);

-- Job 3: Suspensión de morosos — diario a las 09:00 ART (12:00 UTC)
SELECT cron.schedule(
  'saas_suspender_morosos_diario',
  '0 12 * * *',
  $$SELECT public.saas_cron_suspender_morosos()$$
);

-- ---------------------------------------------------------------------------
-- 18. Comentarios de documentación
-- ---------------------------------------------------------------------------
COMMENT ON TABLE  public.saas_facturas   IS 'Facturas de la suscripción SaaS (≠ facturas del negocio del cliente)';
COMMENT ON TABLE  public.saas_email_log  IS 'Log de emails SaaS enviados; el Edge Function lee este tabla para disparar envíos';
COMMENT ON TABLE  public.saas_config     IS 'Configuración global del SaaS: CBU, precio, días de gracia. Singleton (id=1)';
COMMENT ON VIEW   public.saas_panel_admin IS 'Vista para el panel superadmin: estado de cada empresa + última factura';
COMMENT ON FUNCTION public.saas_confirmar_pago IS 'Llamar desde el panel admin cuando se verifica la transferencia en el banco';
COMMENT ON FUNCTION public.saas_crear_factura  IS 'Crea y registra una factura SaaS; retorna el UUID de la factura';
