-- =============================================================================
-- 048_fix_sync_code_v47.sql
-- Sincronización esquema ↔ código v47
--
-- Corrige todos los desajustes detectados entre el backup de la DB real y el
-- código de los handlers. Aplicar una sola vez en el proyecto Supabase.
-- =============================================================================

-- ── 1. notif_log — tabla faltante en backup ───────────────────────────────
-- Definida en 005_notif_log.sql pero no presente en el backup de producción.
-- Usada por notif.js, _push.js y pedidos.js para auditoría de mensajes WA/Push.
CREATE TABLE IF NOT EXISTS public.notif_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id   UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  pedido_id    UUID REFERENCES public.pedidos(id)  ON DELETE SET NULL,
  tipo         TEXT NOT NULL,
  canal        TEXT NOT NULL DEFAULT 'whatsapp',
  telefono     TEXT,
  email        TEXT,
  message_id   TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_cliente_tipo
    ON public.notif_log (cliente_id, tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_log_pedido
    ON public.notif_log (pedido_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_empresa
    ON public.notif_log (empresa_id, created_at DESC);

ALTER TABLE public.notif_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ver notif_log propia empresa" ON public.notif_log;
CREATE POLICY "ver notif_log propia empresa"
  ON public.notif_log FOR SELECT
  USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()
    )
  );

-- ── 2. categorias.activa — columna faltante ───────────────────────────────
-- Migration 041 la agrega como 'activa' (femenino). El código usa .eq('activa').
-- Idempotente: IF NOT EXISTS.
ALTER TABLE public.categorias
    ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_categorias_empresa_activa
    ON public.categorias (empresa_id, activa);

-- ── 3. lotes — estado CHECK y columnas ───────────────────────────────────
-- La tabla lotes en el backup usa: 'activo','agotado','vencido'.
-- El código insertaba 'vigente' (incorrecto) y filtraba 'dado_de_baja' (inexistente).
-- Ambos ya corregidos en el código. No se necesita cambio de esquema aquí.
-- Confirmar constraint existente:
-- CONSTRAINT lotes_estado_check CHECK (estado IN ('activo','agotado','vencido'))
-- Si hubiera filas con estado='vigente' del pasado, normalizar:
UPDATE public.lotes SET estado = 'activo' WHERE estado = 'vigente';
UPDATE public.lotes SET estado = 'agotado' WHERE estado = 'dado_de_baja';

-- ── 4. canjear_puntos — función faltante ─────────────────────────────────
-- Requerida por frontend/admin/js/puntos.js y frontend/cliente/js/puntos.js.
-- Descuenta puntos del saldo y registra el movimiento.
CREATE OR REPLACE FUNCTION public.canjear_puntos(
    p_empresa_id     UUID,
    p_cliente_id     UUID,
    p_puntos         INTEGER,
    p_concepto       TEXT    DEFAULT 'Canje manual',
    p_ref_tipo       TEXT    DEFAULT 'manual',
    p_usuario_id     UUID    DEFAULT NULL,
    p_usuario_nombre TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_saldo_actual INTEGER;
    v_saldo_nuevo  INTEGER;
BEGIN
    -- Leer saldo actual con bloqueo
    SELECT COALESCE(puntos_disponibles, 0)
      INTO v_saldo_actual
      FROM public.saldo_puntos
     WHERE cliente_id = p_cliente_id
       AND empresa_id = p_empresa_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El cliente no tiene saldo de puntos';
    END IF;

    IF v_saldo_actual < p_puntos THEN
        RAISE EXCEPTION 'Saldo insuficiente (disponible: %, requerido: %)', v_saldo_actual, p_puntos;
    END IF;

    v_saldo_nuevo := v_saldo_actual - p_puntos;

    -- Actualizar saldo
    UPDATE public.saldo_puntos
       SET puntos_disponibles = v_saldo_nuevo,
           puntos_canjeados   = COALESCE(puntos_canjeados, 0) + p_puntos,
           ultimo_movimiento  = now()
     WHERE cliente_id = p_cliente_id
       AND empresa_id = p_empresa_id;

    -- Registrar movimiento
    INSERT INTO public.movimientos_puntos
           (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
    VALUES (p_cliente_id, p_empresa_id, 'canje', p_puntos, p_concepto, NULL);

    RETURN json_build_object('ok', true, 'saldo_nuevo', v_saldo_nuevo);
END;
$$;

-- ── 5. acreditar_puntos — función faltante ────────────────────────────────
-- Requerida por frontend/admin/js/puntos.js para acreditación manual.
CREATE OR REPLACE FUNCTION public.acreditar_puntos(
    p_empresa_id     UUID,
    p_cliente_id     UUID,
    p_puntos         INTEGER,
    p_concepto       TEXT    DEFAULT 'Acreditación manual',
    p_ref_tipo       TEXT    DEFAULT 'manual',
    p_usuario_id     UUID    DEFAULT NULL,
    p_usuario_nombre TEXT    DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_saldo_nuevo INTEGER;
BEGIN
    -- Upsert saldo
    INSERT INTO public.saldo_puntos
           (cliente_id, empresa_id, puntos_disponibles, puntos_totales, ultimo_movimiento)
    VALUES (p_cliente_id, p_empresa_id, p_puntos, p_puntos, now())
    ON CONFLICT (cliente_id, empresa_id) DO UPDATE
       SET puntos_disponibles = saldo_puntos.puntos_disponibles + p_puntos,
           puntos_totales     = saldo_puntos.puntos_totales + p_puntos,
           ultimo_movimiento  = now()
    RETURNING puntos_disponibles INTO v_saldo_nuevo;

    -- Registrar movimiento
    INSERT INTO public.movimientos_puntos
           (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
    VALUES (p_cliente_id, p_empresa_id, 'ganancia', p_puntos, p_concepto, NULL);

    RETURN json_build_object('ok', true, 'saldo', v_saldo_nuevo);
END;
$$;

-- ── 6. saldo_puntos — unique constraint (cliente_id, empresa_id) ──────────
-- El código hace upsert con onConflict: 'cliente_id,empresa_id'.
-- Asegurar que existe el constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.saldo_puntos'::regclass
           AND contype = 'u'
           AND conkey = ARRAY(
                SELECT attnum FROM pg_attribute
                 WHERE attrelid = 'public.saldo_puntos'::regclass
                   AND attname IN ('cliente_id','empresa_id')
                 ORDER BY attnum
               )
    ) THEN
        ALTER TABLE public.saldo_puntos
            ADD CONSTRAINT saldo_puntos_cliente_empresa_uq UNIQUE (cliente_id, empresa_id);
    END IF;
END $$;

-- ── 7. presupuesto_items — descuento_pct ─────────────────────────────────
-- La tabla tiene 'descuento_pct'. El código usaba 'descuento' (ya corregido).
-- Si la tabla tiene 'descuento' en vez de 'descuento_pct', crear alias:
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'presupuesto_items'
           AND column_name  = 'descuento'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'presupuesto_items'
           AND column_name  = 'descuento_pct'
    ) THEN
        ALTER TABLE public.presupuesto_items RENAME COLUMN descuento TO descuento_pct;
    END IF;
END $$;

-- ── Fin 048_fix_sync_code_v47.sql ────────────────────────────────────────
