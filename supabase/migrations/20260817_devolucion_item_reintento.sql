-- PED-006/PED-007: estado idempotente por ítem al reponer una devolución.
ALTER TABLE public.devolucion_items
  ADD COLUMN IF NOT EXISTS reposicion_at timestamptz,
  ADD COLUMN IF NOT EXISTS reposicion_error text,
  ADD COLUMN IF NOT EXISTS reposicion_deposito_id uuid;

COMMENT ON COLUMN public.devolucion_items.reposicion_at IS
  'Momento en que el ítem fue repuesto en stock; evita duplicar el ingreso al reintentar.';
COMMENT ON COLUMN public.devolucion_items.reposicion_error IS
  'Último error de reposición de este ítem, visible para reintento selectivo.';
COMMENT ON COLUMN public.devolucion_items.reposicion_deposito_id IS
  'Depósito donde se realizó la reposición de este ítem.';
