-- ═══════════════════════════════════════════════════════════════════════════
-- 051_automatizacion_setup.sql — Tablas para el panel de automatización
-- Idempotente: usa IF NOT EXISTS en todo.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. notif_prefs_auto — preferencias de alertas push por empresa
CREATE TABLE IF NOT EXISTS public.notif_prefs_auto (
  empresa_id              UUID PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  piloto_sugerencia       BOOLEAN DEFAULT true,
  cierre_cliente_bloqueado BOOLEAN DEFAULT true,
  cierre_error_cola       BOOLEAN DEFAULT true,
  stock_quiebre           BOOLEAN DEFAULT true,
  stock_orden_auto        BOOLEAN DEFAULT true,
  score_caida_critica     BOOLEAN DEFAULT true,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.notif_prefs_auto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif_prefs_auto_empresa" ON public.notif_prefs_auto;
CREATE POLICY "notif_prefs_auto_empresa" ON public.notif_prefs_auto
  FOR ALL USING (empresa_id = public.get_empresa_id());

-- 2. Insertar fila de prefs para empresas existentes que no la tengan
INSERT INTO public.notif_prefs_auto (empresa_id)
SELECT id FROM public.empresas
WHERE id NOT IN (SELECT empresa_id FROM public.notif_prefs_auto)
ON CONFLICT DO NOTHING;

-- 3. ciclos_compra: asegurar índice en proximo_pedido (para el piloto)
CREATE INDEX IF NOT EXISTS idx_ciclos_proximo_activo
  ON public.ciclos_compra (empresa_id, proximo_pedido)
  WHERE activo = true;

-- 4. clientes: asegurar columnas de score si no existen (migration 036)
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_actual        NUMERIC(5,2);
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_categoria     TEXT;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS score_actualizado   TIMESTAMPTZ;

-- 5. rutas: columnas GPS si no existen (migration 034)
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS chofer_lat         DOUBLE PRECISION;
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS chofer_lng         DOUBLE PRECISION;
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS chofer_actualizado TIMESTAMPTZ;

-- 6. Índices útiles para queries del panel
CREATE INDEX IF NOT EXISTS idx_facturas_empresa_estado
  ON public.facturas (empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_cobros_empresa_fecha
  ON public.cobros (empresa_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_rutas_empresa_fecha
  ON public.rutas (empresa_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_lotes_empresa_vencimiento
  ON public.lotes (empresa_id, fecha_vencimiento)
  WHERE estado = 'activo';

-- 7. Verificación final
SELECT 'notif_prefs_auto' AS tabla, COUNT(*) AS filas FROM public.notif_prefs_auto
UNION ALL
SELECT 'ciclos_compra', COUNT(*) FROM public.ciclos_compra
UNION ALL
SELECT 'clientes_con_score', COUNT(*) FROM public.clientes WHERE score_actual IS NOT NULL;
