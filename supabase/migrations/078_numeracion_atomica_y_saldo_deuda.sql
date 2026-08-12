-- ============================================================
-- MIGRACIÓN 078 — Numeración atómica de comprobantes + trigger saldo_deuda
-- distrib v85
-- Corrige hallazgos #3 y #5 de la auditoría v84.
-- ============================================================

BEGIN;

-- ============================================================
-- PASO 1: RPC atómico para numeración de comprobantes
-- Reemplaza el SELECT+upsert no atómico desde el browser.
-- Usa SELECT...FOR UPDATE para garantizar serialización.
-- ============================================================

CREATE OR REPLACE FUNCTION public.siguiente_numero_comprobante(
  p_empresa_id uuid,
  p_tipo       text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_siguiente integer;
BEGIN
  -- Lock de la fila específica para serializar accesos concurrentes
  -- Si no existe la fila, la crea con 0 y la lockea
  INSERT INTO public.contadores_empresa (empresa_id, tipo, ultimo_numero)
    VALUES (p_empresa_id, p_tipo, 0)
    ON CONFLICT (empresa_id, tipo) DO NOTHING;

  SELECT ultimo_numero + 1
    INTO v_siguiente
    FROM public.contadores_empresa
   WHERE empresa_id = p_empresa_id
     AND tipo       = p_tipo
  FOR UPDATE;  -- Lock de fila — garantiza atomicidad

  UPDATE public.contadores_empresa
     SET ultimo_numero = v_siguiente,
         updated_at    = now()
   WHERE empresa_id = p_empresa_id
     AND tipo       = p_tipo;

  -- Retorna número formateado con 8 dígitos (ej: "00000042")
  RETURN lpad(v_siguiente::text, 8, '0');
END;
$$;

-- Revocar acceso directo a anon; solo authenticated puede llamarla
REVOKE ALL ON FUNCTION public.siguiente_numero_comprobante(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.siguiente_numero_comprobante(uuid, text) TO authenticated;

-- ============================================================
-- PASO 2: Trigger para mantener clientes.saldo_deuda sincronizado
-- con cta_cte (fuente de verdad real del saldo del cliente).
-- Corrige el hallazgo #3: saldo_deuda nunca se actualizaba.
-- ============================================================

-- Función que recalcula el saldo sumando débitos y restando créditos
CREATE OR REPLACE FUNCTION public.sync_saldo_deuda_cliente()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_cliente_id uuid;
  v_saldo      numeric(15,2);
BEGIN
  -- Determinar el cliente_id afectado (INSERT/UPDATE/DELETE)
  IF TG_OP = 'DELETE' THEN
    v_cliente_id := OLD.cliente_id;
  ELSE
    v_cliente_id := NEW.cliente_id;
  END IF;

  -- Recalcular saldo desde cta_cte (fuente de verdad)
  -- débito = cliente debe dinero (+), crédito/cobro = reduce deuda (-)
  SELECT COALESCE(
    SUM(CASE
          WHEN tipo IN ('factura', 'debito', 'cargo') THEN monto
          WHEN tipo IN ('cobro', 'credito', 'nota_credito', 'pago') THEN -monto
          ELSE 0
        END
    ), 0
  )
  INTO v_saldo
  FROM public.cta_cte
  WHERE cliente_id = v_cliente_id;

  -- Actualizar saldo_deuda en clientes
  UPDATE public.clientes
     SET saldo_deuda = GREATEST(0, v_saldo),
         updated_at  = now()
   WHERE id = v_cliente_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_saldo_deuda ON public.cta_cte;
CREATE TRIGGER trg_sync_saldo_deuda
  AFTER INSERT OR UPDATE OR DELETE
  ON public.cta_cte
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_saldo_deuda_cliente();

-- Sincronización inicial: recalcular todos los saldos existentes
-- (puede tardar si hay muchos clientes — ejecutar fuera de horario pico)
UPDATE public.clientes c
SET saldo_deuda = GREATEST(0, COALESCE((
  SELECT SUM(CASE
               WHEN tipo IN ('factura', 'debito', 'cargo') THEN monto
               WHEN tipo IN ('cobro', 'credito', 'nota_credito', 'pago') THEN -monto
               ELSE 0
             END)
    FROM public.cta_cte
   WHERE cliente_id = c.id
), 0));

-- ============================================================
-- PASO 3: Cron para presupuestos vencidos (requiere pg_cron)
-- Marca como 'vencido' los presupuestos con fecha pasada.
-- Si no tenés pg_cron en tu plan de Supabase, usar Vercel cron
-- apuntando a /api/admin?_ruta=vencer-presupuestos (ver handler).
-- ============================================================

-- Verificar si pg_cron está disponible antes de registrar:
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'vencer-presupuestos-diario',
      '0 3 * * *',  -- 3am Argentina ≈ 6am UTC
      $$
        UPDATE public.presupuestos
           SET estado     = 'vencido',
               updated_at = now()
         WHERE estado           = 'enviado'
           AND fecha_vencimiento < CURRENT_DATE;
      $$
    );
  END IF;
END $$;

-- ============================================================
-- PASO 4: Idempotencia en cobros (previene doble cobro)
-- ============================================================

-- Agregar columna idempotency_key si no existe
ALTER TABLE public.cobros
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS cobros_idempotency_key_unique
  ON public.cobros (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- PASO 5: Validación aplicación de pagos en cc_proveedores
-- ============================================================

-- Función de validación usada por el handler antes de insertar
CREATE OR REPLACE FUNCTION public.validar_aplicacion_pago_proveedor(
  p_monto              numeric,
  p_facturas_aplicadas jsonb  -- array de {factura_id, monto_aplicado}
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_suma numeric;
BEGIN
  SELECT COALESCE(SUM((elem->>'monto_aplicado')::numeric), 0)
    INTO v_suma
    FROM jsonb_array_elements(p_facturas_aplicadas) AS elem;

  -- Tolerancia de $0.01 por redondeo
  RETURN ABS(v_suma - p_monto) < 0.01;
END;
$$;

COMMIT;
