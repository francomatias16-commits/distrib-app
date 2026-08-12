-- ============================================================
-- MIGRACIÓN 077 — RLS crítico + política movimientos_cta_cte
-- distrib v85  |  cada bloque es independiente (sin tx global)
-- ============================================================

-- ============================================================
-- PASO 1: Habilitar RLS en las 22 tablas con políticas inertes
-- ============================================================

ALTER TABLE public.productos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cta_cte                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cheques                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobros                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precios_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_stock      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rutas                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entregas               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depositos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispositivos_push      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canjes_recompensas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integraciones_pago     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificaciones_push    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programas_fidelizacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recompensas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saldo_puntos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sugerencias_pedido     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transacciones_pago     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_puntos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notas_internas         ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- PASO 2: Corregir política movimientos_cta_cte (hallazgo #4)
-- ============================================================

DROP POLICY IF EXISTS admin_all ON public.movimientos_cta_cte;
DROP POLICY IF EXISTS movimientos_cta_cte_empresa ON public.movimientos_cta_cte;
DROP POLICY IF EXISTS movimientos_cta_cte_escritura ON public.movimientos_cta_cte;

CREATE POLICY movimientos_cta_cte_empresa ON public.movimientos_cta_cte
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.clientes c
        JOIN public.usuarios u ON u.id = auth.uid()
       WHERE c.id = movimientos_cta_cte.cliente_id
         AND c.empresa_id = u.empresa_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.clientes c
        JOIN public.usuarios u ON u.id = auth.uid()
       WHERE c.id = movimientos_cta_cte.cliente_id
         AND c.empresa_id = u.empresa_id
         AND u.rol IN ('dueno', 'admin', 'contador')
    )
  );

-- ============================================================
-- PASO 3: Constraints de integridad
-- Cada bloque DO es independiente — un fallo no cancela los demás
-- ============================================================

-- CUIT único por empresa
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clientes_cuit_empresa_unique'
      AND conrelid = 'public.clientes'::regclass
  ) THEN
    ALTER TABLE public.clientes
      ADD CONSTRAINT clientes_cuit_empresa_unique UNIQUE (empresa_id, cuit);
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'clientes_cuit_empresa_unique: % — omitido', SQLERRM;
END $$;

-- CHECK formato CUIT
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'clientes_cuit_formato'
      AND conrelid = 'public.clientes'::regclass
  ) THEN
    ALTER TABLE public.clientes
      ADD CONSTRAINT clientes_cuit_formato
        CHECK (cuit IS NULL OR cuit ~ '^\d{2}-\d{8}-\d{1}$');
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'clientes_cuit_formato: % — omitido', SQLERRM;
END $$;

-- Código de producto único por empresa
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'productos_codigo_empresa_unique'
      AND conrelid = 'public.productos'::regclass
  ) THEN
    ALTER TABLE public.productos
      ADD CONSTRAINT productos_codigo_empresa_unique UNIQUE (empresa_id, codigo);
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'productos_codigo_empresa_unique: % — omitido', SQLERRM;
END $$;

-- CHECK estados cheques (incluye todos los valores existentes en producción)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cheques_estado_check'
      AND conrelid = 'public.cheques'::regclass
  ) THEN
    ALTER TABLE public.cheques
      ADD CONSTRAINT cheques_estado_check
        CHECK (estado IN (
          'pendiente',
          'en_cartera',
          'cobrado',
          'depositado',
          'rechazado',
          'entregado_proveedor',
          'anulado'
        ));
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'cheques_estado_check: % — omitido', SQLERRM;
END $$;

-- CHECK estados devoluciones
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'devoluciones_estado_check'
      AND conrelid = 'public.devoluciones'::regclass
  ) THEN
    ALTER TABLE public.devoluciones
      ADD CONSTRAINT devoluciones_estado_check
        CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'procesada'));
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'devoluciones_estado_check: % — omitido (verificar estados existentes con SELECT DISTINCT estado FROM devoluciones)', SQLERRM;
END $$;

-- NOTA: constraint lotes_fecha_vencimiento_futura OMITIDO intencionalmente.
-- Hay lotes históricos con fecha vencida que violarían el check.
-- La validación se hace en el frontend al dar de alta nuevos lotes.

-- ============================================================
-- PASO 4: Trigger sync cantidad_disponible en stock
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_stock_disponible()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.cantidad_disponible := GREATEST(0, NEW.cantidad - COALESCE(NEW.cantidad_reservada, 0));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_stock_disponible ON public.stock;
CREATE TRIGGER trg_sync_stock_disponible
  BEFORE INSERT OR UPDATE OF cantidad, cantidad_reservada
  ON public.stock
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_stock_disponible();

-- ============================================================
-- PASO 5: security_invoker en vista rentabilidad_zona
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_rentabilidad_zona_ruta'
             AND schemaname = 'public') THEN
    ALTER VIEW public.v_rentabilidad_zona_ruta SET (security_invoker = true);
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'v_rentabilidad_zona_ruta security_invoker: % — omitido', SQLERRM;
END $$;

-- ============================================================
-- PASO 6: Normalizar vence_oferta_at a timestamptz
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ofertas_liquidacion'
      AND column_name  = 'vence_oferta_at'
      AND data_type    = 'timestamp without time zone'
  ) THEN
    ALTER TABLE public.ofertas_liquidacion
      ALTER COLUMN vence_oferta_at TYPE timestamptz
        USING vence_oferta_at AT TIME ZONE 'America/Argentina/Buenos_Aires';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ofertas_liquidacion'
      AND column_name  = 'notificada_at'
      AND data_type    = 'timestamp without time zone'
  ) THEN
    ALTER TABLE public.ofertas_liquidacion
      ALTER COLUMN notificada_at TYPE timestamptz
        USING notificada_at AT TIME ZONE 'America/Argentina/Buenos_Aires';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'ofertas_liquidacion'
      AND column_name  = 'desactivada_at'
      AND data_type    = 'timestamp without time zone'
  ) THEN
    ALTER TABLE public.ofertas_liquidacion
      ALTER COLUMN desactivada_at TYPE timestamptz
        USING desactivada_at AT TIME ZONE 'America/Argentina/Buenos_Aires';
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'ofertas_liquidacion timestamptz: % — omitido', SQLERRM;
END $$;

-- ============================================================
-- PASO 7: Índice único parcial rutas (pedido en una sola ruta activa)
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables
             WHERE schemaname = 'public' AND tablename = 'ruta_items') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_un_pedido_por_ruta_activa
      ON public.ruta_items (pedido_id)
      WHERE EXISTS (
        SELECT 1 FROM public.rutas r
        WHERE r.id = ruta_items.ruta_id
          AND r.estado IN ('planificada', 'en_curso')
      );
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'idx_un_pedido_por_ruta_activa: % — omitido', SQLERRM;
END $$;

-- ============================================================
-- PASO 8: Índice performance pedidos por fecha
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_pedidos_empresa_fecha
  ON public.pedidos (empresa_id, fecha_pedido DESC);

-- ============================================================
-- FIN — verificar warnings en la consola de Supabase
-- ============================================================
