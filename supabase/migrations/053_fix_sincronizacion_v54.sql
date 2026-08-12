-- ═══════════════════════════════════════════════════════════════════════════
-- 053_fix_sincronizacion_v54.sql
-- Sincronización DB con código v54 — ejecutar en Supabase SQL Editor
-- Orden: después de 052_saneamiento_final_v54.sql
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. TABLA notif_prefs_auto (faltante en DB) ─────────────────────────────
-- Necesaria para que el Panel de Automatización pueda leer/escribir
-- preferencias de notificaciones push por motor.
CREATE TABLE IF NOT EXISTS public.notif_prefs_auto (
  empresa_id              UUID        PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  piloto_sugerencia       BOOLEAN     NOT NULL DEFAULT TRUE,
  cierre_cliente_bloqueado BOOLEAN    NOT NULL DEFAULT TRUE,
  cierre_error_cola        BOOLEAN    NOT NULL DEFAULT TRUE,
  stock_quiebre           BOOLEAN     NOT NULL DEFAULT TRUE,
  stock_orden_auto        BOOLEAN     NOT NULL DEFAULT TRUE,
  score_caida_critica     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS para notif_prefs_auto
ALTER TABLE public.notif_prefs_auto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_prefs_auto_empresa ON public.notif_prefs_auto;
CREATE POLICY notif_prefs_auto_empresa ON public.notif_prefs_auto
  FOR ALL
  USING (empresa_id = public.get_empresa_id());

-- ── 2. COLUMNAS p256dh y auth en dispositivos_push ─────────────────────────
-- El panel de automatización guarda suscripciones Web Push (VAPID).
-- La DB solo tenía token_push (FCM). Se agregan las columnas faltantes.
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS p256dh   TEXT;
ALTER TABLE public.dispositivos_push ADD COLUMN IF NOT EXISTS auth     TEXT;

-- Índice único para evitar duplicar suscripciones por endpoint
DROP INDEX IF EXISTS public.idx_dispositivos_push_endpoint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispositivos_push_endpoint
  ON public.dispositivos_push(endpoint)
  WHERE endpoint IS NOT NULL;

-- ── 3. COLUMNA presupuesto_id en pedidos ───────────────────────────────────
-- Cuando se acepta un presupuesto se crea un pedido vinculado.
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS presupuesto_id UUID REFERENCES public.presupuestos(id);
ALTER TABLE public.pedidos ADD COLUMN IF NOT EXISTS notas_internas TEXT;

-- ── 4. UNIFICAR ESTADOS DE PRESUPUESTOS ────────────────────────────────────
-- El código v54 usa: aceptado | vencido (correcto según el CHECK constraint del backup).
-- Si quedaron filas con estados viejos (aprobado/expirado/convertido), migrarlas:
UPDATE public.presupuestos SET estado = 'aceptado' WHERE estado = 'aprobado';
UPDATE public.presupuestos SET estado = 'vencido'  WHERE estado = 'expirado';
UPDATE public.presupuestos SET estado = 'aceptado' WHERE estado = 'convertido';

-- ── 5. COLUMNA cliente_id en usuarios ──────────────────────────────────────
-- Permite que enviarPush() desde contexto cliente funcione.
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL;

-- ── 6. COLUMNAS adicionales en cta_cte ─────────────────────────────────────
ALTER TABLE public.cta_cte ADD COLUMN IF NOT EXISTS descripcion TEXT;

COMMIT;
