-- ============================================================================
-- 065_fidelizacion_bonus_score.sql
--
-- Innovación #8 (Fidelización Conectada al Score, no solo a la Compra),
-- según roadmap-innovaciones-distrib.md.
--
-- Contenido:
--   1. Columna programas_fidelizacion.bonus_pct_categoria: % extra de puntos
--      según la categoría de score del cliente al momento del pedido.
--      JSONB en vez de columnas fijas para que cada empresa ajuste el bonus
--      sin requerir nueva migración si cambian las categorías de score.
-- ============================================================================

ALTER TABLE public.programas_fidelizacion
  ADD COLUMN IF NOT EXISTS bonus_pct_categoria jsonb
    DEFAULT '{"premium":20,"bueno":10,"normal":0,"riesgo":0,"bloqueado":0}'::jsonb
    NOT NULL;

COMMENT ON COLUMN public.programas_fidelizacion.bonus_pct_categoria IS
  'Bonus porcentual de puntos según clientes.score_categoria al momento de '
  'acreditar puntos del pedido. Ej: {"premium":20} = +20% de puntos para '
  'clientes premium. Categorías sin entrada o en 0 no reciben bonus. '
  'Usado por acreditarPuntos() en lib/handlers/pedidos.js.';

-- Empresas existentes ya reciben el default vía el ADD COLUMN de arriba
-- (NOT NULL + DEFAULT aplica a filas existentes automáticamente en Postgres).
