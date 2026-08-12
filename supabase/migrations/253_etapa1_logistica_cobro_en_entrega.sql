-- ─────────────────────────────────────────────────────────────────────────
-- 253_etapa1_logistica_cobro_en_entrega.sql
-- Auditoría UX v2 — brecha funcional real (sección 4, fila "Entrega,
-- conciliación y cobranza en el reparto"): la app del chofer confirma
-- entregas con firma y foto, pero no tiene forma de registrar que cobró
-- efectivo/cheque/transferencia al entregar.
--
-- No se crea una tabla nueva ni un circuito de cobro paralelo: se reutiliza
-- el mismo punto de entrada que ya usa /admin/cobranzas y el "Cobro rápido"
-- de /admin/rutas (resumen del día) — el RPC registrar_cobro_completo
-- (migración 199), que ya crea el cobro, el movimiento en cta_cte y
-- reevalúa el bloqueo por deuda del cliente en un solo paso atómico.
--
-- Lo único que falta es dejar registrado, en la propia fila de `entregas`,
-- que ESE cobro puntual quedó asociado a ESA entrega (para poder mostrarlo
-- en el detalle del remito y en el historial del chofer/admin sin tener
-- que cruzar contra cta_cte a mano).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.entregas
  ADD COLUMN IF NOT EXISTS monto_cobrado NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS medio_cobro   TEXT,
  ADD COLUMN IF NOT EXISTS cobro_id      UUID REFERENCES public.cobros(id);

COMMENT ON COLUMN public.entregas.monto_cobrado IS
  'Monto cobrado por el chofer al momento de confirmar esta entrega (opcional). NULL = no se cobró nada en el reparto (ej: cliente ya paga por cta cte / transferencia previa).';
COMMENT ON COLUMN public.entregas.medio_cobro IS
  'Medio de pago del cobro registrado en el reparto: efectivo | transferencia | cheque | otro. Mismo vocabulario que cobros.medio.';
COMMENT ON COLUMN public.entregas.cobro_id IS
  'FK al registro real en cobros (creado vía RPC registrar_cobro_completo). Permite trazar el cobro completo (cta_cte, numeración, reevaluación de bloqueo) desde la entrega.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '253_etapa1_logistica_cobro_en_entrega.sql', '253', 'claude-session',
        'Auditoria UX v2, brecha funcional real: agrega monto_cobrado/medio_cobro/cobro_id a entregas para soportar el registro de cobro (monto + medio de pago) desde la confirmacion de entrega del chofer. Reutiliza el RPC registrar_cobro_completo (migracion 199) como unico punto de entrada, sin crear un circuito de cobro paralelo.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
