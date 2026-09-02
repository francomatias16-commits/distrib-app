-- 460_perf_indices_ventas_pos_pedidos.sql
--
-- Load test (2026-08-29, scripts/load-test.js contra prod) detectó
-- /api/admin/comparativa-mensual con p99 8881ms bajo 30 conexiones
-- concurrentes (umbral: 5000ms). obtener_comparativa_mensual() (243)
-- filtra ventas_pos y pedidos por (empresa_id, estado, rango de created_at),
-- pero:
--   - ventas_pos solo tenía índice en empresa_id (072_pos.sql) — nada por
--     estado+created_at, así que el filtro de fecha/estado se resuelve en
--     memoria sobre todas las filas de la empresa.
--   - pedidos tenía (empresa_id, estado) [052] y (empresa_id, estado,
--     fecha_pedido) [096], pero esta RPC filtra por created_at, no por
--     fecha_pedido — ningún índice existente cubre ese patrón exacto.
--
-- Con poca carga no se nota (Postgres compensa con el índice de empresa_id
-- solo), pero bajo concurrencia cada conexión escanea más filas de las
-- necesarias y compiten por CPU/IO, degradando la latencia de cola (p99)
-- aunque el p50 se mantenga bien.
--
-- CONCURRENTLY: para no tomar lock exclusivo sobre tablas con escritura
-- constante (ventas POS y pedidos) en un ambiente productivo.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ventas_pos_empresa_estado_created
  ON public.ventas_pos (empresa_id, estado, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_empresa_estado_created
  ON public.pedidos (empresa_id, estado, created_at);

-- ⚠️ OJO al aplicar: CREATE INDEX CONCURRENTLY no puede correr dentro de una
-- transacción. Si usan `supabase db push` (que envuelve cada migración en
-- una transacción), este archivo va a fallar. Aplíquenlo aparte, por
-- ejemplo con psql directo:
--   psql "$DATABASE_URL" -f 460_perf_indices_ventas_pos_pedidos.sql
-- o pegando el contenido en el SQL Editor de Supabase (que sí permite
-- CONCURRENTLY fuera de transacción).
